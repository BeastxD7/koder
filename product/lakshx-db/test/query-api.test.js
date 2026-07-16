// Unit tests for the exported runReadOnlyQuery orchestrator (lib/query-api.js)
// with every vscode-backed dependency mocked. Proves the opt-in gate refuses
// BEFORE the secret is read, engine validation, the no-secret path, the
// happy-path formatting, and that it never throws across the boundary.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRunReadOnlyQuery } = require("../lib/query-api.js");
const { redactText } = require("../lib/redact.js");

function makeDriver(overrides = {}) {
  return {
    label: "SQLite",
    secretKey: "lakshx.db.sqlite.path",
    async runReadOnlyQuery() {
      return { columns: ["id"], rows: [[1]], rowCount: 1, truncated: false, databaseName: "app.db" };
    },
    ...overrides,
  };
}

function harness({ allowed = true, secret = "/tmp/app.db", driver = makeDriver() } = {}) {
  const calls = { getSecret: 0, isAiQueriesAllowed: 0, driverRun: 0 };
  const run = createRunReadOnlyQuery({
    getDriver: () => driver,
    getSecret: async (key) => {
      calls.getSecret++;
      calls.lastSecretKey = key;
      return secret;
    },
    isAiQueriesAllowed: async () => {
      calls.isAiQueriesAllowed++;
      return allowed;
    },
    redactText,
    timeoutMs: 5000,
  });
  return { run, calls };
}

test("opt-in gate: when the flag is OFF it refuses BEFORE the secret is read", async () => {
  const { run, calls } = harness({ allowed: false });
  const res = await run("sqlite", "SELECT 1");
  assert.equal(res.isError, true);
  assert.match(res.text, /not allowed for AI queries/);
  assert.match(res.text, /Allow AI queries/);
  assert.equal(calls.isAiQueriesAllowed, 1);
  assert.equal(calls.getSecret, 0, "the secret must NOT be read when not opted in");
});

test("mongo is a supported engine: opt-in gate and secret read behave exactly like the SQL engines", async () => {
  const driver = makeDriver({
    label: "MongoDB",
    secretKey: "lakshx.db.mongo.connectionString",
    async runReadOnlyQuery() {
      return { columns: ["_id"], rows: [["1"]], rowCount: 1, truncated: false, databaseName: "shop" };
    },
  });
  const { run, calls } = harness({ allowed: false, driver });
  const res = await run("mongo", '{"collection":"users"}');
  assert.equal(res.isError, true);
  assert.match(res.text, /not allowed for AI queries/);
  assert.equal(calls.getSecret, 0, "opt-in gate refuses mongo BEFORE the secret is read, same as SQL engines");
});

test("mongo happy path: uses the mongo-specific readOnlyNote (no 'transaction, rolled back' phrasing)", async () => {
  let received;
  const driver = makeDriver({
    label: "MongoDB",
    secretKey: "lakshx.db.mongo.connectionString",
    async runReadOnlyQuery(conn, query, opts) {
      received = { conn, query, opts };
      return { columns: ["_id", "name"], rows: [["1", "widget"]], rowCount: 1, truncated: false, databaseName: "shop" };
    },
  });
  const { run, calls } = harness({ driver, secret: "mongodb://localhost/shop" });
  const q = '{"collection":"users","filter":{"active":true}}';
  const res = await run("mongo", q, { maxRows: 20 });
  assert.equal(res.isError, false);
  assert.match(res.text, /Connection: MongoDB — shop  \(find-only query — no writes, no aggregation\)/);
  assert.equal(res.text.includes("read-only transaction, rolled back"), false);
  assert.match(res.text, /1 \| widget/);
  assert.equal(received.conn, "mongodb://localhost/shop");
  assert.equal(received.query, q, "the JSON query-spec string is passed through unmodified, like SQL text");
  assert.equal(received.opts.maxRows, 20);
  assert.equal(calls.getSecret, 1);
  assert.equal(calls.lastSecretKey, "lakshx.db.mongo.connectionString");
});

