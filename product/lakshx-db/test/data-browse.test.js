// Tests for the DATA-BROWSING helpers (lib/data-browse.js) — the user reading
// rows from their OWN connected database (NOT the AI db_query tool, and NOT
// gated by the opt-in flag). Two layers:
//
//  1. Pure helpers (quoting, bounded-SELECT builder, cell serialization, page
//     shaping) — no I/O, node --test only.
//  2. A LIVE SQLite end-to-end pass: a temp .db with real rows driven through
//     buildBoundedSelect + the EXISTING driver.runReadOnlyQuery, proving the
//     page/probe/pagination invariant against the actual read-only path and
//     that a table name with hostile characters is safely quoted.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
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
  DEFAULT_PAGE_SIZE,
} = require("../lib/data-browse.js");
const { wrapWithRowLimit } = require("../lib/query-guard.js");
const sqlite = require("../lib/drivers/sqlite.js");

// ---------- clamps + offset ----------

test("clampPageSize/clampPage/offsetFor", () => {
  assert.equal(clampPageSize(undefined), DEFAULT_PAGE_SIZE);
  assert.equal(clampPageSize(0), DEFAULT_PAGE_SIZE);
  assert.equal(clampPageSize(-3), DEFAULT_PAGE_SIZE);
  assert.equal(clampPageSize(25), 25);
  assert.equal(clampPageSize(99999), 500); // hard cap
  assert.equal(clampPage(-1), 0);
  assert.equal(clampPage(2.9), 2);
  assert.equal(offsetFor(0, 50), 0);
  assert.equal(offsetFor(3, 50), 150);
});

// ---------- identifier quoting ----------

test("quoteSegment escapes the engine's quote char by doubling", () => {
  assert.equal(quoteSegment("postgres", "users"), '"users"');
  assert.equal(quoteSegment("sqlite", "users"), '"users"');
  assert.equal(quoteSegment("mysql", "users"), "`users`");
  // hostile names: a double-quote / backtick inside the identifier
  assert.equal(quoteSegment("postgres", 'we"ird'), '"we""ird"');
  assert.equal(quoteSegment("mysql", "we`ird"), "`we``ird`");
});

test("quoteTableName qualifies a dotted Postgres name; keeps others whole", () => {
  assert.equal(quoteTableName("postgres", "audit.events"), '"audit"."events"');
  assert.equal(quoteTableName("postgres", "users"), '"users"');
  // sqlite/mysql do not schema-split — a dotted name is quoted whole
  assert.equal(quoteTableName("sqlite", "a.b"), '"a.b"');
  assert.equal(quoteTableName("mysql", "a.b"), "`a.b`");
});

// ---------- bounded SELECT builder ----------

test("buildBoundedSelect: LIMIT pageSize+1 (probe) OFFSET page*pageSize, quoted table", () => {
  assert.equal(buildBoundedSelect("sqlite", "items", { pageSize: 50, page: 0 }), 'SELECT * FROM "items" LIMIT 51 OFFSET 0');
  assert.equal(buildBoundedSelect("sqlite", "items", { pageSize: 50, page: 2 }), 'SELECT * FROM "items" LIMIT 51 OFFSET 100');
  assert.equal(buildBoundedSelect("mysql", "orders", { pageSize: 10, page: 1 }), "SELECT * FROM `orders` LIMIT 11 OFFSET 10");
  assert.equal(
    buildBoundedSelect("postgres", "audit.events", { pageSize: 25, page: 0 }),
    'SELECT * FROM "audit"."events" LIMIT 26 OFFSET 0',
  );
});

test("buildBoundedSelect emits OFFSET *after* LIMIT (SQLite requires this ordering)", () => {
  const sql = buildBoundedSelect("sqlite", "t", { pageSize: 5, page: 1 });
  assert.match(sql, /LIMIT \d+ OFFSET \d+$/);
  assert.ok(sql.indexOf("LIMIT") < sql.indexOf("OFFSET"));
});

test("buildBoundedSelect safely quotes a hostile table name (no identifier break-out)", () => {
  // A table literally named  x" OR 1=1 --  cannot escape its quotes.
  const sql = buildBoundedSelect("sqlite", 'x" OR 1=1 --', { pageSize: 5, page: 0 });
  assert.equal(sql, 'SELECT * FROM "x"" OR 1=1 --" LIMIT 6 OFFSET 0');
});

// ---------- the load-bearing pagination invariant ----------
//
// buildBoundedSelect asks for pageSize+1 rows; the caller passes that same
// pageSize+1 as maxRows into driver.runReadOnlyQuery, which internally wraps
// with wrapWithRowLimit(sql, maxRows+1). The OUTER limit must be >= the inner
// probe limit, or the wrap would clip the probe row and silently break the
// "hasMore" signal. Pin it so a future change to wrapWithRowLimit is caught.
test("INVARIANT: read-only wrap's outer LIMIT never clips the page's probe row", () => {
  const pageSize = 50;
  const inner = buildBoundedSelect("sqlite", "items", { pageSize, page: 0 }); // LIMIT 51
  const maxRows = pageSize + 1; // what extension.js passes
  const wrapped = wrapWithRowLimit(inner, maxRows + 1); // what the driver does
  const outer = Number(wrapped.match(/LIMIT (\d+)$/)[1]);
  assert.equal(outer, pageSize + 2);
  assert.ok(outer >= pageSize + 1, "outer wrap must not clip the probe row");
});

