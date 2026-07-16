"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fuzzyScore,
  matchQuery,
  escapeGlob,
  buildFileGlob,
  rankSection,
  buildQuickPickItems,
  createGeneration,
  createDebounced,
} = require("../lib/omnibox.js");

// ---------------------------------------------------------------------------
// fuzzyScore / matchQuery
// ---------------------------------------------------------------------------

test("fuzzyScore: empty query matches everything with score 0", () => {
  assert.equal(fuzzyScore("", "anything.js"), 0);
});

test("fuzzyScore: non-subsequence returns -1", () => {
  assert.equal(fuzzyScore("xyz", "extension.js"), -1);
});

test("fuzzyScore: exact substring beats scattered subsequence", () => {
  const substring = fuzzyScore("ext", "extension.js");
  const scattered = fuzzyScore("etn", "extension.js"); // e-x-t-e-n... e,t,n in order but scattered
  assert.ok(substring > scattered, `expected substring score (${substring}) > scattered score (${scattered})`);
});

test("fuzzyScore: match at start of string scores higher than match in the middle", () => {
  const atStart = fuzzyScore("pkg", "pkg.json");
  const inMiddle = fuzzyScore("pkg", "my-pkg.json");
  assert.ok(atStart > inMiddle, `expected start match (${atStart}) > middle match (${inMiddle})`);
});

test("fuzzyScore: is case-insensitive", () => {
  assert.equal(fuzzyScore("EXT", "extension.js") > -1, true);
  assert.equal(fuzzyScore("ext", "EXTENSION.JS") > -1, true);
});

test("fuzzyScore: word-boundary match scores higher than mid-word match of same length", () => {
  const boundary = fuzzyScore("fb", "foo_bar"); // f at start, b right after boundary '_'
  const midword = fuzzyScore("fb", "xxfxxxbxx"); // f/b both mid-word, no boundaries, no "fb" substring
  assert.ok(boundary > midword, `expected boundary score (${boundary}) > midword score (${midword})`);
});

test("matchQuery: picks the best score across multiple fields", () => {
  const score = matchQuery("open", ["Close Window", "Open File Explorer"]);
  assert.ok(score > -1);
  const noMatch = matchQuery("zzz", ["Close Window", "Open File Explorer"]);
  assert.equal(noMatch, -1);
});

test("matchQuery: ignores falsy fields", () => {
  const score = matchQuery("foo", [null, undefined, "", "foo bar"]);
  assert.ok(score > -1);
});

// ---------------------------------------------------------------------------
// escapeGlob / buildFileGlob
// ---------------------------------------------------------------------------

test("escapeGlob: brackets glob-special characters", () => {
  assert.equal(escapeGlob("a*b"), "a[*]b");
  assert.equal(escapeGlob("[test]"), "[[]test[]]");
  assert.equal(escapeGlob("(foo)"), "[(]foo[)]");
  assert.equal(escapeGlob("plain"), "plain");
});

test("buildFileGlob: wraps query in a bounded substring glob", () => {
  assert.equal(buildFileGlob("index"), "**/*index*");
});

test("buildFileGlob: empty query matches everything", () => {
  assert.equal(buildFileGlob(""), "**/*");
  assert.equal(buildFileGlob("   "), "**/*");
});

test("buildFileGlob: escapes special characters from user input before embedding", () => {
  const glob = buildFileGlob("a*.js");
  assert.equal(glob, "**/*a[*].js*");
});

// ---------------------------------------------------------------------------
// rankSection / buildQuickPickItems
// ---------------------------------------------------------------------------

test("rankSection: sorts by score descending and caps to the given count", () => {
  const items = [
    { label: "low", score: 1 },
    { label: "high", score: 100 },
    { label: "mid", score: 50 },
  ];
  const ranked = rankSection(items, 2);
  assert.deepEqual(
    ranked.map((i) => i.label),
    ["high", "mid"],
  );
});

