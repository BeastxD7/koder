# LakshX Structural Search

Find & replace across files by code **shape**, not literal text — inspired by
JetBrains' Structural Search & Replace (SSR). `console.log($MSG)` matches
every call to `console.log` with exactly one argument, regardless of what
that argument is; `$FN($$ARGS)` matches any call to anything, with any
number of arguments, regardless of whitespace or quote style. Every
replacement shows a **before → after preview** across every affected file —
nothing is ever written until you explicitly click "Apply selected".

This complements LakshX's agent chat, it doesn't duplicate it: the agent is
great at nondeterministic, judgment-requiring edits; this tool is for the
opposite case — a bulk mechanical rewrite you want applied deterministically
and identically everywhere, with zero LLM calls and zero cost.

## What this is (and isn't)

**This is a token-level structural matcher, not a full AST/parser.** It
tokenizes both your pattern and every candidate file into a flat stream of
JS/TS tokens (identifiers, punctuation, strings, numbers — comments and
insignificant whitespace dropped) and matches the pattern's token sequence
against the source's, with a couple of placeholder tokens standing in for
"any expression" or "any argument list". That's a different, cheaper thing
than JetBrains SSR's real per-language AST engine, which is a genuine
multi-year, multi-language undertaking. Token-level matching is a deliberate,
documented middle ground between literal regex (can't express "any call to
foo(...) regardless of argument order/whitespace/variable names") and true
AST-SSR (needs a real parser). See "Known limitations" below for concrete
cases a real parser would catch that this won't — the goal here is to be
useful for the common mechanical-refactor cases, honestly scoped, not to
oversell shape-matching as JetBrains-equivalent.

This choice is also consistent with how the rest of this codebase treats
dependency weight: `product/lakshx-graph/lib/depgraph.js` extracts imports
with a regex/line-based scan instead of bundling a parser, for the same
reasons (robust, dependency-free, fast on thousands of files, and an
explicitly-documented tradeoff rather than a silent one). The agent runtime
elsewhere in this repo makes the same call (`playwright-core` instead of the
full `playwright` package). A bundled tree-sitter or a real JS/TS parser
would give exact AST matching, but at real install-size and maintenance
cost, and only for the languages you bundled a grammar for — this extension
stays true to that "pragmatic over heavy" precedent instead.

**v1 scope**: JS/TS/JSX/TSX only (`.js .jsx .mjs .cjs .ts .tsx .mts .cts`) —
the most tractable target given no bundled parser, and where placeholder
patterns for calls/conditions/assignments cover the most common mechanical
refactors.

## Pattern syntax

| Syntax | Meaning |
|---|---|
| any literal token(s) | matched exactly (after whitespace normalization and string quote-style normalization — see below) |
| `$NAME` | matches exactly **one** expression / argument slot (a run of tokens, balanced across nested brackets, up to the next top-level comma or the next literal pattern token) |
| `$$NAME` | matches **zero or more** comma-separated expressions as a single capture — "the rest of the argument list", any count including empty |
| repeated `$NAME` | every occurrence of the **same** placeholder name in one pattern must capture the **same** text (a back-reference), e.g. `$X === $X` matches `a === a` but not `a === b` |
| `$NAME!lit` / `$$NAME!lit` | matches exactly like `$NAME`/`$$NAME`, but the whole pattern only fires if that capture is **NOT** a plain string/template literal token — see "SAST-lite security scan" below |

### Examples

```
Pattern:      $FN($$ARGS)
Matches:      foo(1, 2, 3)         captures FN=foo,    ARGS="1, 2, 3"
              bar()                captures FN=bar,    ARGS=""
              baz(compute(a, b))   captures FN=baz,    ARGS="compute(a, b)"  (nested call kept whole)

Pattern:      $OBJ.$METHOD($$ARGS)
Matches:      req.log('hi')        captures OBJ=req,   METHOD=log, ARGS="'hi'"

Pattern:      log($X)                 (single, non-variadic — exactly one arg)
Matches:      log(1)                  YES
Doesn't:      log(1, 2)  /  log()     NO — wrong argument count

Pattern:      $X === $X               (repeated placeholder = back-reference)
Matches:      if (a === a)            YES  (captures X=a)
Doesn't:      if (a === b)            NO   (a != b)
```

Whitespace is always insignificant (patterns and source are compared as
token streams, not text), and string-literal quote style is normalized —
`'x'` and `"x"` are the same token for matching purposes, in both the
pattern and in repeated-placeholder back-references.

### Replace

A replacement is a template string using the **same placeholder names** as
the search pattern; each `$NAME` (or `$$NAME`) occurrence in the template is
replaced with that placeholder's exact captured source text (not
re-formatted — whatever the original argument text looked like is preserved
verbatim).

