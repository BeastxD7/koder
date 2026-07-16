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
