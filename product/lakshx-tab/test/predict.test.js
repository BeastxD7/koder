"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  buildPrompt,
  buildRequestBody,
  extractText,
  parsePrediction,
  callProvider,
  MAX_PREFIX_CHARS,
  MAX_SUFFIX_CHARS,
} = require("../lib/predict.js");

// ---------------------------------------------------------------------------
// buildPrompt — bounded context window
// ---------------------------------------------------------------------------
test("buildPrompt: includes language, cursor marker, and both prefix/suffix", () => {
  const { system, user } = buildPrompt({ prefix: "const x = ", suffix: ";\n", historyText: "", languageId: "javascript" });
  assert.match(system, /next-EDIT prediction/);
  assert.match(system, /reply with exactly: NONE/i);
  assert.match(user, /Language: javascript/);
  assert.match(user, /<CURSOR>/);
  assert.match(user, /const x = /);
  assert.match(user, /;\n/);
});

test("buildPrompt: omits the 'recent edits' section entirely when there is no history", () => {
  const { user } = buildPrompt({ prefix: "a", suffix: "b", historyText: "", languageId: "ts" });
  assert.doesNotMatch(user, /Recent edits/);
});

test("buildPrompt: includes recent edits section when history is present", () => {
  const { user } = buildPrompt({ prefix: "a", suffix: "b", historyText: 'L1: +"foo"', languageId: "ts" });
  assert.match(user, /Recent edits in this file/);
  assert.match(user, /L1: \+"foo"/);
});

test("buildPrompt: truncates a huge prefix to MAX_PREFIX_CHARS, keeping the END (closest to cursor)", () => {
  const bigPrefix = "A".repeat(5000) + "TAIL_MARKER";
  const { user } = buildPrompt({ prefix: bigPrefix, suffix: "", historyText: "", languageId: "js" });
  assert.match(user, /TAIL_MARKER/);
  // The prompt shouldn't contain the full 5000-char run of A's.
  assert.ok(!user.includes("A".repeat(5000)));
});

test("buildPrompt: truncates a huge suffix to MAX_SUFFIX_CHARS, keeping the START (closest to cursor)", () => {
  const bigSuffix = "HEAD_MARKER" + "B".repeat(5000);
  const { user } = buildPrompt({ prefix: "", suffix: bigSuffix, historyText: "", languageId: "js" });
  assert.match(user, /HEAD_MARKER/);
  assert.ok(!user.includes("B".repeat(5000)));
});

test("buildPrompt: defaults languageId to plaintext when missing", () => {
  const { user } = buildPrompt({ prefix: "", suffix: "", historyText: "" });
  assert.match(user, /Language: plaintext/);
});

// ---------------------------------------------------------------------------
// buildRequestBody — per-wire-format shape
// ---------------------------------------------------------------------------
test("buildRequestBody: anthropic shape has top-level system + single user message", () => {
  const body = buildRequestBody({ kind: "anthropic", model: "claude-sonnet-5", system: "SYS", user: "USR" });
  assert.equal(body.model, "claude-sonnet-5");
  assert.equal(body.system, "SYS");
  assert.deepEqual(body.messages, [{ role: "user", content: "USR" }]);
  assert.equal(body.temperature, 0);
  assert.ok(body.max_tokens > 0 && body.max_tokens <= 200); // small, non-agentic budget
});

test("buildRequestBody: openai-compatible shape has system+user as two messages", () => {
  const body = buildRequestBody({ kind: "openai", model: "gpt-5", system: "SYS", user: "USR" });
  assert.deepEqual(body.messages, [
    { role: "system", content: "SYS" },
    { role: "user", content: "USR" },
  ]);
  assert.equal(body.model, "gpt-5");
});

test("buildRequestBody: respects a custom maxTokens", () => {
  const body = buildRequestBody({ kind: "openai", model: "m", system: "s", user: "u", maxTokens: 12 });
  assert.equal(body.max_tokens, 12);
});

// ---------------------------------------------------------------------------
// extractText — per-wire-format response parsing
// ---------------------------------------------------------------------------
test("extractText: anthropic response with a text content block", () => {
  const json = { content: [{ type: "text", text: "hello world" }] };
  assert.equal(extractText("anthropic", json), "hello world");
});

