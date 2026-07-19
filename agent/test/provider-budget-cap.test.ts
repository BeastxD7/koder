/**
 * Unit tests for the hosted lakshx proxy's budget-cap 429 handling
 * (agent/src/providers/types.ts's `budgetCapMessage()`/`BUDGET_CAP_SENTINEL`,
 * wired into both azure-responses.ts and openai-compat.ts). Context: a free
 * user hitting their $5 lifetime cap, or the $800 global ceiling, used to
 * surface as a raw "429: user_cap_reached" error with no explanation — these
 * adapters now translate the proxy's `{error: "user_cap_reached" |
 * "global_ceiling_reached"}` body (confirmed against
 * landing-page/app/api/lakshx-model/{chat/completions,responses}/route.ts
 * and check_budget() in landing-page/supabase/schema.sql) into a
 * BUDGET_CAP_SENTINEL-prefixed, actionable message extension.js renders as a
 * plain system message instead of an error.
 *
 * `fetchWithRetry` retries 429s up to 3 times (see provider-retry.test.ts) —
 * `withQueuedFetch`'s single-response arrays below repeat that one response
 * for every attempt, so this is unaffected; these tests only assert on the
 * FINAL thrown error, not the call count.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AzureResponsesAdapter } from "../src/providers/azure-responses.js";
import { OpenAICompatAdapter } from "../src/providers/openai-compat.js";
import { BUDGET_CAP_SENTINEL } from "../src/providers/types.js";

function plainResponse(status: number, body = ""): Response {
  return new Response(body, { status });
}

/** Same convention as provider-retry.test.ts's withQueuedFetch. */
async function withQueuedFetch<T>(responses: Response[], run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  let count = 0;
  globalThis.fetch = (async () => {
    const r = responses[Math.min(count, responses.length - 1)];
    count++;
    return r;
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const turnArgs = {
  model: "gpt-5-mini",
  system: "s",
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  tools: [],
};

// ---------------------------------------------------------------------------
// AzureResponsesAdapter — ONLY ever talks to the hosted lakshx proxy, so no
// baseUrl gate needed; every 429 it sees is already our own check_budget().
// ---------------------------------------------------------------------------

test("AzureResponsesAdapter: user_cap_reached 429 throws a sentinel-prefixed message with the pricing link", async () => {
  const adapter = new AzureResponsesAdapter({ baseUrl: "http://fake", apiKey: "t" } as any);
  await assert.rejects(
    () => withQueuedFetch([plainResponse(429, JSON.stringify({ error: "user_cap_reached" }))], () => adapter.runTurn(turnArgs)),
    (err: Error) => {
      assert.ok(err.message.startsWith(BUDGET_CAP_SENTINEL), "must carry the sentinel prefix");
      assert.match(err.message, /\[Upgrade →\]\(https:\/\/lakshx\.in\/pricing\)/, "must include the clickable upgrade link");
      return true;
    },
  );
});

test("AzureResponsesAdapter: global_ceiling_reached 429 throws a sentinel-prefixed message WITHOUT an upgrade link", async () => {
  const adapter = new AzureResponsesAdapter({ baseUrl: "http://fake", apiKey: "t" } as any);
  await assert.rejects(
    () => withQueuedFetch([plainResponse(429, JSON.stringify({ error: "global_ceiling_reached" }))], () => adapter.runTurn(turnArgs)),
    (err: Error) => {
      assert.ok(err.message.startsWith(BUDGET_CAP_SENTINEL), "must carry the sentinel prefix");
      assert.doesNotMatch(err.message, /pricing/, "upgrading doesn't fix the global ceiling — must not push it");
      return true;
    },
  );
});

test("AzureResponsesAdapter: an unrecognized 429 body falls back to the generic error (no sentinel)", async () => {
  const adapter = new AzureResponsesAdapter({ baseUrl: "http://fake", apiKey: "t" } as any);
  await assert.rejects(
    () => withQueuedFetch([plainResponse(429, JSON.stringify({ error: "budget check failed" }))], () => adapter.runTurn(turnArgs)),
    (err: Error) => {
      assert.ok(!err.message.startsWith(BUDGET_CAP_SENTINEL), "an RPC-failure reason must not be mislabeled as a budget cap");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// OpenAICompatAdapter — shared by every BYOK provider too, so the sentinel
// must only fire when baseUrl matches the hosted lakshx proxy.
// ---------------------------------------------------------------------------

test("OpenAICompatAdapter: user_cap_reached 429 from the lakshx proxy baseUrl throws the sentinel with the pricing link", async () => {
  const adapter = new OpenAICompatAdapter({ baseUrl: "https://lakshx.in/api/lakshx-model", apiKey: "t", kind: "openai" } as any);
  await assert.rejects(
    () => withQueuedFetch([plainResponse(429, JSON.stringify({ error: "user_cap_reached" }))], () => adapter.runTurn(turnArgs)),
    (err: Error) => {
      assert.ok(err.message.startsWith(BUDGET_CAP_SENTINEL));
      assert.match(err.message, /\[Upgrade →\]\(https:\/\/lakshx\.in\/pricing\)/);
      return true;
    },
  );
});

test("OpenAICompatAdapter: global_ceiling_reached 429 from the lakshx proxy baseUrl throws the sentinel without an upgrade link", async () => {
  const adapter = new OpenAICompatAdapter({ baseUrl: "https://lakshx.in/api/lakshx-model", apiKey: "t", kind: "openai" } as any);
  await assert.rejects(
    () => withQueuedFetch([plainResponse(429, JSON.stringify({ error: "global_ceiling_reached" }))], () => adapter.runTurn(turnArgs)),
    (err: Error) => {
      assert.ok(err.message.startsWith(BUDGET_CAP_SENTINEL));
      assert.doesNotMatch(err.message, /pricing/);
      return true;
    },
  );
});

// This is the discriminating test: a 429 shaped EXACTLY like our own
// budget-cap body, but from a baseUrl that is NOT the lakshx proxy, must be
// treated as a genuine third-party rate-limit (every other provider sharing
// this adapter — OpenAI, OpenRouter, Groq, ... — could plausibly return a
// 429 with an `error` field that happens to collide with our reason
// strings) — proves the baseUrl gate actually discriminates, not just that
// the reason-string parsing works.
test("OpenAICompatAdapter: an identically-shaped 429 from a NON-lakshx baseUrl (e.g. real OpenAI) is NOT treated as a budget cap", async () => {
  const adapter = new OpenAICompatAdapter({ baseUrl: "https://api.openai.com/v1", apiKey: "t", kind: "openai" } as any);
  await assert.rejects(
    () => withQueuedFetch([plainResponse(429, JSON.stringify({ error: "user_cap_reached" }))], () => adapter.runTurn(turnArgs)),
    (err: Error) => {
      assert.ok(!err.message.startsWith(BUDGET_CAP_SENTINEL), "a non-lakshx-proxy 429 must never be mislabeled as our own budget cap");
      return true;
    },
  );
});
