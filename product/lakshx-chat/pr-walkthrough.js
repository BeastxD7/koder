// PR/diff walkthrough auto-generator (docs/research/16-ide-feature-roadmap-round2.md
// §"PR walkthrough auto-generator") — pure prompt-assembly for the `/walkthrough`
// slash command. Zero vscode/fs/child_process dependency, directly unit-testable
// with plain `node --test`, same extraction rationale as crash-context.js:
// extension.js can't be exercised without a running Extension Host, this can.
//
// extension.js's "walkthrough" handler does all the vscode/fs/git work (shelling
// out to `git diff` / `git diff --cached` / `git log`, reading a bounded set of
// workspace files for the dependents/coverage scan below) and hands the raw,
// already-resolved strings/arrays in here. This module only turns that data into
// the two things the rest of the flow needs, mirroring crash-context.js's split
// exactly:
//
//   - `displayText` — short, goes in the persisted/rendered "user" bubble (e.g.
//                     "Generate a PR walkthrough for the current changes (3
//                     files changed)"), exactly like buildCrashDisplayText().
//   - `promptBlock` — the full `<pr_context>...</pr_context>` block, folded into
//                     the OUTGOING prompt text only (never shown/persisted as
//                     the user message) — the same "display stays clean, model
//                     gets the full context" split extension.js's
//                     buildFileBlock()/`<file>` chip expansion and
//                     crash-context.js's `<exception>` block both already use.
//
// IMPORTANT SCOPING NOTE (per the task this was built from): the "dependency
// graph" data this module produces is a SMALL, BOUNDED, SELF-CONTAINED
// heuristic (see findLightweightDependents below) — a grep-style regex import
// scan over a capped file set, deliberately NOT the full algorithm
// product/lakshx-graph/lib/depgraph.js implements (multi-language resolution,
// index-file resolution, external-package nodes, cycle detection via Tarjan's
// SCC, ...). This file does not import from or call into lakshx-graph at all:
// VS Code extensions can't reach into each other's internals without a defined
// cross-extension API, and lakshx-graph doesn't expose one. What's here is an
// independent, much smaller scan that answers exactly one bounded question
// ("which OTHER files in the capped scan set import this changed file via a
// relative specifier") — good enough to ground a walkthrough narration, not a
// substitute for a real dependency graph.
"use strict";

const { capText } = require("./diagnostics.js");

// ---------------------------------------------------------------------------
// Bounds — same spirit as extension.js's MAX_ATTACH_LINES/MAX_ATTACH_CHARS and
// crash-context.js's MAX_CRASH_FRAMES: never hand the model (or this module's
// own scan) an unbounded amount of work/context just because a diff or a
// workspace happened to be huge.
// ---------------------------------------------------------------------------
const MAX_SCAN_FILES = 300; // how many workspace files findLightweightDependents will look through
const MAX_DEPENDENTS_PER_FILE = 8; // how many dependents findLightweightDependents returns per file
const MAX_FILES_SUMMARIZED = 20; // how many changed files buildWalkthroughPrompt describes in detail
const MAX_DEPENDENTS_SHOWN = 5; // how many dependents buildWalkthroughPrompt lists per file (belt-and-suspenders on top of MAX_DEPENDENTS_PER_FILE)
const MAX_HUNKS_PER_FILE = 4; // how many hunks buildWalkthroughPrompt shows per file
const MAX_HUNK_LINES = 30; // how many lines of a single hunk buildWalkthroughPrompt shows
const MAX_COMMITS = 15; // how many recent commit messages buildWalkthroughPrompt includes
const MAX_PROMPT_CHARS = 20_000; // final safety clip on the whole <pr_context> block (capText's head/tail)

// ---------------------------------------------------------------------------
// getDiffSummary — small, self-contained unified-diff parser
// ---------------------------------------------------------------------------

