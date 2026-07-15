// Sanity tests for changelog.js — the "What's new" panel's data source.
// Cheap, structural checks only: this is a low-risk UI feature, not core
// agent logic, so we just guard the shape extension.js/panel.js depend on.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CHANGELOG } = require("../changelog.js");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

test("every changelog entry has the required fields with sane types", () => {
  assert.ok(Array.isArray(CHANGELOG));
  assert.ok(CHANGELOG.length > 0);
  for (const entry of CHANGELOG) {
    assert.match(entry.date, DATE_RE, `bad date: ${entry.date}`);
    assert.ok(!Number.isNaN(new Date(entry.date).getTime()), `unparseable date: ${entry.date}`);
    assert.equal(typeof entry.title, "string");
    assert.ok(entry.title.length > 0);
    assert.equal(typeof entry.description, "string");
    assert.ok(entry.description.length > 0);
  }
});

test("changelog.js's own array order is already newest-first (extension.js relies on a stable re-sort of this)", () => {
  const dates = CHANGELOG.map((e) => e.date);
  const sorted = [...dates].sort((a, b) => b.localeCompare(a));
  assert.deepEqual(dates, sorted);
});
