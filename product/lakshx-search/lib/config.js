// BYOK config resolution for LakshX Search — deliberately standalone.
//
// This extension does NOT import anything from agent/src or lakshx-chat: it
// re-reads the same ~/.lakshx/providers.json file directly and keeps its own
// small copy of the preset table (mirroring agent/src/config.ts's PRESETS).
// That duplication is intentional per this extension's design brief (fully
// standalone, no routing through the agent) — this file is where the
// "duplicated on purpose" surface lives, kept small and documented so the
// two copies are easy to eyeball against each other if agent/src/config.ts
// ever adds a preset.
//
// vscode-free — safe to `node --test` directly.
"use strict";

const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

/**
 * One entry per provider preset from agent/src/config.ts's PRESETS, PLUS an
 * `embeddings` field this extension needs that the chat/agent side has no
 * reason to track:
 *
 *   - "confirmed"  — this provider's OpenAI-compatible endpoint is documented
 *                    to serve POST {baseUrl}/embeddings. Verified against each
 *                    provider's own docs (see docs/research/15's item #7 and
 *                    the build report for links): openai, openrouter, gemini
 *                    (openai-compat shim), mistral all confirmed live; ollama
 *                    confirmed IF the user has pulled an embedding model
 *                    locally (can't verify that part statically).
 *   - "unconfirmed" — the provider's SDKs expose an embeddings() method (it's
 *                    boilerplate OpenAI-client-derived shape) but there's no
 *                    confirmation they actually host embedding models today
 *                    (groq, deepseek, xai, cerebras). Not excluded outright —
 *                    a user who knows their account has an embeddings-capable
 *                    model can still pick it — but never auto-selected, and
 *                    a failed call gets a "this provider might not support
 *                    embeddings" hint instead of a bare HTTP error.
 *   - "none"        — never exposes embeddings at all (anthropic: native
 *                    Messages API only, no /embeddings surface).
 */
