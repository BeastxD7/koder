// Pure-function tests for each SQL engine's introspection-result → payload
// mapping, using mock catalog/PRAGMA rows — no live server needed. The live
// query strings themselves are exercised end-to-end for SQLite (node:sqlite
// is built into Node) elsewhere; Postgres/MySQL query execution requires a
// live server and is intentionally not covered here.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mapPostgresIntrospection } = require("../lib/drivers/postgres.js");
const { mapMysqlIntrospection } = require("../lib/drivers/mysql.js");
const { mapSqliteIntrospection } = require("../lib/drivers/sqlite.js");
const { listEngines, getDriver } = require("../lib/engines.js");

// ---------- engine registry / picker plumbing ----------

test("engine registry lists all four engines and every driver implements the full interface", () => {
  assert.deepEqual(
    listEngines().map((e) => e.id),
    ["mongo", "postgres", "mysql", "sqlite"],
  );
  for (const { id } of listEngines()) {
    const driver = getDriver(id);
    assert.equal(driver.id, id);
    assert.equal(typeof driver.label, "string");
    assert.ok(["uri", "file"].includes(driver.connectionKind), `${id} has a valid connectionKind`);
    assert.match(driver.secretKey, /^lakshx\.db\./, `${id} has a namespaced SecretStorage key`);
    for (const fn of ["testConnection", "connect", "close", "resolveDatabase", "introspect"]) {
      assert.equal(typeof driver[fn], "function", `${id}.${fn} is a function`);
    }
  }
  // Per-engine secrets must never collide (switching engines must not clobber a saved connection)
  const keys = listEngines().map((e) => getDriver(e.id).secretKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.throws(() => getDriver("oracle"), /Unknown database engine/);
});

test("URI engines carry scheme validation for the input box; the file engine carries dialog filters instead", () => {
  assert.ok(getDriver("mongo").prompt.schemeRe.test("mongodb+srv://x"));
  assert.ok(getDriver("postgres").prompt.schemeRe.test("postgresql://x"));
  assert.ok(getDriver("postgres").prompt.schemeRe.test("postgres://x"));
  assert.equal(getDriver("postgres").prompt.schemeRe.test("mysql://x"), false);
  assert.ok(getDriver("mysql").prompt.schemeRe.test("mysql://x"));
  assert.equal(getDriver("sqlite").connectionKind, "file");
  assert.ok(getDriver("sqlite").prompt.fileFilters["SQLite database"].includes("sqlite"));
});

// ---------- Postgres mapping ----------

test("mapPostgresIntrospection maps information_schema/pg_catalog rows to tables, PKs, and paired FK columns", () => {
  const { tables, relationships } = mapPostgresIntrospection({
    tableRows: [
      { table_schema: "public", table_name: "users" },
      { table_schema: "public", table_name: "orders" },
    ],
    columnRows: [
      { table_schema: "public", table_name: "users", column_name: "id", data_type: "integer", is_nullable: "NO" },
      { table_schema: "public", table_name: "users", column_name: "email", data_type: "text", is_nullable: "YES" },
      { table_schema: "public", table_name: "orders", column_name: "id", data_type: "integer", is_nullable: "NO" },
      { table_schema: "public", table_name: "orders", column_name: "user_id", data_type: "integer", is_nullable: "NO" },
    ],
    pkRows: [
      { table_schema: "public", table_name: "users", column_name: "id" },
      { table_schema: "public", table_name: "orders", column_name: "id" },
    ],
    fkRows: [
      { from_schema: "public", from_table: "orders", from_column: "user_id", to_schema: "public", to_table: "users", to_column: "id" },
    ],
  });

  const users = tables.find((t) => t.name === "users");
  assert.deepEqual(users.fields.map((f) => f.name), ["id", "email"]);
  assert.equal(users.fields[0].pk, true);
  assert.equal(users.fields[1].nullable, true);

  const orders = tables.find((t) => t.name === "orders");
  assert.equal(orders.fields.find((f) => f.name === "user_id").fk, true);

  assert.deepEqual(relationships, [
    { from: "orders", fromField: "user_id", to: "users", toField: "id", kind: "fk" },
  ]);
});

test("mapPostgresIntrospection schema-qualifies non-public tables and leaves public ones bare", () => {
  const { tables, relationships } = mapPostgresIntrospection({
    tableRows: [
      { table_schema: "public", table_name: "users" },
      { table_schema: "audit", table_name: "events" },
    ],
    columnRows: [
      { table_schema: "public", table_name: "users", column_name: "id", data_type: "integer", is_nullable: "NO" },
      { table_schema: "audit", table_name: "events", column_name: "user_id", data_type: "integer", is_nullable: "NO" },
    ],
    pkRows: [],
    fkRows: [
      { from_schema: "audit", from_table: "events", from_column: "user_id", to_schema: "public", to_table: "users", to_column: "id" },
    ],
  });
  assert.deepEqual(tables.map((t) => t.name).sort(), ["audit.events", "users"]);
  assert.equal(relationships[0].from, "audit.events");
  assert.equal(relationships[0].to, "users");
});

test("mapPostgresIntrospection ignores columns of filtered-out relations and dedupes repeated FK rows", () => {
  const fkRow = { from_schema: "public", from_table: "a", from_column: "b_id", to_schema: "public", to_table: "b", to_column: "id" };
  const { tables, relationships } = mapPostgresIntrospection({
    tableRows: [
      { table_schema: "public", table_name: "a" },
      { table_schema: "public", table_name: "b" },
    ],
    columnRows: [
      { table_schema: "public", table_name: "a", column_name: "b_id", data_type: "integer", is_nullable: "NO" },
      { table_schema: "public", table_name: "b", column_name: "id", data_type: "integer", is_nullable: "NO" },
      { table_schema: "public", table_name: "some_view", column_name: "x", data_type: "text", is_nullable: "YES" },
    ],
    pkRows: [],
    fkRows: [fkRow, { ...fkRow }],
  });
  assert.equal(tables.some((t) => t.name === "some_view"), false);
  assert.equal(relationships.length, 1);
});

// ---------- MySQL mapping ----------

test("mapMysqlIntrospection maps information_schema rows: PRI column_key becomes pk, referenced columns become FKs", () => {
  const { tables, relationships } = mapMysqlIntrospection({
    tableRows: [{ table_name: "users" }, { table_name: "orders" }],
    columnRows: [
      { table_name: "users", column_name: "id", data_type: "int", is_nullable: "NO", column_key: "PRI" },
      { table_name: "users", column_name: "email", data_type: "varchar", is_nullable: "YES", column_key: "" },
      { table_name: "orders", column_name: "id", data_type: "int", is_nullable: "NO", column_key: "PRI" },
      { table_name: "orders", column_name: "user_id", data_type: "int", is_nullable: "NO", column_key: "MUL" },
    ],
    fkRows: [
      { table_name: "orders", column_name: "user_id", referenced_table_name: "users", referenced_column_name: "id" },
    ],
  });
  assert.equal(tables.find((t) => t.name === "users").fields.find((f) => f.name === "id").pk, true);
  assert.equal(tables.find((t) => t.name === "users").fields.find((f) => f.name === "email").nullable, true);
  assert.equal(tables.find((t) => t.name === "orders").fields.find((f) => f.name === "user_id").fk, true);
  assert.deepEqual(relationships, [
    { from: "orders", fromField: "user_id", to: "users", toField: "id", kind: "fk" },
  ]);
});

test("mapMysqlIntrospection skips FK rows pointing at tables outside the introspected set", () => {
  const { relationships } = mapMysqlIntrospection({
    tableRows: [{ table_name: "orders" }],
    columnRows: [{ table_name: "orders", column_name: "user_id", data_type: "int", is_nullable: "NO", column_key: "MUL" }],
    fkRows: [
      { table_name: "orders", column_name: "user_id", referenced_table_name: "users_in_other_db", referenced_column_name: "id" },
    ],
  });
  assert.deepEqual(relationships, []);
});

// ---------- SQLite mapping ----------

test("mapSqliteIntrospection maps pragma_table_info/pragma_foreign_key_list rows, including composite-PK ordinals", () => {
  const { tables, relationships } = mapSqliteIntrospection([
    {
      name: "users",
      columns: [
        { cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: "email", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ],
      foreignKeys: [],
    },
    {
      name: "order_items",
      columns: [
        { cid: 0, name: "order_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 1 },
        { cid: 1, name: "line_no", type: "INTEGER", notnull: 1, dflt_value: null, pk: 2 }, // 2nd column of a composite PK
        { cid: 2, name: "user_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
      ],
      foreignKeys: [{ id: 0, seq: 0, table: "users", from: "user_id", to: "id", on_update: "NO ACTION", on_delete: "NO ACTION", match: "NONE" }],
    },
  ]);

  const items = tables.find((t) => t.name === "order_items");
  assert.equal(items.fields.find((f) => f.name === "order_id").pk, true);
  assert.equal(items.fields.find((f) => f.name === "line_no").pk, true); // ordinal 2 still counts as PK membership
  assert.equal(items.fields.find((f) => f.name === "user_id").fk, true);
  assert.equal(items.fields.find((f) => f.name === "user_id").nullable, true);
  assert.deepEqual(relationships, [
    { from: "order_items", fromField: "user_id", to: "users", toField: "id", kind: "fk" },
  ]);
});

test("mapSqliteIntrospection resolves a NULL `to` (FK against the implicit PK) to the target's PK column, and defaults a typeless column to blob affinity", () => {
  const { tables, relationships } = mapSqliteIntrospection([
    {
      name: "users",
      columns: [{ cid: 0, name: "id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 }],
      foreignKeys: [],
    },
    {
      name: "notes",
      columns: [
        { cid: 0, name: "user_id", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { cid: 1, name: "anything", type: "", notnull: 0, dflt_value: null, pk: 0 }, // CREATE TABLE notes(user_id INTEGER ..., anything)
      ],
      foreignKeys: [{ id: 0, seq: 0, table: "users", from: "user_id", to: null, on_update: "NO ACTION", on_delete: "NO ACTION", match: "NONE" }],
    },
  ]);
  assert.equal(relationships[0].toField, "id");
  assert.equal(tables.find((t) => t.name === "notes").fields.find((f) => f.name === "anything").type, "blob");
});

test("mapSqliteIntrospection tolerates a dangling FK to a table that doesn't exist (SQLite allows those)", () => {
  const { relationships } = mapSqliteIntrospection([
    {
      name: "orphans",
      columns: [{ cid: 0, name: "ghost_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 }],
      foreignKeys: [{ id: 0, seq: 0, table: "ghosts", from: "ghost_id", to: "id", on_update: "NO ACTION", on_delete: "NO ACTION", match: "NONE" }],
    },
  ]);
  assert.deepEqual(relationships, []);
});
