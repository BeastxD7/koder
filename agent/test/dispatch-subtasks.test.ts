/**
 * Unit tests for `dispatch_subtasks` (agent/src/loop.ts), driven directly
 * against `runPrompt()` in-process rather than through a spawned server
 * subprocess (server-e2e.test.ts's style) — no ACP framing needed here, just
 * the loop + a scripted OpenAI-compatible provider. `os.homedir()` (used by
 * `config.ts`/`checkpoint.ts`/`audit.ts`) reads `process.env.HOME` at CALL
 * time, not once at import time, so pointing `HOME` at a temp dir with a
 * `providers.json` before calling `runPrompt` is enough to route model calls
 * at our `FakeOpenAI` server with no real API keys or network access.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { _resetGuardCacheForTests } from "../src/checkpoint.js";
import type { AgentSession, LoopCallbacks } from "../src/loop.js";
import { runPrompt } from "../src/loop.js";
import { FakeOpenAI, textTurn, toolTurn } from "./helpers/fake-openai.js";

/** Minimal LoopCallbacks that records everything a test might want to assert on. */
function makeRecordingCallbacks(): LoopCallbacks & {
  subagentsStart: any[];
  subagentActivity: any[];
  subagentsEnd: any[];
} {
  const subagentsStart: any[] = [];
  const subagentActivity: any[] = [];
  const subagentsEnd: any[] = [];
  return {
    onText: () => {},
    onThinking: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onPermission: async () => true,
    subagentsStart,
    subagentActivity,
    subagentsEnd,
    onSubagentsStart: (info) => subagentsStart.push(info),
    onSubagentActivity: (info) => subagentActivity.push(info),
    onSubagentsEnd: (info) => subagentsEnd.push(info),
  };
}

async function setupHome(fake: FakeOpenAI): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lakshx-dispatch-home-"));
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

/**
 * Find the `tool` role message with the given tool_call_id, searching ALL
 * recorded requests (not just the most recent) — a child spawned by
 * `dispatch_subtasks` has its own independent message thread, separate from
 * the parent's, so its tool_result can land in an EARLIER request than the
 * parent's own final wrap-up request that arrives after it.
 */
function findToolMessage(fake: FakeOpenAI, toolCallId: string) {
  for (const req of fake.requests) {
    const m = req.messages.find((mm: any) => mm.role === "tool" && mm.tool_call_id === toolCallId);
    if (m) return m;
  }
  return undefined;
}

