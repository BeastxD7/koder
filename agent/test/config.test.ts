/** Unit tests for src/config.ts: model-string parsing, key resolution, provider listing. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  availableProviders,
  loadConfig,
  resolveModel,
  PRESETS,
  type LakshXConfig,
  type ProviderConfig,
} from "../src/config.js";

const provider = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  kind: "openai",
  baseUrl: "http://example.invalid/v1",
  ...over,
});

const cfg = (providers: Record<string, ProviderConfig>, defaultModel = "anthropic/claude-sonnet-5"): LakshXConfig => ({
  defaultModel,
  providers,
});

/** Run fn with process.env patched (undefined → delete), restoring afterwards. */
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("resolveModel parses provider/model", () => {
  const c = cfg({ anthropic: provider({ kind: "anthropic", apiKey: "sk-test" }) });
  const r = resolveModel(c, "anthropic/claude-sonnet-5");
  assert.equal(r.providerId, "anthropic");
  assert.equal(r.model, "claude-sonnet-5");
  assert.equal(r.provider, c.providers.anthropic);
});

test("resolveModel splits on the FIRST slash only (nested model ids)", () => {
  const c = cfg({ openrouter: provider({ apiKey: "or-test" }) });
  const r = resolveModel(c, "openrouter/deepseek/deepseek-chat");
  assert.equal(r.providerId, "openrouter");
  assert.equal(r.model, "deepseek/deepseek-chat");
});

test("resolveModel falls back to cfg.defaultModel when no model string given", () => {
  const c = cfg({ groq: provider({ apiKey: "gk" }) }, "groq/llama-3.3-70b");
  const r = resolveModel(c);
  assert.equal(r.providerId, "groq");
  assert.equal(r.model, "llama-3.3-70b");
});

test("resolveModel rejects a model string without a slash", () => {
  const c = cfg({ anthropic: provider({ apiKey: "k" }) });
  assert.throws(() => resolveModel(c, "claude-sonnet-5"), /must be "provider\/model"/);
});

test("resolveModel rejects an unknown provider and lists known ones", () => {
  const c = cfg({ anthropic: provider({ apiKey: "k" }), groq: provider({ apiKey: "k" }) });
  assert.throws(
    () => resolveModel(c, "nope/some-model"),
    (err: Error) => /Unknown provider "nope"/.test(err.message) && /anthropic/.test(err.message) && /groq/.test(err.message),
  );
});

test("resolveModel rejects a provider without an API key, naming its env var", () => {
  const c = cfg({ openai: provider() });
  assert.throws(
    () => resolveModel(c, "openai/gpt-4o"),
    (err: Error) => /No API key for "openai"/.test(err.message) && /OPENAI_API_KEY/.test(err.message),
  );
});

test("resolveModel missing-key error for a non-preset provider mentions 'its env var'", () => {
  const c = cfg({ myproxy: provider() });
  assert.throws(() => resolveModel(c, "myproxy/some-model"), /No API key for "myproxy".*its env var/);
});

test("loadConfig picks up API keys from environment variables (isolated HOME)", () => {
  const home = mkdtempSync(join(tmpdir(), "lakshx-cfg-home-"));
  try {
    withEnv(
      { HOME: home, CEREBRAS_API_KEY: "ck-env-test", GROQ_API_KEY: undefined },
      () => {
        const c = loadConfig();
        assert.equal(c.defaultModel, "anthropic/claude-sonnet-5"); // built-in default
        assert.equal(c.providers.cerebras.apiKey, "ck-env-test"); // env pickup
        assert.equal(c.providers.groq.apiKey, undefined); // no key anywhere
        assert.equal(c.providers.ollama.apiKey, "ollama"); // implicit local key
        assert.equal(c.providers.openrouter.baseUrl, PRESETS.openrouter.baseUrl);
        // env-supplied key must satisfy resolveModel
        assert.equal(resolveModel(c, "cerebras/llama3.1-8b").model, "llama3.1-8b");
      },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig: providers.json overrides presets, adds custom providers, wins over env", () => {
  const home = mkdtempSync(join(tmpdir(), "lakshx-cfg-home-"));
  try {
    mkdirSync(join(home, ".lakshx"), { recursive: true });
    writeFileSync(
      join(home, ".lakshx", "providers.json"),
      JSON.stringify({
        defaultModel: "custom/some-model",
        providers: {
          groq: { apiKey: "gk-from-file", baseUrl: "http://proxy.local/v1" },
          custom: { kind: "openai", baseUrl: "http://custom.local/v1", apiKey: "ck" },
        },
      }),
    );
    withEnv({ HOME: home, GROQ_API_KEY: "gk-from-env" }, () => {
      const c = loadConfig();
      assert.equal(c.defaultModel, "custom/some-model");
      assert.equal(c.providers.groq.apiKey, "gk-from-file"); // file beats env
      assert.equal(c.providers.groq.baseUrl, "http://proxy.local/v1");
      assert.equal(c.providers.groq.kind, PRESETS.groq.kind); // kind falls back to preset
      assert.equal(c.providers.custom.apiKey, "ck"); // custom provider beyond presets
      assert.ok(c.providers.anthropic); // presets still present
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("availableProviders lists only providers with keys; ollama gated by LAKSHX_ENABLE_OLLAMA", () => {
  const c = cfg({
    anthropic: provider({ kind: "anthropic", apiKey: "k1" }),
    openai: provider(), // no key → excluded
    ollama: provider({ apiKey: "ollama" }),
  });
  withEnv({ LAKSHX_ENABLE_OLLAMA: undefined }, () => {
    assert.deepEqual(availableProviders(c), ["anthropic"]);
  });
  withEnv({ LAKSHX_ENABLE_OLLAMA: "1" }, () => {
    assert.deepEqual(availableProviders(c).sort(), ["anthropic", "ollama"]);
  });
});
