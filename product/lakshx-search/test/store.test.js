// LIVE node:sqlite end-to-end pass against a real temp file — same
// convention as product/lakshx-db/test/*.test.js (a live DatabaseSync pass
// proves the actual read/write path, not just the pure helpers).
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  floatsToBuffer,
  bufferToFloats,
  openStore,
  closeStore,
  getMeta,
  setMeta,
  getFileHash,
  getAllFileHashes,
  listIndexedFiles,
  countChunks,
  upsertFile,
  deleteFile,
  getAllChunkRows,
} = require("../lib/store.js");

test("floatsToBuffer/bufferToFloats: round-trips float32 precision (not exact float64 equality, by design)", () => {
  const original = [0.1, -0.5, 1.0, 3.14159, -2.71828];
  const restored = bufferToFloats(floatsToBuffer(original));
  assert.equal(restored.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(restored[i] - original[i]) < 1e-6, `index ${i}: ${restored[i]} vs ${original[i]}`);
  }
});

test("floatsToBuffer: compact — 4 bytes per dimension, not decimal-text-sized", () => {
  const buf = floatsToBuffer(new Array(1536).fill(0.123456));
  assert.equal(buf.length, 1536 * 4);
});

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lakshx-search-test-"));
  const dbPath = path.join(dir, ".lakshx", "search-index.db"); // deliberately nested — proves openStore creates the parent dir
  const db = openStore(dbPath);
  try {
    fn(db, dbPath);
  } finally {
    closeStore(db);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("openStore: creates the parent .lakshx/ directory and the schema", () => {
  withTempDb((db, dbPath) => {
    assert.ok(fs.existsSync(dbPath));
    assert.equal(countChunks(db), 0);
  });
});

test("meta: set/get round-trips, unset key is undefined", () => {
  withTempDb((db) => {
    assert.equal(getMeta(db, "providerId"), undefined);
    setMeta(db, "providerId", "openai");
    assert.equal(getMeta(db, "providerId"), "openai");
    setMeta(db, "providerId", "mistral"); // upsert, not insert-fails-on-conflict
    assert.equal(getMeta(db, "providerId"), "mistral");
  });
});

test("upsertFile: inserts chunk rows + a files row, queryable back with embeddings intact", () => {
  withTempDb((db) => {
    upsertFile(db, "src/a.js", "hash1", [
      { startLine: 1, endLine: 5, text: "function a() {}", embedding: [0.1, 0.2, 0.3] },
      { startLine: 6, endLine: 10, text: "function b() {}", embedding: [0.4, 0.5, 0.6] },
    ]);
    assert.equal(countChunks(db), 2);
    assert.equal(getFileHash(db, "src/a.js"), "hash1");
    const rows = getAllChunkRows(db);
    assert.equal(rows.length, 2);
    const first = rows.find((r) => r.startLine === 1);
    assert.equal(first.filePath, "src/a.js");
    assert.equal(first.chunkText, "function a() {}");
    assert.equal(first.embedding.length, 3);
    assert.ok(Math.abs(first.embedding[0] - 0.1) < 1e-6);
  });
});

test("upsertFile: re-indexing the SAME file replaces its chunks (no stale duplicates)", () => {
  withTempDb((db) => {
    upsertFile(db, "a.js", "hash1", [{ startLine: 1, endLine: 2, text: "old", embedding: [1, 0] }]);
    upsertFile(db, "a.js", "hash2", [
      { startLine: 1, endLine: 3, text: "new1", embedding: [1, 0] },
      { startLine: 4, endLine: 6, text: "new2", embedding: [0, 1] },
    ]);
    assert.equal(countChunks(db), 2);
    assert.equal(getFileHash(db, "a.js"), "hash2");
    const rows = getAllChunkRows(db);
    assert.ok(rows.every((r) => r.chunkText !== "old"));
  });
});

test("upsertFile: chunks from DIFFERENT files are independent (touching one doesn't disturb the other)", () => {
  withTempDb((db) => {
    upsertFile(db, "a.js", "h1", [{ startLine: 1, endLine: 1, text: "a", embedding: [1, 0] }]);
    upsertFile(db, "b.js", "h2", [{ startLine: 1, endLine: 1, text: "b", embedding: [0, 1] }]);
    upsertFile(db, "a.js", "h1b", [{ startLine: 1, endLine: 1, text: "a2", embedding: [1, 1] }]);
    assert.equal(countChunks(db), 2);
    assert.equal(getFileHash(db, "b.js"), "h2");
  });
});

test("deleteFile: removes both the chunk rows and the files row", () => {
  withTempDb((db) => {
    upsertFile(db, "a.js", "h1", [{ startLine: 1, endLine: 1, text: "a", embedding: [1] }]);
    deleteFile(db, "a.js");
    assert.equal(countChunks(db), 0);
    assert.equal(getFileHash(db, "a.js"), undefined);
    assert.deepEqual(listIndexedFiles(db), []);
  });
});

test("getAllFileHashes: returns a Map covering every indexed file in one query", () => {
  withTempDb((db) => {
    upsertFile(db, "a.js", "ha", [{ startLine: 1, endLine: 1, text: "a", embedding: [1] }]);
    upsertFile(db, "b.js", "hb", [{ startLine: 1, endLine: 1, text: "b", embedding: [1] }]);
    const map = getAllFileHashes(db);
    assert.equal(map.get("a.js"), "ha");
    assert.equal(map.get("b.js"), "hb");
    assert.equal(map.size, 2);
  });
});