```
Search:       $FN($$ARGS)
Replace with: await $FN($ARGS)     <- "$ARGS" here just means "substitute
                                       whatever ARGS captured"; the $ vs $$
                                       sigil only matters during MATCHING,
                                       not during substitution.

foo(1, 2, 3);   ->   await foo(1, 2, 3);
bar();          ->   await bar();
```

```
Search:       assert.equal($A, $B)
Replace with: assert.strictEqual($A, $B)

assert.equal(got, want);   ->   assert.strictEqual(got, want);
```

## Matcher design — why token-level, not AST

- **Tokenizer** (`lib/pattern.js`): a small hand-written lexer for
  identifiers, punctuation/operators (longest-match-first for multi-char
  operators like `===`, `=>`, `??=`), numbers (hex/oct/bin/bigint), string
  literals (quote-normalized via a decoded `value` alongside the raw
  `text`), template literals (treated as **one opaque token** — see
  limitations), a best-effort regex-vs-division heuristic, and comment
  stripping. Two modes: source mode (plain JS/TS — `$foo` is a completely
  ordinary identifier, same as jQuery's `$`) and pattern mode (`$Name` /
  `$$Name` are recognized as placeholders).
- **Matcher**: walks the pattern's token list against a sliding window of
  the source's token list. Literal tokens must match exactly (quote-style
  normalized for strings). A placeholder's extent is found by scanning
  forward with bracket-depth tracking: it can cross nested brackets (so a
  nested call captured as an argument comes back whole, e.g. `compute(a,b)`
  as one `$X`), but never crosses an **unmatched** closing bracket (that
  belongs to an outer scope) or a **top-level statement-terminating `;`**.
  A non-variadic placeholder additionally stops at a top-level `,`; a
  variadic one doesn't (that's what lets it capture an entire, arbitrary-
  length argument list as one unit). Repeated placeholder names are
  resolved as a direct back-reference against the first occurrence's
  captured token sequence, not re-derived independently, so `$X === $X`
  behaves correctly even when the second `$X` has nothing after it in the
  pattern to bound its scan.
- **Why not backtracking/full parsing**: this grammar is simple enough
  (placeholders always have a deterministic extent given bracket depth +
  the next literal pattern token) that no generic backtracking search is
  needed — each placeholder's boundary is found in one forward scan, so
  matching stays linear in file size and doesn't need a parser's full
  grammar for every language you want to support. That's the whole trade:
  you get shape-matching for the common refactor cases (calls, methods,
  conditions) without the cost of AST infrastructure — see the top-level
  "What this is (and isn't)" section for the explicit tradeoff this makes
  against real JetBrains-style SSR.
- **Search** (`extension.js`): a bounded static scan, same caps/rationale as
  `lakshx-graph`'s dependency scan — `vscode.workspace.findFiles` with a
  JS/TS include glob and the usual vendor/build exclude glob
  (`node_modules,.git,dist,build,out,.next,.venv,venv,__pycache__,coverage,
  vendor`), capped at **2000 files** and **512 KB/file**, plus a **500
  total-matches** render cap (`truncated` is always reported honestly rather
  than silently dropping matches). No code is ever executed.
- **Replace**: always preview-first. The webview shows every match's exact
  location, the matched text, and (once you type a replacement) a computed
  before/after diff line per match, each with its own checkbox — nothing is
  selected out of your control implicitly, but you can deselect specific
  matches before applying. Clicking "Apply selected" re-verifies each
  match's original text against the file's **current** contents right
  before building the edit (in case the file changed since the scan —
  mismatches are skipped and reported, never force-applied over stale
  offsets), shows a second explicit confirmation dialog naming the file/match
  count, and only then builds one `vscode.WorkspaceEdit` and calls
  `vscode.workspace.applyEdit` — a single, undoable (via VS Code's normal
  Undo), multi-file transaction. There is no code path that writes a file
  without that confirmation.

## SAST-lite security scan (`lib/rules.js`)

