// Unit tests for the pure query-safety helpers (lib/query-guard.js): the
// statement allowlist (Layer 2 / SECONDARY), the row-cap clamp + wrapper, and
// the §5 result formatter. No I/O, no vscode.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  classifyStatement,
  isWrappable,
  wrapWithRowLimit,
  clampMaxRows,
  formatCell,
  formatResultText,
  QueryRejectedError,
  DEFAULT_MAX_ROWS,
  HARD_MAX_ROWS,
  parseMongoQuerySpec,
} = require("../lib/query-guard.js");

// ---------- allowlist: accepts ----------

test("classifyStatement accepts leading SELECT / WITH…SELECT / SHOW / EXPLAIN", () => {
  assert.equal(classifyStatement("SELECT * FROM users").kind, "select");
  assert.equal(classifyStatement("  select 1").kind, "select");
  assert.equal(classifyStatement("WITH t AS (SELECT 1) SELECT * FROM t").kind, "with");
  assert.equal(classifyStatement("SHOW TABLES").kind, "show");
  assert.equal(classifyStatement("SHOW CREATE TABLE users").kind, "show"); // "CREATE" must NOT trip the scan for SHOW
  assert.equal(classifyStatement("EXPLAIN SELECT * FROM users").kind, "explain");
  assert.equal(classifyStatement("EXPLAIN ANALYZE SELECT * FROM users").kind, "explain");
  assert.equal(classifyStatement("-- a comment\nSELECT 1").kind, "select"); // leading comment tolerated
});

test("classifyStatement does not reject write-keyword substrings inside string literals or identifiers", () => {
  // 'DELETE' here is data, not a statement — stripping literals first prevents the false reject.
  assert.equal(classifyStatement("SELECT * FROM orders WHERE status = 'DELETE'").kind, "select");
  assert.equal(classifyStatement("SELECT id FROM t WHERE note = 'please UPDATE me'").kind, "select");
});

// ---------- allowlist: rejects ----------

for (const [name, sql] of [
  ["INSERT", "INSERT INTO t VALUES (1)"],
  ["UPDATE", "UPDATE t SET x = 1"],
  ["DELETE", "DELETE FROM t"],
  ["DROP", "DROP TABLE t"],
  ["ALTER", "ALTER TABLE t ADD c int"],
  ["TRUNCATE", "TRUNCATE t"],
  ["GRANT", "GRANT ALL ON t TO u"],
  ["CREATE", "CREATE TABLE t (x int)"],
  ["REPLACE", "REPLACE INTO t VALUES (1)"],
  ["MERGE", "MERGE INTO t USING s ON (1=1)"],
  ["CALL", "CALL do_thing()"],
  ["COPY", "COPY t TO '/tmp/x'"],
  ["bare non-read verb", "VACUUM"],
]) {
  test(`classifyStatement rejects ${name}`, () => {
    assert.throws(() => classifyStatement(sql), QueryRejectedError);
  });
}

test("classifyStatement rejects multi-statement / stacked input (a trailing ; alone is fine)", () => {
  assert.equal(classifyStatement("SELECT 1;").kind, "select"); // single trailing ; tolerated
  assert.throws(() => classifyStatement("SELECT 1; DROP TABLE t"), QueryRejectedError);
  assert.throws(() => classifyStatement("SELECT 1; SELECT 2"), QueryRejectedError);
});

test("classifyStatement blocks the sneaky write-in-a-CTE (WITH x AS (DELETE…) SELECT …)", () => {
  assert.throws(
    () => classifyStatement("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"),
    QueryRejectedError,
  );
  assert.throws(
    () => classifyStatement("WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x"),
    QueryRejectedError,
  );
});

test("classifyStatement rejects EXPLAIN of a write statement", () => {
  assert.throws(() => classifyStatement("EXPLAIN DELETE FROM t"), QueryRejectedError);
  assert.throws(() => classifyStatement("EXPLAIN ANALYZE UPDATE t SET x=1"), QueryRejectedError);
});

test("classifyStatement DOCUMENTED GAP: cannot see a write hidden in a function call (that's why Layer 1 exists)", () => {
  // The allowlist is SECONDARY. `SELECT volatile_writing_fn()` passes it —
  // only the DB-enforced read-only transaction stops the actual write. This
  // test pins the known limitation rather than pretending it's caught.
  assert.equal(classifyStatement("SELECT some_writing_function()").kind, "select");
});

// ---------- row-cap clamp + wrapper ----------

test("clampMaxRows defaults, floors, and clamps to [1, HARD_MAX_ROWS]", () => {
  assert.equal(clampMaxRows(undefined), DEFAULT_MAX_ROWS);
  assert.equal(clampMaxRows(0), DEFAULT_MAX_ROWS);
  assert.equal(clampMaxRows(-5), DEFAULT_MAX_ROWS);
  assert.equal(clampMaxRows("abc"), DEFAULT_MAX_ROWS);
  assert.equal(clampMaxRows(10), 10);
  assert.equal(clampMaxRows(12.9), 12);
  assert.equal(clampMaxRows(999999), HARD_MAX_ROWS);
});

