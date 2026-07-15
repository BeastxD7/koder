# Research: BYOK Multi-Provider Model Layer (July 2026)

## Three wire protocols cover everything
(A) **Anthropic Messages API**; (B) **OpenAI Chat Completions** (industry standard, supported "indefinitely"); (C) OpenAI Responses API (OpenAI-only; ~3% better on SWE-bench for reasoning models, 40–80% better caching; Assistants API dies Aug 2026). Gemini has an official OpenAI-compat endpoint good enough for IDE use.

**Adapter consolidation: Anthropic-native + one parameterized OpenAI-CC adapter covers 10 of 11 targets** (OpenAI, Gemini-compat, xAI, DeepSeek, Mistral, Groq, Cerebras, OpenRouter, Ollama, LM Studio). Optional third adapter: OpenAI Responses. ← This is what agent/src/providers implements.

## Provider quirks that bite (hardening checklist)
- OpenAI CC tool-call deltas: id/name only on FIRST delta — accumulate by index (✅ implemented).
- Anthropic: buffer input_json_delta, parse at content_block_stop (✅); ALL tool_results must go in ONE user message (✅); thinking blocks must be replayed unmodified (TODO when thinking enabled).
- Gemini compat endpoint historically buggy with streamed tool args — buffer whole calls; silently ignores unknown params.
- Newest Anthropic models (Opus 4.7+/Sonnet 5/Fable 5) REJECT temperature/top_p/top_k with 400 → strip-don't-pass params by default (✅ we send none).
- Cerebras 400s on frequency_penalty/logit_bias; Groq rejects n>1; never hardcode Cerebras model IDs (catalog went 12→2 models in months).
- max_tokens (Anthropic, required) vs max_completion_tokens (OpenAI reasoning) vs max_output_tokens (Responses/Gemini) — per-provider mapping TODO.
- Reasoning surfaces: Anthropic `thinking:{type:"adaptive"}` + `output_config.effort` (budget_tokens REMOVED on 4.7+); OpenAI reasoning_effort; Gemini thinkingConfig.thinkingBudget; DeepSeek `reasoning_content` extension field. Normalize to one reasoningDelta chunk + one effort knob.
- stop_reason mapping: Anthropic tool_use|end_turn|max_tokens|pause_turn|refusal vs OpenAI tool_calls|stop|length|content_filter. Handle pause_turn + refusal explicitly.
- Prompt caching: Anthropic explicit cache_control breakpoints (4 max, 5m/1h TTL); OpenAI/xAI/Groq/DeepSeek automatic. Agent loops resend huge prefixes — caching is a 10x cost lever. TODO: cache_control on system + history tail.

## Libraries evaluated
- **Vercel AI SDK 6** (Apache-2.0): good fallback, but major-version churn in core runtime + providerOptions escape hatches for everything that matters. Not adopted.
- **LiteLLM**: Python (wrong stack), March 2026 PyPI supply-chain attack on a key-handling layer. Rejected.
- **Cline `@cline/llms`** (Apache-2.0): best architecture to copy — `ApiHandler.createMessage() → ApiStream` chunks {text|reasoning|usage}. We mirror this contract.
- **OpenRouter**: ship as a provider entry (1M BYOK req/mo free, then 5%), not as the architecture.

## Key storage best practice
Industry norm = OS keychain: VS Code SecretStorage (BYOK GA June 2026, works without GitHub sign-in), Zed system keychain + env override, Cline SecretStorage (its CLI plaintext fallback is the criticized anti-pattern). **LakshX TODO Phase 2: Electron safeStorage for keys; env + ${env:VAR} references; never per-project files (committed!); redact from logs; warn on custom baseUrl + existing key (exfiltration vector).** v1 plaintext ~/.lakshx/providers.json is a stopgap.

## Model picker / cost UX
Group by provider; show ctx window, tool/vision badges, $/M in+out; per-role model choice (agent vs chat vs commit-msg); per-message cost from usage chunk × versioned local pricing catalog (models.dev-style) with remote refresh; running per-task total + context fill meter; fallback chains must surface model switches in transcript, never silent.

## Default model recommendations (verify IDs at ship time)
- Agent default: **Opus 4.8** (`claude-opus-4-8`, 1M ctx, $5/$25) with adaptive thinking
- Fast tier: **Sonnet 5** ($3/$15) or Haiku 4.5 ($1/$5)
- Max opt-in: Fable 5 ($10/$50 — handle refusal stop-reason, fallback to Opus)
- Local: Qwen3-Coder 30B-A3B via Ollama (24–32GB), Devstral Small 24B (16GB)
- Models <14B local: NOT reliable for multi-step tool loops.

Sources: ai.google.dev/gemini-api/docs/openai · platform.openai.com/docs/guides/migrate-to-responses · docs.x.ai prompt-caching · console.groq.com/docs/prompt-caching · openrouter.ai/docs/use-cases/byok · code.visualstudio.com/blogs/2026/06/18/byok-vscode · github.com/cline/cline (llms layer) · vercel.com/blog/ai-sdk-6 · netwrix.com AI credential-storage risks
