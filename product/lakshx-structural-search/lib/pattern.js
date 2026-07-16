// LakshX Structural Search — pure, vscode-free pattern tokenizer & matcher.
//
// TRADEOFF (intentional, same call as product/lakshx-graph/lib/depgraph.js):
// this is a TOKEN-LEVEL structural matcher, NOT a full AST/parser. We tokenize
// both the pattern and the candidate source into flat JS/TS token streams
// (identifiers, punctuation, strings, numbers — comments and insignificant
// whitespace dropped) and match the pattern's token sequence against a
// sliding window of the source's token sequence, with a small set of
// placeholder tokens standing in for "any expression" or "any argument list".
//
// This is a legitimate, honest middle ground between literal regex (which
// can't express "any call to foo(...) regardless of arg count/whitespace/
// quote style") and true AST-based SSR (which needs a real parser for every
// target language — a multi-year, multi-language investment JetBrains itself
// has put decades into). Token-level matching gets you shape-matching for the
// common JS/TS refactor cases — calls, conditions, assignments — without
// bundling a parser, consistent with this codebase's existing preference for
// dependency-light approaches (playwright-core over playwright, depgraph.js's
// regex/line-based import extraction over an AST). It is NOT AST-equivalent:
// see README.md "Known limitations" for concrete cases this can't handle
// (argument-order-independence, alpha-renaming/variable equivalence, control-
// flow equivalence like De Morgan swaps) — a real parser would catch those,
// this doesn't, and the docs say so on purpose rather than overselling it.
"use strict";

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

// Longest-match-first multi-character operators/punctuation.
const PUNCT_MULTI = [
  ">>>=",
  "...",
  "=>",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  "&&=",
  "||=",
  "??=",
  ">>>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "<<",
  ">>",
  "**",
];
const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);
const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
// Keywords/operators after which a leading `/` starts a regex literal rather
// than a division operator — the classic JS lexer ambiguity. Best-effort
// heuristic (see README limitations): a handful of contrived cases can still
// mis-tokenize, same honesty as depgraph.js's comment-stripping caveat.
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);

/**
 * Tokenize JS/TS-ish source into a flat array of tokens.
 * @param {string} source
 * @param {{allowPlaceholders?: boolean}} [opts] allowPlaceholders=true recognizes
 *   `$Name` / `$$Name` as placeholder tokens (used only when tokenizing a
 *   PATTERN string — real source may legally contain `$`-prefixed identifiers
 *   like jQuery's `$`, so the source tokenizer never special-cases `$`).
 * @returns {Array<object>} tokens: {type, text, value, start, end}
 *   type: "ident" | "punct" | "string" | "number" | "template" | "regex" |
 *         "placeholder" | "placeholder-variadic"
 *   value: normalized comparison value (decoded string contents for "string";
 *          same as text otherwise)
 *   start/end: character offsets into `source` (end exclusive)
 *   notLiteral (placeholder/placeholder-variadic only): true when the
 *     pattern wrote `$Name!lit` — see the "!lit modifier" comment at its
 *     parse site below and the constraint check at the end of tryMatch().
 */
