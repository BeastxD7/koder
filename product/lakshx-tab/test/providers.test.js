"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseProvidersFile, resolveActiveModel, hasUsableProvider, PRESETS } = require("../lib/providers.js");

// ---------------------------------------------------------------------------
// parseProvidersFile
// ---------------------------------------------------------------------------
test("parseProvidersFile: null/empty input yields null", () => {
  assert.equal(parseProvidersFile(null), null);
  assert.equal(parseProvidersFile(undefined), null);
  assert.equal(parseProvidersFile(""), null);
});

test("parseProvidersFile: invalid JSON yields null, never throws", () => {
  assert.equal(parseProvidersFile("{ not json"), null);
});

test("parseProvidersFile: valid JSON that isn't a plain object (array) yields null", () => {
  assert.equal(parseProvidersFile("[]"), null);
});

test("parseProvidersFile: valid JSON object round-trips", () => {
  const raw = JSON.stringify({ defaultModel: "anthropic/claude-sonnet-5", providers: {} });
  assert.deepEqual(parseProvidersFile(raw), { defaultModel: "anthropic/claude-sonnet-5", providers: {} });
});

// ---------------------------------------------------------------------------
// resolveActiveModel
// ---------------------------------------------------------------------------
test("resolveActiveModel: null config with no env falls back to anthropic preset but has no key -> null", () => {
  assert.equal(resolveActiveModel(null, {}), null);
});

test("resolveActiveModel: preset provider + env var key resolves", () => {
  const cfg = { defaultModel: "anthropic/claude-sonnet-5", providers: {} };
  const result = resolveActiveModel(cfg, { ANTHROPIC_API_KEY: "sk-ant-test" });
  assert.deepEqual(result, {
    providerId: "anthropic",
    model: "claude-sonnet-5",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "sk-ant-test",
    headers: undefined,
  });
});

test("resolveActiveModel: file-provided apiKey wins over env var", () => {
  const cfg = {
    defaultModel: "openai/gpt-5",
    providers: { openai: { apiKey: "file-key" } },
  };
  const result = resolveActiveModel(cfg, { OPENAI_API_KEY: "env-key" });
  assert.equal(result.apiKey, "file-key");
  assert.equal(result.kind, "openai");
  assert.equal(result.baseUrl, "https://api.openai.com/v1");
});

test("resolveActiveModel: model spec with slash in model id (openrouter-style) parses provider/model correctly", () => {
  const cfg = {
    defaultModel: "openrouter/deepseek/deepseek-chat",
    providers: { openrouter: { apiKey: "or-key" } },
  };
  const result = resolveActiveModel(cfg, {});
  assert.equal(result.providerId, "openrouter");
  assert.equal(result.model, "deepseek/deepseek-chat");
  assert.equal(result.baseUrl, "https://openrouter.ai/api/v1");
});

test("resolveActiveModel: ollama has an implicit apiKey even with none configured", () => {
  const cfg = { defaultModel: "ollama/qwen2.5-coder", providers: {} };
  const result = resolveActiveModel(cfg, {});
  assert.equal(result.apiKey, "ollama");
  assert.equal(result.baseUrl, "http://localhost:11434/v1");
});

test("resolveActiveModel: unknown provider id with no user override -> null", () => {
  const cfg = { defaultModel: "not-a-real-provider/some-model", providers: {} };
  assert.equal(resolveActiveModel(cfg, {}), null);
});

test("resolveActiveModel: user-defined custom provider beyond PRESETS resolves fully", () => {
  const cfg = {
    defaultModel: "myco/custom-model",
    providers: { myco: { kind: "openai", baseUrl: "https://myco.example/v1", apiKey: "k" } },
  };
  const result = resolveActiveModel(cfg, {});
  assert.deepEqual(result, {
    providerId: "myco",
    model: "custom-model",
    kind: "openai",
    baseUrl: "https://myco.example/v1",
    apiKey: "k",
    headers: undefined,
  });
});

test("resolveActiveModel: malformed defaultModel (no slash) -> null", () => {
  assert.equal(resolveActiveModel({ defaultModel: "noSlashHere" }, {}), null);
});

test("resolveActiveModel: custom headers (e.g. OpenRouter attribution) pass through", () => {
  const cfg = {
    defaultModel: "openrouter/some/model",
    providers: { openrouter: { apiKey: "k", headers: { "HTTP-Referer": "https://lakshx.dev" } } },
  };
  const result = resolveActiveModel(cfg, {});
  assert.deepEqual(result.headers, { "HTTP-Referer": "https://lakshx.dev" });
});

// ---------------------------------------------------------------------------
// hasUsableProvider
// ---------------------------------------------------------------------------
test("hasUsableProvider: true when a key is resolvable, false otherwise", () => {
  assert.equal(hasUsableProvider(null, {}), false);
  assert.equal(hasUsableProvider({ defaultModel: "anthropic/claude-sonnet-5" }, {}), false);
  assert.equal(hasUsableProvider({ defaultModel: "anthropic/claude-sonnet-5" }, { ANTHROPIC_API_KEY: "x" }), true);
});

// ---------------------------------------------------------------------------
// PRESETS sanity
// ---------------------------------------------------------------------------
test("PRESETS covers the documented provider set from docs/architecture.md", () => {
  for (const id of ["anthropic", "openai", "openrouter", "deepseek", "groq", "xai", "gemini", "ollama"]) {
    assert.ok(PRESETS[id], `missing preset: ${id}`);
    assert.ok(PRESETS[id].baseUrl.startsWith("http"));
    assert.ok(PRESETS[id].kind === "anthropic" || PRESETS[id].kind === "openai");
  }
});
