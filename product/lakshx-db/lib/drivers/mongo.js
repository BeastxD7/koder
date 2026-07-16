// MongoDB driver for the LakshX Database panel — the existing (originally
// Mongo-only) logic from extension.js, moved behind the shared driver
// interface (see lib/engines.js) with behavior unchanged.
//
// MongoDB is a deliberate special case among the engines this panel family
// targets (Postgres/MySQL/SQLite are FK-enforced and get an authoritative
// schema straight from information_schema/PRAGMA equivalents): Mongo has no
// schema and no enforced foreign keys, so everything shown here is INFERRED
// from a bounded sample of live documents, and every relationship is a
// heuristic suggestion, never a fact. See lib/schema.js, lib/relationships.js,
// lib/mermaid.js for where that distinction is actually enforced (visually
// and in the copy), not just asserted in this comment.
//
// No vscode import here — all UI (input boxes, quick picks) stays in
// extension.js, which passes callbacks in. That keeps every driver module
// loadable under plain `node --test`.
"use strict";

const { MongoClient } = require("mongodb");
const { inferCollectionSchema } = require("../schema.js");
const { detectRelationships } = require("../relationships.js");
const { buildErDiagram } = require("../mermaid.js");
const { redactText } = require("../redact.js");
const { flattenMongoDoc } = require("../data-browse.js");
const { parseMongoQuerySpec, clampMaxRows, DEFAULT_TIMEOUT_MS } = require("../query-guard.js");

const SAMPLE_SIZE = 100; // bounded sample per collection — see lib/schema.js header
const COLLECTION_LIMIT = 40; // guardrail against a huge database fanning out into hundreds of $sample round-trips
const SYSTEM_DB_NAMES = new Set(["admin", "local", "config"]);

/** Connects, verifies with a ping, and disconnects — used to validate a
 * freshly entered connection string before it's persisted to SecretStorage.
 * Returns null on success, or a redacted error message on failure. */
async function testConnection(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    await client.db().admin().ping();
    return null;
  } catch (err) {
    return redactText(String(err?.message ?? err));
  } finally {
    await client.close().catch(() => {});
  }
}

async function connect(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  return client;
}

async function close(client) {
  await client?.close().catch(() => {});
}

/** Decides which database to introspect: listDatabases when permitted,
 * falling back to the connection string's default. `pick(candidates)` is the
 * caller's chooser (a QuickPick in extension.js) for the multi-candidate
 * case; `log` receives diagnostic lines. */
async function resolveDatabase(client, { pick, log = () => {} } = {}) {
  let candidates = null;
  try {
    const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
    candidates = databases.map((d) => d.name).filter((n) => !SYSTEM_DB_NAMES.has(n));
  } catch (err) {
    // Common for a least-privilege user without the clusterMonitor role —
    // fall back to whatever database the connection string itself names.
    log(`listDatabases unavailable (${err?.message ?? err}); falling back to the connection string's default database.`);
  }

  const defaultDb = client.db(); // driver-resolved default (from the URI path), if any
  if (!candidates || candidates.length === 0) {
    if (!defaultDb.databaseName || defaultDb.databaseName === "test") {
      throw new Error(
        "Couldn't determine which database to open: this user can't list databases, and the connection string doesn't name one. Add /yourDbName to the connection string.",
      );
    }
    return defaultDb.databaseName;
  }
  if (candidates.length === 1) return candidates[0];
  if (defaultDb.databaseName && candidates.includes(defaultDb.databaseName)) return defaultDb.databaseName;

  const picked = await pick(candidates);
  if (!picked) throw new Error("No database selected.");
  return picked;
}

/** Connects, samples every collection in `dbName` (bounded, see SAMPLE_SIZE/
 * COLLECTION_LIMIT), infers a schema shape for each, and detects suggested
 * relationships across the set. Returns the payload the webview renders. */