function tokenize(source, opts = {}) {
  const allowPlaceholders = !!opts.allowPlaceholders;
  const tokens = [];
  const n = source.length;
  let i = 0;
  let prevSignificant = null; // last emitted token, for the regex-vs-division heuristic

  while (i < n) {
    const c = source[i];

    // whitespace
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }

    // line comment
    if (c === "/" && source[i + 1] === "/") {
      let j = i + 2;
      while (j < n && source[j] !== "\n") j++;
      i = j;
      continue;
    }
    // block comment
    if (c === "/" && source[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j++;
      i = j < n ? j + 2 : n;
      continue;
    }

    // placeholders (pattern-only): $$Name then $Name, optionally suffixed
    // with the `!lit` modifier (see SAST-lite rules.js / README "Modifiers"):
    // `$NAME!lit` matches exactly like `$NAME` during matching, but flags the
    // compiled pattern's capture as "must NOT be a plain string/template
    // literal token for the overall match to count" — checked once at the
    // end of tryMatch(), below. Purely additive: a placeholder with no `!lit`
    // suffix behaves exactly as before.
    if (allowPlaceholders && c === "$") {
      const double = source[i + 1] === "$";
      const start = i + (double ? 2 : 1);
      let j = start;
      if (j < n && IDENT_START.test(source[j])) {
        j++;
        while (j < n && IDENT_PART.test(source[j])) j++;
        const name = source.slice(start, j);
        let notLiteral = false;
        // Require the exact literal "!lit" not followed by another ident
        // char, so a placeholder legitimately named e.g. `$X!literalValue`
        // (unusual, but not our business to break) isn't misparsed — the
        // `!` and following chars just fall through to normal punct/ident
        // tokenizing in that case.
        if (source.startsWith("!lit", j)) {
          const after = j + 4;
          if (!(after < n && IDENT_PART.test(source[after]))) {
            notLiteral = true;
            j = after;
          }
        }
        tokens.push({
          type: double ? "placeholder-variadic" : "placeholder",
          text: source.slice(i, j),
          value: name,
          name,
          notLiteral,
          start: i,
          end: j,
        });
        prevSignificant = tokens[tokens.length - 1];
        i = j;
        continue;
      }
      // `$` not followed by an identifier — falls through to punct handling
      // below (documented limitation: bare `$` in a pattern is not a useful
      // literal-match target since it always tries placeholder parsing first).
    }

    // string literal: '...' or "..."
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let value = "";
      while (j < n && source[j] !== quote) {
        if (source[j] === "\\" && j + 1 < n) {
          value += source[j] + source[j + 1];
          j += 2;
        } else {
          value += source[j];
          j++;
        }
      }
      j = Math.min(j + 1, n); // consume closing quote
      tokens.push({ type: "string", text: source.slice(i, j), value: decodeEscapes(value), start: i, end: j });
      prevSignificant = tokens[tokens.length - 1];
      i = j;
      continue;
    }

    // template literal: `...` — treated as ONE opaque token (see limitations:
    // nested template literals inside `${...}` are not decomposed correctly).
    if (c === "`") {
      let j = i + 1;
      while (j < n && source[j] !== "`") {
        if (source[j] === "\\" && j + 1 < n) j += 2;
        else j++;
      }
      j = Math.min(j + 1, n);
      tokens.push({ type: "template", text: source.slice(i, j), value: source.slice(i, j), start: i, end: j });
      prevSignificant = tokens[tokens.length - 1];
      i = j;
      continue;
    }

    // number
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] || ""))) {
      let j = i;
      if (c === "0" && (source[i + 1] === "x" || source[i + 1] === "X")) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F_]/.test(source[j])) j++;
      } else if (c === "0" && (source[i + 1] === "b" || source[i + 1] === "B")) {
        j = i + 2;
        while (j < n && /[01_]/.test(source[j])) j++;
      } else if (c === "0" && (source[i + 1] === "o" || source[i + 1] === "O")) {
        j = i + 2;
        while (j < n && /[0-7_]/.test(source[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(source[j])) j++;
        if (source[j] === "." ) {
          j++;
          while (j < n && /[0-9_]/.test(source[j])) j++;
        }
        if (source[j] === "e" || source[j] === "E") {
          let k = j + 1;
          if (source[k] === "+" || source[k] === "-") k++;
          if (/[0-9]/.test(source[k] || "")) {
            j = k;
            while (j < n && /[0-9_]/.test(source[j])) j++;
          }
        }
      }
      if (source[j] === "n") j++; // bigint suffix
      tokens.push({ type: "number", text: source.slice(i, j), value: source.slice(i, j), start: i, end: j });
      prevSignificant = tokens[tokens.length - 1];
      i = j;
      continue;
    }

    // regex literal (heuristic: only where `/` cannot mean division)
    if (c === "/" && regexAllowedHere(prevSignificant)) {
      let j = i + 1;
      let inClass = false;
      let ok = false;
      while (j < n) {
        const cj = source[j];
        if (cj === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (cj === "[") inClass = true;
        else if (cj === "]") inClass = false;
        else if (cj === "/" && !inClass) {
          j++;
          ok = true;
          break;
        } else if (cj === "\n") {
          break; // regex literals can't span lines — bail, treat as division
        }
        j++;
      }
      if (ok) {
        while (j < n && /[a-z]/i.test(source[j])) j++; // flags
        tokens.push({ type: "regex", text: source.slice(i, j), value: source.slice(i, j), start: i, end: j });
        prevSignificant = tokens[tokens.length - 1];
        i = j;
        continue;
      }
      // fall through to punct handling (treat as division)
    }

    // identifier / keyword
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(source[j])) j++;
      tokens.push({ type: "ident", text: source.slice(i, j), value: source.slice(i, j), start: i, end: j });
      prevSignificant = tokens[tokens.length - 1];
      i = j;
      continue;
    }

    // multi-char punctuation (longest match first)
    let matchedMulti = null;
    for (const p of PUNCT_MULTI) {
      if (source.startsWith(p, i)) {
        matchedMulti = p;
        break;
      }
    }
    if (matchedMulti) {
      tokens.push({ type: "punct", text: matchedMulti, value: matchedMulti, start: i, end: i + matchedMulti.length });
      prevSignificant = tokens[tokens.length - 1];
      i += matchedMulti.length;
      continue;
    }

    // single-char punctuation (covers brackets, comma, dot, operators, `$`)
    tokens.push({ type: "punct", text: c, value: c, start: i, end: i + 1 });
    prevSignificant = tokens[tokens.length - 1];
    i++;
  }

  return tokens;
}

