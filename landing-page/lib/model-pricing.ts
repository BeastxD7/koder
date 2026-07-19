/**
 * Per-model USD/1M-token rate cards for every hosted Foundry deployment this
 * proxy can serve. Today there's exactly one (gpt-5-mini) — this exists as a
 * lookup, not a single constant, specifically so adding a second deployment
 * later is "add a rate-card entry," not "hunt down every place a price was
 * hardcoded." Keep this in sync with the actual deployment's real Azure
 * pricing page whenever a model's SKU/region changes — cost accounting is
 * only as correct as these numbers.
 */
export const PRICE_PER_1M_BY_MODEL: Record<string, { input: number; output: number }> = {
  "gpt-5-mini": { input: 0.125, output: 1.0 },

  // --- Planned for Pro+ (not yet deployed to Azure AI Foundry) ---
  // These keys are placeholders matching the Foundry catalog's usual naming;
  // whatever deployment NAME is actually chosen at deploy time must match
  // the key used here, or priceForModel() falls back to gpt-5-mini's rate
  // and logs loudly (see below) rather than silently mispricing. Rates
  // are from Azure AI Foundry's public pricing pages as of 2026-07 —
  // re-verify against the live pricing page before actually deploying any
  // of these, prices drift.
  "gpt-5-nano": { input: 0.05, output: 0.4 }, // Pro's fallback-on-cap target
  "gpt-5": { input: 1.25, output: 10.0 },
  "grok-4-fast-reasoning": { input: 0.43, output: 1.73 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
};

/**
 * Falls back to gpt-5-mini's rate (today's only real deployment) for an
 * unrecognized model name, logging loudly, rather than throwing or silently
 * costing $0 — an unrecognized model should never result in unbilled usage,
 * and this proxy already force-overwrites the client's requested model with
 * the server's configured deployment name (see route.ts), so in practice
 * this fallback only fires if a new deployment is wired in without also
 * adding its rate card here.
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
