// Prompt construction + provider request/response handling for next-edit
// prediction. The pure functions here (buildPrompt, buildRequestBody,
// extractText, parsePrediction) take/return plain strings and objects and
// are fully covered by node --test with no vscode and no network. The one
// impure function, `callProvider`, does the actual HTTPS round trip and is
// kept as small as possible so it needs no mocking to reason about —
// everything it does is delegate to the pure functions plus `fetch`.
"use strict";

// ---- bounded context window (privacy + latency) ----------------------------
// These are the ONLY pieces of the document/session ever sent to the model:
// a short prefix before the cursor, a short suffix after it, and a compact
// summary of the last few edits (itself already bounded by history.js). No
// whole-file content, no other open documents, no workspace metadata.
const MAX_PREFIX_CHARS = 800;
const MAX_SUFFIX_CHARS = 400;
const MAX_HISTORY_CHARS = 500;
const MAX_TOKENS = 80;
const DEFAULT_TIMEOUT_MS = 2500;

function truncateHead(s, n) {
  // Keep the END of the prefix (closest to the cursor matters most).
  if (typeof s !== "string" || s.length <= n) return s || "";
  return s.slice(s.length - n);
}

function truncateTail(s, n) {
  // Keep the START of the suffix (closest to the cursor matters most).
  if (typeof s !== "string" || s.length <= n) return s || "";
  return s.slice(0, n);
}

/**
 * Build the (system, user) prompt pair asking for "the next likely edit",
 * not a token continuation. Deliberately terse: this needs to feel instant,
 * so there's no multi-turn setup, no tool schema, no chain-of-thought ask.
 */
function buildPrompt({ prefix, suffix, historyText, languageId }) {
  const p = truncateHead(prefix, MAX_PREFIX_CHARS);
  const s = truncateTail(suffix, MAX_SUFFIX_CHARS);
  const h = truncateTail(historyText || "", MAX_HISTORY_CHARS);

  const system = [
    "You predict the SINGLE next small edit a developer is about to make at their cursor.",
    "This is next-EDIT prediction, not next-token autocomplete: use the pattern in their recent edits",
    "(if any) to infer an analogous change, not just the most likely continuation of the text.",
    "Reply with ONLY the literal text to insert at <CURSOR>. No explanation, no markdown fences, no quotes around it.",
    "If you have no confident, small, specific prediction, reply with exactly: NONE",
  ].join(" ");

  const user = [
    `Language: ${languageId || "plaintext"}`,
    h ? `Recent edits in this file (oldest first):\n${h}` : "",
    `Code immediately before cursor:\n${p}`,
    `<CURSOR>`,
    `Code immediately after cursor:\n${s}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { system, user };
}

/** Build a minimal chat/completion request body for the given wire `kind`. */
function buildRequestBody({ kind, model, system, user, maxTokens = MAX_TOKENS }) {
  if (kind === "anthropic") {
    return {
      model,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    };
  }
  // openai-compatible (openai, openrouter, deepseek, groq, xai, gemini shim,
  // cerebras, ollama — everything else in PRESETS).
  return {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

/** Pull the raw text reply out of either wire format's response JSON. */
function extractText(kind, json) {
  try {
    if (kind === "anthropic") {
      const block = Array.isArray(json.content) ? json.content.find((b) => b && b.type === "text") : null;
      return block ? block.text || "" : "";
    }
    return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || "";
  } catch {
    return "";
  }
}

/** Normalize a raw model reply into either a clean insertion string or
 * `null` ("no prediction" — including the explicit NONE sentinel, empty
 * replies, and accidental markdown-fence wrapping). */
function parsePrediction(raw) {
  if (typeof raw !== "string") return null;
  let t = raw.trim();
  if (!t) return null;
  // Strip an accidental ```lang\n ... \n``` wrapper some models add anyway.
  const fenced = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) t = fenced[1];
  t = t.trim();
  if (!t || t === "NONE") return null;
  return t;
}

/** The single, small, non-agentic HTTPS call. Times out at `timeoutMs` and
 * fails SILENTLY (returns null, never throws past this function's own
 * catch) — a slow/unreachable model must never block or flash an error in
 * the editor; it should simply mean "no ghost text this time." */
async function callProvider({ kind, baseUrl, apiKey, headers, model, system, user, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
  const body = buildRequestBody({ kind, model, system, user });
  const url = kind === "anthropic" ? `${baseUrl.replace(/\/$/, "")}/v1/messages` : `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const reqHeaders =
    kind === "anthropic"
      ? { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  Object.assign(reqHeaders, headers || {});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onExternalAbort);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    return parsePrediction(extractText(kind, json));
  } catch {
    return null; // timeout, network error, abort, bad JSON — all "no prediction"
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
}

module.exports = {
  MAX_PREFIX_CHARS,
  MAX_SUFFIX_CHARS,
  MAX_HISTORY_CHARS,
  MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  buildPrompt,
  buildRequestBody,
  extractText,
  parsePrediction,
  callProvider,
};
