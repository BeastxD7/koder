/**
 * Regression test for the "agent gets stuck mid-thinking forever" bug:
 * neither provider adapter's SSE fetch had any timeout, so a connection that
 * goes silent without closing (dead proxy/VPN/upstream — TCP alive, no more
 * bytes) hung `for await (const data of sseLines(...))` forever. No error,
 * no turn completion, UI stuck showing "Thinking..." indefinitely.
 *
 * This spins up the real server (ACP over stdio) against a scripted fake
 * OpenAI-compatible server that streams a couple of `reasoning_content`
 * deltas and then holds the connection open and silent — exactly the
 * "partial thinking shown, then dead air" symptom reported — and asserts
 * the runtime now times out on the stall and surfaces a clear error instead
 * of hanging. `LAKSHX_STREAM_IDLE_MS` is set low so this resolves in well
 * under a second instead of the real 45s default.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { PRESETS } from "../src/config.js";
import { FakeOpenAI, reasoningDelta } from "./helpers/fake-openai.js";

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(agentDir, "node_modules", ".bin", "tsx");
const serverPath = join(agentDir, "src", "server.ts");

test("stalled-but-open SSE stream times out and surfaces an error instead of hanging forever", { timeout: 30_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();

  const home = await mkdtemp(join(tmpdir(), "lakshx-idle-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-idle-ws-"));
  await mkdir(join(home, ".lakshx"), { recursive: true });
  await writeFile(
    join(home, ".lakshx", "providers.json"),
    JSON.stringify({
      defaultModel: "fake/test-model",
      providers: {
        fake: { kind: "openai", baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: "test-key-123" },
      },
    }),
  );

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    // fires the idle-stall detector almost immediately instead of waiting
    // out the real 45s production default
    LAKSHX_STREAM_IDLE_MS: "400",
  };
  for (const preset of Object.values(PRESETS)) delete env[preset.envKey];
  delete env.LAKSHX_ENABLE_OLLAMA;

  const child = spawn(tsxBin, [serverPath], {
    cwd: workspace,
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let childStderr = "";
  child.stderr!.on("data", (d) => (childStderr += d));

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!),
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );

  try {
    await acp
      .client({ name: "lakshx-idle-timeout-test" })
      .onRequest(acp.methods.client.session.requestPermission, async () => ({
        outcome: { outcome: "selected", optionId: "allow" },
      }))
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });

        return ctx.buildSession(workspace).withSession(async (session: any) => {
          // model starts reasoning, then the connection goes silent forever
          // (no [DONE], no res.end()) — this is the exact failure mode
          fake.enqueueStall([reasoningDelta("Let me think about"), reasoningDelta(" this carefully...")]);

          const start = Date.now();
          const done = session.prompt("hello");

          const thoughts: string[] = [];
          let stopMsg: any;
          for (;;) {
            const msg = await session.nextUpdate();
            if (msg.kind === "stop") {
              stopMsg = msg;
              break;
            }
            const u: any = msg.update;
            if (u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text") {
              thoughts.push(u.content.text);
            }
          }
          const elapsedMs = Date.now() - start;
          const response = await done;

          // the partial thinking WAS streamed before the stall (matches the
          // reported symptom: user sees thinking start, then silence)
          assert.equal(thoughts.join(""), "Let me think about this carefully...");

          // the turn must resolve (not hang) — well under the 30s test
          // timeout, and specifically bounded by the idle timeout we set,
          // not by some unrelated much-longer ceiling
          assert.ok(
            elapsedMs < 10_000,
            `expected the stall to be detected quickly, took ${elapsedMs}ms`,
          );

          // a genuine idle-timeout is not a user cancellation — it must
          // surface as a real, user-visible error, not be silently
          // classified as "cancelled" or "end_turn" with no explanation
          assert.equal(response.stopReason, "refusal");
          assert.equal(stopMsg.response.stopReason, "refusal");
        });
      });
  } finally {
    child.kill();
    // the fake server's stalled connection is never closed by the script
    // itself (that's the whole point) — without this, its still-listening
    // http.Server keeps the event loop alive and the test process hangs
    // forever after the assertions pass.
    await fake.stop();
  }
});