test("mongo: a QueryRejectedError thrown by the driver (mutating-operator filter) comes back as a clean error", async () => {
  const { parseMongoQuerySpec } = require("../lib/query-guard.js");
  const driver = makeDriver({
    label: "MongoDB",
    async runReadOnlyQuery(conn, query) {
      parseMongoQuerySpec(query); // real guard throws for a mutating operator
      return { columns: [], rows: [], rowCount: 0, truncated: false, databaseName: "d" };
    },
  });
  const { run } = harness({ driver });
  const res = await run("mongo", '{"collection":"users","filter":{"$set":{"admin":true}}}');
  assert.equal(res.isError, true);
  assert.match(res.text, /write\/update operator/);
});

test("unknown engine id returns a clean error", async () => {
  const { run } = harness();
  const res = await run("oracle", "SELECT 1");
  assert.equal(res.isError, true);
  assert.match(res.text, /Unknown or unsupported/);
});

test("empty query is rejected before any connection work", async () => {
  const { run, calls } = harness();
  const res = await run("sqlite", "   ");
  assert.equal(res.isError, true);
  assert.match(res.text, /No SQL query/);
  assert.equal(calls.getSecret, 0);
});

test("no saved connection returns a clean error (opted in, but no secret)", async () => {
  const { run, calls } = harness({ allowed: true, secret: null });
  const res = await run("sqlite", "SELECT 1");
  assert.equal(res.isError, true);
  assert.match(res.text, /No saved SQLite connection/);
  assert.equal(calls.getSecret, 1);
});

test("happy path: reads secret, calls the driver, formats the §5 result block", async () => {
  let received;
  const driver = makeDriver({
    async runReadOnlyQuery(conn, sql, opts) {
      received = { conn, sql, opts };
      return { columns: ["id", "email"], rows: [[1, "a@x.com"]], rowCount: 1, truncated: false, databaseName: "app.db" };
    },
  });
  const { run, calls } = harness({ driver });
  const res = await run("sqlite", "SELECT id, email FROM users", { maxRows: 10 });
  assert.equal(res.isError, false);
  assert.match(res.text, /Connection: SQLite — app\.db  \(read-only transaction, rolled back\)/);
  assert.match(res.text, /Columns: id, email/);
  assert.match(res.text, /1 \| a@x\.com/);
  assert.equal(received.conn, "/tmp/app.db"); // the stored secret is passed as `conn`
  assert.equal(received.opts.maxRows, 10); // clamped and forwarded
  assert.equal(received.opts.timeoutMs, 5000);
  assert.equal(calls.getSecret, 1);
});

test("maxRows is clamped to the hard max before reaching the driver", async () => {
  let seen;
  const driver = makeDriver({
    async runReadOnlyQuery(conn, sql, opts) {
      seen = opts.maxRows;
      return { columns: [], rows: [], rowCount: 0, truncated: false, databaseName: "d" };
    },
  });
  const { run } = harness({ driver });
  await run("sqlite", "SELECT 1", { maxRows: 999999 });
  assert.equal(seen, 1000);
});

test("a driver error is redacted and returned as a clean tool error — never thrown", async () => {
  const driver = makeDriver({
    async runReadOnlyQuery() {
      throw new Error("connection failed for postgres://alice:s3cr3t@db.internal:5432/app");
    },
  });
  const { run } = harness({ driver });
  const res = await run("sqlite", "SELECT 1");
  assert.equal(res.isError, true);
  assert.match(res.text, /Query failed:/);
  assert.match(res.text, /postgres:\/\/\*\*\*:\*\*\*@db\.internal/); // credentials redacted
  assert.equal(res.text.includes("s3cr3t"), false);
});

test("an allowlist rejection thrown by the driver comes back as a clean error", async () => {
  const { classifyStatement } = require("../lib/query-guard.js");
  const driver = makeDriver({
    async runReadOnlyQuery(conn, sql) {
      classifyStatement(sql); // real allowlist throws for a write
      return { columns: [], rows: [], rowCount: 0, truncated: false, databaseName: "d" };
    },
  });
  const { run } = harness({ driver });
  const res = await run("sqlite", "DELETE FROM t");
  assert.equal(res.isError, true);
  // Leading DELETE fails the leading-keyword allowlist check; a CTE-hidden
  // write hits the "Write/DDL" scan. Either way it comes back as a clean error.
  assert.match(res.text, /read-only queries are allowed|Write\/DDL statements are not allowed/);
});
