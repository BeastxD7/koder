// Pure, vscode-FREE helpers for the LakshX Database panel's DATA-BROWSING
// view (the user reading rows from their OWN connected database — distinct
// from the AI db_query tool, and NOT gated by the "Allow AI queries" opt-in).
//
// Everything here is unit-testable under `node --test`: no I/O, no driver
// imports, no vscode. The extension host (extension.js) calls these to build
// the bounded SELECT it hands to the EXISTING read-only path
// (driver.runReadOnlyQuery) and to shape rows for the webview.
//
// SAFETY NOTE on identifiers: a browsed table/collection name always comes
// from introspection (the engine's own catalog / listCollections), never from
// free user text. Even so, every identifier is QUOTED and escaped per engine
// here — defense in depth, so a table whose name contains a quote or a SQL
// keyword can never break out of its identifier position.
"use strict";

const DEFAULT_PAGE_SIZE = 50;
// Transport cap per cell: bounds the postMessage payload. The webview shows a
// short preview and can expand up to this length. This is NOT a safety redact
// (it's the user's own data) — just a size guard so a 1MB text column doesn't
// bloat the message.
const MAX_CELL_TRANSPORT = 2000;

/** Clamp a page size into a sane integer range. */
function clampPageSize(n, fallback = DEFAULT_PAGE_SIZE) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(v, 500);
}

/** Clamp a 0-based page index to a non-negative integer. */
function clampPage(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
}

/** Byte offset for a page. */
function offsetFor(page, pageSize) {
  return clampPage(page) * clampPageSize(pageSize);
}

// ---- per-engine identifier quoting -----------------------------------------

/** Quote a single identifier SEGMENT for the given engine, escaping the
 * engine's quote char by doubling it. MySQL uses backticks; the others use
 * ANSI double quotes. */