test("extractText: anthropic response with no text block returns empty string", () => {
  assert.equal(extractText("anthropic", { content: [{ type: "tool_use" }] }), "");
  assert.equal(extractText("anthropic", {}), "");
});

test("extractText: openai-compatible response", () => {
  const json = { choices: [{ message: { content: "predicted edit" } }] };
  assert.equal(extractText("openai", json), "predicted edit");
});

test("extractText: malformed/missing fields never throw, just return ''", () => {
  assert.equal(extractText("openai", {}), "");
  assert.equal(extractText("openai", null), "");
  assert.equal(extractText("anthropic", undefined), "");
});

// ---------------------------------------------------------------------------
// parsePrediction — normalize model output to insertion text or null
// ---------------------------------------------------------------------------
test("parsePrediction: plain text passes through trimmed", () => {
  assert.equal(parsePrediction("  const y = 2;  "), "const y = 2;");
});

test("parsePrediction: explicit NONE sentinel -> null", () => {
  assert.equal(parsePrediction("NONE"), null);
  assert.equal(parsePrediction("  NONE  "), null);
});

test("parsePrediction: empty/whitespace/non-string -> null", () => {
  assert.equal(parsePrediction(""), null);
  assert.equal(parsePrediction("   "), null);
  assert.equal(parsePrediction(null), null);
  assert.equal(parsePrediction(undefined), null);
});

test("parsePrediction: strips an accidental markdown code fence wrapper", () => {
  assert.equal(parsePrediction("```js\nconst y = 2;\n```"), "const y = 2;");
  assert.equal(parsePrediction("```\nplain\n```"), "plain");
});

test("parsePrediction: fenced NONE still resolves to null", () => {
  assert.equal(parsePrediction("```\nNONE\n```"), null);
});

// ---------------------------------------------------------------------------
// callProvider — real fetch mocked, no network required
// ---------------------------------------------------------------------------
test("callProvider: posts to <baseUrl>/chat/completions for openai-kind and returns parsed prediction", async (t) => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "predicted!" } }] }),
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await callProvider({
    kind: "openai",
    baseUrl: "https://api.example.com/v1",
    apiKey: "test-key",
    model: "m",
    system: "s",
    user: "u",
  });

  assert.equal(result, "predicted!");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/v1/chat/completions");
  assert.equal(calls[0].opts.headers.authorization, "Bearer test-key");
  const sentBody = JSON.parse(calls[0].opts.body);
  assert.equal(sentBody.model, "m");
});

test("callProvider: posts to <baseUrl>/v1/messages with x-api-key for anthropic-kind", async (t) => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ content: [{ type: "text", text: "anthro-predicted" }] }) };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await callProvider({
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "ant-key",
    model: "claude-sonnet-5",
    system: "s",
    user: "u",
  });

  assert.equal(result, "anthro-predicted");
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(calls[0].opts.headers["x-api-key"], "ant-key");
  assert.equal(calls[0].opts.headers["anthropic-version"], "2023-06-01");
});

test("callProvider: non-ok HTTP response fails silently (returns null, no throw)", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, json: async () => ({}) });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await callProvider({ kind: "openai", baseUrl: "https://x", apiKey: "k", model: "m", system: "s", user: "u" });
  assert.equal(result, null);
});

test("callProvider: network error/throw fails silently (returns null, no throw)", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("ECONNRESET");
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await callProvider({ kind: "openai", baseUrl: "https://x", apiKey: "k", model: "m", system: "s", user: "u" });
  assert.equal(result, null);
});

test("callProvider: slow response past timeoutMs fails silently (returns null, does not hang the test)", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = (url, opts) =>
    new Promise((resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
      // Never resolves on its own within the test's patience — only the abort settles it.
    });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await callProvider({
    kind: "openai",
    baseUrl: "https://x",
    apiKey: "k",
    model: "m",
    system: "s",
    user: "u",
    timeoutMs: 20,
  });
  assert.equal(result, null);
});

test("callProvider: custom headers (e.g. OpenRouter attribution) are merged in", async (t) => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(opts);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }) };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  await callProvider({
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "k",
    headers: { "HTTP-Referer": "https://lakshx.dev" },
    model: "m",
    system: "s",
    user: "u",
  });
  assert.equal(calls[0].headers["HTTP-Referer"], "https://lakshx.dev");
});
