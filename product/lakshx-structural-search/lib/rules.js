// LakshX Structural Search — SAST-lite curated rule pack, pure/vscode-free.
//
// These rules are ordinary lib/pattern.js patterns (same tokenizer/matcher,
// same `$NAME`/`$$NAME` placeholder syntax, plus the additive `!lit`
// modifier added alongside this file — see pattern.js's "!lit modifier"
// comment) applied to a fixed, curated list of common vulnerability SHAPES.
//
// HONESTY, up front, same framing as README.md's top-level "What this is
// (and isn't)": this is shape-matching, not taint/dataflow analysis. It
// looks at ONE call/assignment site in isolation and asks "is the risky
// argument slot a fixed literal, or something else?" — it never traces where
// a value actually came from, never crosses function boundaries, and never
// confirms a flagged non-literal is actually attacker-controlled. Each rule
// below carries its own "why this matters" AND "what this WON'T catch" so
// the gap is documented at the point of use, not just in prose elsewhere.
// Every one of those "won't catch" claims is backed by a real test in
// test/rules.test.js that proves the miss, not just asserts it in a comment.
"use strict";

const pattern = require("./pattern.js");

/**
 * @typedef {object} Rule
 * @property {string} id        stable id, used as vscode.Diagnostic#code
 * @property {string} title     one-line summary shown in the Problems panel
 * @property {"error"|"warning"} severity
 * @property {string[]} patterns  one or more lib/pattern.js pattern sources;
 *   a rule fires on ANY of its patterns matching (OR'd) since the matcher has
 *   no alternation syntax of its own — see README "Pattern syntax".
 * @property {string} why       why this shape is a real risk signal
 * @property {string} wontCatch concrete, verified cases this rule misses
 */