// `diff --git a/X b/Y` — non-greedy on the first group so filenames containing
// " b/" substrings don't break the split; this is a heuristic (real git diff
// output can, in rare cases with spaces in paths, be ambiguous to a regex),
// not a full diff-format implementation.
const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
// `@@ -oldStart[,oldLines] +newStart[,newLines] @@ optional section heading`
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parse a unified git diff (as produced by `git diff`, `git diff --cached`, or
 * a concatenation of both) into `{files: [{path, additions, deletions, hunks}]}`.
 *
 * - `path` is the "b/" (post-image) path from the `diff --git` line — for a
 *   plain edit this is the file's path; for a rename it's the NEW path; for a
 *   delete it's still whatever git prints there (typically the same as the
 *   old path, since git only emits a distinct `b/...` for renames/copies).
 * - `additions`/`deletions` count `+`/`-` lines actually inside a hunk (not
 *   the `+++`/`---` file-header lines, which appear before any hunk starts).
 * - `hunks` is `[{header, oldStart, oldLines, newStart, newLines, lines}]`
 *   where `lines` are the raw diff lines (including their leading
 *   `+`/`-`/` ` marker) belonging to that hunk, in order.
 *
 * Never throws: malformed/empty/non-diff input just yields `{files: []}` (or
 * files with no hunks, for e.g. binary-file or mode-only changes).
 */
function getDiffSummary(diffText) {
  const files = [];
  let cur = null;
  let curHunk = null;
  const lines = String(diffText ?? "").split(/\r?\n/);
  for (const line of lines) {
    const gitMatch = DIFF_GIT_RE.exec(line);
    if (gitMatch) {
      cur = { path: gitMatch[2], additions: 0, deletions: 0, hunks: [] };
      curHunk = null;
      files.push(cur);
      continue;
    }
    if (!cur) continue; // stray preamble before the first "diff --git" line
    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      curHunk = {
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1,
        lines: [],
      };
      cur.hunks.push(curHunk);
      continue;
    }
    if (!curHunk) continue; // "index ...", "--- a/x", "+++ b/x", "new file mode ...", "Binary files ... differ", etc.
    if (line.startsWith("+")) {
      cur.additions++;
      curHunk.lines.push(line);
    } else if (line.startsWith("-")) {
      cur.deletions++;
      curHunk.lines.push(line);
    } else if (line.startsWith(" ") || line === "" || line.startsWith("\\")) {
      // context line, blank context line, or "\ No newline at end of file"
      curHunk.lines.push(line);
    }
  }
  return { files };
}

// ---------------------------------------------------------------------------
// findLightweightDependents — bounded, self-contained import scan
// ---------------------------------------------------------------------------

// Minimal local path helpers, deliberately reimplemented here (not required
// from lakshx-graph) so this module has zero cross-extension coupling. All
// paths are treated as POSIX-style workspace-relative strings; the caller
// (extension.js) is responsible for normalizing before calling in, same
// convention depgraph.js documents for its own callers.
function dirnameOf(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function normalizePath(p) {
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else parts.push("..");
    } else parts.push(seg);
  }
  return parts.join("/");
}
function joinPath(dir, rel) {
  return normalizePath(dir ? dir + "/" + rel : rel);
}
// Strip a common JS/TS extension for loose comparison (e.g. an import of
// "./foo" should match a target of "foo.js") — NOT full resolution: unlike
// depgraph.js this does not try index-file resolution, multiple candidate
// extensions, or non-JS languages. That's the intentional scope cut.
function stripKnownExt(p) {
  return String(p ?? "").replace(/\.(mjs|cjs|jsx?|tsx?)$/i, "");
}

