"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildSqlPayload, markForeignKeyFields, TABLE_LIMIT } = require("../lib/sql-common.js");

function table(name, fieldNames = ["id"]) {
  return { name, fields: fieldNames.map((n) => ({ name: n, type: "integer", nullable: false, pk: n === "id", fk: false })) };
}

test("buildSqlPayload produces the webview envelope with authoritative: true and engine metadata", () => {
  const payload = buildSqlPayload({
    engine: "postgres",
    engineLabel: "PostgreSQL",
    databaseName: "shop",
    tables: [table("users", ["id", "email"]), table("orders", ["id", "user_id"])],
    relationships: [{ from: "orders", fromField: "user_id", to: "users", toField: "id", kind: "fk" }],
  });
  assert.equal(payload.engine, "postgres");
  assert.equal(payload.engineLabel, "PostgreSQL");
  assert.equal(payload.authoritative, true);
  assert.equal(payload.databaseName, "shop");
  assert.deepEqual(
    payload.collections.map((c) => c.name),
    ["orders", "users"], // sorted
  );
  assert.equal(payload.collections.find((c) => c.name === "users").fieldCount, 2);
  assert.equal(payload.truncatedCollectionCount, 0);
  assert.equal(payload.relationships.length, 1);
  assert.match(payload.relationships[0].note, /enforced foreign key/);
  assert.match(payload.mermaidSource, /\|\|--o\{/);
});

test("buildSqlPayload caps tables at the limit (default 40, same guardrail as Mongo's COLLECTION_LIMIT) and reports the truncation", () => {
  assert.equal(TABLE_LIMIT, 40);
  const tables = Array.from({ length: 45 }, (_, i) => table(`t${String(i).padStart(2, "0")}`));
  const payload = buildSqlPayload({
    engine: "mysql",
    engineLabel: "MySQL",
    databaseName: "big",
    tables,
    relationships: [],
  });
  assert.equal(payload.collections.length, 40);
  assert.equal(payload.truncatedCollectionCount, 5);
});

test("buildSqlPayload drops relationships whose endpoints fell past the table cap, so the diagram never references an undrawn entity", () => {
  const tables = [table("a"), table("b"), table("c")];
  const payload = buildSqlPayload({
    engine: "sqlite",
    engineLabel: "SQLite",
    databaseName: "x.db",
    tables,
    relationships: [
      { from: "b", fromField: "a_id", to: "a", toField: "id", kind: "fk" },
      { from: "c", fromField: "b_id", to: "b", toField: "id", kind: "fk" },
    ],
    tableLimit: 2, // only a and b survive
  });
  assert.deepEqual(
    payload.collections.map((t) => t.name),
    ["a", "b"],
  );
  assert.equal(payload.relationships.length, 1);
  assert.equal(payload.relationships[0].from, "b");
  assert.equal(/\bc\b/.test(payload.mermaidSource), false);
});

test("markForeignKeyFields flags exactly the referencing columns of the relationship list", () => {
  const tables = [table("users", ["id"]), table("orders", ["id", "user_id", "note"])];
  markForeignKeyFields(tables, [{ from: "orders", fromField: "user_id", to: "users", toField: "id", kind: "fk" }]);
  const orders = tables.find((t) => t.name === "orders");
  assert.equal(orders.fields.find((f) => f.name === "user_id").fk, true);
  assert.equal(orders.fields.find((f) => f.name === "note").fk, false);
  assert.equal(tables.find((t) => t.name === "users").fields[0].fk, false);
});
