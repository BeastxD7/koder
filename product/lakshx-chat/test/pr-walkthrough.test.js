// Unit tests for pr-walkthrough.js — the "/walkthrough" PR/diff walkthrough
// auto-generator's pure prompt-assembly module (docs/research/16-ide-feature-
// roadmap-round2.md §"PR walkthrough auto-generator"). Same rationale as
// crash-context.test.js: extension.js's actual git-shelling + workspace file
// reads can't be exercised without a running Extension Host, but everything
// downstream of "already-fetched diff text / file list" can be, and is,
// tested here with plain `node --test`.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  getDiffSummary,
  findLightweightDependents,
  hasTestCoverage,
  buildWalkthroughDisplayText,
  buildWalkthroughPrompt,
  MAX_DEPENDENTS_PER_FILE,
  MAX_FILES_SUMMARIZED,
  MAX_HUNKS_PER_FILE,
  MAX_HUNK_LINES,
  MAX_COMMITS,
} = require("../pr-walkthrough.js");

// ---------------------------------------------------------------------------
// getDiffSummary — realistic multi-file unified diff
// ---------------------------------------------------------------------------

const REALISTIC_DIFF = `diff --git a/src/totals.js b/src/totals.js
index 1111111..2222222 100644
--- a/src/totals.js
+++ b/src/totals.js
@@ -10,6 +10,9 @@ function computeTotals(items) {
   let total = 0;
   for (const item of items) {
     total += item.price * item.qty;
+    if (item.discount) {
+      total -= item.discount;
+    }
   }
   return total;
 }
@@ -30,4 +33,3 @@ function formatTotal(total) {
   return \`$\${total.toFixed(2)}\`;
-  // stray trailing comment removed
 }
diff --git a/src/checkout.js b/src/checkout.js
index 3333333..4444444 100644
--- a/src/checkout.js
+++ b/src/checkout.js
@@ -1,4 +1,4 @@
-const { computeTotals } = require("./totals");
+const { computeTotals } = require("./totals.js");

 function checkout(cart) {
   return computeTotals(cart.items);
diff --git a/src/new-feature.js b/src/new-feature.js
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/src/new-feature.js
@@ -0,0 +1,3 @@
+function newFeature() {
+  return true;
+}
`;

test("getDiffSummary: realistic 3-file diff yields correct paths, addition/deletion counts, and hunk counts", () => {
  const summary = getDiffSummary(REALISTIC_DIFF);
  assert.equal(summary.files.length, 3);

  const totals = summary.files[0];
  assert.equal(totals.path, "src/totals.js");
  // hunk 1: +3 added lines (the discount block), 0 removed
  // hunk 2: 0 added, 1 removed (the stray comment)
  assert.equal(totals.additions, 3);
  assert.equal(totals.deletions, 1);
  assert.equal(totals.hunks.length, 2);
  assert.equal(totals.hunks[0].oldStart, 10);
  assert.equal(totals.hunks[0].newStart, 10);
  assert.equal(totals.hunks[0].newLines, 9);

  const checkout = summary.files[1];
  assert.equal(checkout.path, "src/checkout.js");
  assert.equal(checkout.additions, 1);
  assert.equal(checkout.deletions, 1);
  assert.equal(checkout.hunks.length, 1);

  const feature = summary.files[2];
  assert.equal(feature.path, "src/new-feature.js");
  assert.equal(feature.additions, 3);
  assert.equal(feature.deletions, 0);
  assert.equal(feature.hunks.length, 1);
  assert.equal(feature.hunks[0].newStart, 1);
});

test("getDiffSummary: hunk lines carry their raw +/-/space prefix, in order", () => {
  const summary = getDiffSummary(REALISTIC_DIFF);
  const firstHunkLines = summary.files[0].hunks[0].lines;
  assert.deepEqual(firstHunkLines, [
    "   let total = 0;",
    "   for (const item of items) {",
    "     total += item.price * item.qty;",
    "+    if (item.discount) {",
    "+      total -= item.discount;",
    "+    }",
    "   }",
    "   return total;",
    " }",
  ]);
});

test("getDiffSummary: empty/non-diff input yields {files: []} without throwing", () => {
  assert.deepEqual(getDiffSummary(""), { files: [] });
  assert.deepEqual(getDiffSummary("not a diff at all\njust some text"), { files: [] });
  assert.deepEqual(getDiffSummary(undefined), { files: [] });
  assert.deepEqual(getDiffSummary(null), { files: [] });
});

