/**
 * BYOK configuration. Keys come from (in order):
 *   1. ~/.koder/providers.json   (user-managed, plaintext for v1 — SecretStorage in Phase 2)
 *   2. environment variables     (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
 * Model strings are "provider/model", e.g. "anthropic/claude-sonnet-5",
 * "openrouter/deepseek/deepseek-chat", "ollama/qwen2.5-coder".
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderConfig {
  kind: "anthropic" | "openai";
  baseUrl: string;
  apiKey?: string;
  /** extra headers, e.g. OpenRouter attribution */
  headers?: Record<string, string>;
}

/** Fully-resolved Langfuse tracing config — see `resolveLangfuseConfig()` below for why all three fields are mandatory with no defaults. */
export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

export interface KoderConfig {
  defaultModel: string;
  providers: Record<string, ProviderConfig>;
  /** Raw, pre-merge Langfuse fields from `~/.koder/providers.json` (env vars fill in the rest — see `resolveLangfuseConfig()`). */
  langfuse?: Partial<LangfuseConfig>;
}

/** Built-in presets: id → wire kind, base URL, API-key env var. */
export const PRESETS: Record<string, { kind: "anthropic" | "openai"; baseUrl: string; envKey: string }> = {
  anthropic:  { kind: "anthropic", baseUrl: "https://api.anthropic.com", envKey: "ANTHROPIC_API_KEY" },
  openai:     { kind: "openai", baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY" },
  openrouter: { kind: "openai", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY" },
  deepseek:   { kind: "openai", baseUrl: "https://api.deepseek.com/v1", envKey: "DEEPSEEK_API_KEY" },
  groq:       { kind: "openai", baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY" },
  xai:        { kind: "openai", baseUrl: "https://api.x.ai/v1", envKey: "XAI_API_KEY" },
  mistral:    { kind: "openai", baseUrl: "https://api.mistral.ai/v1", envKey: "MISTRAL_API_KEY" },
  gemini:     { kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", envKey: "GEMINI_API_KEY" },
  cerebras:   { kind: "openai", baseUrl: "https://api.cerebras.ai/v1", envKey: "CEREBRAS_API_KEY" },
  ollama:     { kind: "openai", baseUrl: "http://localhost:11434/v1", envKey: "OLLAMA_API_KEY" },
};

export function loadConfig(): KoderConfig {
  let fileCfg: Partial<KoderConfig> = {};
  try {
    fileCfg = JSON.parse(readFileSync(join(homedir(), ".koder", "providers.json"), "utf8"));
  } catch {
    /* no config file — env-only mode */
  }

  const providers: Record<string, ProviderConfig> = {};
  for (const [id, preset] of Object.entries(PRESETS)) {
    const user = fileCfg.providers?.[id] ?? ({} as Partial<ProviderConfig>);
    const apiKey = user.apiKey ?? process.env[preset.envKey] ?? (id === "ollama" ? "ollama" : undefined);
    providers[id] = {
      kind: user.kind ?? preset.kind,
      baseUrl: user.baseUrl ?? preset.baseUrl,
      apiKey,
      headers: user.headers,
    };
  }
  // custom providers beyond presets
  for (const [id, user] of Object.entries(fileCfg.providers ?? {})) {
    if (!providers[id]) providers[id] = user as ProviderConfig;
  }

  return {
    defaultModel: fileCfg.defaultModel ?? "anthropic/claude-sonnet-5",
    providers,
    langfuse: fileCfg.langfuse,
  };
}

/**
 * Resolve Langfuse tracing config from (in the same order every other
 * provider uses) `~/.koder/providers.json`'s `langfuse` block, then env vars
 * (`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_BASE_URL`).
 *
 * Returns `undefined` — i.e. tracing disabled — unless ALL THREE fields are
 * present. Deliberately: unlike `PRESETS` above, there is NO built-in
 * `baseUrl` default here (no Langfuse Cloud fallback). Traces contain prompt
 * text, tool-call summaries, and response text pulled from the user's
 * workspace; the only acceptable default is "send nothing anywhere." Do not
 * add one, even as a documented opt-out default — see `tracing.ts`'s module
 * doc for the full rationale.
 */
export function resolveLangfuseConfig(cfg: KoderConfig): LangfuseConfig | undefined {
  const publicKey = cfg.langfuse?.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = cfg.langfuse?.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = cfg.langfuse?.baseUrl ?? process.env.LANGFUSE_BASE_URL;
  if (!publicKey || !secretKey || !baseUrl) return undefined;
  return { publicKey, secretKey, baseUrl };
}

/** "anthropic/claude-sonnet-5" → { provider config, model id }. */
export function resolveModel(cfg: KoderConfig, modelString?: string): { providerId: string; provider: ProviderConfig; model: string } {
  const spec = modelString ?? cfg.defaultModel;
  const slash = spec.indexOf("/");
  if (slash === -1) throw new Error(`Model "${spec}" must be "provider/model"`);
  const providerId = spec.slice(0, slash);
  const model = spec.slice(slash + 1);
  const provider = cfg.providers[providerId];
  if (!provider) throw new Error(`Unknown provider "${providerId}". Known: ${Object.keys(cfg.providers).join(", ")}`);
  if (!provider.apiKey) {
    throw new Error(
      `No API key for "${providerId}". Add it to ~/.koder/providers.json or set ${PRESETS[providerId]?.envKey ?? "its env var"}.`,
    );
  }
  return { providerId, provider, model };
}

/** Providers that currently have a usable key (for the model picker). */
export function availableProviders(cfg: KoderConfig): string[] {
  return Object.entries(cfg.providers)
    .filter(([id, p]) => p.apiKey && (id !== "ollama" || process.env.KODER_ENABLE_OLLAMA))
    .map(([id]) => id);
}