test("wrapWithRowLimit wraps in a subquery (not string-appended) and strips a trailing ;", () => {
  const wrapped = wrapWithRowLimit("SELECT a FROM t UNION SELECT a FROM u;", 51);
  assert.match(wrapped, /^SELECT \* FROM \(/);
  assert.match(wrapped, /\) AS _q LIMIT 51$/);
  assert.equal(wrapped.includes(";"), false); // trailing ; removed before wrapping
});

test("isWrappable is true only for SELECT/WITH (SHOW/EXPLAIN get a cursor cap instead)", () => {
  assert.equal(isWrappable("select"), true);
  assert.equal(isWrappable("with"), true);
  assert.equal(isWrappable("show"), false);
  assert.equal(isWrappable("explain"), false);
});

// ---------- formatCell ----------

test("formatCell stringifies types with a length cap", () => {
  assert.deepEqual(formatCell(null), { text: "NULL", clipped: false });
  assert.deepEqual(formatCell(undefined), { text: "NULL", clipped: false });
  assert.deepEqual(formatCell(42), { text: "42", clipped: false });
  assert.deepEqual(formatCell(10n), { text: "10", clipped: false });
  assert.deepEqual(formatCell({ a: 1 }), { text: '{"a":1}', clipped: false });
  assert.equal(formatCell(new Date("2020-01-02T03:04:05.000Z")).text, "2020-01-02T03:04:05.000Z");
  const big = formatCell("x".repeat(1000), 500);
  assert.equal(big.clipped, true);
  assert.equal(big.text.length, 501); // 500 chars + the "…"
});

// ---------- result formatter (§5) ----------

test("formatResultText renders the §5 block: label + db, read-only marker, columns, rows", () => {
  const text = formatResultText({
    engineLabel: "SQLite",
    databaseName: "app.db",
    columns: ["id", "email"],
    rows: [
      [1, "a@x.com"],
      [2, null],
    ],
    rowCount: 2,
    truncated: false,
    maxRows: 50,
  });
  assert.match(text, /Connection: SQLite — app\.db  \(read-only transaction, rolled back\)/);
  assert.match(text, /Columns: id, email/);
  assert.match(text, /Rows \(2 rows\):/);
  assert.match(text, /1 \| a@x\.com/);
  assert.match(text, /2 \| NULL/); // null renders as NULL, not blank
});

test("formatResultText surfaces the row-cap truncation explicitly", () => {
  const text = formatResultText({
    engineLabel: "PostgreSQL",
    databaseName: "shop",
    columns: ["id"],
    rows: [[1], [2], [3]],
    rowCount: 3,
    truncated: true,
    maxRows: 3,
  });
  assert.match(text, /showing first 3; more rows exist and were not fetched — capped at 3/);
  assert.match(text, /Row limit reached/);
});

test("formatResultText surfaces per-cell truncation as its own line (never silent)", () => {
  const text = formatResultText({
    engineLabel: "MySQL",
    databaseName: "d",
    columns: ["blob"],
    rows: [["y".repeat(2000)]],
    rowCount: 1,
    truncated: false,
    maxRows: 50,
    maxCellLen: 100,
  });
  assert.match(text, /Some cell values were truncated to 100 characters\./);
});

test("formatResultText handles the zero-row case", () => {
  const text = formatResultText({
    engineLabel: "SQLite",
    databaseName: "d",
    columns: ["id"],
    rows: [],
    rowCount: 0,
    truncated: false,
    maxRows: 50,
  });
  assert.match(text, /Rows \(0 rows\):/);
  assert.match(text, /\(no rows\)/);
});

// ---------- formatResultText: readOnlyNote override (Mongo) ----------

test("formatResultText: readOnlyNote overrides the header's read-only phrase (Mongo)", () => {
  const text = formatResultText({
    engineLabel: "MongoDB",
    databaseName: "shop",
    columns: ["_id", "name"],
    rows: [["507f1f77bcf86cd799439011", "widget"]],
    rowCount: 1,
    truncated: false,
    maxRows: 50,
    readOnlyNote: "(find-only query — no writes, no aggregation)",
  });
  assert.match(text, /Connection: MongoDB — shop  \(find-only query — no writes, no aggregation\)/);
  assert.equal(text.includes("read-only transaction, rolled back"), false);
});

// ---------- Mongo query-spec guard (design §10) ----------

test("parseMongoQuerySpec: accepts a JSON string with collection + filter + limit", () => {
  const spec = parseMongoQuerySpec('{"collection":"users","filter":{"active":true},"limit":20}');
  assert.equal(spec.collection, "users");
  assert.deepEqual(spec.filter, { active: true });
  assert.equal(spec.limit, 20);
  assert.equal(spec.projection, undefined);
  assert.equal(spec.sort, undefined);
});