// ---------- cell serialization ----------

test("serializeCell tags primitives, dates, binary placeholder, and nested JSON", () => {
  assert.deepEqual(serializeCell(null), { kind: "null", text: "NULL", clipped: false });
  assert.deepEqual(serializeCell(undefined), { kind: "null", text: "NULL", clipped: false });
  assert.deepEqual(serializeCell(true), { kind: "boolean", text: "true", clipped: false });
  assert.deepEqual(serializeCell(42), { kind: "number", text: "42", clipped: false });
  assert.deepEqual(serializeCell(10n), { kind: "number", text: "10", clipped: false });
  assert.equal(serializeCell(new Date("2020-01-02T03:04:05.000Z")).kind, "date");
  assert.equal(serializeCell(new Date("2020-01-02T03:04:05.000Z")).text, "2020-01-02T03:04:05.000Z");
  // Buffer / bytea → placeholder, never raw bytes
  assert.deepEqual(serializeCell(Buffer.from([1, 2, 3, 4])), { kind: "binary", text: "<binary 4 bytes>", clipped: false });
  assert.deepEqual(serializeCell(new Uint8Array(7)), { kind: "binary", text: "<binary 7 bytes>", clipped: false });
  // nested object / array → compact JSON
  assert.deepEqual(serializeCell({ a: 1, b: [2, 3] }), { kind: "json", text: '{"a":1,"b":[2,3]}', clipped: false });
  assert.equal(serializeCell([1, 2, 3]).kind, "json");
});

test("serializeCell stringifies BSON scalar wrappers via toString (not '{}')", () => {
  const fakeObjectId = { _bsontype: "ObjectId", toString: () => "507f1f77bcf86cd799439011" };
  assert.deepEqual(serializeCell(fakeObjectId), { kind: "string", text: "507f1f77bcf86cd799439011", clipped: false });
  const fakeDecimal = { _bsontype: "Decimal128", toString: () => "9.99" };
  assert.equal(serializeCell(fakeDecimal).text, "9.99");
  const fakeBinary = { _bsontype: "Binary", length: () => 16 };
  assert.deepEqual(serializeCell(fakeBinary), { kind: "binary", text: "<binary 16 bytes>", clipped: false });
});

test("serializeCell caps oversized text and flags clipped", () => {
  const out = serializeCell("z".repeat(3000), 2000);
  assert.equal(out.clipped, true);
  assert.equal(out.text.length, 2001); // 2000 + ellipsis
});

// ---------- SQL page shaping (probe-row / hasMore) ----------

test("shapeSqlPage drops the probe row and reports hasMore=true when it's present", () => {
  const rows = Array.from({ length: 51 }, (_, i) => [i, `name-${i}`]); // pageSize 50 + probe
  const out = shapeSqlPage({ columns: ["id", "name"], rows, pageSize: 50, page: 0 });
  assert.equal(out.hasMore, true);
  assert.equal(out.rows.length, 50); // probe dropped
  assert.deepEqual(out.columns, ["id", "name"]);
  assert.deepEqual(out.rows[0], [
    { kind: "number", text: "0", clipped: false },
    { kind: "string", text: "name-0", clipped: false },
  ]);
});

test("shapeSqlPage: exactly pageSize rows means no next page", () => {
  const rows = Array.from({ length: 50 }, (_, i) => [i]);
  const out = shapeSqlPage({ columns: ["id"], rows, pageSize: 50, page: 3 });
  assert.equal(out.hasMore, false);
  assert.equal(out.rows.length, 50);
  assert.equal(out.page, 3);
});

// ---------- Mongo document shaping ----------

test("flattenMongoDoc keeps top-level keys, does not recurse", () => {
  const m = flattenMongoDoc({ _id: 1, name: "x", meta: { a: 1 } });
  assert.deepEqual([...m.keys()], ["_id", "name", "meta"]);
  assert.deepEqual(m.get("meta"), { a: 1 });
});