async function introspect(client, dbName) {
  const db = client.db(dbName);
  const allCollections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith("system."))
    .sort((a, b) => a.localeCompare(b));

  const collectionNames = allCollections.slice(0, COLLECTION_LIMIT);
  const truncatedCollectionCount = Math.max(0, allCollections.length - collectionNames.length);

  const schemasByCollection = {};
  for (const name of collectionNames) {
    // $sample gives a uniform random sample straight from the server,
    // rather than an insertion-order-biased "first N" scan.
    const sampleDocs = await db.collection(name).aggregate([{ $sample: { size: SAMPLE_SIZE } }]).toArray();
    schemasByCollection[name] = inferCollectionSchema(sampleDocs, { limit: SAMPLE_SIZE });
  }

  const relationships = detectRelationships(schemasByCollection);
  const mermaidSource = buildErDiagram(schemasByCollection, relationships);

  return {
    engine: "mongo",
    engineLabel: "MongoDB",
    authoritative: false, // everything below is inferred from a sample
    databaseName: dbName,
    collections: collectionNames.map((name) => ({
      name,
      sampledCount: schemasByCollection[name].sampledCount,
      fieldCount: schemasByCollection[name].fields.length,
    })),
    truncatedCollectionCount,
    relationships,
    mermaidSource,
    sampleSize: SAMPLE_SIZE,
  };
}

// ---- data browsing (user reading their own rows; NOT the AI db_query tool) --
//
// A FIND-ONLY bounded page: `db.collection(name).find({}).skip(n).limit(k)`.
// No aggregation stages that could write, no $out/$merge — just a plain cursor.
// The collection name comes from introspection (listCollections), and Mongo's
// collection() takes a namespace string, not a query, so there's no injection
// surface here. Reuses the session's already-connected client + resolved
// dbName (passed in by extension.js), same as introspect().
async function fetchCollectionPage(client, dbName, collectionName, { pageSize, page } = {}) {
  const size = Math.min(Math.max(1, Math.floor(Number(pageSize)) || 50), 500);
  const skip = Math.max(0, Math.floor(Number(page)) || 0) * size;
  const db = client.db(dbName);
  // Request size+1 (the probe row) so the caller can tell there's a next page
  // without a separate countDocuments.
  const docs = await db
    .collection(collectionName)
    .find({}, { limit: size + 1, skip })
    .toArray();
  return { docs };
}

// ---- read-only ad-hoc query (db_query feature; design §3/§4/§10) ----------
//
// Completing what design §10 deferred ("MongoDB — weaker read-only story
// than SQL — omit in v1"). Mongo has no engine-enforced read-only
// transaction the way Postgres (`BEGIN ... READ ONLY`) / MySQL (`START
// TRANSACTION READ ONLY`) do, so the read-only guarantee here is STRUCTURAL
// rather than transactional, built from four layers:
//   Layer A (shape):     parseMongoQuerySpec (query-guard.js) requires the
//                         query to be a {collection, filter, ...} SPEC, not
//                         an arbitrary command — there is no way to smuggle
//                         `db.collection.drop()` through this shape at all.
//   Layer B (operators):  the filter is scanned (recursively, through
//                         $and/$or/$nor) for update-operator keys ($set,
//                         $inc, $unset, ...) and aggregation side-effect
//                         stage names ($out/$merge), plus $where (arbitrary
//                         JS execution) — rejected before a connection opens.
//   Layer C (verb):       ONLY `.find()` is ever called below — never
//                         `.aggregate()` (which could carry $out/$merge
//                         stages), never updateOne/deleteOne/insertOne/
//                         bulkWrite/anything else. No code path here can
//                         reach a mutating driver method.
//   Layer D (bounds):     row cap (maxRows, same [1,1000] band as SQL,
//                         layered under any inner "limit" the query spec
//                         itself requested) and a cursor-level maxTimeMS
//                         timeout — mirroring the SQL drivers' row-cap/
//                         timeout layers.
// A FRESH client is opened per call and always closed in `finally`, same
// discipline as the SQL drivers' runReadOnlyQuery. `runReadOnlyWithClient`
// is split out (and exported) so it can be unit-tested with a fake client
// that records the exact find() call, without a live MongoDB — same pattern
// postgres.js/mysql.js use for their read-only paths.

/** Flatten a page of documents into the {columns, rows} shape
 * query-guard.js's formatResultText/formatCell expects: columns are the
 * UNION of top-level keys across the page (in first-seen order, `_id`
 * pulled to the front when present — same discovery rule as
 * data-browse.js's shapeMongoPage), and rows are arrays of RAW values in
 * that column order (a document missing a column gets `null`). Reuses
 * data-browse.js's `flattenMongoDoc` for the per-document flattening rather
 * than reinventing it; deliberately does NOT reuse `shapeMongoPage`'s
 * webview cell-tagging ({kind,text} pairs) — formatResultText/formatCell
 * already knows how to stringify Dates/Buffers/objects for the model. */
