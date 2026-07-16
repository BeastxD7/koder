"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { dot, magnitude, cosineSimilarity, rankChunks, mergeAdjacentHits } = require("../lib/similarity.js");

test("dot/magnitude: basic vector math", () => {
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 32);
  assert.equal(magnitude([3, 4]), 5);
});

test("cosineSimilarity: identical vectors -> 1, orthogonal -> 0, opposite -> -1", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - -1) < 1e-9);
});

test("cosineSimilarity: scale-invariant (magnitude doesn't affect the angle)", () => {
  const a = [1, 2, 3];
  const b = [2, 4, 6]; // same direction, 2x magnitude
  assert.ok(Math.abs(cosineSimilarity(a, b) - 1) < 1e-9);
});

test("cosineSimilarity: zero vector returns 0, not NaN", () => {
  assert.equal(cosineSimilarity([0, 0, 0], [1, 2, 3]), 0);
});

test("cosineSimilarity: dimension mismatch throws", () => {
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]));
});

test("rankChunks: sorts descending by similarity and caps at topN", () => {
  const query = [1, 0];
  const rows = [
    { filePath: "a.js", startLine: 1, endLine: 5, chunkText: "a", embedding: [0, 1] }, // orthogonal -> 0
    { filePath: "b.js", startLine: 1, endLine: 5, chunkText: "b", embedding: [1, 0] }, // identical -> 1
    { filePath: "c.js", startLine: 1, endLine: 5, chunkText: "c", embedding: [0.9, 0.1] }, // close -> high
  ];
  const ranked = rankChunks(query, rows, { topN: 2 });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].filePath, "b.js");
  assert.equal(ranked[1].filePath, "c.js");
  assert.ok(ranked[0].score >= ranked[1].score);
});

test("rankChunks: silently skips rows whose embedding dimension doesn't match the query (stale-model rows)", () => {
  const query = [1, 0, 0];
  const rows = [
    { filePath: "stale.js", startLine: 1, endLine: 2, chunkText: "old", embedding: [1, 0] }, // 2-d, from a different model
    { filePath: "fresh.js", startLine: 1, endLine: 2, chunkText: "new", embedding: [1, 0, 0] },
  ];
  const ranked = rankChunks(query, rows, { topN: 10 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].filePath, "fresh.js");
});

test("rankChunks: rows missing an embedding entirely don't crash", () => {
  const ranked = rankChunks([1, 0], [{ filePath: "x", startLine: 1, endLine: 1, chunkText: "", embedding: null }], {});
  assert.equal(ranked.length, 0);
});

test("mergeAdjacentHits: overlapping windows from the SAME file collapse into one, keeping the higher score", () => {
  const ranked = [
    { filePath: "a.js", startLine: 10, endLine: 30, chunkText: "best", score: 0.9 },
    { filePath: "a.js", startLine: 25, endLine: 45, chunkText: "overlap", score: 0.7 }, // overlaps [10,30]
  ];
  const merged = mergeAdjacentHits(ranked);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].startLine, 10);
  assert.equal(merged[0].endLine, 45);
  assert.equal(merged[0].score, 0.9);
  assert.equal(merged[0].chunkText, "best");
});

test("mergeAdjacentHits: hits within mergeGapLines of each other (but not overlapping) still merge", () => {
  const ranked = [
    { filePath: "a.js", startLine: 1, endLine: 10, chunkText: "first", score: 0.8 },
    { filePath: "a.js", startLine: 13, endLine: 20, chunkText: "second", score: 0.6 }, // gap of 2 lines
  ];
  const merged = mergeAdjacentHits(ranked, { mergeGapLines: 5 });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].endLine, 20);
});

test("mergeAdjacentHits: far-apart hits in the same file stay separate results", () => {
  const ranked = [
    { filePath: "a.js", startLine: 1, endLine: 10, chunkText: "first", score: 0.8 },
    { filePath: "a.js", startLine: 500, endLine: 510, chunkText: "second", score: 0.6 },
  ];
  const merged = mergeAdjacentHits(ranked, { mergeGapLines: 5 });
  assert.equal(merged.length, 2);
});

test("mergeAdjacentHits: same-line-range hits in DIFFERENT files never merge", () => {
  const ranked = [
    { filePath: "a.js", startLine: 1, endLine: 10, chunkText: "a", score: 0.8 },
    { filePath: "b.js", startLine: 1, endLine: 10, chunkText: "b", score: 0.7 },
  ];
  const merged = mergeAdjacentHits(ranked);
  assert.equal(merged.length, 2);
});

test("mergeAdjacentHits: output stays sorted by score descending", () => {
  const ranked = [
    { filePath: "a.js", startLine: 1, endLine: 10, chunkText: "a", score: 0.5 },
    { filePath: "b.js", startLine: 1, endLine: 10, chunkText: "b", score: 0.9 },
  ];
  const merged = mergeAdjacentHits(ranked);
  assert.equal(merged[0].filePath, "b.js");
  assert.equal(merged[1].filePath, "a.js");
});
