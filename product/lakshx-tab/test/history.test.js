"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { makeEditEntry, pushEdit, summarizeEdits, MAX_INSERTED_CHARS_PER_EDIT } = require("../lib/history.js");

// ---------------------------------------------------------------------------
// makeEditEntry
// ---------------------------------------------------------------------------
test("makeEditEntry: normalizes and truncates a long paste", () => {
  const longText = "x".repeat(500);
  const entry = makeEditEntry({ line: 3, removedChars: 2, insertedText: longText });
  assert.equal(entry.line, 3);
  assert.equal(entry.removedChars, 2);
  assert.equal(entry.insertedText.length, MAX_INSERTED_CHARS_PER_EDIT + 1); // +1 for ellipsis marker
  assert.ok(entry.insertedText.endsWith("…"));
  assert.ok(typeof entry.ts === "number");
});

test("makeEditEntry: defaults missing fields safely", () => {
  const entry = makeEditEntry({ insertedText: "hi" });
  assert.equal(entry.line, 0);
  assert.equal(entry.removedChars, 0);
  assert.equal(entry.insertedText, "hi");
});

// ---------------------------------------------------------------------------
// pushEdit — bounded rolling buffer
// ---------------------------------------------------------------------------
test("pushEdit: buffer never exceeds maxEntries, drops oldest first", () => {
  let buf = [];
  for (let i = 0; i < 10; i++) {
    buf = pushEdit(buf, { line: i, removedChars: 0, insertedText: `edit${i}` }, 5);
  }
  assert.equal(buf.length, 5);
  assert.deepEqual(
    buf.map((e) => e.insertedText),
    ["edit5", "edit6", "edit7", "edit8", "edit9"],
  );
});

test("pushEdit: does not mutate the input buffer (immutable)", () => {
  const buf1 = pushEdit([], { line: 0, removedChars: 0, insertedText: "a" }, 5);
  const buf2 = pushEdit(buf1, { line: 1, removedChars: 0, insertedText: "b" }, 5);
  assert.equal(buf1.length, 1);
  assert.equal(buf2.length, 2);
});

// ---------------------------------------------------------------------------
// summarizeEdits — bounded text rendering
// ---------------------------------------------------------------------------
test("summarizeEdits: empty buffer yields empty string", () => {
  assert.equal(summarizeEdits([]), "");
  assert.equal(summarizeEdits(undefined), "");
});

test("summarizeEdits: renders line/removed/inserted compactly, oldest first", () => {
  const buf = [
    makeEditEntry({ line: 10, removedChars: 0, insertedText: "foo" }),
    makeEditEntry({ line: 12, removedChars: 3, insertedText: "bar" }),
  ];
  const out = summarizeEdits(buf);
  assert.equal(out, 'L10: +"foo"\nL12: -3ch +"bar"');
});

test("summarizeEdits: newlines in inserted text are flattened so the summary stays one-line-per-edit", () => {
  const buf = [makeEditEntry({ line: 1, removedChars: 0, insertedText: "a\nb\nc" })];
  const out = summarizeEdits(buf);
  assert.equal(out, 'L1: +"a\\nb\\nc"');
});

test("summarizeEdits: total output is hard-capped at maxChars even with many entries", () => {
  const buf = Array.from({ length: 50 }, (_, i) => makeEditEntry({ line: i, removedChars: 0, insertedText: "x".repeat(20) }));
  const out = summarizeEdits(buf, 100);
  assert.ok(out.length <= 100);
});
