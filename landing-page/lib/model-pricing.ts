/**
 * Per-model USD/1M-token rate cards for every hosted Foundry deployment this
 * proxy can serve. This exists as a lookup, not a single constant,
 * specifically so adding a new deployment is "add a rate-card entry," not
 * "hunt down every place a price was hardcoded." Keep this in sync with the
 * actual deployment's real Azure pricing whenever a model's SKU/region
 * changes — cost accounting is only as correct as these numbers.
 *
 * Keys are the actual Azure deployment NAMES (see
 * `az cognitiveservices account deployment list --name
 * lakshx-ide-global-resource --resource-group rg-hello.401labs-1612`),
 * not the underlying model's catalog name where they differ.
 */
export const PRICE_PER_1M_BY_MODEL: Record<string, { input: number; output: number }> = {
  // --- Live deployments (Responses API-capable — routed via the "lakshx"
  // provider/azure-responses.ts adapter) ---
  "gpt-5-mini": { input: 0.125, output: 1.0 },
  "gpt-5-4-mini": { input: 0.75, output: 4.5 },

  // --- Live deployments (Chat Completions only — routed via loop.ts's
  // model-based override to the "openai"-kind adapter, same proxy) ---
  //
  // Pricing confidence varies a lot per model here (researched 2026-07-19;
  // Azure's own pricing pages wouldn't render for direct verification, so
  // several of these are cross-checked aggregator/native-platform prices,
  // not a first-party Azure price card — re-verify against the Azure Portal
  // pricing calculator before this matters for real billing at any volume):
  "gpt-oss-120b": { input: 0.15, output: 0.6 },
  // Two conflicting figures found — an unverified channel report claimed
  // $0.43/$1.73 (no Microsoft price card confirms it) vs xAI's own native
  // API price used here. Flagged, not resolved.
  "grok-4-1-fast-reasoning": { input: 0.2, output: 0.5 },
  // Azure prices this ~4x above DeepSeek's own native API ($0.435/$0.87) per
  // a Microsoft Q&A billing thread — confirmed as intentional Azure markup,
  // not a research error.
  "deepseek-v4-pro": { input: 1.74, output: 3.48 },
  "codestral-2501": { input: 0.3, output: 0.9 },
  "llama-4-maverick": { input: 0.25, output: 1.0 },
  // Preview-status deployments (Moonshot AI) — native platform pricing,
  // no Azure-specific price card found. Kimi-K2.6's figure is notably
  // cheaper than Moonshot's own API price ($0.95/$4.00), plausibly an Azure
  // preview discount, but unconfirmed.
  "kimi-k2-7-code": { input: 0.95, output: 4.0 },
  "kimi-k2-6": { input: 0.6, output: 3.0 },

  // --- Planned, NOT yet deployed (blocked on Azure quota requests or, for
  // Claude, a Marketplace subscription — see the founder's Azure quota
  // investigation from 2026-07-19) ---
  "gpt-5-nano": { input: 0.05, output: 0.4 }, // Pro's fallback-on-cap target
  "gpt-5": { input: 1.25, output: 10.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
};

/**
 * Falls back to gpt-5-mini's rate for an unrecognized model name, logging
 * loudly, rather than throwing or silently costing $0 — an unrecognized
 * model should never result in unbilled usage. In practice this only fires
 * if a new deployment is wired into the proxy's ALLOWED_MODELS list without
 * also adding its rate card here.
 */
export function priceForModel(model: string): { input: number; output: number } {
  const price = PRICE_PER_1M_BY_MODEL[model];
  if (!price) {
    console.error(`model-pricing: no rate card for model "${model}" — falling back to gpt-5-mini's rate. Add it to PRICE_PER_1M_BY_MODEL.`);
    return PRICE_PER_1M_BY_MODEL["gpt-5-mini"];
  }
  return price;
}

/** cost_usd for a given model + token counts, using this file's rate cards. */
export function computeCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const price = priceForModel(model);
  return (tokensIn / 1_000_000) * price.input + (tokensOut / 1_000_000) * price.output;
}
