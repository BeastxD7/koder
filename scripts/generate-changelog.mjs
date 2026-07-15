#!/usr/bin/env node
// Generates "What's New" changelog candidates for
// product/lakshx-chat/changelog.js from real git history, so new entries
// don't require hand-editing that file from scratch every time. Read
// product/lakshx-chat/changelog.js's header comment first — this script
// exists to preserve that file's curation bar ("every entry must trace back
// to a real commit/feature; no aspirational or noise items"), not relax it.
//
// Two trust tiers, matching how much human curation already happened:
//
//   1. TRAILER commits — the commit message carries explicit
//      `Changelog-Title:` / `Changelog-Description:` trailers, e.g.:
//
//          lakshx-chat: add parallel multi-agent subtasks
//
//          <body...>
//
//          Changelog-Title: Parallel multi-agent subtasks
//          Changelog-Description: The agent can now investigate multiple
//          independent things at once, with live per-task progress shown
//          right in the chat.
//          Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
//
//      This mirrors the repo's existing `Co-Authored-By:` trailer
//      convention. Two trailers (not one `Changelog: title — description`
//      line) deliberately, because real entries already contain em dashes
//      in prose (see changelog.js's "Optional reliability tracing" entry:
//      "off by default, and only ever sent to a self-hosted endpoint you
//      configure, never a default remote service" — an em-dash split would
//      mis-parse that). Whoever wrote the commit already curated the
//      user-facing copy, so --apply will append these automatically.
//
//   2. PLAIN commits — everything else in range, after dropping merges and
//      non-user-facing prefixes (ci:, chore:, test:, docs:, build:, deps:).
//      These are printed as review candidates ONLY. --apply never writes
//      them to changelog.js — a human decides whether each one is real,
//      user-facing, and worth a line, then edits/pastes it in by hand. This
//      is the "raw git log is not a changelog" guard: a plain commit
//      subject like "fix: null check" is exactly the noise changelog.js's
//      header comment says not to add.
//
// Usage:
//   node scripts/generate-changelog.mjs                  print all candidates (both tiers) since the last changelog date
//   node scripts/generate-changelog.mjs --since <ref>     override the range (git ref or date)
//   node scripts/generate-changelog.mjs --apply           also append TRAILER-tier commits to changelog.js (plain commits still only print)
//
// NOT wired into CI or the release process — this is a manual tool, run it
// by hand when preparing a release. See the report this script shipped
// with for why, and where the trailer convention should be documented
// (commit template / CONTRIBUTING) so committers actually discover it.
"use strict";

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = join(root, "product", "lakshx-chat", "changelog.js");
const require = createRequire(import.meta.url);

const FIELD_SEP = "\x1f"; // unit separator — between fields of one record
const RECORD_SEP = "\x1e"; // record separator — between commits

// Subjects starting with these are internal/maintenance noise, never
// user-facing — matches this repo's own commit prefix conventions (see
// `git log --oneline`: "ci: ...", "landing-page: ..." etc. are used for
// scoping, not severity, but ci/chore/test/docs/build/deps are reliably
// non-user-facing regardless of scope).
const NOISE_PREFIX_RE = /^(ci|chore|test|docs|build|deps?)(\([^)]*\))?:\s*/i;

