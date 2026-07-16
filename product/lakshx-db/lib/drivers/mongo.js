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
};
