// Rolling, bounded per-document edit history. Gives the model "what did the
// developer just do" context so it can predict the NEXT analogous edit
// (Cursor/Zed-style next-edit prediction), instead of just continuing
// whatever text sits before the cursor like plain autocomplete.
//
// Everything here is a pure function over plain arrays/objects — no vscode
// Range/Position types, no document handles — so it's covered directly by
// `node --test` with fabricated change events. extension.js adapts real
// vscode.TextDocumentContentChangeEvent objects into the plain `{line,
// removedChars, insertedText}` shape these functions expect.
"use strict";

/** Hard caps — both are "privacy + latency" bounds from the task brief: we
 * never accumulate an unbounded log of everything typed, and we never ship
 * more than a small, fixed-size window of it to the model. */
const DEFAULT_MAX_ENTRIES = 5;
const DEFAULT_MAX_SUMMARY_CHARS = 500;
/** Per-edit insertion text is truncated before it ever enters the buffer, so
 * even a giant paste only ever contributes a short snippet to history. */
const MAX_INSERTED_CHARS_PER_EDIT = 160;

function truncate(s, n) {
  if (typeof s !== "string") return "";
  return s.length <= n ? s : s.slice(0, n) + "…"; // trailing ellipsis marks truncation
}

/**
 * Build a bounded history entry from a raw change event's essentials.
 * @param {{line:number, removedChars:number, insertedText:string, ts?:number}} change
 */
function makeEditEntry(change) {
  return {
    line: Number.isFinite(change.line) ? change.line : 0,
    removedChars: Math.max(0, change.removedChars | 0),
    insertedText: truncate(change.insertedText || "", MAX_INSERTED_CHARS_PER_EDIT),
    ts: change.ts ?? Date.now(),
  };
}

/**
 * Append an edit to a document's history buffer, dropping the oldest entry
 * once bounded length `maxEntries` is exceeded. Returns a NEW array (does
 * not mutate `buffer`), so callers can hold immutable snapshots.
 */
function pushEdit(buffer, change, maxEntries = DEFAULT_MAX_ENTRIES) {
  const entry = makeEditEntry(change);
  const next = buffer.concat([entry]);
  if (next.length > maxEntries) next.splice(0, next.length - maxEntries);
  return next;
}

/**
 * Render a history buffer as compact, model-friendly text, oldest first,
 * hard-capped at `maxChars` total (a second, coarser privacy/latency bound
 * on top of the per-edit truncation in `makeEditEntry`).
 */
function summarizeEdits(buffer, maxChars = DEFAULT_MAX_SUMMARY_CHARS) {
  if (!Array.isArray(buffer) || buffer.length === 0) return "";
  const lines = [];
  let used = 0;
  for (const e of buffer) {
    const insertedFlat = (e.insertedText || "").replace(/\n/g, "\\n");
    const removedPart = e.removedChars ? `-${e.removedChars}ch ` : "";
    const line = `L${e.line}: ${removedPart}+"${insertedFlat}"`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_SUMMARY_CHARS,
  MAX_INSERTED_CHARS_PER_EDIT,
  makeEditEntry,
  pushEdit,
  summarizeEdits,
};
