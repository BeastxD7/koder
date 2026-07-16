"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chunkText, snippetOf, DEFAULT_CHUNK_LINES, DEFAULT_OVERLAP_LINES } = require("../lib/chunker.js");

test("chunkText: empty/whitespace-only text produces no chunks", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("\n\n   \n\t\n"), []);
});

test("chunkText: a file shorter than one chunk is a single chunk covering all lines", () => {
  const text = ["a", "b", "c"].join("\n");
  const chunks = chunkText(text, { chunkLines: 60, overlapLines: 10 });
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], { startLine: 1, endLine: 3, text: "a\nb\nc" });
});

test("chunkText: windows advance by (chunkLines - overlapLines) and overlap by overlapLines", () => {
  // 25 lines, chunkLines=10, overlapLines=4 -> stride=6
  const lines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`);
  const chunks = chunkText(lines.join("\n"), { chunkLines: 10, overlapLines: 4 });
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 10);
  assert.equal(chunks[1].startLine, 7); // 1 + stride(6)
  assert.equal(chunks[1].endLine, 16);
  assert.equal(chunks[2].startLine, 13);
  assert.equal(chunks[2].endLine, 22);
  // last chunk reaches EOF exactly once, not duplicated past the end
  const last = chunks[chunks.length - 1];
  assert.equal(last.endLine, 25);
});

test("chunkText: consecutive chunks actually share the overlapping lines' content", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
  const chunks = chunkText(lines.join("\n"), { chunkLines: 10, overlapLines: 3 });
  const firstTail = chunks[0].text.split("\n").slice(-3);
  const secondHead = chunks[1].text.split("\n").slice(0, 3);
  assert.deepEqual(firstTail, secondHead);
});

test("chunkText: whitespace-only trailing window is dropped, not emitted as an empty chunk", () => {
  const text = "real content here\n" + "\n".repeat(5);
  const chunks = chunkText(text, { chunkLines: 3, overlapLines: 0 });
  for (const c of chunks) assert.ok(c.text.split("\n").some((l) => l.trim() !== ""));
});

test("chunkText: overlapLines is clamped below chunkLines (never a zero/negative stride)", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `l${i}`);
  const chunks = chunkText(lines.join("\n"), { chunkLines: 5, overlapLines: 5000 });
  // stride must be >= 1, so this must terminate and produce > 1 chunk
  assert.ok(chunks.length > 1);
  assert.ok(chunks.length < 30);
});

test("chunkText: defaults are the documented 60/10", () => {
  assert.equal(DEFAULT_CHUNK_LINES, 60);
  assert.equal(DEFAULT_OVERLAP_LINES, 10);
});

test("snippetOf: takes the first non-blank line, trimmed", () => {
  assert.equal(snippetOf("\n  \nfunction foo() {\n  return 1;\n}"), "function foo() {");
});

test("snippetOf: length-caps with an ellipsis", () => {
  const long = "x".repeat(300);
  const s = snippetOf(long, 50);
  assert.equal(s.length, 50);
  assert.ok(s.endsWith("…"));
});

test("snippetOf: empty text yields empty string, not a throw", () => {
  assert.equal(snippetOf(""), "");
  assert.equal(snippetOf("\n\n\n"), "");
});