A small, curated pack of built-in rules for common JS/TS vulnerability
*shapes* — SQLi and XSS-class — built entirely on the same token-level
matcher above, reusing the same bounded workspace scan as search/replace
(`extension.js`'s `collectWorkspaceFiles`). Run it via the command palette:
**"LakshX: SAST-lite Security Scan (workspace)"** (`lakshx.structuralSearch.scanWorkspace`).
Hits show up in the standard **Problems panel** (`vscode.languages.
createDiagnosticCollection`), the same diagnostics style `lakshx-graph`
already uses for its OSV dependency-vulnerability checks — not a new wiring
style invented for this feature.

**Say this plainly, the same way the section above does: this is
shape-matching, not taint/dataflow analysis.** It looks at one call or
assignment site in isolation and asks "is the risky argument a fixed
literal, or something else?" — it never traces where a value actually came
from, never crosses a function boundary, and never confirms that a flagged
non-literal argument is actually attacker-controlled. Given this codebase
just finished a security audit, overselling this as more than it is would be
actively misleading — so every rule below documents its own **"what this
WON'T catch"**, not just this general framing.

### The `!lit` modifier (matcher extension)

To express "flag only if this captured slot is NOT a plain string/template
literal" — the actual injection signal — patterns can suffix a placeholder
name with `!lit`: `$SQL!lit` (or `$$SQL!lit` for a trailing/variadic slot).
During MATCHING it behaves exactly like `$SQL`/`$$SQL` (captures one
expression slot, or the rest of a statement for a trailing variadic one).
The extra behavior: once a candidate match is otherwise complete, any
`!lit`-tagged capture that turns out to be **exactly one plain string or
template token** causes the WHOLE match to be rejected (not just that
capture) — so the rule only actually fires when the slot is something other
than a fixed literal (a variable, a concatenation, a call, ...).

```
Pattern:   $OBJ.query($SQL!lit)
db.query("SELECT * FROM users")     NOT flagged  — SQL is one string token, a plain literal
db.query(sql)                       flagged      — SQL is an identifier, not a literal
db.query("SELECT * FROM " + userInput)   flagged — SQL is 3 tokens (string, +, ident), not ONE literal token
```

This is additive: a placeholder with no `!lit` suffix behaves exactly as it
did before this feature — no existing pattern's behavior changes.

One sharp edge worth knowing (and pinned as a test in `test/rules.test.js`):
a **template literal** is tokenized as one opaque token no matter what it
interpolates (see "Known limitations" below), so
`` db.query(`SELECT * FROM x WHERE id=${userInput}`) `` is treated as "one
plain literal token" and is **NOT flagged** — a real, acknowledged gap, not
an oversight.

### The 4 curated rules

| id | fires on | severity |
|---|---|---|
| `sast-sql-injection` | `$OBJ.query($SQL!lit)` / `$OBJ.execute($SQL!lit)` — string-built SQL | error |
| `sast-xss-innerhtml` | `$EL.innerHTML = $$X!lit` — dynamic innerHTML assignment | warning |
| `sast-eval` | `eval($X)` — any argument, eval itself is the risk | warning |
| `sast-shell-exec` | `child_process.exec($CMD!lit)` / `require("child_process").exec($CMD!lit)` — dynamic shell exec | error |

Each rule in `lib/rules.js` carries its own `why` ("why this matters") and
`wontCatch` ("what this WON'T catch") fields, surfaced in the source so the
honesty framing travels with the rule, not just this doc. Concrete
**what-this-WON'T-catch** examples, each proven by a real (not just
asserted) test in `test/rules.test.js`:

- **Template literal with interpolation** (see above) —
  `` db.query(`SELECT ... ${userInput}`) `` is missed; the tokenizer's
  opaque-template-token limitation defeats the literal check.
- **Extra call arguments** — `db.query(sql, callback)` doesn't match the
  1-argument pattern shape at all (the placeholder stops at the first
  top-level comma), so it's silently never scanned.
- **A common destructured import** — `const { exec } = require("child_process");
  exec(cmd);` is missed: at the call site it's just a bare `exec(cmd)`,
  structurally indistinguishable from any other 1-argument function call.
- **A compound assignment operator** — `el.innerHTML += userInput` uses a
  different operator token (`+=` vs `=`) than the rule's exact pattern and
  is not matched.
- **Aliased/indirect `eval`** — `const run = eval; run(userInput);` doesn't
  match the literal identifier `eval` the rule looks for.

One important **non-gap**, worth stating precisely because the naive
intuition is wrong: taint flowing through an *intermediate variable within
the same expression* is generally still caught, because a variable
reference is not a literal token — `const q = userInput; db.query(q +
rest);` **does** fire (`q + rest` is 3 tokens, not one literal). The real
gap is taint that flows through a call the rule's shape doesn't cover at
all, an intermediate template literal, or extra call arguments — the
concrete cases enumerated above, not "any variable at all."

