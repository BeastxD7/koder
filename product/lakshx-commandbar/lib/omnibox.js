// Pure logic for the LakshX Command Bar omnibox: fuzzy scoring, per-source
// ranking/merging into a sectioned list, glob-escaping for file search, a
// staleness/generation guard for cancelling stale async work, and a
// dependency-injectable debounce. Nothing in this file touches `vscode` or
// real timers, so it's exercised by plain `node --test` (see ../test/).
"use strict";

// ---------------------------------------------------------------------------
// Fuzzy scoring
// ---------------------------------------------------------------------------

/**
 * Case-insensitive subsequence fuzzy match of `query` against `text`.
 * Returns a numeric score (higher = better) or -1 if `query` isn't a
 * subsequence of `text` at all. Empty query matches everything with score 0
 * (used so an empty omnibox query still shows results, e.g. recent files).
 *
 * Scoring rewards (roughly, in the same spirit as VS Code's own filters):
 *  - an exact substring match (big bonus, more for matching at position 0)
 *  - consecutive-character runs (typing "abc" hitting "abc" back to back)
 *  - matches right after a word boundary (/, -, _, space, or a camelCase hump)
 * It is deliberately simple, not a reimplementation of VS Code's internal
 * fuzzy scorer (which isn't part of the public API surface).
 */
function fuzzyScore(query, text) {
  if (!query) return 0;
  if (!text) return -1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  const substringIdx = t.indexOf(q);
  let score = 0;
  if (substringIdx !== -1) {
    score += 1000 - substringIdx; // earlier substring match wins
    if (substringIdx === 0) score += 200;
  }

  // Subsequence walk, rewarding consecutive runs and boundary starts.
  let qi = 0;
  let ti = 0;
  let consecutive = 0;
  let matchedAny = false;
  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      matchedAny = true;
      consecutive += 1;
      score += 10 + consecutive * 5;
      const prev = ti > 0 ? text[ti - 1] : "";
      const isBoundary = ti === 0 || /[/\-_.\s]/.test(prev) || (/[A-Z]/.test(text[ti]) && /[a-z]/.test(prev));
      if (isBoundary) score += 15;
      qi += 1;
      ti += 1;
    } else {
      consecutive = 0;
      ti += 1;
    }
  }
  if (qi < q.length) return -1; // not all query chars were found in order
  if (!matchedAny && q.length > 0) return -1;
  // Slightly penalize long texts so shorter, more-specific matches rank first.
  score -= Math.min(text.length, 200) * 0.1;
  return score;
}

/**
 * Score a candidate against a query using its best-matching field. `fields`
 * is an ordered list of strings to try (e.g. [label, description]); the
 * highest score among fields that match is returned, or -1 if none match.
 */
function matchQuery(query, fields) {
  let best = -1;
  for (const f of fields) {
    if (!f) continue;
    const s = fuzzyScore(query, f);
    if (s > best) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Glob building for vscode.workspace.findFiles
// ---------------------------------------------------------------------------

const GLOB_SPECIAL = /[*?[\]{}()!+@]/g;

/** Escape glob-special characters so raw user input is safe to embed in a glob pattern. */
function escapeGlob(input) {
  return String(input).replace(GLOB_SPECIAL, (c) => `[${c}]`);
}

/**
 * Build a bounded substring-match glob for a file-search query, e.g.
 * "foo bar" -> "**\/*foo bar*". Whitespace is preserved (VS Code's findFiles
 * glob matches it literally), only glob metacharacters are escaped. Empty
 * query yields a glob matching everything.
 */
function buildFileGlob(query) {
  const q = escapeGlob(String(query || "").trim());
  return q ? `**/*${q}*` : "**/*";
}

// ---------------------------------------------------------------------------
// Ranking + sectioning
// ---------------------------------------------------------------------------

/** Sort a list of already-scored items by score desc (stable) and cap the count. */
function rankSection(items, cap) {
  return items
    .map((item, idx) => ({ item, idx })) // idx keeps the sort stable across equal scores
    .sort((a, b) => b.item.score - a.item.score || a.idx - b.idx)
    .slice(0, cap)
    .map((x) => x.item);
}

/**
 * Assemble the final flat list for the quick pick: ranks + caps each section,
 * then concatenates them in the given section order, each preceded by a
 * separator descriptor `{ kind: "separator", label }` when the section is
 * non-empty. Sections with no items are omitted entirely (no empty headers).
 *
 * `sections` is an ordered array of `{ key, title, items, cap }`. Returns a
 * flat array of `{ kind: "separator", label }` or `{ kind: "item", section, ...item }`.
 */
function buildQuickPickItems(sections, defaultCap = 8) {
  const out = [];
  for (const section of sections) {
    const cap = section.cap != null ? section.cap : defaultCap;
    const ranked = rankSection(section.items || [], cap);
    if (ranked.length === 0) continue;
    out.push({ kind: "separator", label: section.title });
    for (const item of ranked) {
      out.push({ kind: "item", section: section.key, ...item });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Staleness / generation guard
// ---------------------------------------------------------------------------

/**
 * A tiny counter-based guard for cancelling stale async work: call `next()`
 * each time a new query starts to get a token, then check `isCurrent(token)`
 * after an await resolves before applying its results. If the user typed
 * again in the meantime, `next()` will have been called again and the old
 * token is no longer current, so its results are dropped instead of racing
 * onto the screen out of order.
 */
function createGeneration() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
  };
}

// ---------------------------------------------------------------------------
// Debounce (timer functions injectable so this is testable without real time)
// ---------------------------------------------------------------------------

/**
 * Returns a debounced wrapper around `fn`: repeated calls within `waitMs`
 * collapse into a single trailing call with the latest arguments. The timer
 * functions are injectable (`setTimeoutFn`/`clearTimeoutFn`) precisely so
 * unit tests can supply fakes and assert scheduling behavior without
 * sleeping in real time.
 */
function createDebounced(fn, waitMs, opts) {
  const setTimeoutFn = (opts && opts.setTimeoutFn) || setTimeout;
  const clearTimeoutFn = (opts && opts.clearTimeoutFn) || clearTimeout;
  let timer = null;

  function debounced(...args) {
    if (timer !== null) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      timer = null;
      fn(...args);
    }, waitMs);
  }
  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  };
  return debounced;
}

module.exports = {
  fuzzyScore,
  matchQuery,
  escapeGlob,
  buildFileGlob,
  rankSection,
  buildQuickPickItems,
  createGeneration,
  createDebounced,
};
