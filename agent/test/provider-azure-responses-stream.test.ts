/**
 * Provider-level unit tests for AzureResponsesAdapter's streaming-event
 * parsing (Azure Responses API migration — hosted "lakshx" provider).
 * Drives the adapter directly against a fake `fetch` returning a hand-built
 * SSE stream shaped exactly like the confirmed-live event sequence (see
 * agent/src/providers/azure-responses.ts's module doc): response.created,
 * response.output_item.added, response.reasoning_summary_text.delta,
 * response.output_text.delta, response.function_call_arguments.delta,
 * response.completed. No real HTTP server needed — same convention as
 * provider-tool-input-delta.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AzureResponsesAdapter } from "../src/providers/azure-responses.js";

/** Build a `Response` whose body is an SSE stream of the given already-formatted `data:` lines. */
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

async function withFakeFetch<T>(events: unknown[], run: (capturedRequest: { body?: any }) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  const captured: { body?: any } = {};
  globalThis.fetch = (async (_url: any, init: any) => {
    captured.body = init?.body ? JSON.parse(init.body) : undefined;
    return sseResponse(events);
  }) as typeof fetch;
  try {
    return await run(captured);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("AzureResponsesAdapter: reasoning-summary deltas reach onThinking and final text reaches onText", async () => {
  const events = [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.in_progress" },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
    { type: "response.reasoning_summary_part.added", output_index: 0 },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Let me check " },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "the file first." },
    { type: "response.reasoning_summary_text.done", output_index: 0 },
    { type: "response.reasoning_summary_part.done", output_index: 0 },
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1" } },
    { type: "response.content_part.added", output_index: 1 },
    { type: "response.output_text.delta", output_index: 1, delta: "The answer " },
    { type: "response.output_text.delta", output_index: 1, delta: "is 42." },
    { type: "response.output_text.done", output_index: 1 },
    { type: "response.content_part.done", output_index: 1 },
    { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1" } },
    {
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 100, output_tokens: 20, output_tokens_details: { reasoning_tokens: 12 } } },
    },
  ];

  const thinking: string[] = [];
  const texts: string[] = [];
  const adapter = new AzureResponsesAdapter({ baseUrl: "http://fake", apiKey: "supabase-token" } as any);

  const result = await withFakeFetch(events, () =>
    adapter.runTurn({
      model: "gpt-5-mini",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "what's 6*7?" }] }],
      tools: [],
      onThinking: (t) => thinking.push(t),
      onText: (t) => texts.push(t),
    }),
  );

  assert.equal(thinking.join(""), "Let me check the file first.");
  assert.equal(texts.join(""), "The answer is 42.");
  assert.equal(result.text, "The answer is 42.");
  assert.equal(result.stopReason, "end_turn");
  // output_tokens taken as-is (already inclusive of reasoning_tokens) — see
  // azure-responses.ts's module doc on why NOT to add reasoning_tokens on top.
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20 });
});

test("AzureResponsesAdapter: request body uses flat tool defs, `instructions` for system, and `input` (not `messages`)", async () => {
  const events = [{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } }];
  const adapter = new AzureResponsesAdapter({ baseUrl: "http://fake", apiKey: "supabase-token" } as any);

  const captured = await withFakeFetch(events, async (cap) => {
    await adapter.runTurn({
      model: "gpt-5-mini",
      system: "you are a coding agent",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "read_file", description: "reads a file", input_schema: { type: "object", properties: {} } }],
    });
    return cap;
  });

  assert.equal(captured.body.instructions, "you are a coding agent");
  assert.equal(captured.body.messages, undefined, "must not send Chat-Completions-shaped `messages`");
  assert.ok(Array.isArray(captured.body.input));
  assert.deepEqual(captured.body.tools, [
    { type: "function", name: "read_file", description: "reads a file", parameters: { type: "object", properties: {} } },
  ]);
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.stream, true);
});

test("AzureResponsesAdapter: a full tool-call round trip — output_item.added gives call_id/name immediately, arguments accumulate via deltas", async () => {
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "read_file", arguments: "" },
    },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"a.ts",' },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '"limit":50}' },
    { type: "response.function_call_arguments.done", output_index: 0, arguments: '{"path":"a.ts","limit":50}' },
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_abc", name: "read_file" } },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } },
  ];

  const deltas: Array<{ index: number; id: string; name: string; delta: string }> = [];
  const adapter = new AzureResponsesAdapter({ baseUrl: "http://fake", apiKey: "t" } as any);
  const result = await withFakeFetch(events, () =>
    adapter.runTurn({
      model: "gpt-5-mini",
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "read a.ts" }] }],
      tools: [],
      onToolInputDelta: (ev) => deltas.push(ev),
    }),
  );

  assert.equal(deltas.map((d) => d.delta).join(""), '{"path":"a.ts","limit":50}');
  assert.ok(deltas.every((d) => d.id === "call_abc" && d.name === "read_file"));
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(result.toolCalls[0], { id: "call_abc", name: "read_file", input: { path: "a.ts", limit: 50 } });
  assert.equal(result.stopReason, "tool_use");
});

test("AzureResponsesAdapter: an incomplete response (max_output_tokens) maps to stopReason 'max_tokens'", async () => {
  const events = [
    { type: "response.output_text.delta", output_index: 0, delta: "partial..." },
    {
      type: "response.completed",
      response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 5 } },
    },
  ];
  const adapter = new AzureResponsesAdapter({ baseUrl: "http://fake", apiKey: "t" } as any);
  const result = await withFakeFetch(events, () =>
    adapter.runTurn({ model: "gpt-5-mini", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], tools: [] }),
  );
  assert.equal(result.stopReason, "max_tokens");
});

test("AzureResponsesAdapter: a mid-stream error event throws", async () => {
  const events = [{ type: "error", error: { type: "too_many_requests", code: "no_capacity", message: "high demand" } }];
  const adapter = new AzureResponsesAdapter({ baseUrl: "http://fake", apiKey: "t" } as any);
  await assert.rejects(
    () => withFakeFetch(events, () => adapter.runTurn({ model: "gpt-5-mini", system: "s", messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], tools: [] })),
    /stream error/,
  );
});
