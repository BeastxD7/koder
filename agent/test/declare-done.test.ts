/**
 * Loop-level tests for the harness-enforced completion gate (Royal Mode 2.0
 * Stage A): `set_verification_spec` + `declare_done` (agent/src/loop.ts,
 * agent/src/verify.ts). Driven directly against `runPrompt()` with a scripted
 * FakeOpenAI provider, matching the style of test/dispatch-subtasks.test.ts.
 *
 * The point of this file: prove the model's own "I'm done" claim is never
 * the answer — `declare_done` must return a REAL verification result, backed
 * by an actually-executed command, not a fabricated pass.
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

function makeRecordingCallbacks(): LoopCallbacks & { toolEnds: any[] } {
  const toolEnds: any[] = [];
  return {
    onText: () => {},
    onThinking: () => {},
    onToolStart: () => {},
    onToolEnd: (c) => toolEnds.push(c),
    onPermission: async () => true,
    toolEnds,
  };
}

async function setupHome(fake: FakeOpenAI): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lakshx-declare-done-home-"));
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

test(
  "declare_done: with no verification spec set, refuses to confirm completion (never a fabricated pass)",
  { timeout: 30_000 },
  async () => {
    const fake = new FakeOpenAI();
    await fake.start();
    const home = await setupHome(fake);
    const workspace = await mkdtemp(join(tmpdir(), "lakshx-declare-done-ws1-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    _resetGuardCacheForTests();

    try {
      const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "auto", history: [] };
      const cb = makeRecordingCallbacks();

      fake.enqueue(toolTurn("call_declare1", "declare_done", { summary: "I believe I'm done" }));
      fake.enqueue(textTurn("Understood, I need a verification spec first."));

      const stop = await runPrompt(session, "are you done?", cb, "pr_no_spec");
      assert.equal(stop, "end_turn");

      const toolMsg = findToolMessage(fake, "call_declare1")!.content as string;
      assert.match(toolMsg, /no verification spec is set/i);
      assert.match(toolMsg, /set_verification_spec/);
      const end = cb.toolEnds.find((e) => e.id === "call_declare1");
      assert.equal(end.isError, true, "must be reported as a failure, not a pass, when no spec exists");
    } finally {
      process.env.HOME = realHome;
      await fake.stop();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "declare_done: a spec designed to FAIL really executes and comes back as a real failure, not a fabricated pass",
  { timeout: 30_000 },
  async () => {
    const fake = new FakeOpenAI();
    await fake.start();
    const home = await setupHome(fake);
    const workspace = await mkdtemp(join(tmpdir(), "lakshx-declare-done-ws2-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    _resetGuardCacheForTests();

    try {
      const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "auto", history: [] };
      const cb = makeRecordingCallbacks();

      fake.enqueue(
        toolTurn("call_set1", "set_verification_spec", {
          mechanical: [{ cmd: `node -e "process.exit(1)"`, expect: "exitZero" }],
        }),
      );
      fake.enqueue(toolTurn("call_declare2", "declare_done", {}));
      // Model sees the real failure and reports it honestly instead of
      // claiming success — that's what a correctly-gated model does, but the
      // test asserts on the TOOL RESULT itself, not this final text.
      fake.enqueue(textTurn("Verification failed — I am not done yet."));

      const stop = await runPrompt(session, "set a spec designed to fail, then declare done", cb, "pr_fail_spec");
      assert.equal(stop, "end_turn");

      const setMsg = findToolMessage(fake, "call_set1")!.content as string;
      assert.match(setMsg, /frozen/i);

      const doneMsg = findToolMessage(fake, "call_declare2")!.content as string;
      assert.match(doneMsg, /FAILED/);
      assert.match(doneMsg, /not done/i);
      assert.match(doneMsg, /exit 1/);
      const end = cb.toolEnds.find((e) => e.id === "call_declare2");
      assert.equal(end.isError, true, "a real failing check must never be reported as a pass");
    } finally {
      process.env.HOME = realHome;
      await fake.stop();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "declare_done: a spec designed to PASS really executes and comes back green",
  { timeout: 30_000 },
  async () => {
    const fake = new FakeOpenAI();
    await fake.start();
    const home = await setupHome(fake);
    const workspace = await mkdtemp(join(tmpdir(), "lakshx-declare-done-ws3-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    _resetGuardCacheForTests();

    try {
      const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "auto", history: [] };
      const cb = makeRecordingCallbacks();

      fake.enqueue(
        toolTurn("call_set2", "set_verification_spec", {
          mechanical: [{ cmd: `node -e "process.exit(0)"`, expect: "exitZero" }],
        }),
      );
      fake.enqueue(toolTurn("call_declare3", "declare_done", { summary: "typecheck-equivalent passes" }));
      fake.enqueue(textTurn("Verification passed — the work is done."));

      const stop = await runPrompt(session, "set a passing spec, then declare done", cb, "pr_pass_spec");
      assert.equal(stop, "end_turn");

      const doneMsg = findToolMessage(fake, "call_declare3")!.content as string;
      assert.match(doneMsg, /Verification passed: 1\/1 checks green/);
      assert.match(doneMsg, /PASS \(exit 0/);
      const end = cb.toolEnds.find((e) => e.id === "call_declare3");
      assert.equal(end.isError, false, "a real passing check must be reported as a pass");
    } finally {
      process.env.HOME = realHome;
      await fake.stop();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "declare_done: refuses to run in review mode (verification executes real commands; review mode is read-only)",
  { timeout: 30_000 },
  async () => {
    const fake = new FakeOpenAI();
    await fake.start();
    const home = await setupHome(fake);
    const workspace = await mkdtemp(join(tmpdir(), "lakshx-declare-done-ws4-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    _resetGuardCacheForTests();

    try {
      const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "review", history: [] };
      const cb = makeRecordingCallbacks();

      fake.enqueue(toolTurn("call_declare_review", "declare_done", {}));
      fake.enqueue(textTurn("Understood, cannot verify in review mode."));

      const stop = await runPrompt(session, "declare done while reviewing", cb, "pr_review_gate");
      assert.equal(stop, "end_turn");

      const msg = findToolMessage(fake, "call_declare_review")!.content as string;
      assert.match(msg, /review mode/i);
      const end = cb.toolEnds.find((e) => e.id === "call_declare_review");
      assert.equal(end.isError, true);
    } finally {
      process.env.HOME = realHome;
      await fake.stop();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

test(
  "declare_done: a spec containing a floor-blocked command is refused rather than executed",
  { timeout: 30_000 },
  async () => {
    const fake = new FakeOpenAI();
    await fake.start();
    const home = await setupHome(fake);
    const workspace = await mkdtemp(join(tmpdir(), "lakshx-declare-done-ws5-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    _resetGuardCacheForTests();

    try {
      const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "auto", history: [] };
      const cb = makeRecordingCallbacks();

      fake.enqueue(
        toolTurn("call_set_floor", "set_verification_spec", {
          mechanical: [{ cmd: "git push --force origin main", expect: "exitZero" }],
        }),
      );
      fake.enqueue(toolTurn("call_declare_floor", "declare_done", {}));
      fake.enqueue(textTurn("Understood, the spec itself was unsafe."));

      const stop = await runPrompt(session, "set an unsafe spec, then declare done", cb, "pr_floor_spec");
      assert.equal(stop, "end_turn");

      const msg = findToolMessage(fake, "call_declare_floor")!.content as string;
      assert.match(msg, /safety floor/i);
      const end = cb.toolEnds.find((e) => e.id === "call_declare_floor");
      assert.equal(end.isError, true);
    } finally {
      process.env.HOME = realHome;
      await fake.stop();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
