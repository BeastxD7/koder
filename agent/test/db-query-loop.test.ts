/**
 * Loop-level tests for the `db_query` special-case branch in src/loop.ts,
 * driven directly against `runPrompt()` with a scripted OpenAI-compatible
 * provider (the dispatch-subtasks.test.ts style — no ACP framing). These
 * prove the AGENT+RELAY wiring in isolation:
 *
 *  - a `db_query` tool_use is routed to `cb.onDbQuery` (NOT `spec.run`, whose
 *    stub throws), with VALIDATED input (engine passed through, maxRows
 *    clamped/defaulted), and the handler's `{text, isError}` becomes the
 *    model-facing tool_result;
 *  - a throwing/rejecting `onDbQuery` still yields a clean `isError` tool_result
 *    and the loop finishes normally — never a crash;
 *  - with NO `onDbQuery` wired at all (non-LakshX client), the branch degrades
 *    to a clean "capability unavailable" tool-error.
 *
 * NOT exercised here: the real agent↔lakshx-chat↔lakshx-db round-trip
 * (runReadOnlyQuery, the read-only transaction, the opt-in gate, redaction).
 * There's no extension host in this harness — `onDbQuery` is a fake stand-in
 * for server.ts's ACP relay. See db.test.ts for the pure validation and the
 * task report for what is deliberately not round-tripped end-to-end.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _resetGuardCacheForTests } from "../src/checkpoint.js";
import type { AgentSession, LoopCallbacks } from "../src/loop.js";
import { runPrompt } from "../src/loop.js";
import { FakeOpenAI, textTurn, toolTurn } from "./helpers/fake-openai.js";

async function setupHome(fake: FakeOpenAI): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lakshx-dbq-home-"));
  await mkdir(join(home, ".lakshx"), { recursive: true });
  await writeFile(
    join(home, ".lakshx", "providers.json"),
    JSON.stringify({
      defaultModel: "fake/test-model",
      providers: { fake: { kind: "openai", baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: "test-key-123" } },
    }),
  );
  return home;
}

function findToolMessage(fake: FakeOpenAI, toolCallId: string) {
  for (const req of fake.requests) {
    const m = req.messages.find((mm: any) => mm.role === "tool" && mm.tool_call_id === toolCallId);
    if (m) return m;
  }
  return undefined;
}

/** Base callbacks with the required members stubbed; tests override onDbQuery. */
function baseCallbacks(): LoopCallbacks & { starts: any[]; ends: any[] } {
  const starts: any[] = [];
  const ends: any[] = [];
  return {
    onText: () => {},
    onThinking: () => {},
    onToolStart: (c) => starts.push(c),
    onToolEnd: (c) => ends.push(c),
    onPermission: async () => true,
    starts,
    ends,
  };
}

