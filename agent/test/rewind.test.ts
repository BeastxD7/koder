/**
 * Conversation rewind (`lakshx/rewind_to_prompt`) e2e tests — the real spawned
 * server over ACP against the scripted provider, same harness shape as
 * session-persistence.test.ts.
 *
 * What must hold (the feature's contract):
 *  1. Multi-prompt rewind: rewinding to prompt #1 of 3 reverts the UNION of
 *     files touched by #1..#3 (overlapping + distinct) back to #1's baseline,
 *     truncates session.history to just BEFORE #1's user message, and drops
 *     all three checkpoints — WITHOUT flagging the later prompts as conflicts
 *     (the laterOverlap misfire this request exists to avoid).
 *  2. A genuinely EXTERNAL disk edit (matches neither the rewind target nor
 *     the checkpoint mechanism's own last write) still refuses without force.
 *  3. A running turn refuses the rewind outright.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { FakeOpenAI, reasoningDelta, textTurn, toolTurn } from "./helpers/fake-openai.js";

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(agentDir, "node_modules", ".bin", "tsx");
const serverPath = join(agentDir, "src", "server.ts");

async function waitFor(pred: () => boolean, what: string, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Drive a full prompt with an explicit client-minted promptId (the `_meta` bag LakshX's own extension uses — see server.ts). */
async function promptWithId(ctx: any, sessionId: string, promptId: string, text: string) {
  return ctx.request(acp.methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text }],
    _meta: { promptId },
  });
}

async function newAutoSession(ctx: any, workspace: string): Promise<string> {
  const s = await ctx.request<{ sessionId: string }>("session/new", { cwd: workspace, mcpServers: [] });
  await ctx.request(acp.methods.agent.session.setMode, { sessionId: s.sessionId, modeId: "auto" });
  return s.sessionId;
}

