"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { detectRelationships, parseRefFieldName, matchCollectionName } = require("../lib/relationships.js");

test("parseRefFieldName recognizes userId/user_id/userIds/user_ids and rejects unrelated names", () => {
  assert.deepEqual(parseRefFieldName("userId"), { base: "user", plural: false });
  assert.deepEqual(parseRefFieldName("user_id"), { base: "user", plural: false });
  assert.deepEqual(parseRefFieldName("userIds"), { base: "user", plural: true });
  assert.deepEqual(parseRefFieldName("user_ids"), { base: "user", plural: true });
  assert.equal(parseRefFieldName("username"), null);
  assert.equal(parseRefFieldName("valid"), null);
});

test("matchCollectionName tries simple pluralization guesses, case-insensitively", () => {
  assert.equal(matchCollectionName("user", ["Users", "orders"]), "Users");
  assert.equal(matchCollectionName("category", ["categories"]), "categories");
  assert.equal(matchCollectionName("box", ["boxes"]), "boxes");
  assert.equal(matchCollectionName("nope", ["users", "orders"]), null);
});

test("detectRelationships finds naming-convention suggestions only for ObjectId-typed fields", () => {
  const schemas = {
    orders: {
      sampledCount: 10,
      fields: [
        { name: "_id", types: ["ObjectId"], presentIn: 10, optional: false, isPrimaryKey: true, refCollections: [] },
        { name: "userId", types: ["ObjectId"], presentIn: 10, optional: false, isPrimaryKey: false, refCollections: [] },
        // looks like a ref by name, but never actually typed as ObjectId in the sample — should NOT be suggested
        { name: "statusId", types: ["string"], presentIn: 10, optional: false, isPrimaryKey: false, refCollections: [] },
      ],
    },
    users: {
      sampledCount: 5,
      fields: [{ name: "_id", types: ["ObjectId"], presentIn: 5, optional: false, isPrimaryKey: true, refCollections: [] }],
    },
  };
  const rels = detectRelationships(schemas);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].from, "orders");
  assert.equal(rels[0].fromField, "userId");
  assert.equal(rels[0].to, "users");
  assert.equal(rels[0].kind, "naming");
});

test("detectRelationships prefers a manual $ref over a naming guess for the same field, and never targets a nonexistent collection", () => {
  const schemas = {
    posts: {
      sampledCount: 4,
      fields: [{ name: "authorId", types: ["ObjectId", "DBRef"], presentIn: 4, optional: false, isPrimaryKey: false, refCollections: ["people"] }],
    },
    people: { sampledCount: 2, fields: [] },
  };
  const rels = detectRelationships(schemas);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].kind, "manualRef");
  assert.equal(rels[0].to, "people");

  const schemasNoTarget = {
    posts: {
      sampledCount: 4,
      fields: [{ name: "ownerId", types: ["ObjectId"], presentIn: 4, optional: false, isPrimaryKey: false, refCollections: [] }],
    },
  };
  assert.deepEqual(detectRelationships(schemasNoTarget), []);
});

test("detectRelationships suppresses a field that would guess its own collection as the target (self-edge)", () => {
  const schemas = {
    employees: {
      sampledCount: 3,
      fields: [
        { name: "_id", types: ["ObjectId"], presentIn: 3, optional: false, isPrimaryKey: true, refCollections: [] },
        // "employeeId" guesses base "employee" -> "employees", i.e. its own collection
        { name: "employeeId", types: ["ObjectId"], presentIn: 3, optional: false, isPrimaryKey: false, refCollections: [] },
      ],
    },
  };
  const rels = detectRelationships(schemas);
  assert.deepEqual(rels, []);
});