const PRESETS = {
  anthropic: { kind: "anthropic", baseUrl: "https://api.anthropic.com", envKey: "ANTHROPIC_API_KEY", embeddings: "none" },
  openai: { kind: "openai", baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY", embeddings: "confirmed", defaultModel: "text-embedding-3-small" },
  openrouter: { kind: "openai", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY", embeddings: "confirmed", defaultModel: "openai/text-embedding-3-small" },
  deepseek: { kind: "openai", baseUrl: "https://api.deepseek.com/v1", envKey: "DEEPSEEK_API_KEY", embeddings: "unconfirmed", defaultModel: "deepseek-embedding" },
  groq: { kind: "openai", baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY", embeddings: "unconfirmed", defaultModel: "" },
  xai: { kind: "openai", baseUrl: "https://api.x.ai/v1", envKey: "XAI_API_KEY", embeddings: "unconfirmed", defaultModel: "" },
  mistral: { kind: "openai", baseUrl: "https://api.mistral.ai/v1", envKey: "MISTRAL_API_KEY", embeddings: "confirmed", defaultModel: "mistral-embed" },
  gemini: {
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    embeddings: "confirmed",
    defaultModel: "gemini-embedding-001",
  },
  cerebras: { kind: "openai", baseUrl: "https://api.cerebras.ai/v1", envKey: "CEREBRAS_API_KEY", embeddings: "unconfirmed", defaultModel: "" },
  ollama: { kind: "openai", baseUrl: "http://localhost:11434/v1", envKey: "OLLAMA_API_KEY", embeddings: "confirmed", defaultModel: "nomic-embed-text" },
};

/** Order auto-selection prefers among "confirmed" providers when more than one is configured. */
const AUTO_PRIORITY = ["openai", "mistral", "gemini", "openrouter", "ollama"];

/** Reads ~/.lakshx/providers.json. Returns {} (env-only / no-file mode) on any read/parse error, same tolerance as agent/src/config.ts. */
function readProvidersFile(homeDirOverride) {
  try {
    const raw = readFileSync(join(homeDirOverride ?? homedir(), ".lakshx", "providers.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Merge PRESETS with the user's file + env vars into a flat list of
 * configured (apiKey-bearing) providers. Pure given its inputs — `env` and
 * `fileCfg` are injected so this is directly unit-testable without touching
 * the real filesystem/process.env.
 *
 * @returns {Array<{id:string, kind:string, baseUrl:string, apiKey:string, embeddings:string, model:string}>}
 */
function listConfiguredProviders(fileCfg, env) {
  const out = [];
  const fileProviders = fileCfg?.providers ?? {};
  for (const [id, preset] of Object.entries(PRESETS)) {
    const hasEntry = Object.prototype.hasOwnProperty.call(fileProviders, id);
    const user = fileProviders[id] ?? {};
    // DELIBERATE DEVIATION from agent/src/config.ts here: the chat agent
    // defaults ollama's apiKey to the placeholder "ollama" UNCONDITIONALLY
    // (a locally-running, no-auth server is a reasonable default model
    // choice to just try). For embeddings that default would break the
    // exact graceful-degradation case this file exists for: an
    // Anthropic-only user would silently get routed to a probably-not-
    // running http://localhost:11434 instead of the clear "configure an
    // OpenAI-compatible provider" message. So ollama only counts as
    // "configured" here if the user has an explicit `"ollama": {...}` entry
    // in providers.json (even an empty object opts in) or OLLAMA_API_KEY is set.
    const apiKey = user.apiKey ?? env?.[preset.envKey] ?? (id === "ollama" && hasEntry ? "ollama" : undefined);
    if (!apiKey) continue;
    out.push({
      id,
      kind: user.kind ?? preset.kind,
      baseUrl: user.baseUrl ?? preset.baseUrl,
      apiKey,
      embeddings: preset.embeddings,
      model: user.embeddingModel ?? preset.defaultModel ?? "",
    });
  }
  return out;
}

/**
 * The graceful-degradation decision point: given what's configured, decide
 * whether embeddings are usable at all right now, and if so with which
 * provider/model. Never throws — every branch returns a plain result object
 * the UI can render directly as guidance text.
 *
 * @param {{preferredProviderId?: string, preferredModel?: string}} opts
 *   `preferredProviderId`/`preferredModel` come from meta.json (query path,
 *   which MUST reuse the index's recording — see indexer.js) or user config
 *   (lakshx.search.provider/model settings) — either way, an explicit
 *   preference wins over auto-selection when it's still configured.
 */
function resolveEmbeddingsProvider(fileCfg, env, opts = {}) {
  const configured = listConfiguredProviders(fileCfg, env);
  if (configured.length === 0) {
    return {
      ok: false,
      reason: "no-config",
      message:
        "No provider is configured in ~/.lakshx/providers.json (or environment variables). LakshX Search needs an OpenAI-compatible embeddings endpoint — add a provider (e.g. openai, openrouter, mistral, gemini, or a local ollama) the same way you configure the LakshX Agent's BYOK providers.",
    };
  }

  if (opts.preferredProviderId) {
    const forced = configured.find((p) => p.id === opts.preferredProviderId);
    if (forced) {
      return {
        ok: true,
        providerId: forced.id,
        baseUrl: forced.baseUrl,
        apiKey: forced.apiKey,
        model: opts.preferredModel || forced.model,
        confirmed: forced.embeddings === "confirmed",
      };
    }
    // The provider the index was built with is no longer configured — do
    // NOT silently fall back to a different provider/model (a query vector
    // from a different model is meaningless against the stored chunks).
    return {
      ok: false,
      reason: "index-provider-missing",
      message: `This index was built with the "${opts.preferredProviderId}" provider, which is no longer configured in ~/.lakshx/providers.json. Reconfigure it, or run "LakshX Search: Rebuild Index" to rebuild against a currently-configured provider.`,
    };
  }

  const embeddingCapable = configured.filter((p) => p.embeddings !== "none");
  if (embeddingCapable.length === 0) {
    // Exactly the brief's named example: an Anthropic-only config.
    const onlyKinds = [...new Set(configured.map((p) => p.id))].join(", ");
    return {
      ok: false,
      reason: "anthropic-only",
      message: `The only provider(s) configured (${onlyKinds}) don't do embeddings. Anthropic's API is chat/messages-only — embeddings need an OpenAI-compatible provider configured (e.g. openai, openrouter, mistral, gemini, or a local ollama with an embedding model pulled).`,
    };
  }

  const confirmed = embeddingCapable.filter((p) => p.embeddings === "confirmed");
  const pool = confirmed.length > 0 ? confirmed : embeddingCapable;
  pool.sort((a, b) => {
    const ai = AUTO_PRIORITY.indexOf(a.id);
    const bi = AUTO_PRIORITY.indexOf(b.id);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  const chosen = pool[0];
  return {
    ok: true,
    providerId: chosen.id,
    baseUrl: chosen.baseUrl,
    apiKey: chosen.apiKey,
    model: chosen.model,
    confirmed: chosen.embeddings === "confirmed",
    warning:
      chosen.embeddings === "confirmed"
        ? undefined
        : `"${chosen.id}" is not confirmed to support embeddings — if this call fails, configure openai/openrouter/mistral/gemini/ollama instead.`,
  };
}

module.exports = {
  PRESETS,
  AUTO_PRIORITY,
  readProvidersFile,
  listConfiguredProviders,
  resolveEmbeddingsProvider,
};