function quoteSegment(engine, ident) {
  const s = String(ident);
  if (engine === "mysql") {
    return "`" + s.replace(/`/g, "``") + "`";
  }
  // postgres, sqlite (and any ANSI-quoting engine)
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Quote a (possibly schema-qualified) table name for a FROM clause.
 *
 * Postgres display names are schema-qualified for non-`public` schemas
 * ("audit.events"); we split on the FIRST dot so each part is quoted
 * independently → `"audit"."events"`. This is a CORRECTNESS heuristic, not a
 * safety one: quoting holds regardless of the split, so the worst case for an
 * unusual name (a public table literally called `a.b`) is a failed query shown
 * in the panel's banner — never an injection. MySQL/SQLite names here are bare
 * (no schema prefix in their introspection), so they're quoted whole.
 */
function quoteTableName(engine, name) {
  const s = String(name);
  if (engine === "postgres" && s.includes(".")) {
    const dot = s.indexOf(".");
    const schema = s.slice(0, dot);
    const table = s.slice(dot + 1);
    return quoteSegment(engine, schema) + "." + quoteSegment(engine, table);
  }
  return quoteSegment(engine, s);
}

/**
 * Build the bounded page SELECT for a SQL engine.
 *
 * We request `pageSize + 1` rows (the extra "probe" row) so the caller can
 * tell "there are more" without a COUNT: if pageSize+1 rows come back, there's
 * a next page and the probe row is dropped before display.
 *
 * IMPORTANT — this is fed to driver.runReadOnlyQuery, which itself wraps the
 * statement in `SELECT * FROM (<sql>) AS _q LIMIT maxRows+1`. That is why the
 * caller MUST pass maxRows >= pageSize+1 (see extension.js): otherwise the
 * outer wrap would clip below the page and break the probe-row signal.
 *
 * `LIMIT n OFFSET m` is uniform across postgres/mysql/sqlite; SQLite requires
 * OFFSET to FOLLOW LIMIT (which it does here) — never emit a bare OFFSET.
 */
function buildBoundedSelect(engine, tableName, { pageSize = DEFAULT_PAGE_SIZE, page = 0 } = {}) {
  const size = clampPageSize(pageSize);
  const from = quoteTableName(engine, tableName);
  const limit = size + 1; // probe row
  const offset = offsetFor(page, size);
  return `SELECT * FROM ${from} LIMIT ${limit} OFFSET ${offset}`;
}

// ---- cell serialization (transport shape for the webview) ------------------

/**
 * Serialize one DB/BSON cell value into a { kind, text } tag the webview
 * styles and truncates. Unlike query-guard.formatCell (which targets the model
 * and hex-dumps binary), this targets a human browsing their own data:
 *   - null/undefined     → { kind:"null" }
 *   - boolean            → { kind:"boolean" }
 *   - number/bigint      → { kind:"number" }
 *   - Buffer/typed array → { kind:"binary", text:"<binary N bytes>" }  (placeholder, never raw)
 *   - Date               → { kind:"date", ISO string }
 *   - object/array       → { kind:"json", compact JSON } (BSON ObjectId/Long/
 *                          Decimal128 etc. stringify via their toString/toJSON)
 *   - string             → { kind:"string" }
 * `text` is capped at maxLen chars (with an ellipsis + clipped flag) purely to
 * bound the message size.
 */
function serializeCell(value, maxLen = MAX_CELL_TRANSPORT) {
  let kind = "string";
  let s;
  if (value === null || value === undefined) {
    return { kind: "null", text: "NULL", clipped: false };
  } else if (typeof value === "boolean") {
    kind = "boolean";
    s = value ? "true" : "false";
  } else if (typeof value === "number") {
    kind = "number";
    s = String(value);
  } else if (typeof value === "bigint") {
    kind = "number";
    s = value.toString();
  } else if (value instanceof Date) {
    kind = "date";
    s = value.toISOString();
  } else if (isBinary(value)) {
    const n = binaryByteLength(value);
    return { kind: "binary", text: `<binary ${n} bytes>`, clipped: false };
  } else if (typeof value === "object") {
    // BSON scalars (ObjectId, Long, Decimal128) carry a meaningful toString();
    // a bare JSON.stringify of an ObjectId yields "{}" or a wrapped form, so
    // prefer a hex/string form when the object is clearly a scalar wrapper.
    const scalar = bsonScalarString(value);
    if (scalar !== null) {
      kind = "string";
      s = scalar;
    } else {
      kind = "json";
      try {
        s = JSON.stringify(value);
      } catch {
        s = String(value);
      }
    }
  } else {
    kind = "string";
    s = String(value);
  }
  if (s.length > maxLen) {
    return { kind, text: s.slice(0, maxLen) + "…", clipped: true };
  }
  return { kind, text: s, clipped: false };
}

function isBinary(v) {
  return (
    (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) ||
    v instanceof Uint8Array ||
    v instanceof ArrayBuffer ||
    // node-mongodb Binary has _bsontype "Binary"
    (v && typeof v === "object" && v._bsontype === "Binary")
  );
}

function binaryByteLength(v) {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return v.length;
  if (v instanceof Uint8Array) return v.length;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (v && typeof v === "object") {
    if (typeof v.length === "function") {
      try {
        return v.length();
      } catch {
        /* fall through */
      }
    }
    if (typeof v.length === "number") return v.length;
    if (v.buffer && typeof v.buffer.length === "number") return v.buffer.length;
  }
  return 0;
}

/** If `v` is a BSON scalar wrapper (ObjectId, Long, Decimal128, Timestamp),
 * return its string form; otherwise null (meaning "treat as a nested object").
 * We detect by the mongodb driver's `_bsontype` tag so plain objects and
 * arrays still render as JSON. */
function bsonScalarString(v) {
  if (!v || typeof v !== "object") return null;
  const t = v._bsontype;
  if (!t) return null;
  const SCALAR = new Set(["ObjectId", "ObjectID", "Long", "Decimal128", "Double", "Int32", "Timestamp", "UUID"]);
  if (SCALAR.has(t) && typeof v.toString === "function") {
    try {
      return v.toString();
    } catch {
      return null;
    }
  }
  return null;
}

// ---- SQL page shaping ------------------------------------------------------

/**
 * Turn a driver.runReadOnlyQuery result (columns + rows-as-arrays, where the
 * probe row may make rows.length === pageSize+1) into the webview payload:
 * drop the probe row, serialize every cell, and report hasMore.
 */
function shapeSqlPage({ columns = [], rows = [], pageSize = DEFAULT_PAGE_SIZE, page = 0, maxCellLen = MAX_CELL_TRANSPORT }) {
  const size = clampPageSize(pageSize);
  const hasMore = rows.length > size;
  const pageRows = hasMore ? rows.slice(0, size) : rows;
  const shaped = pageRows.map((row) => (Array.isArray(row) ? row : [row]).map((c) => serializeCell(c, maxCellLen)));
  return { columns: columns.map((c) => String(c)), rows: shaped, page: clampPage(page), pageSize: size, hasMore };
}

// ---- Mongo document shaping ------------------------------------------------

/**
 * Flatten a Mongo document's TOP-LEVEL fields for the table view: scalar
 * fields keep their value; nested objects/arrays become one compact-JSON cell
 * (they are NOT recursively exploded into more columns). Returns a Map so key
 * order is preserved for column discovery.
 */
function flattenMongoDoc(doc) {
  const out = new Map();
  if (!doc || typeof doc !== "object") return out;
  for (const key of Object.keys(doc)) {
    out.set(key, doc[key]);
  }
  return out;
}

/**
 * Turn a page of Mongo documents (docs.length may be pageSize+1 including the
 * probe) into the same webview payload shape as shapeSqlPage. Columns are the
 * UNION of top-level keys across the page, in first-seen order (with `_id`
 * pulled to the front when present). A document missing a column renders as a
 * NULL cell.
 */
function shapeMongoPage({ docs = [], pageSize = DEFAULT_PAGE_SIZE, page = 0, maxCellLen = MAX_CELL_TRANSPORT }) {
  const size = clampPageSize(pageSize);
  const hasMore = docs.length > size;
  const pageDocs = hasMore ? docs.slice(0, size) : docs;

  const flat = pageDocs.map((d) => flattenMongoDoc(d));
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
  // Conventionally show _id first.
  if (seen.has("_id")) {
    const rest = columns.filter((c) => c !== "_id");
    columns.length = 0;
    columns.push("_id", ...rest);
  }

  const rows = flat.map((m) =>
    columns.map((col) => (m.has(col) ? serializeCell(m.get(col), maxCellLen) : { kind: "null", text: "NULL", clipped: false })),
  );
  return { columns, rows, page: clampPage(page), pageSize: size, hasMore };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_CELL_TRANSPORT,
  clampPageSize,
  clampPage,
  offsetFor,
  quoteSegment,
  quoteTableName,
  buildBoundedSelect,
  serializeCell,
  shapeSqlPage,
  flattenMongoDoc,
  shapeMongoPage,
};
