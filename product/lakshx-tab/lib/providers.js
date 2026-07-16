// Reads the SAME `~/.lakshx/providers.json` BYOK config file the main
// LakshX agent uses (agent/src/config.ts) — read-only, no shared code, no
// dependency on agent/src. Deliberately duplicated (not imported) so this
// extension stays fully standalone: it must keep working even if the agent
// runtime is absent, mid-refactor, or not installed at all.
//
// This module is pure/testable: `parseProvidersFile` and `resolveActiveModel`
// take plain strings/objects in and return plain objects out — no `fs`, no
// `vscode`. The one bit of real I/O (reading the file off disk) lives in
// `loadProvidersFileFromDisk`, kept tiny on purpose so almost all the logic
// here can be covered by `node --test` without mocking the filesystem.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Built-in presets: id -> wire kind, base URL, API-key env var.
 * Mirrors agent/src/config.ts's PRESETS map exactly (same ids, same
 * defaults) so a providers.json written for the main agent "just works"
 * here too, with zero extra configuration. */
const PRESETS = {
  anthropic: { kind: "anthropic", baseUrl: "https://api.anthropic.com", envKey: "ANTHROPIC_API_KEY" },
  openai: { kind: "openai", baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY" },
  openrouter: { kind: "openai", baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY" },
  deepseek: { kind: "openai", baseUrl: "https://api.deepseek.com/v1", envKey: "DEEPSEEK_API_KEY" },
  groq: { kind: "openai", baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY" },
  xai: { kind: "openai", baseUrl: "https://api.x.ai/v1", envKey: "XAI_API_KEY" },
  mistral: { kind: "openai", baseUrl: "https://api.mistral.ai/v1", envKey: "MISTRAL_API_KEY" },
  gemini: { kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", envKey: "GEMINI_API_KEY" },
  cerebras: { kind: "openai", baseUrl: "https://api.cerebras.ai/v1", envKey: "CEREBRAS_API_KEY" },
  ollama: { kind: "openai", baseUrl: "http://localhost:11434/v1", envKey: "OLLAMA_API_KEY" },
};

/** Parse providers.json's raw text. Returns `null` on missing/invalid JSON
 * rather than throwing — the caller treats "no usable provider" as a normal,
 * silent state (never a repeated error toast). */
function parseProvidersFile(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the ONE model this extension will call: whatever
 * `~/.lakshx/providers.json`'s `defaultModel` points at (same field the main
 * agent reads). This intentionally does not expose a separate model picker —
 * next-edit prediction shares the agent's provider config, not a second
 * configuration surface (see README "same provider config").
 *
 * @param {object|null} fileCfg   parsed providers.json (or null)
 * @param {object} env            process.env-shaped lookup, injectable for tests
 * @returns {{providerId:string, model:string, kind:"anthropic"|"openai", baseUrl:string, apiKey:string, headers?:object}|null}
 */
function resolveActiveModel(fileCfg, env = {}) {
  const cfg = fileCfg || {};
  const spec = typeof cfg.defaultModel === "string" && cfg.defaultModel ? cfg.defaultModel : "anthropic/claude-sonnet-5";
  const slash = spec.indexOf("/");
  if (slash === -1) return null;
  const providerId = spec.slice(0, slash);
  const model = spec.slice(slash + 1);
  if (!providerId || !model) return null;

  const preset = PRESETS[providerId];
  const userProvider = (cfg.providers && cfg.providers[providerId]) || {};
  const kind = userProvider.kind || (preset && preset.kind);
  const baseUrl = userProvider.baseUrl || (preset && preset.baseUrl);
  const apiKey =
    userProvider.apiKey ||
    (preset && env[preset.envKey]) ||
    (providerId === "ollama" ? "ollama" : undefined);

  if (!kind || !baseUrl || !apiKey) return null;
  return { providerId, model, kind, baseUrl, apiKey, headers: userProvider.headers };
}

/** True iff there's a fully-usable (kind + baseUrl + apiKey) default model. */
function hasUsableProvider(fileCfg, env = {}) {
  return resolveActiveModel(fileCfg, env) !== null;
}

/** The one piece of real I/O: read providers.json off disk. Returns `null`
 * on any error (missing file, permission denied, etc.) — never throws,
 * since "not configured yet" is an expected, common state. */
function loadProvidersFileFromDisk() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".lakshx", "providers.json"), "utf8");
    return parseProvidersFile(raw);
  } catch {
    return null;
  }
}

module.exports = {
  PRESETS,
  parseProvidersFile,
  resolveActiveModel,
  hasUsableProvider,
  loadProvidersFileFromDisk,
};