test("getDiffSummary: binary file notice produces a file entry with no hunks", () => {
  const diff = `diff --git a/image.png b/image.png\nindex aaa..bbb 100644\nBinary files a/image.png and b/image.png differ\n`;
  const summary = getDiffSummary(diff);
  assert.equal(summary.files.length, 1);
  assert.equal(summary.files[0].path, "image.png");
  assert.equal(summary.files[0].hunks.length, 0);
  assert.equal(summary.files[0].additions, 0);
  assert.equal(summary.files[0].deletions, 0);
});

// ---------------------------------------------------------------------------
// findLightweightDependents — synthetic small file set, real import statements
// ---------------------------------------------------------------------------

test("findLightweightDependents: finds files importing the target via require() and ES import, ignores unrelated files", () => {
  const workspaceFiles = [
    { path: "src/totals.js", text: "function computeTotals() {}\nmodule.exports = { computeTotals };\n" },
    { path: "src/checkout.js", text: 'const { computeTotals } = require("./totals");\n' },
    { path: "src/report.js", text: 'import { computeTotals } from "./totals.js";\n' },
    { path: "src/unrelated.js", text: 'const fs = require("fs");\nconst other = require("./other-module");\n' },
    { path: "src/other-module.js", text: "module.exports = {};\n" },
  ];
  const deps = findLightweightDependents("src/totals.js", workspaceFiles);
  assert.deepEqual(deps.sort(), ["src/checkout.js", "src/report.js"]);
});

test("findLightweightDependents: a bare/package specifier never matches (only relative specifiers count)", () => {
  const workspaceFiles = [
    { path: "src/totals.js", text: "module.exports = {};\n" },
    { path: "node_modules/totals/index.js", text: 'const x = require("totals");\n' },
  ];
  const deps = findLightweightDependents("src/totals.js", workspaceFiles);
  assert.deepEqual(deps, []);
});

test("findLightweightDependents: dynamic import() with a relative specifier is matched", () => {
  const workspaceFiles = [
    { path: "src/totals.js", text: "module.exports = {};\n" },
    { path: "src/lazy.js", text: 'async function load() { return import("./totals.js"); }\n' },
  ];
  const deps = findLightweightDependents("src/totals.js", workspaceFiles);
  assert.deepEqual(deps, ["src/lazy.js"]);
});

test("findLightweightDependents: excludes the target file itself and files with no matching import", () => {
  const workspaceFiles = [
    { path: "src/totals.js", text: 'const self = require("./totals");\n' }, // self-import must not count
    { path: "src/sibling.js", text: 'const { other } = require("./other");\n' }, // imports something else entirely
  ];
  const deps = findLightweightDependents("src/totals.js", workspaceFiles);
  assert.deepEqual(deps, []);
});

test("findLightweightDependents: bounded — respects maxFiles and maxDependents caps", () => {
  const many = [];
  for (let i = 0; i < 20; i++) {
    many.push({ path: `src/dep${i}.js`, text: 'require("./target");\n' });
  }
  const workspaceFiles = [{ path: "src/target.js", text: "" }, ...many];
  const capped = findLightweightDependents("src/target.js", workspaceFiles, { maxDependents: 3 });
  assert.equal(capped.length, 3);

  const scanCapped = findLightweightDependents("src/target.js", workspaceFiles, { maxFiles: 1, maxDependents: 50 });
  // maxFiles=1 only looks at workspaceFiles[0], which is the target itself — no dependents found
  assert.deepEqual(scanCapped, []);

  assert.ok(MAX_DEPENDENTS_PER_FILE > 0); // sanity: exported default cap is a positive number
});

test("findLightweightDependents: tolerates non-string/garbage entries without throwing", () => {
  const workspaceFiles = [null, undefined, { path: "src/a.js" }, { path: "src/b.js", text: 'require("./a")' }];
  let deps;
  assert.doesNotThrow(() => {
    deps = findLightweightDependents("src/a.js", workspaceFiles);
  });
  assert.deepEqual(deps, ["src/b.js"]);
});

// ---------------------------------------------------------------------------
// hasTestCoverage — files with/without a matching test file
// ---------------------------------------------------------------------------

test("hasTestCoverage: true when a same-directory <name>.test.<ext> file exists", () => {
  const files = ["src/totals.js", "src/totals.test.js", "src/checkout.js"];
  assert.equal(hasTestCoverage("src/totals.js", files), true);
  assert.equal(hasTestCoverage("src/checkout.js", files), false);
});

