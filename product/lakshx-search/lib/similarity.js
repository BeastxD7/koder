// Cosine similarity + result ranking/merging — pure JS, no native math lib.
// At the scale of a single repo's chunk count (thousands, not billions) a
// plain O(n) scan with a JS dot product is fine; no vector index/ANN
// structure is needed, matching the brief's framing.
//
// vscode-free — safe to `node --test` directly.
"use strict";

/** Dot product of two equal-length numeric vectors. */
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function magnitude(a) {
  return Math.sqrt(dot(a, a));
}

/**
 * Cosine similarity in [-1, 1] (practically [0, 1] for embedding models,
 * which produce non-negative-leaning vectors, but we don't assume that).
 * Returns 0 for a zero-magnitude vector (avoids NaN from a 0/0 divide) and
 * throws on a dimension mismatch — the caller (rankChunks) is expected to
 * have already filtered those out; a mismatch reaching here is a bug, not a
 * bad-data case to silently mask.
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  const ma = magnitude(a);
  const mb = magnitude(b);
  if (ma === 0 || mb === 0) return 0;
  return dot(a, b) / (ma * mb);
}

/**
 * Rank stored chunks against a query embedding.
 *
 * @param {number[]} queryEmbedding
 * @param {Array<{filePath:string, startLine:number, endLine:number, chunkText:string, embedding:number[]}>} rows
 * @param {{topN?: number}} [opts]
 * @returns {Array<row & {score:number}>} sorted desc by score, length <= topN.
 *   Rows whose embedding dimension doesn't match the query's are silently
 *   skipped (not thrown) — this is the real-world case where an index has
 *   stale rows from a since-changed embedding model; the mismatch is
 *   surfaced once at the query-command level (a warning banner), not per row.
 */
function rankChunks(queryEmbedding, rows, opts = {}) {
  const topN = Math.max(1, Math.floor(opts.topN ?? 15));
  const scored = [];
  for (const row of rows) {
    if (!row.embedding || row.embedding.length !== queryEmbedding.length) continue;
    scored.push({ ...row, score: cosineSimilarity(queryEmbedding, row.embedding) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

/**
 * Merge/collapse ranked hits so a single file doesn't monopolize the results
 * list with several overlapping-window chunks that are really "the same
 * spot" (the chunker's overlap deliberately duplicates a few lines between
 * neighboring chunks — without this step a highly-relevant function can
 * show up 2-3 times back to back). Two hits from the same file whose line
 * ranges overlap (or sit within `mergeGapLines` of each other) collapse into
 * one result spanning their union, keeping the higher score and the
 * higher-scoring chunk's text as the representative snippet.
 *
 * @param {Array<{filePath:string, startLine:number, endLine:number, chunkText:string, score:number}>} ranked
 *   already sorted desc by score (rankChunks's output) — merge order follows
 *   that so the surviving representative is always the best-scoring member
 *   of its group.
 * @param {{mergeGapLines?: number}} [opts]
 */
function mergeAdjacentHits(ranked, opts = {}) {
  const mergeGapLines = Math.max(0, Math.floor(opts.mergeGapLines ?? 5));
  const groups = []; // { filePath, startLine, endLine, score, chunkText }
  for (const hit of ranked) {
    const g = groups.find(
      (g) => g.filePath === hit.filePath && hit.startLine <= g.endLine + mergeGapLines && g.startLine <= hit.endLine + mergeGapLines,
    );
    if (!g) {
      groups.push({ filePath: hit.filePath, startLine: hit.startLine, endLine: hit.endLine, score: hit.score, chunkText: hit.chunkText });
      continue;
    }
    g.startLine = Math.min(g.startLine, hit.startLine);
    g.endLine = Math.max(g.endLine, hit.endLine);
    // hit.score <= g.score always holds because `ranked` is sorted desc and
    // g was created by an earlier (>=) scoring hit — keep g's score/text.
  }
  groups.sort((a, b) => b.score - a.score);
  return groups;
}

module.exports = { dot, magnitude, cosineSimilarity, rankChunks, mergeAdjacentHits };