test("parseMongoQuerySpec: accepts an already-parsed object (same-process callers)", () => {
  const spec = parseMongoQuerySpec({ collection: "orders", sort: { createdAt: -1 } });
  assert.equal(spec.collection, "orders");
  assert.deepEqual(spec.filter, {}, "filter defaults to {} when absent");
  assert.deepEqual(spec.sort, { createdAt: -1 });
});

test("parseMongoQuerySpec: accepts projection alongside filter", () => {
  const spec = parseMongoQuerySpec({ collection: "users", filter: {}, projection: { name: 1, _id: 0 } });
  assert.deepEqual(spec.projection, { name: 1, _id: 0 });
});

test("parseMongoQuerySpec: rejects a non-JSON string", () => {
  assert.throws(() => parseMongoQuerySpec("db.users.find()"), QueryRejectedError);
  assert.throws(() => parseMongoQuerySpec("db.users.find()"), /not valid JSON/);
});

test("parseMongoQuerySpec: rejects an empty string", () => {
  assert.throws(() => parseMongoQuerySpec(""), /Empty Mongo query/);
  assert.throws(() => parseMongoQuerySpec("   "), /Empty Mongo query/);
});

test("parseMongoQuerySpec: rejects JSON that isn't an object (array, string, number)", () => {
  assert.throws(() => parseMongoQuerySpec("[1,2,3]"), QueryRejectedError);
  assert.throws(() => parseMongoQuerySpec('"users"'), QueryRejectedError);
  assert.throws(() => parseMongoQuerySpec("42"), QueryRejectedError);
});

test("parseMongoQuerySpec: rejects a missing or blank collection field", () => {
  assert.throws(() => parseMongoQuerySpec({ filter: {} }), /collection/);
  assert.throws(() => parseMongoQuerySpec({ collection: "" }), /collection/);
  assert.throws(() => parseMongoQuerySpec({ collection: "   " }), /collection/);
  assert.throws(() => parseMongoQuerySpec({ collection: 42 }), /collection/);
});

test("parseMongoQuerySpec: refuses a system.* collection", () => {
  assert.throws(() => parseMongoQuerySpec({ collection: "system.users" }), /system collection/);
});

test("parseMongoQuerySpec: rejects a non-object filter/projection/sort", () => {
  assert.throws(() => parseMongoQuerySpec({ collection: "users", filter: "active" }), /"filter" must be a JSON object/);
  assert.throws(() => parseMongoQuerySpec({ collection: "users", projection: "name" }), /"projection" must be a JSON object/);
  assert.throws(() => parseMongoQuerySpec({ collection: "users", sort: "name" }), /"sort" must be a JSON object/);
});

test("parseMongoQuerySpec: rejects a non-positive limit", () => {
  assert.throws(() => parseMongoQuerySpec({ collection: "users", limit: 0 }), /"limit" must be a positive number/);
  assert.throws(() => parseMongoQuerySpec({ collection: "users", limit: -5 }), /"limit" must be a positive number/);
  assert.throws(() => parseMongoQuerySpec({ collection: "users", limit: "abc" }), /"limit" must be a positive number/);
});

test("parseMongoQuerySpec: rejects top-level update operators in the filter (defense in depth)", () => {
  for (const op of ["$set", "$inc", "$unset", "$currentDate", "$rename", "$push", "$pull", "$addToSet", "$bit"]) {
    assert.throws(
      () => parseMongoQuerySpec({ collection: "users", filter: { [op]: { x: 1 } } }),
      QueryRejectedError,
      `expected ${op} to be rejected`,
    );
  }
});

test("parseMongoQuerySpec: rejects aggregation side-effect stage names and $where even though only find() ever runs", () => {
  assert.throws(() => parseMongoQuerySpec({ collection: "users", filter: { $out: "other" } }), /\$out/);
  assert.throws(() => parseMongoQuerySpec({ collection: "users", filter: { $merge: "other" } }), /\$merge/);
  assert.throws(() => parseMongoQuerySpec({ collection: "users", filter: { $where: "1==1" } }), /\$where/);
});

test("parseMongoQuerySpec: rejects a mutating operator nested inside $and/$or", () => {
  const nested = { collection: "users", filter: { $and: [{ active: true }, { $set: { admin: true } }] } };
  assert.throws(() => parseMongoQuerySpec(nested), QueryRejectedError);
  assert.throws(() => parseMongoQuerySpec(nested), /\$set/);
});

test("parseMongoQuerySpec: a legitimate nested filter (no mutating keys) is accepted", () => {
  const spec = parseMongoQuerySpec({
    collection: "users",
    filter: { $and: [{ active: true }, { $or: [{ age: { $gt: 18 } }, { vip: true }] }] },
  });
  assert.equal(spec.collection, "users");
});