test("dispatch_subtasks: runs tasks concurrently and isolates child history", { timeout: 30_000 }, async (t) => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-dispatch-ws-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  _resetGuardCacheForTests();

  try {
    const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "auto", history: [] };
    const cb = makeRecordingCallbacks();

    // Parent turn: one dispatch_subtasks call with two independent tasks —
    // one carries an explicit `context` block, one doesn't.
    fake.enqueue(
      toolTurn("call_dispatch1", "dispatch_subtasks", {
        tasks: [
          { id: "t1", prompt: "investigate file A for the bug pattern" },
          { id: "t2", prompt: "investigate file B for the bug pattern", context: "parent already ruled out auth.ts" },
        ],
      }),
    );
    // Child A's response is held for 800ms; child B's is instant. This is
    // an ORDER proof, not a total-wall-clock one (a busy CI box running the
    // whole suite concurrently makes any absolute-elapsed-time assertion
    // flaky): if the two children ran SEQUENTIALLY, child B's request could
    // not even be DISPATCHED until child A's whole (800ms-delayed) turn had
    // finished — so the gap between when each request ARRIVED at the fake
    // server would be ~800ms. If they ran concurrently (as required), both
    // requests are dispatched back-to-back regardless of how long either
    // response takes to come back, so the arrival gap is small — a few
    // hundred ms of JS/git-shellout scheduling overhead at most, even under
    // load, nowhere near 800ms.
    fake.enqueueDelayed(800, textTurn("child A done: nothing found"));
    fake.enqueue(textTurn("child B done: found it in B"));
    fake.enqueue(textTurn("Synthesized both results."));

    const stop = await runPrompt(session, "investigate the flaky bug across files A and B", cb, "pr_concurrency");
    assert.equal(stop, "end_turn");

    // ---- isolation: neither child's request to the provider carries the
    // PARENT's own user text or the other child's prompt.
    const childRequestIndices = fake.requests
      .map((r, i) => [r, i] as const)
      .filter(([r]) => r.messages.some((m: any) => m.role === "user" && typeof m.content === "string" && /investigate file/.test(m.content)));
    const childRequests = childRequestIndices.map(([r]) => r);
    assert.equal(childRequests.length, 2, "expected exactly one request per child");

    // ---- concurrency: the two children's requests arrived at the fake
    // server close together in wall-clock time, not ~800ms apart.
    const arrivalGapMs = Math.abs(
      fake.requestTimestamps[childRequestIndices[1][1]] - fake.requestTimestamps[childRequestIndices[0][1]],
    );
    assert.ok(arrivalGapMs < 500, `expected both children's requests to be dispatched within 500ms of each other (concurrent), gap was ${arrivalGapMs}ms`);
    for (const req of childRequests) {
      const userMsgs = req.messages.filter((m: any) => m.role === "user").map((m: any) => m.content).join("\n");
      assert.doesNotMatch(
        userMsgs,
        /investigate the flaky bug across files A and B/,
        "child's first message must never contain the parent's own user text — history isolation",
      );
    }
    // task t1 (no context) — its message is exactly its prompt, nothing more
    const t1Req = childRequests.find((r) => r.messages.some((m: any) => m.role === "user" && /file A/.test(m.content)))!;
    const t1Msg = t1Req.messages.find((m: any) => m.role === "user").content;
    assert.match(t1Msg, /investigate file A for the bug pattern/);
    assert.doesNotMatch(t1Msg, /parent_context/, "task with no context must not get a context block");

    // task t2 (explicit context) — the opt-in context block IS present
    const t2Req = childRequests.find((r) => r.messages.some((m: any) => m.role === "user" && /file B/.test(m.content)))!;
    const t2Msg = t2Req.messages.find((m: any) => m.role === "user").content;
    assert.match(t2Msg, /parent_context/);
    assert.match(t2Msg, /parent already ruled out auth\.ts/);
    assert.match(t2Msg, /investigate file B for the bug pattern/);

    // ---- merged tool_result reaches the parent, one block per task id
    const toolMsg = findToolMessage(fake, "call_dispatch1")!.content as string;
    assert.match(toolMsg, /Subtask t1/);
    assert.match(toolMsg, /Subtask t2/);
    assert.match(toolMsg, /child A done/);
    assert.match(toolMsg, /child B done/);

    // ---- live progress callbacks fired (Part 3)
    assert.equal(cb.subagentsStart.length, 1);
    assert.equal(cb.subagentsStart[0].tasks.length, 2);
    assert.equal(cb.subagentsStart[0].promptId, "pr_concurrency");
    assert.equal(cb.subagentsEnd.length, 1);
    assert.equal(cb.subagentsEnd[0].results.length, 2);
    assert.ok(cb.subagentsEnd[0].results.every((r: any) => r.isError === false));
    // same batchId ties start/end/activity together
    const batchId = cb.subagentsStart[0].batchId;
    assert.equal(cb.subagentsEnd[0].batchId, batchId);
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("dispatch_subtasks: depth cap refuses a nested dispatch_subtasks call without crashing", { timeout: 30_000 }, async (t) => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-dispatch-depth-ws-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  _resetGuardCacheForTests();

  try {
    const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "auto", history: [] };
    const cb = makeRecordingCallbacks();

    // Parent dispatches one subtask...
    fake.enqueue(toolTurn("call_dispatch_outer", "dispatch_subtasks", { tasks: [{ id: "child1", prompt: "try to nest" }] }));
    // ...whose FIRST move is to itself call dispatch_subtasks (should be refused, not crash)...
    fake.enqueue(toolTurn("call_dispatch_inner", "dispatch_subtasks", { tasks: [{ id: "grandchild", prompt: "should never run" }] }));
    // ...the child sees the refusal as its tool_result and wraps up...
    fake.enqueue(textTurn("Understood, cannot nest further."));
    // ...and the parent gets the merged result and wraps up too.
    fake.enqueue(textTurn("Subtask reported it could not nest."));

    const stop = await runPrompt(session, "please nest subtasks", cb, "pr_depth");
    assert.equal(stop, "end_turn", "must complete normally, not crash/throw");

    // The refusal reached the CHILD as an error tool_result for its own inner call
    const innerRefusal = findToolMessage(fake, "call_dispatch_inner");
    assert.ok(innerRefusal, "expected a tool_result for the nested dispatch_subtasks call");
    assert.match(innerRefusal!.content as string, /not available (from )?within a subtask|nesting depth/i);

    // The outer dispatch's own tool_result to the PARENT is not itself an error —
    // the parent's dispatch call succeeded; it was the CHILD's nested attempt that failed.
    assert.equal(cb.subagentsEnd.length, 1);
    assert.equal(cb.subagentsEnd[0].results.length, 1);
    assert.equal(cb.subagentsEnd[0].results[0].id, "child1");
    assert.equal(cb.subagentsEnd[0].results[0].isError, false, "the subtask itself completed (its nested attempt failed internally, not the subtask as a whole)");
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("dispatch_subtasks: concurrency cap truncates >6 tasks with a clear message, does not silently drop", { timeout: 30_000 }, async (t) => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-dispatch-cap-ws-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  _resetGuardCacheForTests();

  try {
    const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "auto", history: [] };
    const cb = makeRecordingCallbacks();

    const tasks = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, prompt: `investigate area ${i}` }));
    fake.enqueue(toolTurn("call_dispatch_many", "dispatch_subtasks", { tasks }));
    // Only 6 children should ever fire a request — queue exactly 6 generic replies.
    for (let i = 0; i < 6; i++) fake.enqueue(textTurn(`done ${i}`));
    fake.enqueue(textTurn("Wrapped up the batch."));

    const stop = await runPrompt(session, "investigate 8 areas", cb, "pr_cap");
    assert.equal(stop, "end_turn");

    // Exactly 6 tasks were announced/run, not 8.
    assert.equal(cb.subagentsStart[0].tasks.length, 6);
    assert.equal(cb.subagentsEnd[0].results.length, 6);

    // The merged tool_result carries an explicit truncation note — never a silent drop.
    const toolMsg = findToolMessage(fake, "call_dispatch_many")!.content as string;
    assert.match(toolMsg, /8 tasks were submitted but only 6 run/);
    assert.match(toolMsg, /resubmit/i);

    // No 7th/8th child request ever reached the provider.
    const childRequests = fake.requests.filter((r) =>
      r.messages.some((m: any) => m.role === "user" && typeof m.content === "string" && /investigate area/.test(m.content)),
    );
    assert.equal(childRequests.length, 6);
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test(
  "dispatch_subtasks: a review-mode parent forces every child into review mode too, even when a task requests otherwise",
  { timeout: 30_000 },
  async (t) => {
    const fake = new FakeOpenAI();
    await fake.start();
    const home = await setupHome(fake);
    const workspace = await mkdtemp(join(tmpdir(), "lakshx-dispatch-review-ws-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    _resetGuardCacheForTests();

    try {
      // Parent is in REVIEW mode — dispatch_subtasks must still be offered
      // (this is the fix: it used to be excluded from review mode entirely).
      const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "review", history: [] };
      const cb = makeRecordingCallbacks();

      // The task explicitly asks for "auto" mode, trying to get a
      // mutating child past review mode's guarantee.
      fake.enqueue(
        toolTurn("call_dispatch_review", "dispatch_subtasks", {
          tasks: [{ id: "escapee", prompt: "write a file", mode: "auto" }],
        }),
      );
      // The child, however it's actually run, attempts a write.
      fake.enqueue(toolTurn("call_write_attempt", "write_file", { path: "should-not-exist.txt", content: "escaped review mode" }));
      fake.enqueue(textTurn("Child could not write — reporting back."));
      fake.enqueue(textTurn("Confirmed the write was blocked."));

      const stop = await runPrompt(session, "try to sneak a write past review mode", cb, "pr_review_containment");
      assert.equal(stop, "end_turn");

      // The tool offered to the PARENT for its own turn is still read-only +
      // dispatch_subtasks + db_query (a read-kind tool usable in review mode) +
      // the three background-task management tools (check_tasks/send_to_task/
      // wait_for_tasks are non-dangerous observe/steer/join operations on the
      // registry, not workspace mutations — review mode's guarantee is about
      // write_file/edit_file/bash, which stay excluded below).
      const offeredToParent = fake.requests[0]!.tools.map((tl: any) => tl.function.name).sort();
      assert.deepEqual(offeredToParent, [
        "check_tasks",
        "db_query",
        "dispatch_subtasks",
        "grep",
        "list_dir",
        "list_merge_conflicts",
        "read_file",
        "send_to_task",
        "wait_for_tasks",
      ]);

      // The child's announced mode is "review", NOT the "auto" the task asked for.
      assert.equal(cb.subagentsStart[0].tasks[0].mode, "review");

      // The child's write_file call was denied (review mode's hard gate — no
      // permission prompt, no execution) rather than actually running.
      const writeResult = findToolMessage(fake, "call_write_attempt");
      assert.ok(writeResult, "expected a tool_result for the child's write_file attempt");
      assert.match(writeResult!.content as string, /declined|review mode/i);

      // And, decisively: the file was never actually created on disk.
      await assert.rejects(
        readFile(join(workspace, "should-not-exist.txt")),
        /ENOENT/,
        "review mode's guarantee must hold even for a dispatch_subtasks child",
      );
    } finally {
      process.env.HOME = realHome;
      await fake.stop();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
