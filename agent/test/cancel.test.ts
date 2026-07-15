/**
 * Regression tests for "clicking Stop sometimes does nothing" — the in-flight
 * agent turn keeps running (or worse, silently corrupts the session so the
 * NEXT turn breaks) even after the client sends `session/cancel`.
 *
 * Two independent mechanisms were audited:
 *
 *  1. Does a long-running `bash` tool call actually get killed when
 *     `session/cancel` fires mid-execution, or does the loop only notice
 *     `abort.signal.aborted` at await points BETWEEN tool calls (so a single
 *     slow command ignores cancel until it finishes on its own)? Verified via
 *     the real spawned server + real `session/cancel` notification, exactly
 *     the client's wire path (`server-e2e.test.ts`'s / `checkpoint.test.ts`'s
 *     style) — this one turned out to already be solid (tools.ts's
 *     `execWithKillEscalation` kills the whole process group on abort); the
 *     test below pins that down as a regression guard.
 *
 *  2. What happens when `session/cancel` lands BETWEEN two tool calls of the
 *     SAME assistant turn (model asked for tool call A and B in one
 *     response; A finished, cancel fires, B never starts)? This is the real
 *     bug: `runPromptLoop` (agent/src/loop.ts) pushed a `tool_use` block for
 *     EVERY tool call in the assistant message BEFORE running any of them,
 *     but on a mid-loop abort it used to `return "cancelled"` immediately —
 *     leaving tool call B's `tool_use` with no matching `tool_result` in
 *     history. That's invalid history: the next model call sends an
 *     assistant message with a dangling tool call, which strict providers
 *     (OpenAI et al.) reject outright — the session is left silently
 *     unusable after a Stop click that "did nothing" from the user's chair
 *     (the turn actually stopped; the NEXT one is what breaks). Fixed in
 *     loop.ts to synthesize a "cancelled" tool_result for every un-run call
 *     before pushing history. Verified in-process against `runPrompt`
 *     directly (`dispatch-subtasks.test.ts`'s style) since it needs
 *     precise control over exactly when the abort fires relative to the two
 *     tool calls — a real race over the wire would be flaky to pin down.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { _resetGuardCacheForTests } from "../src/checkpoint.js";
import { PRESETS } from "../src/config.js";
import type { AgentSession, LoopCallbacks } from "../src/loop.js";
import { runPrompt } from "../src/loop.js";
import type { ContentBlock } from "../src/providers/types.js";
import { finish, FakeOpenAI, textTurn, toolTurn } from "./helpers/fake-openai.js";

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(agentDir, "node_modules", ".bin", "tsx");
const serverPath = join(agentDir, "src", "server.ts");

async function setupHome(fake: FakeOpenAI): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lakshx-cancel-home-"));
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

test(
  "session/cancel while a long bash command is running kills it promptly (not after it finishes on its own)",
  { timeout: 60_000 },
  async () => {
    const fake = new FakeOpenAI();
    await fake.start();
    const home = await setupHome(fake);
    const workspace = await mkdtemp(join(tmpdir(), "lakshx-cancel-ws-"));

    const env: Record<string, string | undefined> = { ...process.env, HOME: home };
    for (const preset of Object.values(PRESETS)) delete env[preset.envKey];
    delete env.LAKSHX_ENABLE_OLLAMA;

    const child = spawn(tsxBin, [serverPath], { cwd: workspace, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
    let childStderr = "";
    child.stderr!.on("data", (d) => (childStderr += d));

    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);

    try {
      await acp
        .client({ name: "lakshx-cancel-test" })
        .onRequest(acp.methods.client.session.requestPermission, async () => ({
          outcome: { outcome: "selected", optionId: "allow" },
        }))
        .connectWith(stream, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

          await ctx.buildSession(workspace).withSession(async (session: any) => {
            await ctx.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: "auto" });

            // A command that would take 30s if left to run to completion —
            // if cancel is a no-op (or only checked between tool calls, never
            // during one), the turn only resolves after the full 30s.
            fake.enqueue(toolTurn("call_slow", "bash", { command: "sleep 30" }), textTurn("done"));

            const done = session.prompt("run a slow command");

            // Wait for proof the bash call actually started before cancelling
            // — cancelling before it starts wouldn't exercise the "kill a
            // live child process" path at all.
            for (;;) {
              const msg = await session.nextUpdate();
              const u: any = msg.update;
              if (u?.sessionUpdate === "tool_call" && u.toolCallId === "call_slow" && u.status === "in_progress") break;
            }

            const start = Date.now();
            await ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });

            for (;;) {
              const msg = await session.nextUpdate();
              if (msg.kind === "stop") break;
            }
            const elapsedMs = Date.now() - start;
            const response = await done;

            assert.equal(response.stopReason, "cancelled");
            // generous bound: well under the 30s sleep, but tolerant of the
            // kill-escalation grace period (tools.ts's KILL_GRACE_MS) plus
            // whatever the CI machine is slow at today
            assert.ok(elapsedMs < 15_000, `expected cancel to kill the running command quickly, took ${elapsedMs}ms`);
          });
        });
    } finally {
      child.kill();
      await fake.stop();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
      if (childStderr) console.error("--- server stderr ---\n" + childStderr);
    }
  },
);

/** Minimal LoopCallbacks; `onAbortAfter` fires synchronously right after the named tool call finishes, before the loop moves on to the next one. */
function makeCallbacks(onAbortAfter: { id: string; abort: () => void }): LoopCallbacks {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolStart: () => {},
    onToolEnd: (c) => {
      if (c.id === onAbortAfter.id) onAbortAfter.abort();
    },
    onPermission: async () => true,
  };
}

