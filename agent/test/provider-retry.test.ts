/**
 * Unit tests for `fetchWithRetry` (agent/src/providers/types.ts) and its
 * integration into all three provider adapters. Context: every adapter used
 * to throw immediately on any `!res.ok` from its initial connection-level
 * fetch, so a single transient 5xx/429 from Anthropic/Azure/an
 * OpenAI-compatible upstream (OpenRouter, etc.) failed the WHOLE agentic
 * turn instead of just that one round-trip. `fetchWithRetry` retries ONLY
 * 429/502/503/504 (never other 4xx — those are real client/auth errors),
 * respects `Retry-After` when present, backs off a short fixed ladder
 * otherwise, stays within a small fixed attempt count, and aborts
 * immediately if the caller's `AbortSignal` fires mid-backoff.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicAdapter } from "../src/providers/anthropic.js";
import { AzureResponsesAdapter } from "../src/providers/azure-responses.js";
import { OpenAICompatAdapter } from "../src/providers/openai-compat.js";
import { fetchWithRetry } from "../src/providers/types.js";

function plainResponse(status: number, body = "", headers?: Record<string, string>): Response {
  return new Response(body, { status, headers });
}

/** Build a `Response` whose body is an SSE stream of the given already-formatted `data:` lines — same convention as provider-azure-responses-stream.test.ts. */
function sseResponse(events: unknown[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const ev of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      controller.enqueue(enc.encode(`data: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Installs a global fake `fetch` that returns each of `responses` in order (repeating the last one if called more times than provided), and restores the real `fetch` afterward. */
async function withQueuedFetch<T>(responses: Response[], run: (calls: { count: number }) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const calls = { count: 0 };
  globalThis.fetch = (async () => {
    const r = responses[Math.min(calls.count, responses.length - 1)];
    calls.count++;
    return r;
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// fetchWithRetry itself
// ---------------------------------------------------------------------------

test("fetchWithRetry: succeeds on the first try without any wait when the response is ok", async () => {
  let calls = 0;
  const res = await fetchWithRetry(async () => {
    calls++;
    return plainResponse(200, "ok");
  });
  assert.equal(calls, 1);
  assert.equal(res.status, 200);
});

test("fetchWithRetry: retries a 503 once and succeeds on the second attempt", async () => {
  let calls = 0;
  const res = await fetchWithRetry(async () => {
    calls++;
    return calls === 1 ? plainResponse(503, "unavailable") : plainResponse(200, "ok");
  });
  assert.equal(calls, 2);
  assert.equal(res.status, 200);
});

test("fetchWithRetry: gives up after maxAttempts and returns the LAST (still-failing) response", async () => {
  let calls = 0;
  const res = await fetchWithRetry(
    async () => {
      calls++;
      return plainResponse(503, "still down");
    },
    { maxAttempts: 3 },
  );
  assert.equal(calls, 3);
  assert.equal(res.status, 503);
});

test("fetchWithRetry: does NOT retry a 401 — returns it immediately on the first attempt", async () => {
  let calls = 0;
  const res = await fetchWithRetry(async () => {
    calls++;
    return plainResponse(401, "unauthorized");
  });
  assert.equal(calls, 1, "a real auth error must not be retried");
  assert.equal(res.status, 401);
});

test("fetchWithRetry: does NOT retry a 400 or 404", async () => {
  for (const status of [400, 404]) {
    let calls = 0;
    const res = await fetchWithRetry(async () => {
      calls++;
      return plainResponse(status, "nope");
    });
    assert.equal(calls, 1, `status ${status} must not be retried`);
    assert.equal(res.status, status);
  }
});

test("fetchWithRetry: a 429 with Retry-After is honored (waits noticeably less than the default backoff ladder when Retry-After is short)", async () => {
  let calls = 0;
  const start = Date.now();
  const res = await fetchWithRetry(async () => {
    calls++;
    return calls === 1 ? plainResponse(429, "slow down", { "retry-after": "0.05" }) : plainResponse(200, "ok");
  });
  const elapsed = Date.now() - start;
  assert.equal(calls, 2);
  assert.equal(res.status, 200);
  // default first-backoff step is 250ms; a 50ms Retry-After should finish well under that
  assert.ok(elapsed < 200, `expected Retry-After (50ms) to be honored, took ${elapsed}ms`);
});

test("fetchWithRetry: stops retrying and rejects immediately if the AbortSignal fires during a backoff wait", async () => {
  const controller = new AbortController();
  let calls = 0;
  const p = fetchWithRetry(
    async () => {
      calls++;
      return plainResponse(503, "down");
    },
    { signal: controller.signal },
  );
  // fire the abort during the backoff wait that follows the first 503
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(p);
  assert.equal(calls, 1, "must not attempt a second fetch once aborted mid-backoff");
});

test("fetchWithRetry: a pre-aborted signal still runs the first fetch, then rejects on the backoff wait instead of retrying", async () => {
  // The retry loop only checks the signal during the backoff *wait*, not
  // before the first fetch — so the first attempt always runs, and it's the
  // subsequent wait (after that first 503) that must reject immediately.
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    fetchWithRetry(
      async () => {
        calls++;
        return plainResponse(503, "down");
      },
      { signal: controller.signal },
    ),
  );
  assert.equal(calls, 1, "must not attempt a second fetch when already aborted");
});

// ---------------------------------------------------------------------------
// Adapter integration — each adapter wraps its initial fetch in fetchWithRetry
// ---------------------------------------------------------------------------

test("AnthropicAdapter: recovers from one transient 503 and completes the turn", async () => {
  const events = [
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  ];
  const responses = [plainResponse(503, "busy"), sseResponse(events)];
  const adapter = new AnthropicAdapter({ baseUrl: "http://fake", apiKey: "k" } as any);
  const result = await withQueuedFetch(responses, () =>
    adapter.runTurn({ model: "claude-x", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] }),
  );
  assert.equal(result.text, "hi");
  assert.equal(result.stopReason, "end_turn");
});

test("AnthropicAdapter: a 401 is NOT retried and throws immediately with the provider error message", async () => {
  const responses = [plainResponse(401, JSON.stringify({ error: { message: "bad api key" } }))];
  const adapter = new AnthropicAdapter({ baseUrl: "http://fake", apiKey: "k" } as any);
  await assert.rejects(
    () =>
      withQueuedFetch(responses, (calls) =>
        adapter.runTurn({ model: "claude-x", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] }).finally(() => {
          assert.equal(calls.count, 1, "must not retry a 401");
        }),
      ),
    /bad api key/,
  );
});

test("OpenAICompatAdapter: recovers from a 429 (with Retry-After) and completes the turn", async () => {
  const events = [
    { choices: [{ delta: { content: "hello" } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
  const responses = [plainResponse(429, "rate limited", { "retry-after": "0.05" }), sseResponse(events)];
  const adapter = new OpenAICompatAdapter({ baseUrl: "http://fake", apiKey: "k", kind: "openai" } as any);
  const result = await withQueuedFetch(responses, () =>
    adapter.runTurn({ model: "gpt-x", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] }),
  );
  assert.equal(result.text, "hello");
});

test("OpenAICompatAdapter: a 400 is NOT retried and throws immediately", async () => {
  const responses = [plainResponse(400, "bad request")];
  const adapter = new OpenAICompatAdapter({ baseUrl: "http://fake", apiKey: "k", kind: "openai" } as any);
  let calls: { count: number } | undefined;
  await assert.rejects(() =>
    withQueuedFetch(responses, (c) => {
      calls = c; // same object the fake fetch mutates in place — reference, not a snapshot
      return adapter.runTurn({ model: "gpt-x", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] });
    }),
  );
  // checked AFTER assert.rejects settles, not inside a .finally() gating the
  // rejection itself — otherwise a wrongly-retried request would still
  // "reject" (via this very assertion) and assert.rejects would pass anyway
  assert.equal(calls?.count, 1, "must not retry a 400");
});

test("AzureResponsesAdapter: recovers from a 502 and completes the turn", async () => {
  const events = [
    { type: "response.output_text.delta", output_index: 0, delta: "ok" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  const responses = [plainResponse(502, "bad gateway"), sseResponse(events)];
  const adapter = new AzureResponsesAdapter({ baseUrl: "http://fake", apiKey: "t" } as any);
  const result = await withQueuedFetch(responses, () =>
    adapter.runTurn({ model: "gpt-5-mini", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] }),
  );
  assert.equal(result.text, "ok");
});

test("AzureResponsesAdapter: a 403 is NOT retried and throws immediately", async () => {
  const responses = [plainResponse(403, "forbidden")];
  const adapter = new AzureResponsesAdapter({ baseUrl: "http://fake", apiKey: "t" } as any);
  let calls: { count: number } | undefined;
  await assert.rejects(() =>
    withQueuedFetch(responses, (c) => {
      calls = c;
      return adapter.runTurn({ model: "gpt-5-mini", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] });
    }),
  );
  assert.equal(calls?.count, 1, "must not retry a 403");
});
