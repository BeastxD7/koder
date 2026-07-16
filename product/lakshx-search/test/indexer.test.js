"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  contentHash,
  planFullIndex,
  planFileUpdate,
  estimateChunkCount,
  estimateBatchCount,
  isExcludedPath,
  looksBinary,
} = require("../lib/indexer.js");

test("contentHash: deterministic and content-sensitive", () => {
  assert.equal(contentHash("hello"), contentHash("hello"));
  assert.notEqual(contentHash("hello"), contentHash("hello!"));
});

test("isExcludedPath: catches denylisted directories at any depth", () => {
  assert.ok(isExcludedPath("node_modules/foo/index.js"));
  assert.ok(isExcludedPath("packages/x/node_modules/y/index.js"));
  assert.ok(isExcludedPath(".git/HEAD"));
  assert.ok(isExcludedPath("dist/bundle.js"));
  assert.ok(isExcludedPath(".lakshx/search-index.db"));
  assert.equal(isExcludedPath("src/lib/indexer.js"), false);
});

test("isExcludedPath: doesn't false-positive on a filename that merely CONTAINS a denylisted word", () => {
  // e.g. "distillery.js" must not match "dist"
  assert.equal(isExcludedPath("src/distillery.js"), false);
  assert.equal(isExcludedPath("outer/file.js"), false); // "outer" contains "out" as a prefix, not a path segment
});

test("looksBinary: NUL byte anywhere in the sample marks it binary", () => {
  assert.ok(looksBinary(Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6f])));
  assert.equal(looksBinary(Buffer.from("plain text, no nulls here", "utf8")), false);
});

test("planFullIndex: a brand-new file (not in storedHashes) is scheduled for update", () => {
  const files = [{ filePath: "a.js", text: "line1\nline2" }];
  const plan = planFullIndex(files, new Map());
  assert.equal(plan.toUpdate.length, 1);
  assert.equal(plan.toUpdate[0].filePath, "a.js");
  assert.equal(plan.toDelete.length, 0);
  assert.equal(plan.unchanged, 0);
});

test("planFullIndex: a file whose stored hash still matches is 'unchanged', not re-embedded", () => {
  const text = "line1\nline2";
  const files = [{ filePath: "a.js", text }];
  const stored = new Map([["a.js", contentHash(text)]]);
  const plan = planFullIndex(files, stored);
  assert.equal(plan.toUpdate.length, 0);
  assert.equal(plan.unchanged, 1);
});

test("planFullIndex: a file whose content changed since the stored hash IS re-embedded", () => {
  const files = [{ filePath: "a.js", text: "new content" }];
  const stored = new Map([["a.js", contentHash("old content")]]);
  const plan = planFullIndex(files, stored);
  assert.equal(plan.toUpdate.length, 1);
  assert.equal(plan.toUpdate[0].hash, contentHash("new content"));
});

test("planFullIndex: a stored file no longer present in the workspace is scheduled for deletion (prune)", () => {
  const files = [{ filePath: "a.js", text: "x" }];
  const stored = new Map([
    ["a.js", contentHash("x")],
    ["deleted.js", "some-old-hash"],
  ]);
  const plan = planFullIndex(files, stored);
  assert.deepEqual(plan.toDelete, ["deleted.js"]);
});

test("planFileUpdate: unchanged content (matching storedHash) returns null — the incremental no-op signal", () => {
  const text = "same";
  const result = planFileUpdate("a.js", text, contentHash(text));
  assert.equal(result, null);
});

test("planFileUpdate: changed content returns a plan with the new hash + chunks", () => {
  const result = planFileUpdate("a.js", "line1\nline2\nline3", "stale-hash", { chunkLines: 2, overlapLines: 0 });
  assert.equal(result.filePath, "a.js");
  assert.equal(result.hash, contentHash("line1\nline2\nline3"));
  assert.ok(result.chunks.length >= 1);
});

test("planFileUpdate: a never-indexed file (storedHash undefined) is treated as changed", () => {
  const result = planFileUpdate("new.js", "content", undefined);
  assert.notEqual(result, null);
});

test("estimateChunkCount / estimateBatchCount: the cost-guardrail numbers shown before any API call", () => {
  const toUpdate = [{ chunks: [1, 2, 3] }, { chunks: [1, 2] }];
  assert.equal(estimateChunkCount(toUpdate), 5);
  assert.equal(estimateBatchCount(5, 2), 3); // ceil(5/2)
  assert.equal(estimateBatchCount(0, 32), 0);
});
