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