test("hasTestCoverage: true for this repo's own convention — test/<name>.test.<ext> in the same directory", () => {
  const files = ["product/lakshx-chat/commands.js", "product/lakshx-chat/test/commands.test.js"];
  assert.equal(hasTestCoverage("product/lakshx-chat/commands.js", files), true);
});

test("hasTestCoverage: recognizes .spec.<ext> and __tests__/ conventions too", () => {
  assert.equal(hasTestCoverage("src/a.js", ["src/a.spec.js"]), true);
  assert.equal(hasTestCoverage("src/b.js", ["src/__tests__/b.test.js"]), true);
  assert.equal(hasTestCoverage("src/c.js", ["src/tests/c.test.js"]), true);
});

test("hasTestCoverage: false when no matching test file exists anywhere in the set", () => {
  const files = ["src/totals.js", "src/other.test.js", "README.md"];
  assert.equal(hasTestCoverage("src/totals.js", files), false);
});

test("hasTestCoverage: accepts plain path strings or {path} objects interchangeably", () => {
  const asObjects = [{ path: "src/a.js" }, { path: "src/a.test.js" }];
  assert.equal(hasTestCoverage("src/a.js", asObjects), true);
});

// ---------------------------------------------------------------------------
// buildWalkthroughDisplayText
// ---------------------------------------------------------------------------

test("buildWalkthroughDisplayText: no count falls back to the plain label", () => {
  assert.equal(buildWalkthroughDisplayText(0), "Generate a PR walkthrough for the current changes");
  assert.equal(buildWalkthroughDisplayText(undefined), "Generate a PR walkthrough for the current changes");
});

test("buildWalkthroughDisplayText: singular vs plural file count", () => {
  assert.equal(buildWalkthroughDisplayText(1), "Generate a PR walkthrough for the current changes (1 file changed)");
  assert.equal(buildWalkthroughDisplayText(5), "Generate a PR walkthrough for the current changes (5 files changed)");
});

// ---------------------------------------------------------------------------
// buildWalkthroughPrompt — exact structure assertion
// ---------------------------------------------------------------------------

