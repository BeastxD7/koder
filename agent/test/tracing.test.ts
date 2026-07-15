/**
 * Unit tests for src/tracing.ts — the security-critical property under test
 * is that Langfuse tracing NEVER activates, and NEVER makes a network call,
 * unless the user has explicitly configured all three of
 * LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL. There is no
 * default remote endpoint (see tracing.ts's module doc) — this file asserts
 * that directly rather than leaving it implied by the source.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { KoderConfig } from "../src/config.js";
import { getTracer, NOOP_TRACER } from "../src/tracing.js";

/** Run fn with process.env patched (undefined → delete), restoring afterwards. */
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) {
    saved[k] = process.env[k];
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A bare config with no file-provided `langfuse` block — isolates env-var behavior. */
const bareCfg: KoderConfig = { defaultModel: "anthropic/claude-sonnet-5", providers: {} };

const LANGFUSE_ENV_KEYS = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"];

test("getTracer returns the inert no-op when NO Langfuse env vars are set", () => {
  withEnv(Object.fromEntries(LANGFUSE_ENV_KEYS.map((k) => [k, undefined])), () => {
    assert.strictEqual(getTracer(bareCfg), NOOP_TRACER);
  });
});

test("getTracer returns the inert no-op with only 1 of 3 vars set (publicKey only)", () => {
  withEnv(
    { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: undefined, LANGFUSE_BASE_URL: undefined },
    () => {
      assert.strictEqual(getTracer(bareCfg), NOOP_TRACER);
    },
  );
});

test("getTracer returns the inert no-op with 2 of 3 vars set (publicKey + secretKey, no baseUrl)", () => {
  // This is THE critical case: no default/fallback endpoint even when both
  // keys are configured. If this ever returns a real tracer, someone added
  // a default base URL — see tracing.ts's module doc for why that must
  // never happen.
  withEnv(
    { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test", LANGFUSE_BASE_URL: undefined },
    () => {
      assert.strictEqual(getTracer(bareCfg), NOOP_TRACER);
    },
  );
});

test("getTracer returns the inert no-op with 2 of 3 vars set (secretKey + baseUrl, no publicKey)", () => {
  withEnv(
    { LANGFUSE_PUBLIC_KEY: undefined, LANGFUSE_SECRET_KEY: "sk-test", LANGFUSE_BASE_URL: "http://localhost:3000" },
    () => {
      assert.strictEqual(getTracer(bareCfg), NOOP_TRACER);
    },
  );
});

test("getTracer returns the inert no-op with only baseUrl set", () => {
  withEnv(
    { LANGFUSE_PUBLIC_KEY: undefined, LANGFUSE_SECRET_KEY: undefined, LANGFUSE_BASE_URL: "http://localhost:3000" },
    () => {
      assert.strictEqual(getTracer(bareCfg), NOOP_TRACER);
    },
  );
});

test("getTracer returns a real tracer ONLY once all three of publicKey/secretKey/baseUrl are present", () => {
  withEnv(
    { LANGFUSE_PUBLIC_KEY: "pk-test", LANGFUSE_SECRET_KEY: "sk-test", LANGFUSE_BASE_URL: "http://localhost:3000" },
    () => {
      const tracer = getTracer(bareCfg);
      assert.notStrictEqual(tracer, NOOP_TRACER);
    },
  );
});

test("getTracer never defaults to a public/cloud Langfuse host — baseUrl absence alone disables tracing even with both keys present via providers.json-style cfg", () => {
  const cfgWithKeysNoUrl: KoderConfig = {
    ...bareCfg,
    langfuse: { publicKey: "pk-file", secretKey: "sk-file" }, // no baseUrl in file config either
  };
  withEnv(Object.fromEntries(LANGFUSE_ENV_KEYS.map((k) => [k, undefined])), () => {
    assert.strictEqual(getTracer(cfgWithKeysNoUrl), NOOP_TRACER);
  });
});

test("the no-op tracer's full call surface (trace, generation, tool, end, flush) makes zero network calls", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("network call attempted — the no-op tracer must never touch the network");
  }) as typeof fetch;

  try {
    const tracer = getTracer({ defaultModel: "x", providers: {} }); // no langfuse config at all
    assert.strictEqual(tracer, NOOP_TRACER);

    const trace = tracer.startTrace({
      id: "prompt-1",
      name: "runPrompt",
      sessionId: "session-1",
      input: "hello",
      metadata: { mode: "auto", model: "anthropic/claude-sonnet-5" },
    });
    const generation = trace.generation({ name: "adapter.runTurn", model: "anthropic/claude-sonnet-5", input: {} });
    generation.end({ output: "response text", usage: { inputTokens: 100, outputTokens: 20 } });

    const toolSpan = trace.tool({ name: "read_file", input: { path: "foo.ts" } });
    toolSpan.end({ output: "file contents", isError: false });

    trace.end({ output: "final answer" });
    await tracer.flush();

    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