// Matches a relative specifier (starts with ".") inside `from "..."`,
// `require("...")`, or `import("...")` — a deliberately small subset of
// depgraph.js's JS_PATTERNS, scoped to exactly what this feature needs
// ("does another changed-diff-adjacent file import this one"), not general
// import extraction (no bare "export ... from" side-effect imports, no
// dynamic non-relative specifiers, no Python).
const REL_IMPORT_RE =
  /\bfrom\s*["'`](\.[^"'`]*)["'`]|\brequire\s*\(\s*["'`](\.[^"'`]*)["'`]\s*\)|\bimport\s*\(\s*["'`](\.[^"'`]*)["'`]\s*\)/g;

/**
 * Bounded, self-contained heuristic: which files in `workspaceFiles` (an
 * array of `{path, text}`, workspace-relative POSIX paths) import `filePath`
 * via a relative `./`/`../` specifier. Scans at most `opts.maxFiles`
 * (default MAX_SCAN_FILES) files and returns at most `opts.maxDependents`
 * (default MAX_DEPENDENTS_PER_FILE) matches, in `workspaceFiles` order.
 *
 * THIS IS NOT product/lakshx-graph/lib/depgraph.js's algorithm. It does not:
 *   - resolve bare/package imports (only relative specifiers count),
 *   - try index-file resolution ("./dir" resolving to "./dir/index.js"),
 *   - understand aliased paths (tsconfig `paths`, webpack aliases, monorepo
 *     package names),
 *   - understand non-JS/TS languages,
 *   - do anything beyond a single-pass regex scan of raw file text (so
 *     import-like text inside a comment or string can false-positive, same
 *     documented tradeoff depgraph.js makes for its own regex scan).
 * It is a "good enough to ground a walkthrough narration" heuristic, not a
 * dependency graph.
 *
 * @param {string} filePath
 * @param {Array<{path:string, text:string}>} workspaceFiles
 * @param {{maxFiles?:number, maxDependents?:number}} [opts]
 * @returns {string[]} dependent file paths
 */
function findLightweightDependents(filePath, workspaceFiles, opts = {}) {
  const maxFiles = opts.maxFiles ?? MAX_SCAN_FILES;
  const maxDependents = opts.maxDependents ?? MAX_DEPENDENTS_PER_FILE;
  const targetKey = stripKnownExt(filePath);
  const dependents = [];
  const files = Array.isArray(workspaceFiles) ? workspaceFiles.slice(0, maxFiles) : [];
  for (const f of files) {
    if (!f || typeof f.path !== "string" || f.path === filePath) continue;
    if (typeof f.text !== "string" || !f.text) continue;
    REL_IMPORT_RE.lastIndex = 0;
    let m;
    let isDependent = false;
    while ((m = REL_IMPORT_RE.exec(f.text)) !== null) {
      const spec = m[1] || m[2] || m[3];
      if (!spec) continue;
      const resolved = joinPath(dirnameOf(f.path), spec);
      if (stripKnownExt(resolved) === targetKey) {
        isDependent = true;
        break;
      }
    }
    if (isDependent) {
      dependents.push(f.path);
      if (dependents.length >= maxDependents) break;
    }
  }
  return dependents;
}

// ---------------------------------------------------------------------------
// hasTestCoverage — simple, bounded, documented heuristic
// ---------------------------------------------------------------------------

function extnameOf(p) {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot);
}
function basenameNoExt(p) {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const ext = extnameOf(p);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * Simple heuristic: does a plausibly-matching test file exist for `filePath`
 * among `workspaceFiles` (array of `{path}` objects, or plain path strings)?
 * Checks, relative to `filePath`'s own directory: `<name>.test.<ext>`,
 * `<name>.spec.<ext>`, `test/<name>.test.<ext>`, `tests/<name>.test.<ext>`,
 * and `__tests__/<name>.test.<ext>` — this matches this very repo's own
 * convention (e.g. `commands.js` <-> `test/commands.test.js`).
 *
 * This is NOT a coverage tool: it only checks that a same-named test file
 * EXISTS, never whether it actually imports/exercises `filePath`, nor what
 * fraction of it runs. A file with an unconventionally-named test suite (or
 * one covered only indirectly, via another module's tests) reads as
 * "no test file found" here — a deliberately cheap, bounded proxy, not a
 * real coverage measurement.
 *
 * @param {string} filePath
 * @param {Array<{path:string}|string>} workspaceFiles
 */
function hasTestCoverage(filePath, workspaceFiles) {
  const paths = new Set(
    (Array.isArray(workspaceFiles) ? workspaceFiles : [])
      .map((f) => (typeof f === "string" ? f : f && f.path))
      .filter((p) => typeof p === "string"),
  );
  const dir = dirnameOf(filePath);
  const ext = extnameOf(filePath) || ".js";
  const name = basenameNoExt(filePath);
  const prefix = dir ? `${dir}/` : "";
  const candidates = [
    `${prefix}${name}.test${ext}`,
    `${prefix}${name}.spec${ext}`,
    `${prefix}test/${name}.test${ext}`,
    `${prefix}tests/${name}.test${ext}`,
    `${prefix}__tests__/${name}.test${ext}`,
  ];
  return candidates.some((c) => paths.has(c));
}

// ---------------------------------------------------------------------------
// buildWalkthroughPrompt — composes ONE rich prompt block; display stays short
// ---------------------------------------------------------------------------

/** Short display text for the persisted/rendered "user" bubble — never carries the full diff/context. */
function buildWalkthroughDisplayText(fileCount) {
  if (!fileCount) return "Generate a PR walkthrough for the current changes";
  return `Generate a PR walkthrough for the current changes (${fileCount} file${fileCount === 1 ? "" : "s"} changed)`;
}

/**
 * Assemble the full `<pr_context>` prompt block plus the short display text,
 * mirroring crash-context.js's `buildCrashContext()` return shape exactly:
 * `{displayText, promptBlock}`. Every input is optional/defensive — a missing
 * dependents/testCoverage/commitMessages entry just renders as "none found"
 * rather than throwing, same "degrade to a placeholder, don't omit the tag"
 * rule crash-context.js's buildExceptionPromptBlock follows.
 *
 * @param {object} p
 * @param {{files: Array}} p.diffSummary - getDiffSummary()'s return value
 * @param {Object<string, string[]>} [p.dependents] - filePath -> dependent file paths (e.g. from findLightweightDependents)
 * @param {Object<string, boolean>} [p.testCoverage] - filePath -> hasTestCoverage() result
 * @param {string[]} [p.commitMessages] - recent commit summaries, newest first
 */
function buildWalkthroughPrompt({ diffSummary, dependents = {}, testCoverage = {}, commitMessages = [] } = {}) {
  const allFiles = Array.isArray(diffSummary?.files) ? diffSummary.files : [];
  const shown = allFiles.slice(0, MAX_FILES_SUMMARIZED);
  const omittedFiles = allFiles.length - shown.length;
  const totalAdd = allFiles.reduce((s, f) => s + (f.additions || 0), 0);
  const totalDel = allFiles.reduce((s, f) => s + (f.deletions || 0), 0);

  const lines = [];
  lines.push("<pr_context>");
  lines.push(`Files changed: ${allFiles.length} (+${totalAdd}/-${totalDel})`);

  for (const f of shown) {
    lines.push("");
    lines.push(`## ${f.path} (+${f.additions ?? 0}/-${f.deletions ?? 0})`);

    const deps = Array.isArray(dependents[f.path]) ? dependents[f.path] : [];
    const depsShown = deps.slice(0, MAX_DEPENDENTS_SHOWN);
    if (depsShown.length) {
      const more = deps.length > depsShown.length ? `, +${deps.length - depsShown.length} more` : "";
      lines.push(`Dependents (lightweight scan): ${depsShown.join(", ")}${more}`);
    } else {
      lines.push("Dependents (lightweight scan): none found in scanned files");
    }

    const covered = testCoverage[f.path];
    lines.push(`Test coverage heuristic: ${covered ? "a matching test file was found" : "no matching test file found"}`);

    const hunks = Array.isArray(f.hunks) ? f.hunks : [];
    const hunksShown = hunks.slice(0, MAX_HUNKS_PER_FILE);
    for (const h of hunksShown) {
      lines.push(h.header);
      const hLines = Array.isArray(h.lines) ? h.lines : [];
      const hLinesShown = hLines.slice(0, MAX_HUNK_LINES);
      for (const l of hLinesShown) lines.push(l);
      if (hLines.length > hLinesShown.length) lines.push(`… (${hLines.length - hLinesShown.length} more line(s) omitted)`);
    }
    if (hunks.length > hunksShown.length) lines.push(`… ${hunks.length - hunksShown.length} more hunk(s) omitted`);
  }
  if (omittedFiles > 0) {
    lines.push("");
    lines.push(`… ${omittedFiles} more file(s) omitted`);
  }

  const commits = Array.isArray(commitMessages) ? commitMessages : [];
  if (commits.length) {
    lines.push("");
    lines.push("Recent commits:");
    for (const m of commits.slice(0, MAX_COMMITS)) lines.push(`- ${m}`);
    if (commits.length > MAX_COMMITS) lines.push(`… ${commits.length - MAX_COMMITS} more commit(s) omitted`);
  }

  lines.push("</pr_context>");
  const promptBlock = capText(lines.join("\n"), MAX_PROMPT_CHARS, MAX_PROMPT_CHARS);

  return { displayText: buildWalkthroughDisplayText(allFiles.length), promptBlock };
}

module.exports = {
  getDiffSummary,
  findLightweightDependents,
  hasTestCoverage,
  buildWalkthroughDisplayText,
  buildWalkthroughPrompt,
  MAX_SCAN_FILES,
  MAX_DEPENDENTS_PER_FILE,
  MAX_FILES_SUMMARIZED,
  MAX_DEPENDENTS_SHOWN,
  MAX_HUNKS_PER_FILE,
  MAX_HUNK_LINES,
  MAX_COMMITS,
  MAX_PROMPT_CHARS,
};
