/** Provider-neutral chat types. Anthropic-flavored: richest superset. */

/**
 * One part of a rich (multi-part) tool_result. The `image` variant is what
 * makes screenshots MODEL-VISIBLE (Royal Mode 2.0 Stage 1a): loop.ts embeds
 * a tool's screenshot here (vision-capable models only — see vision.ts)
 * instead of the text-only string every tool result used to be. Each
 * provider adapter maps it to its own wire shape (anthropic.ts: tool_result
 * content array with a base64 image source block; openai-compat.ts: a
 * data:-URI image_url in a follow-up user message) and degrades to an
 * honest text placeholder when the model/provider path can't take images.
 * `path` is the already-saved on-disk file — carried so persistence
 * (store.ts) can drop the multi-MB base64 and keep a pointer instead.
 */
export type ToolResultPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; base64: string; path?: string };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  // `content` stays `string` for every plain tool result (and for all
  // pre-existing persisted history — old session JSON loads unchanged);
  // the `ToolResultPart[]` form is only ever built by loop.ts when a tool
  // returned an image AND the current model is vision-capable.
  | { type: "tool_result"; tool_use_id: string; content: string | ToolResultPart[]; is_error?: boolean };

/** Flatten a tool_result's content to its text, whichever shape it is. */
export function toolResultText(content: string | ToolResultPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ToolResultPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema
}

export interface StreamEvent {
  type: "text";
  text: string;
}

export interface TurnResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "other";
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface TurnRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** streamed text deltas for live UI */
  onText?: (text: string) => void;
  /** streamed reasoning/thinking deltas, when the model emits them */
  onThinking?: (text: string) => void;
  /**
   * Streamed raw JSON fragments for a `tool_use` block's `input`, as the
   * provider assembles it on the wire — Anthropic's `input_json_delta`
   * (`ev.delta.partial_json`) / OpenAI-compat's `delta.tool_calls[].function.
   * arguments` chunks. Mirrors `onText`/`onThinking`: each call carries only
   * the new FRAGMENT, not the running total — a consumer that wants the
   * accumulated JSON-so-far must concatenate these itself, keyed by `index`
   * (stable within one `runTurn()` call, the same index both adapters already
   * use internally to track in-flight tool_use blocks).
   *
   * `id`/`name` are whatever the provider has revealed so far for this block
   * — Anthropic always has both from the very first delta (its
   * `content_block_start` carries them); OpenAI-compat may still have `id:
   * ""` on an early fragment if a provider defers sending the call id, so a
   * consumer correlating by id should tolerate it arriving empty on the
   * first call and populated on a later one for the same `index`.
   *
   * Purely a UI-progress signal — the provider's own tool-call assembly
   * (`toolCalls` in the resolved `TurnResult`) is entirely unaffected by
   * whether this is wired up or not.
   */
  onToolInputDelta?: (ev: { index: number; id: string; name: string; delta: string }) => void;
}

export interface ChatAdapter {
  runTurn(req: TurnRequest): Promise<TurnResult>;
}

/**
 * Idle timeout for streaming SSE reads, in ms: how long we'll wait between
 * bytes before declaring the connection dead. Overridable for tests.
 *
 * This is deliberately an IDLE timeout, not a total-request timeout: a
 * `AbortSignal.timeout(N)` on the fetch would have to be set to several
 * minutes to avoid killing legitimately long generations, which makes
 * stall-detection slow. Providers (Anthropic sends SSE `ping` events; most
 * others keep bytes flowing while generating) emit *something* on the wire
 * every few seconds while alive, so a stalled-but-open connection — a real
 * failure mode for long-lived HTTPS streams behind proxies/VPNs/flaky wifi,
 * or an overloaded free-tier upstream — is reliably distinguishable from a
 * merely slow one by silence, not by total elapsed time.
 */
export function streamIdleMs(): number {
  const v = Number(process.env.LAKSHX_STREAM_IDLE_MS);
  return Number.isFinite(v) && v > 0 ? v : 45_000;
}

/**
 * Hard ceiling on a SINGLE `sseLines()` stream's total wall-clock duration,
 * in ms, regardless of how much data is still arriving. Overridable for
 * tests via `LAKSHX_STREAM_MAX_MS`.
 *
 * Complements (does not replace) `streamIdleMs()`: the idle timer only
 * fires on SILENCE, so it never catches a model that keeps emitting
 * `thinking_delta`/`reasoning_content` tokens continuously without ever
 * going idle — a genuine reasoning loop that never stops is, from the idle
 * timer's point of view, indistinguishable from a healthy long generation,
 * because bytes never stop arriving. This is exactly the "stuck at
 * thinking" report this timeout exists to catch: the session isn't dead,
 * it's just never finishing.
 *
 * 10 minutes default: comfortably above any realistic single generation —
 * even a generous extended-thinking budget plus an 8k-token response
 * finishes in well under a minute at typical provider throughput — while
 * still bounded, so a runaway stream fails loudly (via the same
 * `session/prompt` error path idle timeouts already use) instead of
 * hanging the UI forever. A multi-tool-call turn is unaffected: each
 * `adapter.runTurn()` call gets its own fresh `sseLines()` (and thus its
 * own fresh 10-minute budget) per loop iteration, so this bounds a single
 * generation span, not the whole agentic turn.
 */
export function streamMaxMs(): number {
  const v = Number(process.env.LAKSHX_STREAM_MAX_MS);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60_000;
}

