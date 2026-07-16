"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildErDiagram, buildSqlErDiagram, sanitizeToken } = require("../lib/mermaid.js");

function schema(sampledCount, fields) {
  return { sampledCount, fields };
}
function field(name, types, overrides = {}) {
  return { name, types, presentIn: overrides.presentIn ?? 10, optional: overrides.optional ?? false, isPrimaryKey: overrides.isPrimaryKey ?? false, refCollections: [] };
}

test("buildErDiagram emits an erDiagram header and one entity block per collection", () => {
  const src = buildErDiagram(
    {
      users: schema(10, [field("_id", ["ObjectId"], { isPrimaryKey: true }), field("email", ["string"])]),
    },
    [],
  );
  assert.match(src, /^erDiagram\n/);
  assert.match(src, /users \{/);
  assert.match(src, /ObjectId _id PK/);
  assert.match(src, /string email/);
});

test("suggested relationships render as a DASHED, non-identifying edge — never a solid FK-style edge", () => {
  const schemas = {
    users: schema(5, [field("_id", ["ObjectId"], { isPrimaryKey: true })]),
    orders: schema(5, [field("_id", ["ObjectId"], { isPrimaryKey: true }), field("userId", ["ObjectId"])]),
  };
  const rels = [{ from: "orders", fromField: "userId", to: "users", kind: "naming", plural: false, note: "userId ~ users" }];
  const src = buildErDiagram(schemas, rels);
  assert.match(src, /\}o\.\.o\{/); // dashed non-identifying marker
  assert.equal(/\|\|--o\{/.test(src), false); // never the solid identifying marker reserved for real FKs
  assert.equal(/\bFK\b/.test(src), false); // no field is annotated with the FK key — that's reserved for enforced FKs
});

test("field attributes fold minority types and optionality into a trailing comment instead of dropping them", () => {
  const src = buildErDiagram(
    {
      c: schema(4, [field("age", ["number", "null"], { presentIn: 2, optional: true })]),
    },
    [],
  );
  assert.match(src, /number age "also seen: null; present in 50% of sampled docs"/);
});

test("sanitizeToken strips quotes/backticks/newlines and collapses whitespace so a hostile collection/field name can't break the mermaid source", () => {
  assert.equal(sanitizeToken('weird"name`with\nquotes'), "weirdnamewithquotes");
  assert.equal(sanitizeToken("has spaces here"), "has_spaces_here");
  assert.equal(sanitizeToken(""), "_");
});

// ---- buildSqlErDiagram (Postgres/MySQL/SQLite — authoritative schema) ----

function sqlTable(name, fields) {
  return { name, fields };
}
function sqlField(name, type, overrides = {}) {
  return { name, type, nullable: overrides.nullable ?? false, pk: overrides.pk ?? false, fk: overrides.fk ?? false };
}

test("buildSqlErDiagram renders enforced FKs as SOLID identifying edges with real FK attribute keys — the exact inverse of the Mongo rules", () => {
  const tables = [
    sqlTable("users", [sqlField("id", "integer", { pk: true }), sqlField("email", "text")]),
    sqlTable("orders", [sqlField("id", "integer", { pk: true }), sqlField("user_id", "integer", { fk: true })]),
  ];
  const rels = [{ from: "orders", fromField: "user_id", to: "users", toField: "id", kind: "fk" }];
  const src = buildSqlErDiagram(tables, rels);
  assert.match(src, /^erDiagram\n/);
  assert.match(src, /users \|\|--o\{ orders : "user_id → id"/); // solid, referenced side first
  assert.equal(/\}o\.\.o\{/.test(src), false); // never the dashed suggestion marker
  assert.match(src, /integer user_id FK/); // the FK attribute key Mongo never earns
  assert.match(src, /integer id PK/);
});

test("buildSqlErDiagram marks a column that is both PK and FK with a combined key, and nullable columns with a comment", () => {
  const tables = [
    sqlTable("users", [sqlField("id", "integer", { pk: true })]),
    sqlTable("profiles", [sqlField("user_id", "integer", { pk: true, fk: true }), sqlField("bio", "text", { nullable: true })]),
  ];
  const rels = [{ from: "profiles", fromField: "user_id", to: "users", toField: "id", kind: "fk" }];
  const src = buildSqlErDiagram(tables, rels);
  assert.match(src, /integer user_id PK, FK/);
  assert.match(src, /text bio "nullable"/);
});

test("buildSqlErDiagram sanitizes hostile table/column names and types (they come from a live, untrusted database)", () => {
  const tables = [sqlTable('we"ird table', [sqlField("bad`col", 'character varying(255)')])];
  const src = buildSqlErDiagram(tables, []);
  assert.equal(src.includes('"ird'), false);
  assert.match(src, /we_ird_table \{/); // non-token chars collapsed by the entity id factory
  assert.match(src, /character_varying\(255\) badcol/);
});

test("buildSqlErDiagram skips a relationship whose endpoint table isn't in the table list (defensive)", () => {
  const tables = [sqlTable("users", [sqlField("id", "integer", { pk: true })])];
  const src = buildSqlErDiagram(tables, [{ from: "users", fromField: "x", to: "ghost", toField: "id", kind: "fk" }]);
  assert.equal(/ghost/.test(src), false);
});

test("buildErDiagram skips a relationship whose endpoint collection isn't in the schema map (defensive, shouldn't happen upstream)", () => {
  const schemas = { users: schema(1, [field("_id", ["ObjectId"])]) };
  const src = buildErDiagram(schemas, [{ from: "users", fromField: "x", to: "ghost", kind: "naming", plural: false, note: "x" }]);
  assert.equal(/ghost/.test(src), false);
});