function decodeEscapes(raw) {
  return raw.replace(/\\(.)/g, (m, ch) => {
    switch (ch) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "\\": return "\\";
      case "'": return "'";
      case '"': return '"';
      case "`": return "`";
      default: return ch;
    }
  });
}

function regexAllowedHere(prevTok) {
  if (!prevTok) return true; // start of source/pattern
  if (prevTok.type === "ident") return REGEX_PRECEDING_KEYWORDS.has(prevTok.text);
  if (prevTok.type === "number" || prevTok.type === "string" || prevTok.type === "template" || prevTok.type === "regex") return false;
  if (prevTok.type === "punct") {
    if (prevTok.text === ")" || prevTok.text === "]") return false; // `(a+b)/c` is division
    if (prevTok.text === "}") return true; // heuristic: end of a block, e.g. `}/re/`
    return true; // operators, `(`, `[`, `,`, `;`, `:`, `!`, etc. all allow a leading regex
  }
  return true;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function isOpen(tok) { return tok && tok.type === "punct" && OPEN.has(tok.text); }
function isClose(tok) { return tok && tok.type === "punct" && CLOSE.has(tok.text); }
function isComma(tok) { return tok && tok.type === "punct" && tok.text === ","; }
function isSemicolon(tok) { return tok && tok.type === "punct" && tok.text === ";"; }

/** Literal (non-placeholder) token equality, quote-style-normalized for strings. */
function literalTokenEquals(patTok, srcTok) {
  if (!srcTok) return false;
  if (patTok.type === "string" || srcTok.type === "string") {
    return patTok.type === "string" && srcTok.type === "string" && patTok.value === srcTok.value;
  }
  if (patTok.type !== srcTok.type) return false;
  return patTok.value === srcTok.value;
}

/** Sequence equality for placeholder back-references (e.g. `$X === $X`). */
function sequenceEquals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.type === "string" || y.type === "string") {
      if (x.type !== "string" || y.type !== "string" || x.value !== y.value) return false;
    } else if (x.type !== y.type || x.value !== y.value) {
      return false;
    }
  }
  return true;
}

/** First non-placeholder pattern token at/after idx, or null (end of pattern
 * / adjacent placeholder — see README limitation on adjacent placeholders). */
function nextLiteral(patternTokens, idx) {
  if (idx >= patternTokens.length) return null;
  const t = patternTokens[idx];
  if (t.type === "placeholder" || t.type === "placeholder-variadic") return null;
  return t;
}

/**
 * Determine how many source tokens (starting at `start`) a placeholder
 * consumes. Depth-tracked over brackets so nested calls/lists are captured
 * as one unit; never crosses an unmatched closer belonging to an outer scope.
 */
