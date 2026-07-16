"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RULES, scanText, scanFiles } = require("../lib/rules.js");

function idsFor(text) {
  return scanText(text).map((h) => h.ruleId);
}

// ---------------------------------------------------------------------------
// Rule pack shape sanity
// ---------------------------------------------------------------------------

test("RULES: exactly the 4 curated rules, each with the required honesty fields", () => {
  assert.deepEqual(
    RULES.map((r) => r.id).sort(),
    ["sast-eval", "sast-shell-exec", "sast-sql-injection", "sast-xss-innerhtml"].sort(),
  );
  for (const r of RULES) {
    assert.ok(r.title && r.title.length > 0, `${r.id} needs a title`);
    assert.ok(r.severity === "error" || r.severity === "warning", `${r.id} needs a valid severity`);
    assert.ok(Array.isArray(r.patterns) && r.patterns.length > 0, `${r.id} needs >=1 pattern`);
    assert.ok(r.why && r.why.length > 20, `${r.id} needs a "why this matters" blurb`);
    assert.ok(r.wontCatch && r.wontCatch.length > 20, `${r.id} needs a "what this WON'T catch" blurb`);
  }
});

// ---------------------------------------------------------------------------
// 1. sast-sql-injection: $OBJ.query($SQL!lit) / $OBJ.execute($SQL!lit)
// ---------------------------------------------------------------------------

test("sast-sql-injection: fires on a variable/concatenated query argument", () => {
  assert.deepEqual(idsFor('db.query(sql);'), ["sast-sql-injection"]);
  assert.deepEqual(idsFor('db.query("SELECT * FROM x WHERE id=" + userInput);'), ["sast-sql-injection"]);
  assert.deepEqual(idsFor("conn.execute(buildQuery());"), ["sast-sql-injection"]);
});

test("sast-sql-injection: does NOT fire on a plain string-literal query", () => {
  assert.deepEqual(idsFor('db.query("SELECT * FROM users");'), []);
  assert.deepEqual(idsFor('conn.execute("DELETE FROM sessions");'), []);
});

// ---------------------------------------------------------------------------
// 2. sast-xss-innerhtml: $EL.innerHTML = $X!lit
// ---------------------------------------------------------------------------

test("sast-xss-innerhtml: fires on a dynamic innerHTML assignment", () => {
  assert.deepEqual(idsFor("el.innerHTML = userComment;"), ["sast-xss-innerhtml"]);
  assert.deepEqual(idsFor("el.innerHTML = '<b>' + name + '</b>';"), ["sast-xss-innerhtml"]);
});

test("sast-xss-innerhtml: does NOT fire on a literal innerHTML assignment", () => {
  assert.deepEqual(idsFor('el.innerHTML = "<b>ok</b>";'), []);
});

// ---------------------------------------------------------------------------
// 3. sast-eval: eval($X) — fires unconditionally, even on a literal argument
// ---------------------------------------------------------------------------

test("sast-eval: fires on eval(...) regardless of argument shape", () => {
  assert.deepEqual(idsFor("eval(userInput);"), ["sast-eval"]);
  assert.deepEqual(idsFor('eval("2 + 2");'), ["sast-eval"]); // by design: eval itself is the risk, not the arg shape
});

test("sast-eval: does NOT fire when there's no eval(...) call at all", () => {
  assert.deepEqual(idsFor("evaluate(userInput);"), []); // different identifier entirely
});

test("sast-eval: token matching means member-access forms (window.eval, globalThis.eval) STILL fire", () => {
  // This is the opposite of a miss: the rule matches the bare `eval` token
  // immediately followed by `(...)` wherever it occurs in the token stream,
  // with no notion of "callee"/property access, so `window.eval(x)` and
  // `globalThis.eval(x)` both fire too -- and so, as an honest side effect,
  // does an unrelated method that happens to be named `eval` (a real false
  // positive, not a miss). Pinned here so the README/rules.js "wontCatch"
  // text can't silently drift back into overclaiming a gap that isn't real.
  assert.deepEqual(idsFor("window.eval(x);"), ["sast-eval"]);
  assert.deepEqual(idsFor("globalThis.eval(x);"), ["sast-eval"]);
  assert.deepEqual(idsFor("math.eval(expr);"), ["sast-eval"]); // false positive, documented
});

