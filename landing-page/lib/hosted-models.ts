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