test(
  "session/cancel landing between two tool calls in the same assistant turn does not leave a dangling tool_use",
  { timeout: 30_000 },
  async () => {
    const fake = new FakeOpenAI();
    await fake.start();
    const home = await setupHome(fake);
    const workspace = await mkdtemp(join(tmpdir(), "lakshx-cancel-mid-ws-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    _resetGuardCacheForTests();

    try {
      const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "auto", history: [] };

      // A single assistant response asking for TWO tool calls at once — NOT
      // built with the `toolCallDelta` helper, which hardcodes delta index 0
      // for every call (fine for one call per turn, but two calls at index 0
      // would collapse into the same slot in the OpenAI-compat adapter's
      // parser instead of staying distinct).
      fake.enqueue(
        [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo one" }) } }] } }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo two" }) } }] } }] },
          finish("tool_calls"),
        ],
      );

      const abort = new AbortController();
      // Fires the moment call_1 finishes — deterministically lands the abort
      // in the window between call_1 completing and call_2 starting, instead
      // of relying on a timing-based race over real wall-clock delay.
      const cb = makeCallbacks({ id: "call_1", abort: () => abort.abort() });

      const stop = await runPrompt(session, "run two commands", cb, "pr_mid_abort", abort.signal, undefined, 0);
      assert.equal(stop, "cancelled");

      // The assistant message carries tool_use blocks for BOTH calls (the
      // model asked for both before either ran).
      const assistantMsg = session.history.find((m) => m.role === "assistant")!;
      const toolUseIds = assistantMsg.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => b.id);
      assert.deepEqual(toolUseIds, ["call_1", "call_2"]);

      // The very next history entry must answer BOTH of them — this is the
      // regression check: before the fix, `call_2` had no tool_result at all
      // and `results` (hence this history entry) never even got pushed.
      const idx = session.history.indexOf(assistantMsg);
      const answerMsg = session.history[idx + 1];
      assert.ok(answerMsg, "expected a tool-results message right after the assistant's tool_use message");
      assert.equal(answerMsg.role, "user");
      const results = answerMsg.content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
      const byId = new Map(results.map((r) => [r.tool_use_id, r]));
      assert.equal(byId.size, 2, "every tool_use must have exactly one matching tool_result");

      // call_1 actually ran (its bash command really executed)...
      assert.equal(byId.get("call_1")!.is_error, undefined);
      assert.match(byId.get("call_1")!.content, /one/);

      // ...call_2 never ran, but is still answered — explicitly, as a
      // cancellation, not silently dropped.
      assert.equal(byId.get("call_2")!.is_error, true);
      assert.match(byId.get("call_2")!.content, /cancelled/i);

      // Prove this isn't just a structural nicety: replaying this exact
      // history through the wire-format translation a real provider request
      // uses (openai-compat.ts's `toWire`) must produce a `tool` message for
      // EVERY tool_calls entry in the preceding assistant message — the
      // shape strict providers require. A second real turn on this session
      // is the most direct way to exercise that translation.
      fake.enqueue(textTurn("continuing fine"));
      const cb2 = makeCallbacks({ id: "__never__", abort: () => {} });
      const stop2 = await runPrompt(session, "keep going", cb2, "pr_after_cancel", new AbortController().signal, undefined, 0);
      assert.equal(stop2, "end_turn");

      const secondReqMessages = fake.requests.at(-1)!.messages;
      const assistantWire = secondReqMessages.find((m: any) => m.role === "assistant" && m.tool_calls);
      assert.ok(assistantWire, "expected the assistant tool_calls message to be replayed on the next request");
      for (const call of assistantWire!.tool_calls) {
        assert.ok(
          secondReqMessages.some((m: any) => m.role === "tool" && m.tool_call_id === call.id),
          `tool_call ${call.id} must have a matching tool message on the wire`,
        );
      }
    } finally {
      process.env.HOME = realHome;
      await fake.stop();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