/** @type {Rule[]} */
const RULES = [
  {
    id: "sast-sql-injection",
    title: "Possible SQL injection: query built from a non-literal argument",
    severity: "error",
    patterns: ["$OBJ.query($SQL!lit)", "$OBJ.execute($SQL!lit)"],
    why:
      "A `.query(...)` / `.execute(...)` call whose single argument is NOT a " +
      "plain string/template literal is the classic string-built-SQL shape: " +
      "the query text comes from a variable, a concatenation, or another " +
      "call, and if that value traces back to unsanitized user input, an " +
      "attacker can alter the query. `db.query(\"SELECT * FROM users\")` is " +
      "a fixed literal and is NOT flagged; `db.query(\"SELECT * FROM \" + " +
      "req.query.id)` and `db.query(sql)` ARE flagged, because in both cases " +
      "the argument isn't one plain literal token.",
    wontCatch:
      "This is shape-matching at ONE call site, not taint analysis: (1) a " +
      "template literal used directly as the argument is NOT flagged even " +
      "when it interpolates a variable — a call like `db.query` with a " +
      "template-literal argument containing `${userInput}` is missed, " +
      "because this tokenizer treats a whole template literal as one opaque token — " +
      "template literal as one opaque token (see README's template-literal " +
      "caveat) so it looks like a single 'literal' regardless of what's " +
      "inside it. (2) Only the exact one-argument shape is matched — a call " +
      "with extra arguments, e.g. `db.query(sql, callback)` or `db.query(sql, " +
      "params, callback)`, does not match `$OBJ.query($SQL!lit)` at all (the " +
      "placeholder stops at the first top-level comma) and is silently not " +
      "scanned. (3) Different sink names entirely (`connection.raw(sql)`, an " +
      "ORM query builder, etc.) are out of scope — only literal `.query`/" +
      "`.execute` method names are covered. (4) A flagged non-literal is not " +
      "confirmed to be attacker-controlled — `db.query(buildTrustedQuery())` " +
      "fires too (a false positive, not a miss, but worth knowing).",
  },
  {
    id: "sast-xss-innerhtml",
    title: "Dynamic innerHTML assignment (possible XSS)",
    severity: "warning",
    // `$$X!lit` (variadic), not `$X!lit`: the placeholder is the LAST token
    // in this pattern with no literal after it, so a non-variadic `$X` would
    // fall back to pattern.js's "one token, or one balanced group" rule for
    // trailing placeholders (see README's extentOf limitation) and only
    // capture the first token of the right-hand side — e.g. just `'<b>'` out
    // of `'<b>' + name + '</b>'`, which is a single string token and would
    // wrongly look "literal". The variadic form scans to the statement's
    // top-level `;` instead, correctly capturing the WHOLE right-hand side.
    patterns: ["$EL.innerHTML = $$X!lit"],
    why:
      "Assigning a non-literal value to `.innerHTML` is the classic DOM-XSS " +
      "shape: if that value contains attacker-controlled markup, the browser " +
      "parses and executes it. `el.innerHTML = \"<b>ok</b>\"` is a fixed " +
      "literal and is NOT flagged; `el.innerHTML = userComment` or " +
      "`el.innerHTML = '<b>' + name + '</b>'` ARE flagged.",
    wontCatch:
      "Only the exact `$EL.innerHTML = $X` shape (a plain `=` assignment) is " +
      "matched: a compound assignment like `el.innerHTML += userInput` uses " +
      "a different operator token (`+=` vs `=`) and is NOT matched at all. " +
      "Other sinks with the same risk — `outerHTML`, `insertAdjacentHTML`, " +
      "`document.write`, React's `dangerouslySetInnerHTML` — are out of scope " +
      "for this rule entirely (different shapes, not covered). And, same as " +
      "the SQL rule, this never confirms the assigned value is actually " +
      "attacker-controlled — it only reports 'this is not a fixed literal'. " +
      "One more sharp edge from using a trailing variadic capture (needed so " +
      "`$X` isn't cut short after the first token — see the code comment " +
      "above): in semicolon-free code relying on ASI, a genuinely SAFE " +
      "literal assignment like `el.innerHTML = \"ok\"` followed by another " +
      "statement with no `;` between them can have the capture swallow that " +
      "next statement too, becoming multi-token and wrongly firing.",
  },
  {
    id: "sast-eval",
    title: "Use of eval()",
    severity: "warning",
    patterns: ["eval($X)"],
    why:
      "`eval()` executes its argument as code with the caller's privileges — " +
      "flagged unconditionally (any argument, including a literal), because " +
      "unlike the SQL/XSS shapes above there is no 'safe' argument shape for " +
      "eval: even a literal today can become a concatenated string tomorrow, " +
      "and eval's mere presence is worth a second look in review.",
    wontCatch:
      "This is TOKEN matching, not callee/scope resolution, which cuts both " +
      "ways: `eval($X)` matches the bare token `eval` immediately followed " +
      "by `(...)` wherever it appears in the token stream, so member-access " +
      "forms like `window.eval(x)` and `globalThis.eval(x)` DO still fire " +
      "(the `eval` token is there, regardless of what precedes the `.`) — " +
      "and so does `math.eval(expr)`, a real false positive on an unrelated " +
      "method that happens to be named `eval`. What genuinely slips through " +
      "is TRUE aliasing, where the literal token `eval` never appears at the " +
      "call site at all: `const run = eval; run(userInput);` is NOT caught. " +
      "`new Function(...)`, a separate eval-equivalent API, is also out of " +
      "scope — this rule only looks for the `eval` token.",
  },
  {
    id: "sast-shell-exec",
    title: "Dynamic shell command execution",
    severity: "error",
    patterns: ["child_process.exec($CMD!lit)", "require(\"child_process\").exec($CMD!lit)"],
    why:
      "`child_process.exec(...)` runs its argument through a shell, so a " +
      "non-literal command string is the classic shell-injection shape — a " +
      "value built from user input can inject additional shell commands via " +
      "`;`, `&&`, backticks, etc. `child_process.exec(\"ls -la\")` is a fixed " +
      "literal and is NOT flagged; `child_process.exec(cmd)` or " +
      "`child_process.exec(\"rm \" + filename)` ARE flagged.",
    wontCatch:
      "Only two exact callee shapes are covered: `child_process.exec(...)` " +
      "and `require(\"child_process\").exec(...)`. The very common destructured " +
      "form — `const { exec } = require(\"child_process\"); exec(cmd);` — is " +
      "NOT matched, because at the call site it's just a bare `exec(cmd)`, " +
      "structurally indistinguishable from any other function call. Other " +
      "APIs with the same risk (`execSync`, `spawn(..., { shell: true })`, " +
      "`execFile` with a shell) are out of scope entirely — different method " +
      "names, not covered by these two patterns.",
  },
];

let compiledCache = null;

/** Lazily compile every rule's patterns once (reused across a whole scan). */
function compiledRules() {
  if (compiledCache) return compiledCache;
  compiledCache = RULES.map((rule) => ({
    rule,
    compiled: rule.patterns.map((p) => pattern.compilePattern(p)),
  }));
  return compiledCache;
}

/**
 * Run every curated rule against one file's text.
 * @param {string} text
 * @returns {Array<{ruleId, title, severity, startOffset, endOffset, startLine,
 *   startChar, endLine, endChar, text, captures}>}
 */
function scanText(text) {
  const out = [];
  for (const { rule, compiled } of compiledRules()) {
    for (const c of compiled) {
      for (const m of pattern.findMatches(text, c)) {
        out.push({ ruleId: rule.id, title: rule.title, severity: rule.severity, ...m });
      }
    }
  }
  return out;
}

/**
 * Run every curated rule across many files. Mirrors pattern.searchFiles's
 * `{path, text}` input shape so callers (extension.js) can reuse the exact
 * same bounded file collection used by the search/replace scan — no
 * duplicated file-walk/exclude/cap logic.
 * @param {Array<{path:string, text:string}>} files
 * @returns {Array<{path, ruleId, title, severity, ...match}>}
 */
function scanFiles(files) {
  const out = [];
  for (const f of files) {
    for (const hit of scanText(f.text)) {
      out.push({ path: f.path, ...hit });
    }
  }
  return out;
}

module.exports = {
  RULES,
  scanText,
  scanFiles,
};