// ---------------------------------------------------------------------------
// 4. sast-shell-exec
// ---------------------------------------------------------------------------

test("sast-shell-exec: fires on dynamic child_process.exec / require(\"child_process\").exec", () => {
  assert.deepEqual(idsFor("child_process.exec(cmd);"), ["sast-shell-exec"]);
  assert.deepEqual(idsFor('require("child_process").exec("rm " + filename);'), ["sast-shell-exec"]);
});

test("sast-shell-exec: does NOT fire on a literal shell command", () => {
  assert.deepEqual(idsFor('child_process.exec("ls -la");'), []);
});

// ---------------------------------------------------------------------------
// scanFiles: multi-file orchestration mirrors pattern.searchFiles's {path,text} shape
// ---------------------------------------------------------------------------

test("scanFiles: tags every hit with its originating file path", () => {
  const files = [
    { path: "a.js", text: "db.query(sql);" },
    { path: "b.js", text: 'db.query("SELECT 1");' },
    { path: "c.js", text: "eval(x);" },
  ];
  const hits = scanFiles(files).map((h) => ({ path: h.path, ruleId: h.ruleId }));
  assert.deepEqual(hits, [
    { path: "a.js", ruleId: "sast-sql-injection" },
    { path: "c.js", ruleId: "sast-eval" },
  ]);
});

// ---------------------------------------------------------------------------
// HONESTY GAPS — each "won't catch" claim above proven by a real test that
// asserts the rule does NOT fire, not just asserted in prose. These are the
// deliberate, acknowledged limitations of shape-matching-not-taint-analysis.
// ---------------------------------------------------------------------------

test("HONEST GAP (sast-sql-injection): a template literal that interpolates a variable is NOT flagged", () => {
  // The tokenizer treats a whole `` `...` `` literal as ONE opaque token
  // (see pattern.js / README known limitations), so it looks like "a plain
  // literal" to the !lit check no matter what's interpolated inside it.
  // This is a genuine miss, not a hypothetical one.
  const src = "db.query(`SELECT * FROM x WHERE id=${userInput}`);";
  assert.deepEqual(idsFor(src), []);
});

test("HONEST GAP (sast-sql-injection): a query call with extra arguments (params/callback) isn't matched at all", () => {
  // $OBJ.query($SQL!lit) is a single-argument shape; the placeholder stops at
  // the first top-level comma, so a 2-arg call never even reaches the
  // literal-vs-non-literal check -- the whole call shape doesn't match.
  const src = "db.query(sql, function (err, rows) {});";
  assert.deepEqual(idsFor(src), []);
});

test("HONEST GAP (sast-xss-innerhtml): a compound assignment (+=) is a different operator token, not matched", () => {
  const src = "el.innerHTML += userComment;";
  assert.deepEqual(idsFor(src), []);
});

test("HONEST GAP (sast-eval): aliasing eval to a variable defeats the literal-identifier match", () => {
  const src = "const runIt = eval; runIt(userInput);";
  assert.deepEqual(idsFor(src), []);
});

test("HONEST GAP (sast-shell-exec): the common destructured-import call shape isn't matched", () => {
  // `const { exec } = require("child_process")` followed by a bare `exec(cmd)`
  // call is arguably the MOST common real-world way this API gets used, and
  // it's a real miss: at the call site it's structurally just any other
  // one-argument function call, indistinguishable from a safe one.
  const src = 'const { exec } = require("child_process");\nexec(cmd);';
  assert.deepEqual(idsFor(src), []);
});

// Variable-flow, once more, generalized: the task's intuition ("taint through
// an intermediate variable is missed") is right in SPIRIT but the concrete
// example matters -- `db.query(q + rest)` where q was assigned from a
// variable ACTUALLY FIRES under this matcher (a concatenation is exactly the
// non-literal signal it's designed to catch). Pinned here so that claim isn't
// silently re-introduced into docs without a contradicting test catching it.
test("NOT a gap (contrast case): a concatenation built from an intermediate variable STILL fires", () => {
  const src = "const q = userInput; db.query(q + rest);";
  assert.deepEqual(idsFor(src), ["sast-sql-injection"]);
});