test("buildWalkthroughPrompt: well-formed <pr_context> block with real diff/dependents/coverage/commit data; short display text stays separate", () => {
  const diffSummary = getDiffSummary(REALISTIC_DIFF);
  const dependents = {
    "src/totals.js": ["src/checkout.js", "src/report.js"],
  };
  const testCoverage = {
    "src/totals.js": false,
    "src/checkout.js": true,
    "src/new-feature.js": false,
  };
  const commitMessages = ["abc1234 add discount support", "def5678 fix checkout rounding"];

  const { displayText, promptBlock } = buildWalkthroughPrompt({ diffSummary, dependents, testCoverage, commitMessages });

  // display text stays short and separate from the rich context
  assert.equal(displayText, "Generate a PR walkthrough for the current changes (3 files changed)");
  assert.ok(!promptBlock.includes(displayText)); // the rich block never repeats the short display text verbatim

  // well-formed <pr_context> wrapper
  assert.ok(promptBlock.startsWith("<pr_context>"));
  assert.ok(promptBlock.endsWith("</pr_context>"));

  // header totals: (+3/-1) + (+1/-1) + (+3/-0) = +7/-2 across 3 files
  assert.match(promptBlock, /^<pr_context>\nFiles changed: 3 \(\+7\/-2\)/);

  // per-file sections, in diff order
  assert.match(promptBlock, /## src\/totals\.js \(\+3\/-1\)/);
  assert.match(promptBlock, /## src\/checkout\.js \(\+1\/-1\)/);
  assert.match(promptBlock, /## src\/new-feature\.js \(\+3\/-0\)/);
  const totalsIdx = promptBlock.indexOf("## src/totals.js");
  const checkoutIdx = promptBlock.indexOf("## src/checkout.js");
  const featureIdx = promptBlock.indexOf("## src/new-feature.js");
  assert.ok(totalsIdx < checkoutIdx && checkoutIdx < featureIdx);

  // dependents rendered for totals.js, "none found" for files with no entry
  assert.match(promptBlock, /Dependents \(lightweight scan\): src\/checkout\.js, src\/report\.js/);
  const checkoutSection = promptBlock.slice(checkoutIdx, featureIdx);
  assert.match(checkoutSection, /Dependents \(lightweight scan\): none found in scanned files/);

  // test coverage heuristic rendered per file
  assert.match(promptBlock, /## src\/totals\.js[\s\S]*?Test coverage heuristic: no matching test file found/);
  assert.match(checkoutSection, /Test coverage heuristic: a matching test file was found/);

  // actual hunk content is included (grounding, not just counts)
  assert.match(promptBlock, /\+ {4}if \(item\.discount\) \{/);

  // commit messages included, in order, under their own heading
  const commitsIdx = promptBlock.indexOf("Recent commits:");
  assert.ok(commitsIdx > -1);
  assert.match(promptBlock.slice(commitsIdx), /- abc1234 add discount support\n- def5678 fix checkout rounding/);
});

test("buildWalkthroughPrompt: missing dependents/testCoverage/commitMessages degrade to placeholders, never throw", () => {
  const diffSummary = getDiffSummary(REALISTIC_DIFF);
  let result;
  assert.doesNotThrow(() => {
    result = buildWalkthroughPrompt({ diffSummary });
  });
  assert.match(result.promptBlock, /Dependents \(lightweight scan\): none found in scanned files/);
  assert.match(result.promptBlock, /Test coverage heuristic: no matching test file found/);
  assert.ok(!result.promptBlock.includes("Recent commits:")); // no commits given -> section omitted entirely
});

test("buildWalkthroughPrompt: empty diff summary still yields a well-formed (if empty) block and the fallback display text", () => {
  const { displayText, promptBlock } = buildWalkthroughPrompt({ diffSummary: { files: [] } });
  assert.equal(displayText, "Generate a PR walkthrough for the current changes");
  assert.equal(promptBlock, "<pr_context>\nFiles changed: 0 (+0/-0)\n</pr_context>");
});

test("buildWalkthroughPrompt: bounded — more than MAX_FILES_SUMMARIZED files notes how many were omitted", () => {
  const files = [];
  for (let i = 0; i < MAX_FILES_SUMMARIZED + 5; i++) {
    files.push({ path: `src/f${i}.js`, additions: 1, deletions: 0, hunks: [] });
  }
  const { promptBlock } = buildWalkthroughPrompt({ diffSummary: { files } });
  const shownSections = promptBlock.match(/^## /gm) ?? [];
  assert.equal(shownSections.length, MAX_FILES_SUMMARIZED);
  assert.match(promptBlock, /… 5 more file\(s\) omitted/);
});

test("buildWalkthroughPrompt: bounded — more than MAX_DEPENDENTS_SHOWN dependents notes how many more exist", () => {
  const manyDeps = [];
  for (let i = 0; i < 20; i++) manyDeps.push(`src/dep${i}.js`);
  const diffSummary = { files: [{ path: "src/x.js", additions: 1, deletions: 0, hunks: [] }] };
  const { promptBlock } = buildWalkthroughPrompt({ diffSummary, dependents: { "src/x.js": manyDeps } });
  assert.match(promptBlock, /\+15 more/);
});

test("buildWalkthroughPrompt: bounded — more than MAX_HUNKS_PER_FILE hunks and MAX_HUNK_LINES lines are noted as omitted", () => {
  const manyHunks = [];
  for (let i = 0; i < MAX_HUNKS_PER_FILE + 2; i++) {
    const hunkLines = [];
    for (let j = 0; j < MAX_HUNK_LINES + 3; j++) hunkLines.push(`+line ${j}`);
    manyHunks.push({ header: `@@ -${i},1 +${i},${MAX_HUNK_LINES + 3} @@`, lines: hunkLines });
  }
  const diffSummary = { files: [{ path: "src/x.js", additions: 100, deletions: 0, hunks: manyHunks }] };
  const { promptBlock } = buildWalkthroughPrompt({ diffSummary });
  assert.match(promptBlock, /… 2 more hunk\(s\) omitted/);
  assert.match(promptBlock, /… \(3 more line\(s\) omitted\)/);
});

test("buildWalkthroughPrompt: bounded — more than MAX_COMMITS commit messages notes how many more exist", () => {
  const commitMessages = [];
  for (let i = 0; i < MAX_COMMITS + 4; i++) commitMessages.push(`commit ${i}`);
  const diffSummary = { files: [] };
  const { promptBlock } = buildWalkthroughPrompt({ diffSummary, commitMessages });
  assert.match(promptBlock, /… 4 more commit\(s\) omitted/);
  const shownCommitLines = promptBlock.match(/^- commit \d+$/gm) ?? [];
  assert.equal(shownCommitLines.length, MAX_COMMITS);
});