test("lakshx/rewind_to_prompt: multi-prompt revert + truncate, external-edit conflict, running-turn refusal", { timeout: 120_000 }, async (t) => {
  const fake = new FakeOpenAI();
  await fake.start();

  const home = await mkdtemp(join(tmpdir(), "lakshx-rewind-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-rewind-ws-"));
  await mkdir(join(home, ".lakshx"), { recursive: true });
  await writeFile(
    join(home, ".lakshx", "providers.json"),
    JSON.stringify({
      defaultModel: "fake/test-model",
      providers: { fake: { kind: "openai", baseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: "test-key-123" } },
    }),
  );
  await writeFile(join(workspace, "a.txt"), "base\n");

  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  const child = spawn(tsxBin, [serverPath], { cwd: workspace, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
  let childStderr = "";
  child.stderr!.on("data", (d) => (childStderr += d));
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);

  try {
    await acp
      .client({ name: "lakshx-rewind-test" })
      .onRequest(acp.methods.client.session.requestPermission, async () => ({
        outcome: { outcome: "selected", optionId: "allow" },
      }))
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

        await t.test("rewind to prompt #1 of 3 reverts the union of files and truncates history + checkpoints", async () => {
          const sessionId = await newAutoSession(ctx, workspace);

          // Prompt 1 (pr_1): a.txt base→one (overlap file), c.txt created.
          fake.enqueue(
            toolTurn("c_1a", "write_file", { path: "a.txt", content: "one\n" }),
            toolTurn("c_1c", "write_file", { path: "c.txt", content: "c1\n" }),
            textTurn("done one"),
          );
          assert.equal((await promptWithId(ctx, sessionId, "pr_1", "change one")).stopReason, "end_turn");

          // Prompt 2 (pr_2): a.txt one→two (SAME file again), b.txt created.
          fake.enqueue(
            toolTurn("c_2a", "write_file", { path: "a.txt", content: "two\n" }),
            toolTurn("c_2b", "write_file", { path: "b.txt", content: "b2\n" }),
            textTurn("done two"),
          );
          assert.equal((await promptWithId(ctx, sessionId, "pr_2", "change two")).stopReason, "end_turn");

          // Prompt 3 (pr_3): d.txt created (fully distinct).
          fake.enqueue(toolTurn("c_3d", "write_file", { path: "d.txt", content: "d3\n" }), textTurn("done three"));
          assert.equal((await promptWithId(ctx, sessionId, "pr_3", "change three")).stopReason, "end_turn");

          assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "two\n");
          assert.ok(existsSync(join(workspace, "b.txt")) && existsSync(join(workspace, "c.txt")) && existsSync(join(workspace, "d.txt")));

          // The coordinated rewind: later prompts touching pr_1's files must
          // NOT surface as conflicts (they're being reverted together) — no
          // force needed despite the a.txt overlap between pr_1 and pr_2.
          const res = await ctx.request<any>("lakshx/rewind_to_prompt", { sessionId, promptId: "pr_1" });
          assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res)}`);
          assert.deepEqual([...res.revertedFiles].sort(), ["a.txt", "b.txt", "c.txt", "d.txt"]);
          // 3 prompts × (user + assistant/tool round-trips): everything goes.
          assert.ok(res.truncatedMessages >= 3, `expected the whole history truncated, got ${res.truncatedMessages}`);

          // Final on-disk state = exactly the pre-pr_1 workspace.
          assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "base\n");
          assert.ok(!existsSync(join(workspace, "b.txt")), "b.txt (created by pr_2) must be gone");
          assert.ok(!existsSync(join(workspace, "c.txt")), "c.txt (created by pr_1) must be gone");
          assert.ok(!existsSync(join(workspace, "d.txt")), "d.txt (created by pr_3) must be gone");

          // Persisted session mirrors the truncation (history/checkpoints/markers all empty).
          await new Promise((r) => setTimeout(r, 700)); // saveSessionSoon debounce
          const stored = JSON.parse(await readFile(join(home, ".lakshx", "sessions", `${sessionId}.json`), "utf8"));
          assert.equal(stored.history.length, 0, "persisted history must be truncated to before pr_1's user message");
          assert.deepEqual(stored.checkpoints, [], "all three prompts' checkpoints must be dropped");
          assert.deepEqual(stored.prompts, [], "all rewound prompt markers must be dropped");

          // The agent's REAL history is truncated too: the next provider call
          // must carry only the new prompt, none of the rewound turns.
          fake.enqueue(textTurn("fresh reply"));
          assert.equal((await promptWithId(ctx, sessionId, "pr_4", "fresh start")).stopReason, "end_turn");
          const lastReq = fake.requests.at(-1)!;
          assert.equal(lastReq.messages.filter((m) => m.role === "user").length, 1, "only the new user message survives");
          const serialized = JSON.stringify(lastReq.messages);
          assert.doesNotMatch(serialized, /change one|change two|change three|done one|done two/);
        });

        await t.test("external manual edit still conflicts (needs force); force reverts it", async () => {
          await writeFile(join(workspace, "e.txt"), "e-base\n");
          const sessionId = await newAutoSession(ctx, workspace);

          fake.enqueue(toolTurn("c_e1", "write_file", { path: "e.txt", content: "e1\n" }), textTurn("edited e once"));
          assert.equal((await promptWithId(ctx, sessionId, "pr_e1", "edit e first")).stopReason, "end_turn");
          fake.enqueue(toolTurn("c_e2", "write_file", { path: "e.txt", content: "e2\n" }), textTurn("edited e twice"));
          assert.equal((await promptWithId(ctx, sessionId, "pr_e2", "edit e second")).stopReason, "end_turn");

          // A genuinely external edit: disk now matches neither the rewind
          // target (e-base) nor the mechanism's own last write (e2).
          await writeFile(join(workspace, "e.txt"), "manual-edit\n");

          const refused = await ctx.request<any>("lakshx/rewind_to_prompt", { sessionId, promptId: "pr_e1" });
          assert.equal(refused.ok, false);
          assert.deepEqual(refused.conflicts, ["e.txt"]);
          assert.equal(await readFile(join(workspace, "e.txt"), "utf8"), "manual-edit\n", "a refused rewind must revert nothing");

          const forced = await ctx.request<any>("lakshx/rewind_to_prompt", { sessionId, promptId: "pr_e1", force: true });
          assert.equal(forced.ok, true);
          assert.deepEqual(forced.revertedFiles, ["e.txt"]);
          assert.equal(await readFile(join(workspace, "e.txt"), "utf8"), "e-base\n");
        });

        await t.test("a running turn refuses the rewind; after cancel it succeeds (checkpoint-free truncation)", async () => {
          const sessionId = await newAutoSession(ctx, workspace);

          fake.enqueue(textTurn("first reply"));
          assert.equal((await promptWithId(ctx, sessionId, "pr_s1", "say hi")).stopReason, "end_turn");

          // A stalled provider stream keeps the second turn genuinely running.
          const requestsBefore = fake.requests.length;
          fake.enqueueStall([reasoningDelta("thinking forever")]);
          const pending = promptWithId(ctx, sessionId, "pr_s2", "hang please");
          await waitFor(() => fake.requests.length > requestsBefore, "the stalled turn to reach the provider");

          await assert.rejects(
            ctx.request("lakshx/rewind_to_prompt", { sessionId, promptId: "pr_s1" }),
            /turn is still running|Internal error/i, // SDK may wrap the handler's message generically
            "rewind must be refused while a turn is running",
          );

          await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
          assert.equal((await pending).stopReason, "cancelled");

          // No mutating tools ran in this session — rewind is a pure
          // conversation truncation (revertedFiles empty), and still works.
          const res = await ctx.request<any>("lakshx/rewind_to_prompt", { sessionId, promptId: "pr_s1" });
          assert.equal(res.ok, true);
          assert.deepEqual(res.revertedFiles, []);
          assert.ok(res.truncatedMessages >= 2, "pr_s1's turn AND the cancelled pr_s2 user message must both go");
        });
      });
  } catch (err) {
    if (childStderr) console.error("server stderr:\n" + childStderr);
    throw err;
  } finally {
    child.kill();
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
