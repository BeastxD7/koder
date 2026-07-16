// Tests for each SQL driver's runReadOnlyQuery (db_query feature).
//
//  - Postgres / MySQL: no live server was reachable during development, so
//    these use a FAKE client/connection that records the exact command
//    sequence. What's proven: the read-only transaction is opened, the
//    timeout is set, the query is wrapped, and the transaction is ROLLED BACK
//    in `finally` even when the query throws. (Actual read-only ENFORCEMENT
//    rests on the Postgres/MySQL docs — see the driver headers.)
//  - SQLite: fully LIVE end-to-end against a temp file via built-in
//    node:sqlite, including an INDEPENDENT proof that the read-only OPEN
//    (Layer 1) rejects a write, separate from the allowlist (Layer 2).
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pg = require("../lib/drivers/postgres.js");
const mysqlDriver = require("../lib/drivers/mysql.js");
const sqlite = require("../lib/drivers/sqlite.js");
const { QueryRejectedError } = require("../lib/query-guard.js");

// ---------- Postgres: command sequence + rollback-in-finally (mock) ----------

function fakePgClient({ throwOnQuery = false } = {}) {
  const commands = [];
  return {
    commands,
    async query(arg) {
      const text = typeof arg === "string" ? arg : arg.text;
      commands.push(text);
      if (/^SELECT current_database/i.test(text)) return { rows: [{ db: "testdb" }] };
      if (/^SELECT \* FROM \(/i.test(text)) {
        if (throwOnQuery) throw new Error("boom during query");
        return { fields: [{ name: "id" }, { name: "email" }], rows: [[1, "a@x.com"], [2, "b@x.com"]] };
      }
      return {};
    },
  };
}

test("pg runReadOnlyWithClient: BEGIN READ ONLY → SET LOCAL timeout → wrapped query → ROLLBACK, maps rows", async () => {
  const client = fakePgClient();
  const res = await pg.runReadOnlyWithClient(client, "SELECT id, email FROM users", {
    maxRows: 50,
    timeoutMs: 5000,
    kind: "select",
  });
  assert.equal(client.commands[0], "BEGIN TRANSACTION READ ONLY");
  assert.equal(client.commands[1], "SET LOCAL statement_timeout = 5000");
  assert.match(client.commands[2], /^SELECT current_database/);
  assert.match(client.commands[3], /^SELECT \* FROM \(/); // wrapped, not string-appended
  assert.match(client.commands[3], /LIMIT 51$/); // maxRows + 1
  assert.equal(client.commands[client.commands.length - 1], "ROLLBACK");

  assert.deepEqual(res.columns, ["id", "email"]);
  assert.deepEqual(res.rows, [[1, "a@x.com"], [2, "b@x.com"]]);
  assert.equal(res.rowCount, 2);
  assert.equal(res.truncated, false);
  assert.equal(res.databaseName, "testdb");
});

test("pg runReadOnlyWithClient: still ROLLBACKs when the query throws", async () => {
  const client = fakePgClient({ throwOnQuery: true });
  await assert.rejects(
    () => pg.runReadOnlyWithClient(client, "SELECT * FROM users", { maxRows: 50, timeoutMs: 5000, kind: "select" }),
    /boom during query/,
  );
  assert.equal(client.commands.includes("BEGIN TRANSACTION READ ONLY"), true);
  assert.equal(client.commands[client.commands.length - 1], "ROLLBACK", "rollback must run in finally on error");
});

test("pg runReadOnlyWithClient: sets truncated when more than maxRows come back", async () => {
  const client = {
    commands: [],
    async query(arg) {
      const text = typeof arg === "string" ? arg : arg.text;
      this.commands.push(text);
      if (/current_database/i.test(text)) return { rows: [{ db: "d" }] };
      if (/^SELECT \* FROM \(/i.test(text)) return { fields: [{ name: "n" }], rows: [[1], [2], [3]] };
      return {};
    },
  };
  const res = await pg.runReadOnlyWithClient(client, "SELECT n FROM t", { maxRows: 2, timeoutMs: 5000, kind: "select" });
  assert.equal(res.truncated, true);
  assert.equal(res.rowCount, 2);
  assert.deepEqual(res.rows, [[1], [2]]);
});

test("pg runReadOnlyQuery rejects a write via the allowlist before opening a connection", async () => {
  // No connection is attempted because classifyStatement throws first.
  await assert.rejects(() => pg.runReadOnlyQuery("postgres://x/y", "DELETE FROM t"), QueryRejectedError);
});

// ---------- MySQL: command sequence + rollback-in-finally (mock) ----------

function fakeMysqlConn({ throwOnQuery = false } = {}) {
  const commands = [];
  return {
    commands,
    async query(arg) {
      const sql = typeof arg === "string" ? arg : arg.sql;
      commands.push(sql);
      if (/^SELECT DATABASE/i.test(sql)) return [[{ db: "testdb" }], [{ name: "db" }]];
      if (/^SELECT \* FROM \(/i.test(sql)) {
        if (throwOnQuery) throw new Error("mysql boom");
        return [[[1, "a"], [2, "b"]], [{ name: "id" }, { name: "name" }]];
      }
      return [[], []];
    },
  };
}

test("mysql runReadOnlyWithConnection: START TXN READ ONLY → max_execution_time → wrapped query → ROLLBACK", async () => {
  const conn = fakeMysqlConn();
  const res = await mysqlDriver.runReadOnlyWithConnection(conn, "SELECT id, name FROM users", {
    maxRows: 50,
    timeoutMs: 5000,
    kind: "select",
  });
  assert.equal(conn.commands[0], "START TRANSACTION READ ONLY");
  assert.equal(conn.commands[1], "SET SESSION max_execution_time = 5000");
  assert.match(conn.commands[2], /^SELECT DATABASE/);
  assert.match(conn.commands[3], /^SELECT \* FROM \(/);
  assert.match(conn.commands[3], /LIMIT 51$/);
  assert.equal(conn.commands[conn.commands.length - 1], "ROLLBACK");

  assert.deepEqual(res.columns, ["id", "name"]);
  assert.deepEqual(res.rows, [[1, "a"], [2, "b"]]);
  assert.equal(res.databaseName, "testdb");
});

test("mysql runReadOnlyWithConnection: still ROLLBACKs when the query throws", async () => {
  const conn = fakeMysqlConn({ throwOnQuery: true });
  await assert.rejects(
    () => mysqlDriver.runReadOnlyWithConnection(conn, "SELECT * FROM t", { maxRows: 50, timeoutMs: 5000, kind: "select" }),
    /mysql boom/,
  );
  assert.equal(conn.commands[conn.commands.length - 1], "ROLLBACK");
});

// ---------- SQLite: LIVE end-to-end ----------

function tempDbWith(rows) {
  const { DatabaseSync } = require("node:sqlite");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lakshx-db-")), "test.db");
  const db = new DatabaseSync(file); // read-write for setup only
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  const insert = db.prepare("INSERT INTO items (id, name) VALUES (?, ?)");
  for (let i = 1; i <= rows; i++) insert.run(i, `item-${i}`);
  db.close();
  return file;
}

test("sqlite runReadOnlyQuery: LIVE SELECT returns real rows and columns", async () => {
  const file = tempDbWith(5);
  const res = await sqlite.runReadOnlyQuery(file, "SELECT id, name FROM items ORDER BY id");
  assert.deepEqual(res.columns, ["id", "name"]);
  assert.equal(res.rowCount, 5);
  assert.equal(res.truncated, false);
  assert.deepEqual(res.rows[0], [1, "item-1"]);
  assert.equal(res.databaseName, "test.db");
});

test("sqlite runReadOnlyQuery: LIVE row cap truncates at maxRows and flags truncated", async () => {
  const file = tempDbWith(60);
  const res = await sqlite.runReadOnlyQuery(file, "SELECT id, name FROM items", { maxRows: 50 });
  assert.equal(res.rowCount, 50);
  assert.equal(res.truncated, true);
});

test("sqlite runReadOnlyQuery: LIVE a write statement is rejected by the ALLOWLIST (Layer 2)", async () => {
  const file = tempDbWith(3);
  await assert.rejects(() => sqlite.runReadOnlyQuery(file, "DELETE FROM items"), QueryRejectedError);
});

test("sqlite: LIVE PROOF that the read-only OPEN itself (Layer 1) rejects a write, independent of the allowlist", () => {
  const { DatabaseSync } = require("node:sqlite");
  const file = tempDbWith(3);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    // This bypasses the allowlist entirely — the write is handed straight to
    // SQLite on a read-only handle. It must still be refused. This is the
    // PRIMARY control the whole design leans on.
    assert.throws(() => db.exec("DELETE FROM items"), /readonly|read-only|read only/i);
  } finally {
    db.close();
  }
});

// ---------- Mongo: command sequence + result shaping (fake client) ----------
//
// No live MongoDB was reachable during development (same situation as
// Postgres/MySQL above), so this exercises `runReadOnlyWithClient` — the
// pure function `runReadOnlyQuery` wraps around a real MongoClient — against
// a FAKE client/db/collection/cursor that records the exact find() call.
// What's proven: resolveDatabase's single-candidate fallback is used, find()
// is called with the filter/projection/sort/limit/maxTimeMS derived from the
// spec, results are shaped into {columns, rows} via top-level key union
// (mirroring data-browse.js's shapeMongoPage discovery rule), and the
// row-cap/truncation signal matches the SQL drivers'.

const mongoDriver = require("../lib/drivers/mongo.js");
const { parseMongoQuerySpec: parseSpec } = require("../lib/query-guard.js");

/** A fake MongoClient whose `admin().listDatabases()` always throws (as it
 * does for a least-privilege user without clusterMonitor) — this exercises
 * resolveDatabase's "fall back to the connection string's default database"
 * branch, the same one a single-database connection hits in practice, with
 * no interactive picker involved (matching runReadOnlyWithClient's
 * `pick: async () => null`, since there's no human in an AI tool call). */
function fakeMongoClient({ docs = [], dbName = "shop" } = {}) {
  const calls = { find: [], collectionName: null };
  const dbHandle = {
    databaseName: dbName,
    admin: () => ({
      listDatabases: async () => {
        throw new Error("not authorized to list databases");
      },
    }),
    collection(name) {
      calls.collectionName = name;
      return {
        find(filter, opts) {
          calls.find.push({ filter, opts });
          return { toArray: async () => docs };
        },
      };
    },
  };
  return {
    calls,
    db: () => dbHandle, // always the connection-string default — no multi-db picking in these tests
    async close() {},
  };
}

test("mongo runReadOnlyWithClient: single-database connection needs no picker; find() gets filter/projection/sort/limit+1/maxTimeMS", async () => {
  const client = fakeMongoClient({
    docs: [
      { _id: "1", name: "widget", active: true },
      { _id: "2", name: "gadget", active: true },
    ],
  });

  const spec = parseSpec({ collection: "widgets", filter: { active: true }, projection: { name: 1 }, sort: { name: 1 }, limit: 10 });
  const res = await mongoDriver.runReadOnlyWithClient(client, spec, { maxRows: 50, timeoutMs: 4000 });

  assert.equal(client.calls.collectionName, "widgets");
  assert.equal(client.calls.find.length, 1);
  assert.deepEqual(client.calls.find[0].filter, { active: true });
  assert.deepEqual(client.calls.find[0].opts.projection, { name: 1 });
  assert.deepEqual(client.calls.find[0].opts.sort, { name: 1 });
  assert.equal(client.calls.find[0].opts.limit, 11); // spec.limit(10), NOT maxRows(50), is the tighter cap: +1 probe
  assert.equal(client.calls.find[0].opts.maxTimeMS, 4000);

  assert.deepEqual(res.columns, ["_id", "name", "active"]); // _id pulled to front
  assert.deepEqual(res.rows, [
    ["1", "widget", true],
    ["2", "gadget", true],
  ]);
  assert.equal(res.rowCount, 2);
  assert.equal(res.truncated, false);
  assert.equal(res.databaseName, "shop");
});

test("mongo runReadOnlyWithClient: maxRows is the hard ceiling even when the spec's own limit is larger", async () => {
  const client = fakeMongoClient({ docs: [{ _id: "1" }] });
  const spec = parseSpec({ collection: "widgets", limit: 5000 });
  await mongoDriver.runReadOnlyWithClient(client, spec, { maxRows: 50 });
  assert.equal(client.calls.find[0].opts.limit, 51, "capped at maxRows(50)+1, not spec.limit(5000)+1");
});

test("mongo runReadOnlyWithClient: truncates at the effective limit and flags truncated", async () => {
  const docs = Array.from({ length: 4 }, (_, i) => ({ _id: String(i), n: i }));
  const client = fakeMongoClient({ docs });
  const spec = parseSpec({ collection: "widgets", limit: 3 });
  const res = await mongoDriver.runReadOnlyWithClient(client, spec, { maxRows: 50 });
  // fake cursor ignores `limit` and always returns all 4 docs — proves the
  // driver-side slice (not the fake) performs the cap/truncation signal.
  assert.equal(res.truncated, true);
  assert.equal(res.rowCount, 3);
  assert.deepEqual(res.rows.map((r) => r[0]), ["0", "1", "2"]);
});

test("mongo runReadOnlyWithClient: a document missing a column gets NULL, union of keys across the page", async () => {
  const client = fakeMongoClient({
    docs: [
      { _id: "1", name: "a" },
      { _id: "2", email: "b@x.com" },
    ],
  });
  const spec = parseSpec({ collection: "widgets" });
  const res = await mongoDriver.runReadOnlyWithClient(client, spec, { maxRows: 50 });
  assert.deepEqual(res.columns, ["_id", "name", "email"]);
  assert.deepEqual(res.rows, [
    ["1", "a", null],
    ["2", null, "b@x.com"],
  ]);
});

test("mongo runReadOnlyQuery: rejects a spec with a mutating operator BEFORE opening a connection", async () => {
  await assert.rejects(
    () => mongoDriver.runReadOnlyQuery("mongodb://x/y", JSON.stringify({ collection: "users", filter: { $set: { admin: true } } })),
    QueryRejectedError,
  );
});

test("mongo shapeDocsForResult: flattens top-level fields only (nested objects stay as one cell)", () => {
  const { columns, rows } = mongoDriver.shapeDocsForResult([{ _id: "1", address: { city: "NYC" }, tags: ["a", "b"] }]);
  assert.deepEqual(columns, ["_id", "address", "tags"]);
  assert.deepEqual(rows[0][1], { city: "NYC" }); // raw value — formatCell (query-guard.js) does the JSON.stringify for display
  assert.deepEqual(rows[0][2], ["a", "b"]);
});
