import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Which Azure deployment names each hosted-model proxy route is allowed to
 * forward to. Both routes validate the client-requested model against
 * their own list instead of trusting it outright — an unlisted model
 * string is rejected with a 400, never silently substituted or forwarded,
 * so a client can't probe for/hit an undeployed or wrong-shaped deployment.
 *
 * The split mirrors Azure's own per-deployment capability flags (checked
 * via `az cognitiveservices account deployment list`): only gpt-5-mini and
 * gpt-5-4-mini report `"responses": true` — everything else on this
 * resource is Chat Completions-only.
 */
export const RESPONSES_API_MODELS = new Set(["gpt-5-mini", "gpt-5-4-mini"]);

export const CHAT_COMPLETIONS_MODELS = new Set([
  "gpt-5-mini",
  "gpt-5-4-mini",
  "gpt-oss-120b",
  "grok-4-1-fast-reasoning",
  "deepseek-v4-pro",
  "codestral-2501",
  "llama-4-maverick",
  "kimi-k2-7-code",
  "kimi-k2-6",
]);

export const DEFAULT_MODEL = "gpt-5-mini";

/**
 * Plan-gated model access (found missing entirely — reported live: a Free
 * user was able to select and bill against Grok/DeepSeek/Kimi/etc., not
 * just gpt-5-mini). Until this was added, both hosted-model routes only
 * checked "is this model deployed on Azure at all" (the sets above) —
 * NEVER "is this user's plan allowed to use it." check_budget() gates
 * DOLLAR spend per plan, but never gated WHICH model a request could name,
 * so a Free user's own $5 credit could be spent on any deployed model,
 * including ones meant to be Pro-exclusive.
 *
 * Free tier: gpt-5-mini only, matching the pricing page's own description
 * ("Everything in Free" + "the hosted LakshX model (gpt-5-mini)... no key
 * to manage" for Pro — Pro was never meant to unlock MORE models over
 * Free, just a bigger monthly allowance on the same model). Every other
 * currently-deployed model requires an active Pro subscription — there is
 * no Pro+ tier in the schema yet (`user_subscription.plan` only allows
 * 'free'/'pro'), so "Pro+" model exclusivity (Claude/Grok-4-full/GPT-5
 * full) is aspirational pricing-page copy, not something to gate on until
 * that tier actually exists.
 */
export const FREE_TIER_MODELS = new Set(["gpt-5-mini"]);

/** True if `model` is usable on `plan` — the ONLY thing that can lift a
 * model out of FREE_TIER_MODELS today is an active Pro subscription. */
export function isModelAllowedForPlan(model: string, plan: "free" | "pro"): boolean {
  return plan === "pro" || FREE_TIER_MODELS.has(model);
}

/**
 * Same "pro && active" condition check_budget() uses internally
 * (supabase/schema.sql) to decide which budget rule applies — duplicated
 * here rather than added as a new RPC round-trip, since both hosted-model
 * routes already hold a service-role client and this is one indexed
 * primary-key lookup. Any other status (on_hold/cancelled/failed/expired)
 * or no row at all falls back to 'free' — fail closed, not open, exactly
 * like check_budget()'s own fallback.
 */
export async function getEffectivePlan(supabase: SupabaseClient, userId: string): Promise<"free" | "pro"> {
  const { data } = await supabase.from("user_subscription").select("plan, status").eq("user_id", userId).maybeSingle();
  return data?.plan === "pro" && data?.status === "active" ? "pro" : "free";
}

/**
 * Models whose Azure deployment rejects the standard OpenAI
 * `stream_options: {include_usage: true}` request field outright (422
 * "extra_forbidden" — confirmed live against codestral-2501 on 2026-07-19,
 * not a guess). These models return `usage` on their final chunk anyway
 * without needing the flag, so the fix is just "don't send it," not "find
 * another way to get usage" — the proxy's existing generic `if (ev.usage)`
 * scan already picks it up regardless of which chunk carries it. Add to
 * this set as more incompatibilities are found; don't assume every
 * third-party model here behaves like OpenAI's own by default.
 */
export const MODELS_REJECTING_STREAM_OPTIONS = new Set(["codestral-2501"]);