function sh(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function parseArgs(argv) {
  const opts = { apply: false, since: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") opts.apply = true;
    else if (argv[i] === "--since") opts.since = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") opts.help = true;
  }
  return opts;
}

function loadExistingChangelog() {
  delete require.cache[require.resolve(changelogPath)];
  return require(changelogPath).CHANGELOG;
}

// The non-trailer, non-subject body text, collapsed to its first paragraph.
// Used only as a PLAIN-tier draft description — always labeled REVIEW, never
// auto-applied, so this deliberately stays simple (strip the subject line,
// strip a trailing block of `Key: value` trailer lines, take the first
// blank-line-delimited paragraph of what's left).
function draftDescription(body) {
  const lines = body.split("\n");
  lines.shift(); // subject
  if (lines[0] === "") lines.shift(); // blank line after subject

  // Strip a trailing contiguous block of trailer-looking lines.
  let end = lines.length;
  while (end > 0 && (lines[end - 1].trim() === "" || /^[A-Za-z][A-Za-z0-9-]*:\s+\S/.test(lines[end - 1]))) {
    end--;
  }
  const withoutTrailers = lines.slice(0, end);

  const paragraphs = withoutTrailers.join("\n").split(/\n\s*\n/);
  return (paragraphs[0] ?? "").replace(/\s+/g, " ").trim();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function gitLog(since) {
  // %cd (committer date), not %ad (author date): changelog.js's own header
  // comment defines `date` as "the day the feature actually shipped", i.e.
  // when it landed on main, which is the committer date (a rebase/cherry-
  // pick can carry an old author date forward). --since below also filters
  // on committer date, so using %cd for display keeps the filter and the
  // displayed date reading the same clock.
  const format =
    `%H${FIELD_SEP}%cd${FIELD_SEP}%P${FIELD_SEP}%s${FIELD_SEP}%B` +
    `${FIELD_SEP}%(trailers:key=Changelog-Title,valueonly,unfold)` +
    `${FIELD_SEP}%(trailers:key=Changelog-Description,valueonly,unfold)${RECORD_SEP}`;
  // `since` is either a plain YYYY-MM-DD date (the common case — the newest
  // date already in changelog.js, or a user-supplied --since date) or a git
  // ref/sha (e.g. a tag, for callers who want an exact cursor instead of a
  // calendar-day cutoff). Dates use --since so the whole cutoff day is
  // still included (changelog.js's date field is day-granularity, so a
  // day-range `<date>..HEAD` would wrongly exclude same-day commits);
  // refs use `<ref>..HEAD` for an exact boundary.
  const args = DATE_RE.test(since)
    ? ["log", "HEAD", `--since=${since}T00:00:00`, `--pretty=format:${format}`, "--date=short"]
    : ["log", `${since}..HEAD`, `--pretty=format:${format}`, "--date=short"];
  let raw;
  try {
    raw = sh(args);
  } catch (err) {
    console.error(`git log failed for since "${since}": ${err.message}`);
    process.exit(1);
  }
  return raw
    .split(RECORD_SEP)
    .map((s) => s.replace(/^\n/, ""))
    .filter((s) => s.trim().length)
    .map((rec) => {
      const [hash, date, parents, subject, body, trailerTitle, trailerDescription] = rec.split(FIELD_SEP);
      return {
        hash,
        shortHash: hash.slice(0, 9),
        date,
        isMerge: parents.trim().includes(" "),
        subject: subject.trim(),
        body,
        trailerTitle: trailerTitle.trim() || null,
        trailerDescription: (trailerDescription || "").trim() || null,
      };
    });
}

function classify(commits, existingTitles) {
  const trailerEntries = [];
  const plainEntries = [];

  for (const c of commits) {
    if (c.isMerge) continue; // merge commits carry no independent user-facing content

    if (c.trailerTitle && c.trailerDescription) {
      if (existingTitles.has(normalize(c.trailerTitle))) continue; // already applied
      trailerEntries.push({
        date: c.date,
        title: c.trailerTitle,
        description: c.trailerDescription,
        hash: c.shortHash,
      });
      continue;
    }

    if (NOISE_PREFIX_RE.test(c.subject)) continue;
    if (existingTitles.has(normalize(c.subject))) continue;

    plainEntries.push({
      date: c.date,
      title: c.subject.replace(NOISE_PREFIX_RE, ""),
      description: draftDescription(c.body),
      hash: c.shortHash,
    });
  }

  return { trailerEntries, plainEntries };
}

function normalize(s) {
  return s.trim().toLowerCase();
}

function formatEntry(e) {
  return `  {\n    date: "${e.date}",\n    title: ${JSON.stringify(e.title)},\n    description: ${JSON.stringify(e.description)},\n  },`;
}

function applyToChangelog(entries, existing) {
  if (!entries.length) return 0;

  // Fast path: prepend the new (already newest-first-sorted) block right
  // after the array opener, targeted string insertion — not parse-object-
  // then-reserialize, which would silently drop changelog.js's curation-
  // discipline header comment. This only keeps the file's documented
  // newest-first invariant (test/changelog.test.js asserts it) if every new
  // entry's date is >= the current newest existing date, which is always
  // true for the default (since = existing newest date) range. Guard the
  // one case where it wouldn't be: a caller passing an older `--since`.
  const currentNewest = existing[0]?.date ?? "0000-00-00";
  const oldestNew = entries[entries.length - 1].date;
  if (oldestNew < currentNewest) {
    console.error(
      `--apply: refusing to write — a candidate entry is dated ${oldestNew}, older than the ` +
        `existing newest entry (${currentNewest}). Prepending it here would break changelog.js's ` +
        `documented newest-first order. Insert it by hand at the correct position instead ` +
        `(this only happens with an explicit --since older than the last changelog entry).`,
    );
    process.exit(1);
  }

  const src = readFileSync(changelogPath, "utf8");
  const marker = "const CHANGELOG = [";
  const idx = src.indexOf(marker);
  if (idx === -1) {
    console.error(`Could not find "${marker}" in ${changelogPath} — refusing to touch the file.`);
    process.exit(1);
  }
  const insertAt = idx + marker.length;
  const block = "\n" + entries.map(formatEntry).join("\n");
  const next = src.slice(0, insertAt) + block + src.slice(insertAt);
  writeFileSync(changelogPath, next);
  return entries.length;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    return;
  }

  const existing = loadExistingChangelog();
  const existingTitles = new Set(existing.map((e) => normalize(e.title)));
  const since = opts.since ?? existing.reduce((max, e) => (e.date > max ? e.date : max), "1970-01-01");

  const commits = gitLog(since);
  const { trailerEntries, plainEntries } = classify(commits, existingTitles);

  // Newest-first, matching changelog.js's own documented order.
  trailerEntries.sort((a, b) => b.date.localeCompare(a.date));
  plainEntries.sort((a, b) => b.date.localeCompare(a.date));

  console.log(`Scanned commits since ${JSON.stringify(since)} (${commits.length} commits, merges excluded).\n`);

  console.log(`== TRAILER tier (${trailerEntries.length}) — curated by the commit author, safe to --apply ==`);
  if (!trailerEntries.length) {
    console.log("  (none — no commits in range carry Changelog-Title/Changelog-Description trailers)");
  } else {
    for (const e of trailerEntries) console.log(`${formatEntry(e)}  // ${e.hash}`);
  }

  console.log(`\n== PLAIN tier (${plainEntries.length}) — REVIEW REQUIRED, never auto-applied ==`);
  if (!plainEntries.length) {
    console.log("  (none)");
  } else {
    for (const e of plainEntries) console.log(`${formatEntry(e)}  // ${e.hash}`);
  }

  if (opts.apply) {
    const n = applyToChangelog(trailerEntries, existing);
    console.log(`\n--apply: appended ${n} TRAILER-tier entr${n === 1 ? "y" : "ies"} to ${changelogPath}`);
    if (plainEntries.length) {
      console.log(`(${plainEntries.length} PLAIN-tier candidate(s) above were NOT applied — review and paste in by hand if they belong.)`);
    }
  } else if (trailerEntries.length || plainEntries.length) {
    console.log("\n(dry run — pass --apply to append the TRAILER tier to changelog.js; PLAIN tier is always manual)");
  }
}

main();
