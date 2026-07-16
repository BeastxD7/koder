"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { listConfiguredProviders, resolveEmbeddingsProvider, PRESETS } = require("../lib/config.js");

test("PRESETS: anthropic is marked 'none' for embeddings; at least one OpenAI-compatible preset is 'confirmed'", () => {
  assert.equal(PRESETS.anthropic.embeddings, "none");
  assert.equal(PRESETS.openai.embeddings, "confirmed");
  assert.ok(Object.values(PRESETS).some((p) => p.embeddings === "confirmed"));
});

test("listConfiguredProviders: only returns providers with a resolvable API key", () => {
  const fileCfg = { providers: { openai: { apiKey: "sk-abc" } } };
  const list = listConfiguredProviders(fileCfg, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "openai");
});

test("listConfiguredProviders: ollama is NOT auto-included unless the user explicitly listed it (embeddings-specific deviation from agent/src/config.ts's always-on ollama default)", () => {
  const list = listConfiguredProviders({}, {});
  assert.equal(list.find((p) => p.id === "ollama"), undefined);
});

test("listConfiguredProviders: an explicit (even empty-object) ollama entry in providers.json opts it in", () => {
  const list = listConfiguredProviders({ providers: { ollama: {} } }, {});
  const ollama = list.find((p) => p.id === "ollama");
  assert.ok(ollama);
  assert.equal(ollama.apiKey, "ollama");
});

test("listConfiguredProviders: env var fills in when providers.json omits a key", () => {
  const list = listConfiguredProviders({}, { MISTRAL_API_KEY: "env-key" });
  assert.ok(list.some((p) => p.id === "mistral" && p.apiKey === "env-key"));
});


test("resolveEmbeddingsProvider: empty config -> ok:false, reason 'no-config'", () => {
  const r = resolveEmbeddingsProvider({}, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-config");
});

test("resolveEmbeddingsProvider: THE NAMED BRIEF CASE — only anthropic configured -> clear 'anthropic-only' guidance, not a cryptic error", () => {
  const fileCfg = { providers: { anthropic: { apiKey: "sk-ant-abc" } } };
  const r = resolveEmbeddingsProvider(fileCfg, {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "anthropic-only");
  assert.match(r.message, /OpenAI-compatible/);
});

test("resolveEmbeddingsProvider: a single confirmed provider is auto-selected", () => {
  const fileCfg = { providers: { openai: { apiKey: "sk-abc" } } };
  const r = resolveEmbeddingsProvider(fileCfg, {});
  assert.equal(r.ok, true);
  assert.equal(r.providerId, "openai");
  assert.equal(r.confirmed, true);
});

test("resolveEmbeddingsProvider: anthropic + openai configured together -> openai wins, anthropic silently excluded (not an error)", () => {
  const fileCfg = { providers: { anthropic: { apiKey: "sk-ant" }, openai: { apiKey: "sk-oai" } } };
  const r = resolveEmbeddingsProvider(fileCfg, {});
  assert.equal(r.ok, true);
  assert.equal(r.providerId, "openai");
});

test("resolveEmbeddingsProvider: AUTO_PRIORITY prefers openai over openrouter when both confirmed providers are configured", () => {
  const fileCfg = { providers: { openrouter: { apiKey: "sk-or" }, openai: { apiKey: "sk-oai" } } };
  const r = resolveEmbeddingsProvider(fileCfg, {});
  assert.equal(r.providerId, "openai");
});

test("resolveEmbeddingsProvider: an unconfirmed-only provider (e.g. groq) is still usable, with a warning attached", () => {
  const fileCfg = { providers: { groq: { apiKey: "gsk-abc" } } };
  const r = resolveEmbeddingsProvider(fileCfg, {});
  assert.equal(r.ok, true);
  assert.equal(r.providerId, "groq");
  assert.equal(r.confirmed, false);
  assert.match(r.warning, /not confirmed/);
});

test("resolveEmbeddingsProvider: preferredProviderId (from a stored index's meta) is honored over auto-selection", () => {
  const fileCfg = { providers: { openai: { apiKey: "sk-oai" }, mistral: { apiKey: "sk-mis" } } };
  const r = resolveEmbeddingsProvider(fileCfg, {}, { preferredProviderId: "mistral" });
  assert.equal(r.providerId, "mistral");
});

test("resolveEmbeddingsProvider: preferredProviderId no longer configured -> 'index-provider-missing', NOT a silent fallback to a different provider", () => {
  const fileCfg = { providers: { openai: { apiKey: "sk-oai" } } };
  const r = resolveEmbeddingsProvider(fileCfg, {}, { preferredProviderId: "mistral" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "index-provider-missing");
  assert.match(r.message, /mistral/);
  assert.match(r.message, /Rebuild Index/);
});

test("resolveEmbeddingsProvider: preferredModel overrides the preset default when the preferred provider IS still configured", () => {
  const fileCfg = { providers: { openai: { apiKey: "sk-oai" } } };
  const r = resolveEmbeddingsProvider(fileCfg, {}, { preferredProviderId: "openai", preferredModel: "text-embedding-3-large" });
  assert.equal(r.model, "text-embedding-3-large");
});

test("resolveEmbeddingsProvider: a custom baseUrl/apiKey override in providers.json is honored (BYOK passthrough)", () => {
  const fileCfg = { providers: { openai: { apiKey: "sk-custom", baseUrl: "https://my-proxy.example.com/v1" } } };
  const r = resolveEmbeddingsProvider(fileCfg, {});
  assert.equal(r.baseUrl, "https://my-proxy.example.com/v1");
  assert.equal(r.apiKey, "sk-custom");
});
