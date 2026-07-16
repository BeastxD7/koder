"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CURATED_EXTENSIONS, CATEGORIES, validateEntry, validateCuratedList, groupByCategory } = require("../lib/curated.js");

// ---------------------------------------------------------------------------
// validateEntry
// ---------------------------------------------------------------------------
test("validateEntry accepts a well-formed entry", () => {
  const problems = validateEntry({
    id: "publisher.name",
    displayName: "Thing",
    description: "Does a thing.",
    category: CATEGORIES[0],
    verifiedOn: "Open VSX",
    reason: "Because.",
  });
  assert.deepEqual(problems, []);
});

test("validateEntry rejects a missing/malformed id", () => {
  assert.ok(validateEntry({ id: "", displayName: "x", description: "x", category: CATEGORIES[0], verifiedOn: "both", reason: "x" }).length > 0);
  assert.ok(
    validateEntry({ id: "no-dot-here", displayName: "x", description: "x", category: CATEGORIES[0], verifiedOn: "both", reason: "x" }).length > 0,
  );
});

test("validateEntry rejects an unknown category or verifiedOn value", () => {
  const badCategory = validateEntry({
    id: "pub.name",
    displayName: "x",
    description: "x",
    category: "NotACategory",
    verifiedOn: "both",
    reason: "x",
  });
  assert.ok(badCategory.some((p) => p.includes("category")));

  const badVerifiedOn = validateEntry({
    id: "pub.name",
    displayName: "x",
    description: "x",
    category: CATEGORIES[0],
    verifiedOn: "TotallyLegit",
    reason: "x",
  });
  assert.ok(badVerifiedOn.some((p) => p.includes("verifiedOn")));
});

test("validateEntry requires displayName, description and reason to be non-empty", () => {
  const problems = validateEntry({
    id: "pub.name",
    displayName: "  ",
    description: "",
    category: CATEGORIES[0],
    verifiedOn: "both",
  });
  assert.ok(problems.some((p) => p.includes("displayName")));
  assert.ok(problems.some((p) => p.includes("description")));
  assert.ok(problems.some((p) => p.includes("reason")));
});

// ---------------------------------------------------------------------------
// validateCuratedList
// ---------------------------------------------------------------------------
test("validateCuratedList flags duplicate ids (case-insensitive)", () => {
  const list = [
    { id: "pub.name", displayName: "A", description: "d", category: CATEGORIES[0], verifiedOn: "both", reason: "r" },
    { id: "Pub.Name", displayName: "B", description: "d", category: CATEGORIES[0], verifiedOn: "both", reason: "r" },
  ];
  const { valid, problems } = validateCuratedList(list);
  assert.equal(valid, false);
  assert.ok(problems.some((p) => p.problems.some((msg) => msg.includes("duplicate"))));
});

test("validateCuratedList rejects a non-array input", () => {
  const { valid } = validateCuratedList({ not: "an array" });
  assert.equal(valid, false);
});

test("validateCuratedList accepts an empty list", () => {
  const { valid, problems } = validateCuratedList([]);
  assert.equal(valid, true);
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// The actual shipped list must itself be valid — a regression guard so a
// future hand-edit to CURATED_EXTENSIONS can't silently break the schema.
// ---------------------------------------------------------------------------
test("the shipped CURATED_EXTENSIONS list is itself schema-valid", () => {
  const { valid, problems } = validateCuratedList(CURATED_EXTENSIONS);
  assert.equal(valid, true, `curated list has problems: ${JSON.stringify(problems, null, 2)}`);
});

test("the shipped CURATED_EXTENSIONS list has no entries silently left as 'unverified'", () => {
  // Shipping an "unverified" entry isn't a schema violation (the value is a
  // legal enum member, used for candidates awaiting a maintainer check) but
  // it should never happen unnoticed — this test is the tripwire.
  const unverified = CURATED_EXTENSIONS.filter((e) => e.verifiedOn === "unverified");
  assert.deepEqual(unverified, [], "every shipped entry should have been checked before shipping");
});

// ---------------------------------------------------------------------------
// groupByCategory
// ---------------------------------------------------------------------------
test("groupByCategory groups entries and preserves within-group order", () => {
  const list = [
    { id: "a.one", category: "Formatting" },
    { id: "b.two", category: "Linting" },
    { id: "c.three", category: "Formatting" },
  ];
  const groups = groupByCategory(list);
  assert.deepEqual(
    groups.get("Formatting").map((e) => e.id),
    ["a.one", "c.three"],
  );
  assert.deepEqual(
    groups.get("Linting").map((e) => e.id),
    ["b.two"],
  );
});
