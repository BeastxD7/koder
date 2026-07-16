// Chunking strategy: fixed-size overlapping LINE windows, not
// function/class-boundary heuristics.
//
// WHY (documented per the build brief, which explicitly asks to pick one and
// say why): depgraph.js (lakshx-graph) shows how much per-language nuance
// even a lightweight regex heuristic needs just to find IMPORT statements
// across two languages (JS family + Python) — comment stripping, multi-line
// specifiers, dynamic import forms, etc. Function/class-boundary chunking
// needs the same kind of per-language grammar (`function`/`def`/`class`/
// brace-matching/indentation rules for Python vs braces for C-like
// languages vs `end` for Ruby...) to avoid producing garbage chunks on
// syntax it doesn't recognize, and this extension has no per-file language
// gate — it indexes whatever text files the workspace has, of any
// extension. A fixed-size overlapping line window:
//   - works identically for any text file regardless of language/markup,
//   - keeps "startLine/endLine" trivial to compute and jump to (the query
//     UI's whole point is click-to-jump — line numbers are the natural unit),
//   - the overlap (a few lines shared between consecutive chunks) means a
//     function/class that straddles a chunk boundary still appears whole in
//     at least one neighboring chunk, which is what boundary-detection would
//     have bought anyway, without the per-language brittleness.
// This is a documented v1 tradeoff, matching depgraph.js's own "regex, not
// AST" tradeoff note — a real AST-aware chunker is future work, not this pass.
//
// Pure, vscode-free — safe to `node --test` directly.
"use strict";

const DEFAULT_CHUNK_LINES = 60;
const DEFAULT_OVERLAP_LINES = 10;

/**
 * Split `text` into overlapping line-range chunks.
 *
 * @param {string} text
 * @param {{chunkLines?: number, overlapLines?: number}} [opts]
 * @returns {Array<{startLine:number, endLine:number, text:string}>}
 *   1-based, inclusive line numbers (matches how editors display them, and
 *   how vscode.Range is built at the call site: startLine-1/endLine-1 for
 *   the 0-based vscode.Position).
 */
function chunkText(text, opts = {}) {
  const chunkLines = Math.max(1, Math.floor(opts.chunkLines ?? DEFAULT_CHUNK_LINES));
  const overlapLines = Math.min(chunkLines - 1, Math.max(0, Math.floor(opts.overlapLines ?? DEFAULT_OVERLAP_LINES)));
  const stride = chunkLines - overlapLines;

  const lines = text.split("\n");
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return [];

  const chunks = [];
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(start + chunkLines, lines.length);
    const slice = lines.slice(start, end);
    // Skip whitespace-only chunks (common at file tails) — nothing useful
    // to embed, and it would waste an API call slot for zero search value.
    if (slice.some((l) => l.trim() !== "")) {
      chunks.push({ startLine: start + 1, endLine: end, text: slice.join("\n") });
    }
    if (end >= lines.length) break;
  }
  return chunks;
}

/** A short, single-line-ish preview for QuickPick result rows: first non-blank line of the chunk, trimmed and length-capped. */
function snippetOf(chunkText_, maxLen = 160) {
  const firstLine = chunkText_.split("\n").find((l) => l.trim() !== "") ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen - 1) + "…" : trimmed;
}

module.exports = { DEFAULT_CHUNK_LINES, DEFAULT_OVERLAP_LINES, chunkText, snippetOf };