test("db_query: routes to onDbQuery with validated input; result becomes the tool_result", { timeout: 30_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-dbq-ws-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  _resetGuardCacheForTests();

  try {
    const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "review", history: [] };
    const cb = baseCallbacks();
    const dbCalls: any[] = [];
    cb.onDbQuery = async (input) => {
      dbCalls.push(input);
      return { text: "id | name\n1  | Ada", isError: false };
    };

    // Model calls db_query with an over-max maxRows — it must be clamped to
    // 1000 by db.ts validation BEFORE reaching onDbQuery (the relay).
    fake.enqueue(toolTurn("call_db1", "db_query", { connectionRef: "postgres", query: "SELECT * FROM users", maxRows: 99999 }));
    fake.enqueue(textTurn("Here are the rows."));

    const stop = await runPrompt(session, "show me the users", cb, "pr_db1");
    assert.equal(stop, "end_turn");

    // ---- onDbQuery received VALIDATED input, not the raw tool input.
    assert.equal(dbCalls.length, 1, "onDbQuery must be called exactly once");
    assert.equal(dbCalls[0].connectionRef, "postgres");
    assert.equal(dbCalls[0].query, "SELECT * FROM users");
    assert.equal(dbCalls[0].maxRows, 1000, "maxRows must be clamped into [1,1000] before the relay");

    // ---- the handler's text became the model-facing tool_result, not an error.
    const toolMsg = findToolMessage(fake, "call_db1");
    assert.ok(toolMsg, "expected a tool_result for the db_query call");
    assert.match(toolMsg!.content as string, /id \| name/);

    // ---- UI callbacks fired with the read-kind card + Query title.
    const start = cb.starts.find((s) => s.name === "db_query");
    assert.ok(start, "onToolStart must fire for db_query");
    assert.equal(start.kind, "read");
    assert.match(start.title, /Query postgres/);
    const end = cb.ends.find((e) => e.output && /id \| name/.test(e.output));
    assert.ok(end, "onToolEnd must carry the result text");
    assert.equal(end.isError, false);
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("db_query: an invalid engine id is a clean tool-error, onDbQuery never called", { timeout: 30_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-dbq-bad-ws-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  _resetGuardCacheForTests();

  try {
    const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "review", history: [] };
    const cb = baseCallbacks();
    let called = false;
    cb.onDbQuery = async () => {
      called = true;
      return { text: "should not get here", isError: false };
    };

    // "oracle" is a genuinely unsupported engine id (unlike "mongo", which
    // is now valid — see the mongo-specific shape-rejection test below).
    fake.enqueue(toolTurn("call_db_bad", "db_query", { connectionRef: "oracle", query: "SELECT 1" }));
    fake.enqueue(textTurn("Understood, oracle isn't supported."));

    const stop = await runPrompt(session, "query oracle", cb, "pr_db_bad");
    assert.equal(stop, "end_turn", "validation failure must not crash the loop");
    assert.equal(called, false, "onDbQuery must not be called for input that fails validation");

    // The OpenAI-compat `tool` message carries no is_error flag — the
    // error-ness is observable via the content text and the onToolEnd callback.
    const toolMsg = findToolMessage(fake, "call_db_bad");
    assert.ok(toolMsg);
    assert.match(toolMsg!.content as string, /not a supported database/);
    const end = cb.ends.find((e) => /not a supported database/.test(e.output ?? ""));
    assert.ok(end, "onToolEnd must fire for a validation failure");
    assert.equal(end.isError, true);
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("db_query: mongo with a non-JSON query is a clean tool-error, onDbQuery never called", { timeout: 30_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-dbq-mongobad-ws-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  _resetGuardCacheForTests();

  try {
    const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "review", history: [] };
    const cb = baseCallbacks();
    let called = false;
    cb.onDbQuery = async () => {
      called = true;
      return { text: "should not get here", isError: false };
    };

    // Mongo IS a supported engine now, but its query must be a JSON spec,
    // not free-form text — this must fail agent-side validation and never
    // reach onDbQuery, same as the invalid-engine case above.
    fake.enqueue(toolTurn("call_db_mongobad", "db_query", { connectionRef: "mongo", query: "db.users.find()" }));
    fake.enqueue(textTurn("That mongo query wasn't valid JSON."));

    const stop = await runPrompt(session, "query mongo", cb, "pr_db_mongobad");
    assert.equal(stop, "end_turn", "validation failure must not crash the loop");
    assert.equal(called, false, "onDbQuery must not be called for input that fails validation");

    const toolMsg = findToolMessage(fake, "call_db_mongobad");
    assert.ok(toolMsg);
    assert.match(toolMsg!.content as string, /not valid JSON/);
    const end = cb.ends.find((e) => /not valid JSON/.test(e.output ?? ""));
    assert.ok(end, "onToolEnd must fire for a validation failure");
    assert.equal(end.isError, true);
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("db_query: a throwing onDbQuery yields a clean isError tool_result, loop finishes", { timeout: 30_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-dbq-throw-ws-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  _resetGuardCacheForTests();

  try {
    const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "review", history: [] };
    const cb = baseCallbacks();
    cb.onDbQuery = async () => {
      throw new Error("relay exploded");
    };

    fake.enqueue(toolTurn("call_db_throw", "db_query", { connectionRef: "sqlite", query: "SELECT 1" }));
    fake.enqueue(textTurn("Noted the failure."));

    const stop = await runPrompt(session, "run a query", cb, "pr_db_throw");
    assert.equal(stop, "end_turn", "a throwing handler must never crash the turn");

    const toolMsg = findToolMessage(fake, "call_db_throw");
    assert.ok(toolMsg);
    assert.match(toolMsg!.content as string, /relay exploded/);
    // onToolEnd must still fire (card resolves) with isError — the flag is
    // carried by the callback, not by the OpenAI-format tool message.
    const end = cb.ends.find((e) => /relay exploded/.test(e.output ?? ""));
    assert.ok(end, "onToolEnd must fire even when the handler throws");
    assert.equal(end.isError, true);
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("db_query: with no onDbQuery wired (non-LakshX client) → clean capability-unavailable error", { timeout: 30_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-dbq-nocap-ws-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  _resetGuardCacheForTests();

  try {
    const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "review", history: [] };
    const cb = baseCallbacks(); // deliberately no onDbQuery

    fake.enqueue(toolTurn("call_db_nocap", "db_query", { connectionRef: "mysql", query: "SELECT 1" }));
    fake.enqueue(textTurn("Capability unavailable, understood."));

    const stop = await runPrompt(session, "run a query", cb, "pr_db_nocap");
    assert.equal(stop, "end_turn");

    const toolMsg = findToolMessage(fake, "call_db_nocap");
    assert.ok(toolMsg);
    assert.match(toolMsg!.content as string, /capability unavailable/i);
    const end = cb.ends.find((e) => /capability unavailable/i.test(e.output ?? ""));
    assert.ok(end, "onToolEnd must fire in the no-capability path");
    assert.equal(end.isError, true);
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