function extentOf(sourceTokens, start, { variadic, stopTok }) {
  if (start >= sourceTokens.length) return start; // only valid for variadic (empty capture)

  if (!stopTok && !variadic) {
    // No boundary token in the pattern to look for (placeholder is at the end
    // of the pattern with nothing after it, and not variadic). Fall back to
    // "one balanced unit": a single token, or — if it opens a bracket — the
    // whole balanced group, so `$A` still captures `bar(1,2)` as one thing
    // when used as a bare trailing placeholder. See README limitations:
    // trailing single placeholders don't span further binary operators etc.
    if (isOpen(sourceTokens[start])) {
      let depth = 0, j = start;
      do {
        if (isOpen(sourceTokens[j])) depth++;
        else if (isClose(sourceTokens[j])) depth--;
        j++;
      } while (depth > 0 && j < sourceTokens.length);
      return j;
    }
    return start + 1;
  }

  let depth = 0;
  let j = start;
  let first = true;
  while (j < sourceTokens.length) {
    const tok = sourceTokens[j];
    if (depth === 0) {
      if (!variadic && !first && isComma(tok)) break;
      // A top-level `;` is always a statement boundary — no placeholder
      // (single or variadic) should ever swallow one, even mid-scan when it
      // isn't the pattern's own stop token. Without this a placeholder with
      // no other nearby boundary (e.g. `$FN` before its own `(`) can wander
      // backwards-in-spirit into an unrelated PRECEDING statement's trailing
      // tokens once the scan resumes right after a previous match. Known
      // exception (documented in README): a `for (;;)` header's semicolons.
      if (isSemicolon(tok)) break;
      if (stopTok && literalTokenEquals(stopTok, tok)) break;
      if (isClose(tok)) break; // unmatched closer -> belongs to an outer scope
    }
    if (isOpen(tok)) depth++;
    else if (isClose(tok)) depth--;
    j++;
    first = false;
  }
  return j;
}

/** Try to match patternTokens against sourceTokens starting exactly at sStart. */
function tryMatch(patternTokens, sourceTokens, sStart) {
  let sIdx = sStart;
  const captures = new Map();
  for (let pIdx = 0; pIdx < patternTokens.length; pIdx++) {
    const ptok = patternTokens[pIdx];
    if (ptok.type === "placeholder" || ptok.type === "placeholder-variadic") {
      const variadic = ptok.type === "placeholder-variadic";
      const existing = captures.get(ptok.name);
      if (existing) {
        // Back-reference (e.g. `$X === $X`): require EXACTLY the previously
        // captured token sequence, by length, right here — rather than
        // independently re-deriving an extent (which for a *trailing*
        // repeated placeholder with no following literal token would fall
        // back to the single-token/degenerate rule and almost always mismatch
        // the first occurrence's longer capture, e.g. `fn(1)` vs `fn`).
        const want = existing.tokens;
        const got = sourceTokens.slice(sIdx, sIdx + want.length);
        if (!sequenceEquals(want, got)) return null;
        sIdx += want.length;
        continue;
      }
      const stopTok = nextLiteral(patternTokens, pIdx + 1);
      const endIdx = extentOf(sourceTokens, sIdx, { variadic, stopTok });
      if (!variadic && endIdx === sIdx) return null; // single placeholder needs >=1 token
      const capturedToks = sourceTokens.slice(sIdx, endIdx);
      captures.set(ptok.name, { tokens: capturedToks, variadic, notLiteral: !!ptok.notLiteral });
      sIdx = endIdx;
      continue;
    }
    if (sIdx >= sourceTokens.length) return null;
    if (!literalTokenEquals(ptok, sourceTokens[sIdx])) return null;
    sIdx++;
  }
  // `!lit` constraint check (see tokenizer comment above): a capture tagged
  // notLiteral fails the WHOLE match if it turns out to be exactly one plain
  // string/template token — this is what lets a rule like
  // `$OBJ.query($SQL!lit)` match anything as a slot but only actually FIRE
  // when that slot isn't a fixed literal. A capture is only "a plain literal"
  // when it collapses to a single string/template token; multiple tokens
  // (e.g. a concatenation `"a" + b`) are, correctly, NOT a plain literal and
  // DO count as the risk signal. Template literals are tokenized as one
  // opaque token regardless of any `${...}` interpolation inside them (see
  // README "Known limitations") — so a template literal is always treated as
  // "literal" here even if it interpolates a variable. That is a real,
  // acknowledged gap (see rules.js "what this WON'T catch" + README), not an
  // oversight: fixing it would require decomposing template literals, which
  // this tokenizer deliberately doesn't do.
  for (const cap of captures.values()) {
    if (!cap.notLiteral) continue;
    const toks = cap.tokens;
    const isPlainLiteral = toks.length === 1 && (toks[0].type === "string" || toks[0].type === "template");
    if (isPlainLiteral) return null;
  }
  return { endIdx: sIdx, captures };
}

/** offset -> {line, character}, both 0-based. Pure — no vscode dependency, so
 * extension.js can build a vscode.Position directly from the result. */
function offsetToPosition(source, offset) {
  let line = 0;
  let lastNewline = -1;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      line++;
      lastNewline = i;
    }
  }
  return { line, character: offset - lastNewline - 1 };
}