/**
 * Builds a clean, user-facing message for a failed HTTP response — never
 * dumps a raw HTML error page (e.g. a platform-level 404/500 from an infra
 * layer in front of the actual app, which returns its own styled error page
 * instead of the app's JSON error shape) straight into the chat transcript.
 * Structured JSON error bodies (our own routes' `{"error": "..."}` shape,
 * or similar from third-party providers) still surface their real message —
 * only genuinely unstructured/HTML bodies get replaced with a generic,
 * status-coded message.
 */
export function httpErrorMessage(baseUrl: string, status: number, rawBody: string): string {
  const trimmed = rawBody.trim();
  if (/^<!doctype html|^<html[\s>]/i.test(trimmed)) {
    return `${baseUrl} returned an unexpected server error (HTTP ${status}). Try again in a moment — if it keeps happening, use the Report button to let us know.`;
  }
  try {
    const parsed = JSON.parse(trimmed);
    const msg =
      typeof parsed?.error === "string" ? parsed.error : typeof parsed?.error?.message === "string" ? parsed.error.message : undefined;
    if (msg) return `${baseUrl} ${status}: ${msg.slice(0, 400)}`;
  } catch {
    // not JSON — fall through to the plain-text handling below
  }
  // Plain text (not HTML, not structured JSON) — still show it, truncated,
  // since some providers return genuinely useful short plain-text errors.
  return `${baseUrl} ${status}: ${trimmed.slice(0, 400)}`;
}

/** HTTP statuses worth a retry: rate-limited or upstream/gateway trouble. Never 4xx auth/client errors — retrying those just delays the real error reaching the user. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** Fallback exponential-ish backoff (ms) when no `Retry-After` header is present, indexed by attempt number (1-based) that just failed. */
const RETRY_BACKOFF_MS = [250, 750, 1500];

/** Hard cap on any single backoff wait (including a provider-supplied `Retry-After`) — this is a live chat turn, not a batch job, so total added latency across all retries must stay in the low single-digit seconds, not tens of seconds. */
const MAX_BACKOFF_MS = 2000;

/**
 * Sleep for `ms`, but reject immediately with the signal's abort reason if
 * `signal` fires while waiting — used so a mid-backoff Stop-button cancel
 * interrupts a retry wait instead of silently continuing it.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** How long to wait before the NEXT attempt, given the just-failed response — `Retry-After` (seconds, or an HTTP-date) if present, else the fixed backoff ladder. Always capped at `MAX_BACKOFF_MS`. */
function retryDelayMs(res: Response, attemptNumber: number): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, Math.min(secs * 1000, MAX_BACKOFF_MS));
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) return Math.max(0, Math.min(dateMs - Date.now(), MAX_BACKOFF_MS));
  }
  return Math.min(RETRY_BACKOFF_MS[Math.min(attemptNumber - 1, RETRY_BACKOFF_MS.length - 1)], MAX_BACKOFF_MS);
}

/**
 * Retries a fetch-returning function for transient failures only (429 rate
 * limit, 502/503/504 — NOT other 4xx, which are real client/auth errors that
 * retrying can't fix). Exponential-ish backoff, small fixed number of
 * attempts — this is a hosted coding assistant mid-agentic-turn, not a batch
 * job, so bound the total added latency tightly (a few seconds max across
 * all retries, not tens of seconds).
 *
 * Only retries the FULL request, not a partial stream: this wraps the
 * initial connection-level `fetch()` call, before any `!res.ok` check — a
 * stream that starts successfully (`res.ok`) and then fails mid-SSE is a
 * different failure mode, out of scope here (no partial-stream resumption
 * exists in this codebase).
 *
 * Respects `opts.signal` (the caller's `AbortSignal`, e.g. the chat's Stop
 * button): if it fires while waiting out a backoff, the wait rejects
 * immediately instead of silently continuing the retry loop.
 */
export async function fetchWithRetry(
  fn: () => Promise<Response>,
  opts?: { maxAttempts?: number; signal?: AbortSignal },
): Promise<Response> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const signal = opts?.signal;
  let res: Response;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = await fn();
    if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt === maxAttempts) return res;
    const waitMs = retryDelayMs(res, attempt);
    console.error(`[fetchWithRetry] attempt ${attempt}/${maxAttempts} got HTTP ${res.status} — retrying in ${waitMs}ms`);
    await abortableSleep(waitMs, signal);
  }
  return res!;
}

/** Minimal SSE line parser shared by both adapters. */
export async function* sseLines(
  body: ReadableStream<Uint8Array>,
  idleMs: number = streamIdleMs(),
  maxMs: number = streamMaxMs(),
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // One deadline for the WHOLE stream, armed once and reused across every
  // iteration of the read loop below — unlike the idle timer (which resets
  // on every byte received), this keeps counting down regardless of how
  // much data keeps arriving, so a continuously-streaming-but-never-done
  // connection still gets cut off.
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  const maxDeadline = new Promise<never>((_, reject) => {
    maxTimer = setTimeout(
      () =>
        reject(
          new Error(
            `provider stream exceeded max duration of ${maxMs}ms while still receiving data — ` +
              `likely a runaway/continuous generation (e.g. thinking that never stops), not a stalled connection`,
          ),
        ),
      maxMs,
    );
  });
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout>;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`provider stream stalled: no data for ${idleMs}ms`)),
          idleMs,
        );
      });
      let done: boolean, value: Uint8Array | undefined;
      try {
        ({ done, value } = await Promise.race([reader.read(), idle, maxDeadline]));
      } finally {
        clearTimeout(timer!);
      }
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  } finally {
    clearTimeout(maxTimer);
    // on early exit (idle timeout, max-duration timeout, break, or the
    // consumer stopping iteration) release the underlying connection
    // instead of leaking it
    await reader.cancel().catch(() => {});
  }
}
