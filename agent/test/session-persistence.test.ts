/**
 * Session persistence + resume: a chat reopened after the runtime process
 * restarts should come back with real agent memory (session.history), not
 * just a rendered view. We simulate a restart by killing the server
 * subprocess and spawning a fresh one against the same HOME.
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
import { FakeOpenAI, textTurn, toolTurn } from "./helpers/fake-openai.js";

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(agentDir, "node_modules", ".bin", "tsx");
const serverPath = join(agentDir, "src", "server.ts");

async function runTurn(session: any, text: string) {
  const done = session.prompt(text);
  const updates: any[] = [];
  for (;;) {
    const msg = await session.nextUpdate();
    if (msg.kind === "stop") return { updates, response: await done };
    updates.push(msg.update);
  }
}

function spawnServer(home: string, workspace: string) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  return spawn(tsxBin, [serverPath], { cwd: workspace, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
}

test("session survives a runtime restart and resumes with real history", { timeout: 120_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();

  const home = await mkdtemp(join(tmpdir(), "koder-persist-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "koder-persist-ws-"));
  await mkdir(join(home, ".koder"), { recursive: true });
  await writeFile(
    join(home, ".koder", "providers.json"),
    JSON.stringify({
      defaultModel: "fake/test-model",
      providers: { fake: { kind: "openai", baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: "test-key-123" } },
    }),
  );

  let sessionId = "";

  try {
    // --- process 1: create a session, run a turn with a tool call, then die ---
    const child1 = spawnServer(home, workspace);
    const stream1 = acp.ndJsonStream(Writable.toWeb(child1.stdin!), Readable.toWeb(child1.stdout!) as ReadableStream<Uint8Array>);

    await acp
      .client({ name: "koder-persist-test" })
      .onRequest(acp.methods.client.session.requestPermission, async () => ({
        outcome: { outcome: "selected", optionId: "allow" },
      }))
      .connectWith(stream1, async (ctx) => {
        const init = await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        assert.equal(init.agentCapabilities?.loadSession, true, "runtime must advertise loadSession support");

        await ctx.buildSession(workspace).withSession(async (session: any) => {
          sessionId = session.sessionId;
          await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: "auto" });

          fake.enqueue(toolTurn("call_p1", "bash", { command: "echo restart-me" }), textTurn("Done, echoed restart-me."));
          const r = await runTurn(session, "echo something memorable: restart-me");
          assert.equal(r.response.stopReason, "end_turn");
        });
      });

    // saveSessionSoon debounces 300ms — give it time to flush before we kill the process
    await new Promise((r) => setTimeout(r, 700));
    child1.kill();
    await new Promise((r) => setTimeout(r, 200));

    // --- process 2: fresh runtime, same HOME — resume the session ---
    const child2 = spawnServer(home, workspace);
    const stream2 = acp.ndJsonStream(Writable.toWeb(child2.stdin!), Readable.toWeb(child2.stdout!) as ReadableStream<Uint8Array>);

    const replayedText: string[] = [];
    let replayedToolCall = false;

    try {
      await acp
        .client({ name: "koder-persist-test-2" })
        .onRequest(acp.methods.client.session.requestPermission, async () => ({
          outcome: { outcome: "selected", optionId: "allow" },
        }))
        .onNotification(acp.methods.client.session.update, (v: unknown) => v as any, async (ctx) => {
          const u = ctx.params.update;
          if (u.sessionUpdate === "agent_message_chunk") replayedText.push(u.content.text);
          if (u.sessionUpdate === "tool_call") replayedToolCall = true;
        })
        .connectWith(stream2, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

          const loaded = await ctx.request<{ modes: { currentModeId: string } }>("session/load", {
            sessionId,
            cwd: workspace,
            mcpServers: [],
          });
          assert.equal(loaded.modes.currentModeId, "auto", "resumed session keeps its prior mode");
          assert.ok(replayedText.some((t) => t.includes("restart-me")), "replay must surface prior assistant text");
          assert.ok(replayedToolCall, "replay must surface the prior tool call");

          // the real proof: the NEXT request sent to the provider must carry
          // the restored history, not just the new message. session/load
          // already registered the sessionId server-side, so we drive it
          // directly via session/prompt (buildSession would mint a new one).
          fake.enqueue(textTurn("I remember."));
          const promptResult = await ctx.request<{ stopReason: string }>(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "what did I just ask you to echo?" }],
          });
          assert.equal(promptResult.stopReason, "end_turn");

          const lastReq = fake.requests.at(-1)!;
          assert.ok(lastReq.messages.length > 2, "restored history must be sent, not just the new prompt");
          const serialized = JSON.stringify(lastReq.messages);
          assert.match(serialized, /restart-me/, "the prior turn's content survived the restart");
        });
    } finally {
      child2.kill();
    }

    // --- unknown session id falls back cleanly (client's job to call session/new) ---
    const child3 = spawnServer(home, workspace);
    const stream3 = acp.ndJsonStream(Writable.toWeb(child3.stdin!), Readable.toWeb(child3.stdout!) as ReadableStream<Uint8Array>);
    try {
      await acp.client({ name: "koder-persist-test-3" }).connectWith(stream3, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        // the SDK wraps thrown handler errors generically ("Internal error")
        // rather than propagating our message — what matters is that it
        // rejects at all, so the client knows to fall back to session/new
        await assert.rejects(ctx.request("session/load", { sessionId: "does-not-exist", cwd: workspace, mcpServers: [] }));
      });
    } finally {
      child3.kill();
    }
  } finally {
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