test("shapeMongoPage: union columns (_id first), missing field → NULL cell, nested → JSON, probe drop", () => {
  const docs = [
    { _id: "a", name: "Alice", tags: ["x", "y"] },
    { _id: "b", age: 30 }, // no name/tags; has age
    { _id: "c", name: "Cara" }, // probe row (pageSize 2)
  ];
  const out = shapeMongoPage({ docs, pageSize: 2, page: 0 });
  assert.equal(out.hasMore, true);
  assert.equal(out.rows.length, 2); // probe dropped
  assert.deepEqual(out.columns, ["_id", "name", "tags", "age"]); // first-seen order, _id pinned first
  // row 0: name present, age missing → NULL
  const row0 = out.rows[0];
  assert.deepEqual(row0[0], { kind: "string", text: "a", clipped: false }); // _id
  assert.deepEqual(row0[1], { kind: "string", text: "Alice", clipped: false }); // name
  assert.deepEqual(row0[2], { kind: "json", text: '["x","y"]', clipped: false }); // tags → JSON
  assert.deepEqual(row0[3], { kind: "null", text: "NULL", clipped: false }); // age missing
  // row 1: name missing → NULL, age present
  assert.deepEqual(out.rows[1][1], { kind: "null", text: "NULL", clipped: false });
  assert.deepEqual(out.rows[1][3], { kind: "number", text: "30", clipped: false });
});

// ---------- LIVE SQLite end-to-end (builder + real read-only path) ----------

function tempDbWithTable(tableName, rowCount) {
  const { DatabaseSync } = require("node:sqlite");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lakshx-browse-")), "test.db");
  const db = new DatabaseSync(file); // read-write for setup only
  // The table name is spliced with the SAME quoting the browse builder uses,
  // so we can prove a hostile name round-trips through create → browse.
  const quoted = quoteTableName("sqlite", tableName);
  db.exec(`CREATE TABLE ${quoted} (id INTEGER PRIMARY KEY, name TEXT, blob_col BLOB)`);
  const insert = db.prepare(`INSERT INTO ${quoted} (id, name, blob_col) VALUES (?, ?, ?)`);
  for (let i = 1; i <= rowCount; i++) insert.run(i, `row-${i}`, null);
  db.close();
  return file;
}

test("LIVE sqlite: bounded browse page 0 returns pageSize rows + hasMore via the read-only path", async () => {
  const file = tempDbWithTable("items", 130);
  const pageSize = 50;

  const sql0 = buildBoundedSelect("sqlite", "items", { pageSize, page: 0 });
  const res0 = await sqlite.runReadOnlyQuery(file, sql0, { maxRows: pageSize + 1 });
  const page0 = shapeSqlPage({ columns: res0.columns, rows: res0.rows, pageSize, page: 0 });
  assert.deepEqual(page0.columns, ["id", "name", "blob_col"]);
  assert.equal(page0.rows.length, 50);
  assert.equal(page0.hasMore, true); // 130 rows > 50
  assert.equal(page0.rows[0][0].text, "1");
  assert.equal(page0.rows[0][1].text, "row-1");

  // page 2 (OFFSET 100) → rows 101..130 = 30 rows, no more.
  const sql2 = buildBoundedSelect("sqlite", "items", { pageSize, page: 2 });
  const res2 = await sqlite.runReadOnlyQuery(file, sql2, { maxRows: pageSize + 1 });
  const page2 = shapeSqlPage({ columns: res2.columns, rows: res2.rows, pageSize, page: 2 });
  assert.equal(page2.rows.length, 30);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.rows[0][0].text, "101");
  assert.equal(page2.rows[29][0].text, "130");
});

test("LIVE sqlite: a table name containing a double-quote is safely quoted and browsable", async () => {
  // The quote is doubled by the builder, round-trips through CREATE and the
  // real read-only path, and cannot break out of its identifier position.
  const weird = 'we"ird table';
  const file = tempDbWithTable(weird, 3);
  const sql = buildBoundedSelect("sqlite", weird, { pageSize: 50, page: 0 });
  assert.equal(sql, 'SELECT * FROM "we""ird table" LIMIT 51 OFFSET 0');
  const res = await sqlite.runReadOnlyQuery(file, sql, { maxRows: 51 });
  const page = shapeSqlPage({ columns: res.columns, rows: res.rows, pageSize: 50, page: 0 });
  assert.equal(page.rows.length, 3);
  assert.equal(page.hasMore, false);
  assert.equal(page.rows[0][1].text, "row-1");
});

test("DOCUMENTED fail-safe: a table name containing '--' or ';' is REJECTED by the shared allowlist (banner error, never injection)", async () => {
  // The read-only path's classifyStatement strips `--` line-comments BEFORE
  // quoted identifiers, so an identifier containing a comment marker or ';'
  // trips the single-statement guard and is refused. This is fail-SAFE: the
  // quoting already neutralizes injection (proven above); the worst outcome
  // for such an exotic name is a "query failed" banner, not a write. We pin it
  // so the behavior is understood rather than surprising.
  const { QueryRejectedError } = require("../lib/query-guard.js");
  const file = tempDbWithTable("plain", 1); // a real db to open; the name below is the one browsed
  const sql = buildBoundedSelect("sqlite", 'x"; DROP TABLE y --', { pageSize: 50, page: 0 });
  await assert.rejects(() => sqlite.runReadOnlyQuery(file, sql, { maxRows: 51 }), QueryRejectedError);
});
