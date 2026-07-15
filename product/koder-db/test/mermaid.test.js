"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildErDiagram, sanitizeToken } = require("../lib/mermaid.js");

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

test("buildErDiagram skips a relationship whose endpoint collection isn't in the schema map (defensive, shouldn't happen upstream)", () => {
  const schemas = { users: schema(1, [field("_id", ["ObjectId"])]) };
  const src = buildErDiagram(schemas, [{ from: "users", fromField: "x", to: "ghost", kind: "naming", plural: false, note: "x" }]);
  assert.equal(/ghost/.test(src), false);
});
