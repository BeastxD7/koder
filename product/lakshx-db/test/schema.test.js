"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { bsonTypeLabel, inferCollectionSchema } = require("../lib/schema.js");

test("bsonTypeLabel labels native JS and duck-typed BSON values", () => {
  assert.equal(bsonTypeLabel(null), "null");
  assert.equal(bsonTypeLabel(undefined), "undefined");
  assert.equal(bsonTypeLabel("x"), "string");
  assert.equal(bsonTypeLabel(1), "number");
  assert.equal(bsonTypeLabel(true), "boolean");
  assert.equal(bsonTypeLabel([1, 2]), "array");
  assert.equal(bsonTypeLabel(new Date()), "date");
  assert.equal(bsonTypeLabel({ a: 1 }), "object");
  assert.equal(bsonTypeLabel({ _bsontype: "ObjectId" }), "ObjectId");
  assert.equal(bsonTypeLabel({ _bsontype: "Decimal128" }), "Decimal128");
  assert.equal(bsonTypeLabel({ _bsontype: "DBRef" }), "DBRef");
});

test("inferCollectionSchema merges field shapes across a sample and flags optional fields", () => {
  const docs = [
    { _id: { _bsontype: "ObjectId" }, email: "a@x.com", age: 30 },
    { _id: { _bsontype: "ObjectId" }, email: "b@x.com" }, // no `age`
    { _id: { _bsontype: "ObjectId" }, email: "c@x.com", age: null },
  ];
  const schema = inferCollectionSchema(docs);
  assert.equal(schema.sampledCount, 3);

  const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
  assert.equal(byName._id.isPrimaryKey, true);
  assert.equal(byName._id.types[0], "ObjectId");
  assert.equal(byName.email.optional, false);
  assert.equal(byName.age.optional, true);
  assert.equal(byName.age.presentIn, 2);
  assert.deepEqual(new Set(byName.age.types), new Set(["number", "null"]));
});

test("inferCollectionSchema caps the sample at `limit` regardless of input size", () => {
  const docs = Array.from({ length: 500 }, (_, i) => ({ n: i }));
  const schema = inferCollectionSchema(docs, { limit: 100 });
  assert.equal(schema.sampledCount, 100);
  assert.equal(schema.fields.find((f) => f.name === "n").presentIn, 100);
});

test("inferCollectionSchema extracts manual $ref-style references into refCollections", () => {
  const docs = [
    { _id: 1, author: { $ref: "users", $id: "u1" } },
    { _id: 2, author: { $ref: "users", $id: "u2" } },
  ];
  const schema = inferCollectionSchema(docs);
  const author = schema.fields.find((f) => f.name === "author");
  assert.deepEqual(author.refCollections, ["users"]);
});

test("inferCollectionSchema handles an empty sample without throwing", () => {
  const schema = inferCollectionSchema([]);
  assert.equal(schema.sampledCount, 0);
  assert.deepEqual(schema.fields, []);
});
