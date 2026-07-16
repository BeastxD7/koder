// Indexing PLAN logic — pure decision-making, no vscode, no network, no
// sqlite. extension.js is the only side that touches vscode.workspace.findFiles
// / reads file bytes / calls the embeddings API / writes to the store; it
// feeds plain {filePath, text} records in here and gets back a plan
// (which files need (re)embedding, which chunks, which stored files should
// be pruned) that it then executes. Keeping this file vscode-free means the
// correctness-critical surface — hash-based change detection, what counts
// as "needs update", chunk-count estimation for the cost-guardrail — is
// directly `node --test`-able.
//
// Bounds mirror product/lakshx-graph/extension.js's SCAN_MAX_FILES/
// SCAN_EXCLUDE conceptually (same reasoning: a bounded STATIC scan, common
// build/vendor dirs skipped even without files.exclude settings). Reused as
// a documented CONVENTION, not a code import — this extension does not
// depend on lakshx-graph (standalone requirement).
"use strict";

const crypto = require("node:crypto");
const { chunkText } = require("./chunker.js");

const SCAN_MAX_FILES = 2000; // hard cap on files walked per full index
const SCAN_MAX_BYTES = 512 * 1024; // per-file size cap; larger files are skipped (binary/minified/lockfile-shaped)
const SCAN_INCLUDE = "**/*"; // narrowed to text-ish files by extension.js's own binary/size checks, not by extension allowlist — search is deliberately not language-scoped
const SCAN_EXCLUDE = "**/{node_modules,.git,dist,build,out,.next,.venv,venv,__pycache__,coverage,vendor,.lakshx}/**";
// Same directory list as SCAN_EXCLUDE's glob, as plain segments — used both
// by the vscode.workspace.findFiles(SCAN_EXCLUDE) call (full rebuild) AND by
// the incremental per-file save handler, which doesn't get to run a
// findFiles glob for a single already-known path and needs a pure JS check
// instead. Keeping ONE list (not two) means a path is never in-scope for one
// path and out-of-scope for the other.
const EXCLUDED_DIR_SEGMENTS = ["node_modules", ".git", "dist", "build", "out", ".next", ".venv", "venv", "__pycache__", "coverage", "vendor", ".lakshx"];

/** True if a workspace-relative, forward-slash path falls under one of EXCLUDED_DIR_SEGMENTS at any depth. */
function isExcludedPath(relPath) {
  const segments = relPath.split("/");
  return segments.some((seg) => EXCLUDED_DIR_SEGMENTS.includes(seg));
}

/**
 * Cheap binary sniff: a NUL byte anywhere in the sample means "not text" —
 * the same heuristic git/most editors use, good enough to keep an
 * accidental binary (image, compiled artifact that slipped past the
 * directory denylist) from being "chunked" as garbage text and burning an
 * embeddings-API call on it.
 */
function looksBinary(buffer) {
  const sample = buffer.length > 8000 ? buffer.subarray(0, 8000) : buffer;
  return sample.includes(0);
}

/** sha1 of file content — cheap, sufficient for "did this file change" detection (not a security hash). */
function contentHash(text) {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex");
}

/**
 * Decide what a full-index (or rebuild) pass needs to do, given the current
 * workspace file contents and what's already recorded in the store.
 *
 * @param {Array<{filePath:string, text:string}>} files current workspace files (already walked/filtered by extension.js)
 * @param {Map<string,string>} storedHashes filePath -> content_hash, from store.js's files table
 * @param {{chunkLines?:number, overlapLines?:number}} [chunkOpts]
 * @returns {{
 *   toUpdate: Array<{filePath:string, hash:string, chunks:Array<{startLine:number,endLine:number,text:string}>}>,
 *   toDelete: string[],
 *   unchanged: number,
 * }}
 */
function planFullIndex(files, storedHashes, chunkOpts = {}) {
  const seen = new Set();
  const toUpdate = [];
  let unchanged = 0;
  for (const f of files) {
    seen.add(f.filePath);
    const hash = contentHash(f.text);
    if (storedHashes.get(f.filePath) === hash) {
      unchanged++;
      continue;
    }
    const chunks = chunkText(f.text, chunkOpts);
    toUpdate.push({ filePath: f.filePath, hash, chunks });
  }
  const toDelete = [...storedHashes.keys()].filter((p) => !seen.has(p));
  return { toUpdate, toDelete, unchanged };
}

/**
 * Same decision for a SINGLE file (the incremental re-sync path: a file-save
 * event). Returns null if the file's content hash hasn't actually changed
 * (a save with no real content change, or a re-save of an already-current
 * file) — the caller should treat null as "nothing to do", not re-embed.
 *
 * @param {string} filePath
 * @param {string} text
 * @param {string|undefined} storedHash
 * @param {{chunkLines?:number, overlapLines?:number}} [chunkOpts]
 */
function planFileUpdate(filePath, text, storedHash, chunkOpts = {}) {
  const hash = contentHash(text);
  if (hash === storedHash) return null;
  return { filePath, hash, chunks: chunkText(text, chunkOpts) };
}

/** Total chunk count a plan would (re-)embed — this is exactly the number shown in the cost-guardrail confirmation dialog before any API calls happen. */
function estimateChunkCount(toUpdate) {
  return toUpdate.reduce((sum, f) => sum + f.chunks.length, 0);
}

/** How many embeddings-API HTTP calls a chunk count would take at a given batch size — the other cost-guardrail number ("~N chunks across ~M requests"). */
function estimateBatchCount(chunkCount, batchSize) {
  const size = Math.max(1, Math.floor(batchSize));
  return Math.ceil(chunkCount / size);
}

module.exports = {
  SCAN_MAX_FILES,
  SCAN_MAX_BYTES,
  SCAN_INCLUDE,
  SCAN_EXCLUDE,
  EXCLUDED_DIR_SEGMENTS,
  isExcludedPath,
  looksBinary,
  contentHash,
  planFullIndex,
  planFileUpdate,
  estimateChunkCount,
  estimateBatchCount,
};
