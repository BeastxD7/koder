// Local vector store for LakshX Search — `.lakshx/search-index.db`, using
// Node's built-in `node:sqlite` (DatabaseSync). Same zero-native-dependency
// approach as product/lakshx-db/lib/drivers/sqlite.js: no better-sqlite3/no
// native module (breaks cross-platform packaging), no WASM fallback needed,
// verified against this fork's shipped runtime (Electron 42.5.0 / Node
// 24.17.0, where require("node:sqlite") resolves and DatabaseSync works).
//
// Vector storage is plain SQLite, not a vector extension (sqlite-vss/vec0
// etc. would need a native/loadable extension — exactly the dependency this
// approach avoids). Similarity is computed in JS (lib/similarity.js) over
// all stored rows, which is fine at "single repo's chunk count" scale (the
// brief's own framing) — this is NOT meant to scale to millions of vectors.
//
// Embeddings are stored as a BLOB of raw float32 bytes (not JSON text) —
// ~4 bytes/dimension instead of ~15-20 chars/dimension as decimal text, a
// meaningful size difference at thousands of rows × 1536 dims, and trivial
// to round-trip with a Float32Array view over the Buffer.
//
// The require stays lazy inside getSqlite() so merely loading this module
// (e.g. from a unit test importing chunker/similarity from the same
// directory) can't throw on an exotic runtime — matches lakshx-db's pattern.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function getSqlite() {
  try {
    return require("node:sqlite");
  } catch {
    throw new Error(
      "This runtime doesn't provide the built-in node:sqlite module (needs Node.js >= 22.13 in the extension host).",
    );
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS files (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
`;

/** Float32 array -> compact BLOB. Exported for unit tests (pure, no db). */
function floatsToBuffer(floats) {
  const f32 = Float32Array.from(floats);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** BLOB -> plain number[] (round-trips floatsToBuffer). Exported for unit tests. */
function bufferToFloats(buf) {
  const aligned = Buffer.from(buf); // copy onto an aligned, standalone ArrayBuffer — the BLOB's backing buffer isn't guaranteed 4-byte aligned at buf.byteOffset
  const f32 = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
  return Array.from(f32);
}

/** Opens (creating parent dirs + the file + schema if needed) the index DB at `dbPath`. */
function openStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = getSqlite();
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  return db;
}

function closeStore(db) {
  try {
    db?.close();
  } catch {}
}

function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : undefined;
}

function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

function getFileHash(db, filePath) {
  const row = db.prepare("SELECT content_hash FROM files WHERE file_path = ?").get(filePath);
  return row ? row.content_hash : undefined;
}

/** filePath -> content_hash for every indexed file, in one query — used by planFullIndex's change-detection instead of N per-file lookups. */
function getAllFileHashes(db) {
  const map = new Map();
  for (const row of db.prepare("SELECT file_path, content_hash FROM files").all()) {
    map.set(row.file_path, row.content_hash);
  }
  return map;
}

function listIndexedFiles(db) {
  return db
    .prepare("SELECT file_path FROM files")
    .all()
    .map((r) => r.file_path);
}

function countChunks(db) {
  return db.prepare("SELECT count(*) AS n FROM chunks").get().n;
}

/** Replace all chunks for `filePath` in one transaction — the incremental re-sync unit (whole-file granularity: a save re-embeds that file's chunks only, not the repo). */
function upsertFile(db, filePath, contentHash, chunks) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
    const insertChunk = db.prepare("INSERT INTO chunks (file_path, start_line, end_line, chunk_text, embedding) VALUES (?, ?, ?, ?, ?)");
    for (const c of chunks) {
      insertChunk.run(filePath, c.startLine, c.endLine, c.text, floatsToBuffer(c.embedding));
    }
    db.prepare(
      "INSERT INTO files (file_path, content_hash, chunk_count, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET content_hash = excluded.content_hash, chunk_count = excluded.chunk_count, updated_at = excluded.updated_at",
    ).run(filePath, contentHash, chunks.length, Date.now());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Removes a file's chunks entirely (used both for the "file deleted from workspace" prune and for a file that re-scans to zero chunks). */
function deleteFile(db, filePath) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
    db.prepare("DELETE FROM files WHERE file_path = ?").run(filePath);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** All chunk rows with embeddings decoded back to number[] — the full scan rankChunks() runs over. */
function getAllChunkRows(db) {
  return db
    .prepare("SELECT file_path AS filePath, start_line AS startLine, end_line AS endLine, chunk_text AS chunkText, embedding FROM chunks")
    .all()
    .map((r) => ({ filePath: r.filePath, startLine: r.startLine, endLine: r.endLine, chunkText: r.chunkText, embedding: bufferToFloats(r.embedding) }));
}

module.exports = {
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
};