test("rankSection: is stable for equal scores (preserves original order)", () => {
  const items = [
    { label: "a", score: 5 },
    { label: "b", score: 5 },
    { label: "c", score: 5 },
  ];
  const ranked = rankSection(items, 3);
  assert.deepEqual(
    ranked.map((i) => i.label),
    ["a", "b", "c"],
  );
});

test("buildQuickPickItems: emits a separator + capped items per non-empty section, in order", () => {
  const sections = [
    { key: "files", title: "Files", items: [{ label: "f1", score: 10 }, { label: "f2", score: 5 }] },
    { key: "symbols", title: "Symbols", items: [] },
    { key: "commands", title: "Commands", items: [{ label: "c1", score: 1 }] },
  ];
  const flat = buildQuickPickItems(sections, 8);
  assert.deepEqual(
    flat.map((i) => (i.kind === "separator" ? `sep:${i.label}` : `item:${i.section}:${i.label}`)),
    ["sep:Files", "item:files:f1", "item:files:f2", "sep:Commands", "item:commands:c1"],
  );
});

test("buildQuickPickItems: respects a per-section cap override", () => {
  const sections = [
    {
      key: "files",
      title: "Files",
      cap: 1,
      items: [{ label: "f1", score: 10 }, { label: "f2", score: 20 }],
    },
  ];
  const flat = buildQuickPickItems(sections, 8);
  const items = flat.filter((i) => i.kind === "item");
  assert.equal(items.length, 1);
  assert.equal(items[0].label, "f2"); // higher score kept
});

test("buildQuickPickItems: omits sections with no items entirely (no dangling header)", () => {
  const sections = [{ key: "symbols", title: "Symbols", items: [] }];
  assert.deepEqual(buildQuickPickItems(sections), []);
});

// ---------------------------------------------------------------------------
// createGeneration
// ---------------------------------------------------------------------------

test("createGeneration: only the latest token is current", () => {
  const gen = createGeneration();
  const t1 = gen.next();
  const t2 = gen.next();
  assert.equal(gen.isCurrent(t1), false);
  assert.equal(gen.isCurrent(t2), true);
});

test("createGeneration: a token is current until superseded", () => {
  const gen = createGeneration();
  const t1 = gen.next();
  assert.equal(gen.isCurrent(t1), true);
});

// ---------------------------------------------------------------------------
// createDebounced (fake timers injected -- no real sleeping)
// ---------------------------------------------------------------------------

function makeFakeClock() {
  let nextId = 1;
  const pending = new Map(); // id -> callback
  return {
    setTimeoutFn: (cb) => {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    clearTimeoutFn: (id) => {
      pending.delete(id);
    },
    fireAll() {
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb();
    },
    pendingCount() {
      return pending.size;
    },
  };
}

test("createDebounced: collapses rapid calls into a single trailing invocation", () => {
  const clock = makeFakeClock();
  let calls = [];
  const debounced = createDebounced((q) => calls.push(q), 50, clock);

  debounced("a");
  debounced("ab");
  debounced("abc");
  assert.equal(clock.pendingCount(), 1, "only the latest timer should still be pending");

  clock.fireAll();
  assert.deepEqual(calls, ["abc"]);
});

test("createDebounced: cancel() prevents the pending call from firing", () => {
  const clock = makeFakeClock();
  let calls = [];
  const debounced = createDebounced((q) => calls.push(q), 50, clock);

  debounced("a");
  debounced.cancel();
  assert.equal(clock.pendingCount(), 0);

  clock.fireAll();
  assert.deepEqual(calls, []);
});

test("createDebounced: independent call rounds each fire once", () => {
  const clock = makeFakeClock();
  let calls = [];
  const debounced = createDebounced((q) => calls.push(q), 50, clock);

  debounced("first");
  clock.fireAll();
  debounced("second");
  clock.fireAll();

  assert.deepEqual(calls, ["first", "second"]);
});
