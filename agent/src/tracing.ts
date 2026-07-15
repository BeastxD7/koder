/**
 * Langfuse tracing hook for the agent loop (docs/architecture.md §10 item 1:
 * "Tracing/observability" on the reliability roadmap).
 *
 * PRIVACY / SECURITY — READ BEFORE CHANGING ANYTHING HERE:
 * A trace captures the system prompt, message counts/sizes, tool-call
 * summaries, and response text for every turn — i.e. potentially sensitive
 * content pulled straight from the user's workspace. There is, and must
 * stay, NO DEFAULT REMOTE ENDPOINT of any kind. `getTracer()` returns the
 * inert `NOOP_TRACER` (zero network calls, not even a client constructed)
 * unless the user has explicitly set ALL THREE of `LANGFUSE_PUBLIC_KEY`,
 * `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` (env vars, or the
 * equivalent `langfuse` block in `~/.lakshx/providers.json` — see
 * `config.ts`'s `resolveLangfuseConfig()`). In particular `LANGFUSE_BASE_URL`
 * NEVER falls back to Langfuse's public cloud host (`cloud.langfuse.com` or
 * similar) — if it's unset, tracing is disabled, full stop, even if the two
 * keys are present. This is almost always going to point at a self-hosted
 * instance the user chose; that choice must stay explicit. If you're
 * tempted to add a default so tracing "just works" out of the box, don't —
 * the missing default is the feature, not an oversight to fix.
 *
 * Callers (loop.ts) never branch on whether tracing is enabled: `getTracer()`
 * always returns something with this same shape, and the no-op absorbs
 * every call silently. All Langfuse SDK calls are also individually wrapped
 * so a tracing failure (network error, bad config) can never break or delay
 * the agent loop itself — tracing is strictly best-effort.
 */
import { Langfuse } from "langfuse";
import { loadConfig, resolveLangfuseConfig, type LakshXConfig } from "./config.js";

export interface GenerationHandle {
  /** `usage` mirrors `TurnResult["usage"]` (providers/types.ts) — both fields optional, provider-reported. */
  end(result: { output?: string; usage?: { inputTokens?: number; outputTokens?: number }; isError?: boolean }): void;
}

export interface ToolSpanHandle {
  end(result: { output?: string; isError?: boolean }): void;
}

export interface PromptTrace {
  /** One generation span per `adapter.runTurn()` call. */
  generation(params: { name: string; model: string; input: unknown }): GenerationHandle;
  /** One span per tool execution. */
  tool(params: { name: string; input: unknown }): ToolSpanHandle;
  /** Marks the trace complete. Does not flush — call `Tracer.flush()` separately. */
  end(result?: { output?: string; isError?: boolean }): void;
}

export interface Tracer {
  /** One trace per prompt (one `runPrompt()` call). */
  startTrace(params: {
    id: string;
    name: string;
    sessionId?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): PromptTrace;
  /** Best-effort flush of queued events. Call in a `finally` after the trace ends. */
  flush(): Promise<void>;
}

const NOOP_GENERATION: GenerationHandle = { end() {} };
const NOOP_SPAN: ToolSpanHandle = { end() {} };
const NOOP_TRACE: PromptTrace = {
  generation: () => NOOP_GENERATION,
  tool: () => NOOP_SPAN,
  end() {},
};

/**
 * The inert tracer: every method is a synchronous no-op with zero network
 * I/O — no Langfuse client is ever constructed on this path. This is what
 * `getTracer()` returns whenever Langfuse isn't fully configured (see the
 * module doc above for why that's the default).
 */
export const NOOP_TRACER: Tracer = {
  startTrace: () => NOOP_TRACE,
  flush: async () => {},
};

class LangfuseTracer implements Tracer {
  private client: Langfuse;

  constructor(cfg: { publicKey: string; secretKey: string; baseUrl: string }) {
    this.client = new Langfuse({ publicKey: cfg.publicKey, secretKey: cfg.secretKey, baseUrl: cfg.baseUrl });
  }

  startTrace(params: {
    id: string;
    name: string;
    sessionId?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): PromptTrace {
    try {
      const trace = this.client.trace({
        id: params.id,
        name: params.name,
        sessionId: params.sessionId,
        input: params.input,
        metadata: params.metadata,
      });
      return {
        generation: (g) => {
          try {
            const gen = trace.generation({ name: g.name, model: g.model, input: g.input });
            return {
              end: (r) => {
                try {
                  gen.end({
                    output: r.output,
                    usage: { input: r.usage?.inputTokens, output: r.usage?.outputTokens },
                    level: r.isError ? "ERROR" : undefined,
                  });
                } catch {
                  // tracing must never break the loop — see module doc
                }
              },
            };
          } catch {
            return NOOP_GENERATION;
          }
        },
        tool: (t) => {
          try {
            const span = trace.span({ name: t.name, input: t.input });
            return {
              end: (r) => {
                try {
                  span.end({ output: r.output, level: r.isError ? "ERROR" : undefined });
                } catch {
                  // best-effort
                }
              },
            };
          } catch {
            return NOOP_SPAN;
          }
        },
        end: (r) => {
          try {
            trace.update({ output: r?.output });
          } catch {
            // best-effort
          }
        },
      };
    } catch {
      return NOOP_TRACE;
    }
  }

  async flush(): Promise<void> {
    try {
      await this.client.flushAsync();
    } catch {
      // best-effort — a flush failure must never surface to the caller
    }
  }
}

/**
 * Returns a real Langfuse-backed tracer ONLY if publicKey + secretKey +
 * baseUrl are all present (per `resolveLangfuseConfig()`); otherwise the
 * inert `NOOP_TRACER`. `cfg` defaults to `loadConfig()` so call sites don't
 * need to thread config through, but accepts an explicit one for testing.
 */
export function getTracer(cfg: LakshXConfig = loadConfig()): Tracer {
  const lf = resolveLangfuseConfig(cfg);
  if (!lf) return NOOP_TRACER;
  return new LangfuseTracer(lf);
}