function tokensToText(source, tokens) {
  if (tokens.length === 0) return "";
  return source.slice(tokens[0].start, tokens[tokens.length - 1].end);
}

/**
 * Compile a pattern string once (reused across many files in a workspace scan).
 * @returns {{tokens: Array, names: string[]}}
 */
function compilePattern(patternSource) {
  const tokens = tokenize(patternSource, { allowPlaceholders: true });
  const names = [...new Set(tokens.filter((t) => t.type.startsWith("placeholder")).map((t) => t.name))];
  return { tokens, names };
}

/**
 * Find every non-overlapping match of `patternSource` in `sourceText`.
 * @param {string} sourceText
 * @param {string|{tokens:Array}} pattern  a pattern string, or a pre-compiled pattern
 * @returns {Array<{startOffset,endOffset,startLine,startChar,endLine,endChar,text,captures}>}
 */
function findMatches(sourceText, pattern) {
  const compiled = typeof pattern === "string" ? compilePattern(pattern) : pattern;
  const patternTokens = compiled.tokens;
  if (patternTokens.length === 0) return [];
  const sourceTokens = tokenize(sourceText, { allowPlaceholders: false });
  const matches = [];
  for (let start = 0; start < sourceTokens.length; start++) {
    const res = tryMatch(patternTokens, sourceTokens, start);
    if (!res) continue;
    const startOffset = sourceTokens[start] ? sourceTokens[start].start : 0;
    // zero-length match guard (shouldn't happen since pattern.length>0 and at
    // least one literal or non-empty-required placeholder is consumed, but
    // stay defensive so a pathological all-variadic pattern can't loop forever)
    const endOffset = res.endIdx > start ? sourceTokens[res.endIdx - 1].end : startOffset;
    const startPos = offsetToPosition(sourceText, startOffset);
    const endPos = offsetToPosition(sourceText, endOffset);
    const captures = {};
    for (const [name, cap] of res.captures) {
      captures[name] = { text: tokensToText(sourceText, cap.tokens), variadic: cap.variadic };
    }
    matches.push({
      startOffset,
      endOffset,
      startLine: startPos.line,
      startChar: startPos.character,
      endLine: endPos.line,
      endChar: endPos.character,
      text: sourceText.slice(startOffset, endOffset),
      captures,
    });
    start = Math.max(start, res.endIdx - 1); // skip past this match, no overlap
  }
  return matches;
}

/**
 * Run findMatches across many files. Mirrors depgraph.js's buildGraph(files)
 * shape so both this and the workspace scan orchestration in extension.js are
 * pure/testable without an extension host.
 * @param {Array<{path:string, text:string}>} files
 * @param {string|{tokens:Array}} pattern
 * @param {{maxMatches?:number}} [opts]
 */
function searchFiles(files, pattern, opts = {}) {
  const compiled = typeof pattern === "string" ? compilePattern(pattern) : pattern;
  const maxMatches = opts.maxMatches || Infinity;
  const out = [];
  let truncated = false;
  for (const f of files) {
    if (out.length >= maxMatches) { truncated = true; break; }
    const matches = findMatches(f.text, compiled);
    for (const m of matches) {
      if (out.length >= maxMatches) { truncated = true; break; }
      out.push({ path: f.path, ...m });
    }
  }
  return { matches: out, truncated };
}

/**
 * Substitute captured placeholder values into a replacement template. This is
 * a plain string-level substitution over the TEMPLATE TEXT (not a re-tokenize
 * + re-print of the match) so the user's own formatting/spacing in the
 * replacement is preserved exactly; only `$Name` / `$$Name` occurrences are
 * swapped for the raw captured source text. `$$` is tried before `$` so
 * `$$ARGS` isn't misread as `$` + `$ARGS`.
 * @param {string} template
 * @param {Record<string, {text:string}>} captures
 */
function substitute(template, captures) {
  return template.replace(/\$\$([A-Za-z_]\w*)|\$([A-Za-z_]\w*)/g, (whole, dbl, single) => {
    const name = dbl || single;
    const cap = captures[name];
    return cap ? cap.text : whole;
  });
}

module.exports = {
  tokenize,
  compilePattern,
  findMatches,
  searchFiles,
  substitute,
  offsetToPosition,
  // exported for tests / reuse
  _internal: { tryMatch, extentOf, literalTokenEquals, sequenceEquals, tokensToText },
};