function shapeDocsForResult(docs) {
  const flat = docs.map((d) => flattenMongoDoc(d));
  const columns = [];
  const seen = new Set();
  for (const m of flat) {
    for (const k of m.keys()) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  if (seen.has("_id")) {
    const rest = columns.filter((c) => c !== "_id");
    columns.length = 0;
    columns.push("_id", ...rest);
  }
  const rows = flat.map((m) => columns.map((col) => (m.has(col) ? m.get(col) : null)));
  return { columns, rows };
}

/**
 * Runs an already-validated Mongo query spec against a live, connected
 * client. `spec` is the NORMALIZED object `parseMongoQuerySpec` returns
 * (`{collection, filter, projection, sort, limit}`) — parsing/validation
 * happens once, in `runReadOnlyQuery` below, before any connection is
 * opened, exactly like postgres.js computing `kind` via `classifyStatement`
 * before calling `runReadOnlyWithClient`.
 *
 * No interactive picker is available here (this is an AI tool call, not a
 * human quick-pick session): if the connection is genuinely ambiguous
 * (several databases visible, none named by the URI), `resolveDatabase`
 * throws its own clean "No database selected." error rather than guessing.
 */
async function runReadOnlyWithClient(client, spec, { maxRows, timeoutMs } = {}) {
  const cap = clampMaxRows(maxRows);
  const effectiveLimit = spec.limit ? Math.min(spec.limit, cap) : cap;

  const dbName = await resolveDatabase(client, { pick: async () => null, log: () => {} });
  const db = client.db(dbName);

  const findOpts = { limit: effectiveLimit + 1, maxTimeMS: timeoutMs ?? DEFAULT_TIMEOUT_MS };
  if (spec.projection) findOpts.projection = spec.projection;
  if (spec.sort) findOpts.sort = spec.sort;

  const docs = await db.collection(spec.collection).find(spec.filter, findOpts).toArray();

  let truncated = false;
  let pageDocs = docs;
  if (pageDocs.length > effectiveLimit) {
    truncated = true;
    pageDocs = pageDocs.slice(0, effectiveLimit);
  }

  const { columns, rows } = shapeDocsForResult(pageDocs);
  return { columns, rows, rowCount: rows.length, truncated, databaseName: dbName };
}

/** Opens a fresh connection and runs a read-only Mongo query. `conn` is the
 * connection URI (the stored secret), NOT a live handle. `querySpecRaw` is
 * either the JSON-stringified spec (as it travels across the tool-call/ACP
 * boundary) or an already-parsed object (direct unit-test / same-process
 * callers). Throws QueryRejectedError (mapped to a clean tool error by
 * query-api.js) before any connection is opened when the spec is malformed
 * or contains a forbidden operator. */
async function runReadOnlyQuery(conn, querySpecRaw, opts = {}) {
  const spec = parseMongoQuerySpec(querySpecRaw); // throws QueryRejectedError before opening anything
  const maxRows = clampMaxRows(opts.maxRows);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const client = new MongoClient(conn, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    return await runReadOnlyWithClient(client, spec, { maxRows, timeoutMs });
  } finally {
    await client.close().catch(() => {});
  }
}

module.exports = {
  id: "mongo",
  label: "MongoDB",
  connectionKind: "uri", // extension.js prompts with a masked input box
  secretKey: "lakshx.db.mongo.connectionString",
  prompt: {
    title: "LakshX Database: MongoDB Connection String",
    example: "mongodb://user:password@host:27017/mydb or a mongodb+srv:// Atlas URI",
    placeHolder: "mongodb://localhost:27017/mydb",
    schemeError: "Must start with mongodb:// or mongodb+srv://",
    schemeRe: /^mongodb(\+srv)?:\/\//i,
  },
  testConnection,
  connect,
  close,
  resolveDatabase,
  introspect,
  fetchCollectionPage,
  runReadOnlyQuery,
  // exported for unit tests
  runReadOnlyWithClient,
  shapeDocsForResult,
};