## Known limitations (concrete examples — pinned as tests in `test/pattern.test.js`)

1. **Argument order is positional, not commutative.** `foo($A, $B)` matches
   `foo(y, x)` by capturing `A=y, B=x` — it does **not** recognize that as
   "the same call as `foo(x, y)` with arguments swapped". A real AST-based
   tool with semantic knowledge of commutative operations could normalize
   order for cases like `a + b` vs `b + a`; this token matcher has no such
   notion and never will without adding real semantic analysis.

2. **No alpha-equivalence / variable-renaming awareness.** Pattern
   `function foo(x){ return x+1; }` does **not** match
   `function foo(y){ return y+1; }` even though they're structurally
   identical modulo a bound-variable rename. A literal (non-placeholder)
   identifier in the pattern must match that exact identifier text
   everywhere; you'd need to write every occurrence as the same placeholder
   name (`function foo($P){ return $P+1; }`) to make renaming irrelevant,
   and that only works because you already anticipated the variance —
   there's no scope-aware binding analysis under the hood.

3. **No control-flow / semantic equivalence.** Pattern
   `if (a) { x(); } else { y(); }` does **not** match the De-Morgan/branch-
   swapped `if (!a) { y(); } else { x(); }`, nor would an `if/else` pattern
   match a semantically-equivalent ternary. The matcher has zero notion of
   boolean logic or control-flow equivalence — it's comparing token shapes,
   not meaning.

Smaller, secondary caveats: template literals are tokenized as one opaque
span (a nested template literal inside `${...}` isn't decomposed — rare, but
not handled); the regex-vs-division lexer heuristic can mis-tokenize
contrived cases the same class of bug every hand-written JS lexer without a
full grammar has to guess at; and two placeholders directly adjacent with no
literal token between them are unsupported/ambiguous.

## Files

- `lib/pattern.js` — pure, vscode-free tokenizer + matcher + substitution
  (including the `!lit` modifier). Fully unit-tested, no `vscode` import,
  importable straight into `node --test`.
- `lib/rules.js` — pure, vscode-free curated SAST-lite rule pack (4 rules)
  built on `lib/pattern.js`. Fully unit-tested, no `vscode` import.
- `extension.js` — the only file that touches `vscode`: bounded workspace
  scan (`collectWorkspaceFiles`, shared by both the search/replace panel and
  the SAST-lite scan), the webview panel, the `WorkspaceEdit` apply path, and
  the `lakshxSast` `DiagnosticCollection` for the SAST-lite scan.
- `media/search.{js,css}` — the search/replace panel UI (vanilla DOM, no
  framework/CDN, consistent with `lakshx-graph`'s canvas webview).
- `test/pattern.test.js` — `node --test` suite: simple call-shape matches,
  argument-count-agnostic matches, whitespace/quote normalization,
  multi-placeholder substitution round trips, the nested-call and repeated-
  placeholder "tricky" cases, and the three known-limitation examples above
  pinned as tests (so a "fix" can't silently overclaim capability without a
  test update flagging it).
- `test/rules.test.js` — `node --test` suite for the SAST-lite rule pack:
  positive and negative (safe) cases for each of the 4 rules, plus the
  "what this WON'T catch" gaps above, each pinned as a test that proves the
  miss rather than just asserting it in prose.

## Usage

Command palette: **"LakshX: Structural Search & Replace"**, or the
`$(regex) Structural Search` status-bar item. Type a pattern, optionally a
replacement template, hit Search, review the before/after preview per match,
check/uncheck individual matches, then "Apply selected".

For the SAST-lite scan: command palette **"LakshX: SAST-lite Security Scan
(workspace)"**. Hits appear in the Problems panel, tagged `source: "LakshX"`
with the rule id as `code` (e.g. `sast-sql-injection`).

## Verification

```
$ node --check lib/pattern.js lib/rules.js extension.js media/search.js test/pattern.test.js test/rules.test.js
(all pass, no output)

$ node --test test/*.test.js
ℹ tests 43
ℹ pass 43
ℹ fail 0
```

Not verified live inside a real VS Code extension host in this pass (no
extension host available here) — `vscode.workspace.findFiles` /
`applyEdit` / webview wiring in `extension.js` is code-reviewed and
inspection-only, consistent with how `lakshx-graph` documents the same gap
for its own `findFiles` scan path. The correctness-critical surface (pattern
tokenizing, matching, capture, substitution) is the part that's fully
tested in isolation.
