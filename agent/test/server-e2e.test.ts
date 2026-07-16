/**
 * End-to-end tests for the agent loop through the real server.
 *
 * We spawn `src/server.ts` (ACP over stdio) as a subprocess with HOME pointed
 * at a temp directory whose .lakshx/providers.json routes the "fake" provider
 * to a scripted OpenAI-compatible SSE server on localhost. No real API keys.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as acp from "@agentclientprotocol/sdk";
import { PRESETS } from "../src/config.js";
import {
  FakeOpenAI,
  finish,
  reasoningDelta,
  textDelta,
  textTurn,
  toolTurn,
} from "./helpers/fake-openai.js";

const execFileAsync = promisify(execFile);

/**
 * Recompute the shadow-git dir the SAME way `checkpoint.ts`'s `shadowPaths()`
 * does, against the given fake HOME (not this test process's own HOME —
 * the server child runs with HOME overridden, see `env` below).
 */
function shadowGitDirFor(fakeHome: string, worktree: string): string {
  const hash = createHash("sha256").update(resolve(worktree)).digest("hex").slice(0, 16);
  return join(fakeHome, ".lakshx", "checkpoints", hash, "shadow.git");
}

/** Run a shadow-git plumbing command against the checkpoint repo for `worktree`, same explicit --git-dir/--work-tree shape checkpoint.ts uses. */
async function shadowGit(fakeHome: string, worktree: string, args: string[]): Promise<string> {
  const gitDir = shadowGitDirFor(fakeHome, worktree);
  const { stdout } = await execFileAsync("git", [`--git-dir=${gitDir}`, `--work-tree=${worktree}`, ...args], {
    cwd: worktree,
  });
  return stdout;
}

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(agentDir, "node_modules", ".bin", "tsx");
const serverPath = join(agentDir, "src", "server.ts");

type Updates = any[];

async function waitFor(pred: () => boolean, what: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Send a prompt and drain session updates until the turn stops. */
async function runTurn(session: any, text: string): Promise<{ updates: Updates; response: any }> {
  const done = session.prompt(text);
  const updates: Updates = [];
  for (;;) {
    const msg = await session.nextUpdate();
    if (msg.kind === "stop") return { updates, response: await done };
    updates.push(msg.update);
  }
}

const messageText = (updates: Updates) =>
  updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text")
    .map((u) => u.content.text)
    .join("");

const thoughtText = (updates: Updates) =>
  updates
    .filter((u) => u.sessionUpdate === "agent_thought_chunk" && u.content?.type === "text")
    .map((u) => u.content.text)
    .join("");

const lastToolMessage = (fake: FakeOpenAI, toolCallId: string) => {
  const req = fake.requests.at(-1)!;
  return req.messages.find((m) => m.role === "tool" && m.tool_call_id === toolCallId);
};

test("lakshx agent e2e over ACP against a scripted provider", { timeout: 120_000 }, async (t) => {
  const fake = new FakeOpenAI();
  await fake.start();

  const home = await mkdtemp(join(tmpdir(), "lakshx-e2e-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-e2e-ws-"));
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

  // Deterministic child env: fake HOME, no real provider keys leaking in.
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  for (const preset of Object.values(PRESETS)) delete env[preset.envKey];
  delete env.LAKSHX_ENABLE_OLLAMA;

  const child = spawn(tsxBin, [serverPath], {
    cwd: workspace,
    env: env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let childStderr = "";
  child.stderr!.on("data", (d) => (childStderr += d));

  const planReady: Array<{ sessionId: string; path: string }> = [];
  const permissionRequests: any[] = [];
  let permissionAnswer: "allow" | "deny" = "deny";

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!),
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  );

  try {
    await acp
      .client({ name: "lakshx-e2e-test" })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        permissionRequests.push(ctx.params);
        return { outcome: { outcome: "selected", optionId: permissionAnswer } };
      })
      .onNotification(
        "lakshx/plan_ready",
        (v: unknown) => v as { sessionId: string; path: string },
        async (ctx) => void planReady.push(ctx.params),
      )
      .connectWith(stream, async (ctx) => {
        const init = await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        assert.equal(init.protocolVersion, acp.PROTOCOL_VERSION);

        await t.test("lakshx/models reports default model and configured providers", async () => {
          const models = await ctx.request<{ defaultModel: string; providers: string[] }>("lakshx/models", {});
          assert.equal(models.defaultModel, "fake/test-model");
          assert.deepEqual(models.providers, ["fake"]); // only our keyed provider; ollama gated off
        });

        await t.test("review mode: dangerous tool is blocked, plan triggers lakshx/plan_ready", () =>
          ctx.buildSession(workspace).withSession(async (session: any) => {
            // invalid mode ids are ignored — session must stay in review
            await ctx.request(acp.methods.agent.session.setMode, {
              sessionId: session.sessionId,
              modeId: "bogus-mode",
            });

            // Turn A: model tries bash in review mode → hard-blocked, no permission prompt
            fake.enqueue(
              toolTurn("call_rev1", "bash", { command: "rm -rf build" }),
              textTurn("I cannot run commands in review mode."),
            );
            const a = await runTurn(session, "clean the build dir");
            assert.equal(a.response.stopReason, "end_turn");
            assert.equal(permissionRequests.length, 0, "review mode must not ask for permission");

            // request 1 only offered the read-only tools, plus dispatch_subtasks
            // (allowed in review mode since its own children are forced back
            // into review mode too — see loop.ts's dispatchSubtasks), db_query
            // (kind:"read", dangerous:false — its consent gate lives in
            // lakshx-db, so it's usable in review mode; docs/research/13), and
            // the three background-task management tools (check_tasks/
            // send_to_task/wait_for_tasks — non-dangerous observe/steer/join
            // operations on the registry, not workspace mutations).
            const offered = fake.requests.at(-2)!.tools.map((tl) => tl.function.name).sort();
            assert.deepEqual(offered, [
              "check_tasks",
              "db_query",
              "dispatch_subtasks",
              "grep",
              "list_dir",
              "read_file",
              "send_to_task",
              "wait_for_tasks",
            ]);
            // request 2 carries the declined tool result back to the model
            assert.match(lastToolMessage(fake, "call_rev1")!.content, /declined/i);
            // and the client saw the tool call fail
            const upd = a.updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call_rev1");
            assert.equal(upd.status, "failed");
            assert.match(upd.content[0].content.text, /declined/i);
            assert.equal(planReady.length, 0, "no plan_ready without a # Plan heading");

            // Turn B: a "# Plan" reply saves a plan file and notifies lakshx/plan_ready
            fake.enqueue(textTurn("Research done.\n\n# Plan\n1. Touch src/x.ts\n2. Run typecheck\n"));
            const b = await runTurn(session, "plan the feature");
            assert.equal(b.response.stopReason, "end_turn");
            await waitFor(() => planReady.length === 1, "lakshx/plan_ready notification");
            assert.equal(planReady[0].sessionId, session.sessionId);
            assert.ok(planReady[0].path.startsWith(join(workspace, ".lakshx", "plans")));
            assert.match(await readFile(planReady[0].path, "utf8"), /# Plan\n1\. Touch src\/x\.ts/);
            // mode must NOT silently advance — no current_mode_update in either turn
            for (const u of [...a.updates, ...b.updates]) {
              assert.notEqual(u.sessionUpdate, "current_mode_update");
            }
          }),
        );

        await t.test("approve mode: bash asks permission; deny feeds an error result back", () =>
          ctx.buildSession(workspace).withSession(async (session: any) => {
            await ctx.request(acp.methods.agent.session.setMode, {
              sessionId: session.sessionId,
              modeId: "approve",
            });
            permissionAnswer = "deny";
            fake.enqueue(
              toolTurn("call_ap1", "bash", { command: "echo hi" }),
              textTurn("Understood, I will not run it."),
            );
            const { updates, response } = await runTurn(session, "run echo hi");
            assert.equal(response.stopReason, "end_turn");

            assert.equal(permissionRequests.length, 1, "approve mode must request permission");
            const perm = permissionRequests[0];
            assert.equal(perm.sessionId, session.sessionId);
            assert.equal(perm.toolCall.toolCallId, "call_ap1");
            assert.equal(perm.toolCall.title, "$ echo hi");
            assert.deepEqual(perm.options.map((o: any) => o.optionId).sort(), ["allow", "deny"]);

            // the denial reaches the model as a tool message on the next request
            assert.match(lastToolMessage(fake, "call_ap1")!.content, /declined/i);
            const upd = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call_ap1");
            assert.equal(upd.status, "failed");
          }),
        );

        await t.test("auto mode: no permission prompt, tool executes, output reaches the model", (t2) =>
          ctx.buildSession(workspace).withSession(async (session: any) => {
            await ctx.request(acp.methods.agent.session.setMode, {
              sessionId: session.sessionId,
              modeId: "auto",
            });
            const permsBefore = permissionRequests.length;
            fake.enqueue(
              toolTurn("call_auto1", "bash", { command: "echo lakshx-auto-ok" }),
              textTurn("Done."),
            );
            const { updates, response } = await runTurn(session, "run the echo");
            assert.equal(response.stopReason, "end_turn");
            assert.equal(permissionRequests.length, permsBefore, "auto mode must not ask for permission");

            assert.match(lastToolMessage(fake, "call_auto1")!.content, /lakshx-auto-ok/);
            const upd = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call_auto1");
            assert.equal(upd.status, "completed");
            assert.match(upd.content[0].content.text, /lakshx-auto-ok/);
            assert.equal(messageText(updates), "Done.");

            await t2.test("thinking: reasoning_content deltas stream as agent_thought_chunk", async () => {
              fake.enqueue([
                reasoningDelta("Considering the request"),
                reasoningDelta(" carefully."),
                textDelta("Final answer."),
                finish("stop"),
              ]);
              const r = await runTurn(session, "think about it");
              assert.equal(r.response.stopReason, "end_turn");
              assert.equal(thoughtText(r.updates), "Considering the request carefully.");
              assert.equal(messageText(r.updates), "Final answer.");
            });

            await t2.test("lakshx/set_model switches the model used for the session", async () => {
              await ctx.request("lakshx/set_model", { sessionId: session.sessionId, model: "fake/other-model" });
              fake.enqueue(textTurn("switched"));
              await runTurn(session, "hello");
              assert.equal(fake.requests.at(-1)!.model, "other-model");
              assert.equal(fake.authHeaders.at(-1), "Bearer test-key-123");
            });

            await t2.test("lakshx/set_model to an unknown provider surfaces a refusal with the error", async () => {
              await ctx.request("lakshx/set_model", { sessionId: session.sessionId, model: "nope/ghost-model" });
              const r = await runTurn(session, "hello again"); // no scripted turn needed — never reaches provider
              assert.equal(r.response.stopReason, "refusal");
              assert.match(messageText(r.updates), /Unknown provider "nope"/);
            });

            await t2.test("auto mode: destructive-command floor hard-blocks force-push — no permission prompt, no execution", async () => {
              await ctx.request("lakshx/set_model", { sessionId: session.sessionId, model: "fake/test-model" });
              const permsBefore = permissionRequests.length;
              fake.enqueue(
                toolTurn("call_floor1", "bash", { command: "git push --force origin main" }),
                textTurn("Understood, I will not force-push."),
              );
              const { updates, response } = await runTurn(session, "force push my branch");
              assert.equal(response.stopReason, "end_turn");

              // the floor fires before the mode branch — auto mode still asks for
              // no permission, but this time because it's unconditionally blocked,
              // not because it's silently allowed
              assert.equal(permissionRequests.length, permsBefore, "floor block must not go through onPermission");

              // the model sees our deterministic floor message, not real `git`
              // output — proof the command never actually executed
              const toolMsg = lastToolMessage(fake, "call_floor1")!.content;
              assert.match(toolMsg, /Blocked by safety floor/);
              assert.match(toolMsg, /force-push is never allowed/);
              assert.doesNotMatch(toolMsg, /fatal:|Everything up-to-date|remote:/); // would appear if git actually ran

              const upd = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call_floor1");
              assert.equal(upd.status, "failed");
              assert.match(upd.content[0].content.text, /Blocked by safety floor/);
            });
          }),
        );

        await t.test("royal mode: bypasses the floor entirely; keeps a passive checkpoint + audit net", (t3) =>
          ctx.buildSession(workspace).withSession(async (session: any) => {
            await ctx.request(acp.methods.agent.session.setMode, {
              sessionId: session.sessionId,
              modeId: "royal",
            });

            await t3.test("royal mode: force-push is NOT blocked — the inverse of the auto-mode floor test", async () => {
              const permsBefore = permissionRequests.length;
              fake.enqueue(
                toolTurn("call_royal_fp", "bash", { command: "git push --force origin main" }),
                textTurn("Pushed (or tried to)."),
              );
              const { updates, response } = await runTurn(session, "force push my branch");
              assert.equal(response.stopReason, "end_turn");

              // no floor, no permission prompt — same "don't ask" shape as auto,
              // but this time nothing pre-execution-blocked it either
              assert.equal(permissionRequests.length, permsBefore, "royal mode must not ask for permission");

              const toolMsg = lastToolMessage(fake, "call_royal_fp")!.content;
              // the discriminator: NOT the deterministic floor message, and a
              // REAL git error (this workspace has no .git) — proof the
              // command actually reached execution instead of being floored
              assert.doesNotMatch(toolMsg, /Blocked by safety floor/);
              assert.match(toolMsg, /fatal:|not a git repository/i);

              const upd = updates.find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call_royal_fp");
              assert.equal(upd.status, "completed"); // ran (and then failed on its own merits), not denied
            });

            await t3.test("royal mode: checkpoints workspace state BEFORE a mutating tool call runs", async () => {
              await writeFile(join(workspace, "seed.txt"), "seed-content");

              fake.enqueue(
                toolTurn("call_royal_wf", "write_file", { path: "new.txt", content: "hello-royal" }),
                textTurn("Wrote it."),
              );
              const { response } = await runTurn(session, "create new.txt");
              assert.equal(response.stopReason, "end_turn");

              // the real mutation happened on disk...
              assert.equal(await readFile(join(workspace, "new.txt"), "utf8"), "hello-royal");

              // ...but the checkpoint commit taken immediately BEFORE that write
              // captures pre-mutation state: seed.txt is in it, new.txt is not.
              const tree = await shadowGit(home, workspace, ["ls-tree", "-r", "--name-only", "HEAD"]);
              const files = tree.trim().split("\n");
              assert.ok(files.includes("seed.txt"), "checkpoint must include the pre-existing file");
              assert.ok(!files.includes("new.txt"), "checkpoint must NOT include the file the tool was about to create");
              const seedInCheckpoint = await shadowGit(home, workspace, ["show", "HEAD:seed.txt"]);
              assert.equal(seedInCheckpoint, "seed-content");
            });

            await t3.test("royal mode: audit log gets a real entry with the right shape", async () => {
              const now = new Date();
              const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
              const auditPath = join(home, ".lakshx", "royal-audit", `${ym}.jsonl`);
              const lines = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
              const entries = lines.map((l) => JSON.parse(l));

              // the write_file call from the checkpoint test above must have logged
              const entry = entries.find((e) => e.tool === "write_file" && e.input.includes("new.txt"));
              assert.ok(entry, "expected a write_file audit entry mentioning new.txt");
              assert.equal(entry.decision, "allowed");
              assert.equal(entry.cwd, workspace);
              assert.ok(entry.checkpointSha, "audit entry should carry the checkpoint sha taken before this call");
              assert.ok(typeof entry.outputSummary === "string" && entry.outputSummary.length > 0);
              assert.equal(entry.isError, false);
              assert.ok(typeof entry.durationMs === "number");
              assert.ok(!Number.isNaN(Date.parse(entry.ts)), "ts must be a valid timestamp");

              // the force-push from the bypass test above must ALSO be logged —
              // logging is unconditional in royal mode, blocked or not
              const fpEntry = entries.find((e) => e.tool === "bash" && e.input.includes("--force"));
              assert.ok(fpEntry, "expected the force-push bash call to be audited too");
              assert.equal(fpEntry.decision, "allowed"); // allowed by the (absent) floor; failed on its own merits
            });
          }),
        );

        await t.test(
          "client-driven auto-wake: a _meta.wake prompt never aborts a REAL turn already in flight",
          () =>
            ctx.buildSession(workspace).withSession(async (session: any) => {
              await ctx.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: "auto" });

              // The real turn's model response is deliberately held so the turn
              // is still genuinely in-flight (session.pending set server-side)
              // when the wake prompt lands.
              fake.enqueueDelayed(500, toolTurn("call_wake_real", "bash", { command: "echo real-turn-ok" }));
              fake.enqueue(textTurn("Done with the real turn."));

              const realTurnDone = session.prompt("do something slow");
              await new Promise((r) => setTimeout(r, 120)); // let the real turn's request actually land

              // A wake prompt (extension.js's client-driven auto-wake) arrives
              // while the real turn is still running. server.ts must treat this
              // as a no-op — NOT call session.pending?.abort() — since a wake
              // exists only to drain a completed background task's notification
              // into an IDLE session, never to interrupt a real user turn.
              const wakeRes: any = await ctx.request("session/prompt", {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "(wake placeholder)" }],
                _meta: { wake: true },
              });
              assert.equal(wakeRes.stopReason, "end_turn", "a wake prompt with a real turn pending must resolve immediately as a no-op");

              // Drain the real turn's updates and confirm it completed NORMALLY —
              // if the wake had aborted it, this would resolve "cancelled" instead.
              const updates: any[] = [];
              for (;;) {
                const msg = await session.nextUpdate();
                if (msg.kind === "stop") {
                  assert.equal(msg.response.stopReason, "end_turn", "the real turn must not have been aborted by the wake prompt");
                  break;
                }
                updates.push(msg.update);
              }
              await realTurnDone;
              assert.match(messageText(updates), /Done with the real turn/);
            }),
        );

        await t.test(
          "client-driven auto-wake: a _meta.wake prompt is a no-op when nothing is queued for the session",
          () =>
            ctx.buildSession(workspace).withSession(async (session: any) => {
              const requestsBefore = fake.requests.length;
              const wakeRes: any = await ctx.request("session/prompt", {
                sessionId: session.sessionId,
                prompt: [{ type: "text", text: "(wake placeholder)" }],
                _meta: { wake: true },
              });
              assert.equal(wakeRes.stopReason, "end_turn");
              // No request should have reached the provider for a no-op wake —
              // it must short-circuit before ever calling runPrompt.
              assert.equal(fake.requests.length, requestsBefore, "a no-op wake must never reach the model");
            }),
        );
      });
  } finally {
    child.kill();
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    if (process.exitCode && childStderr) console.error("--- server stderr ---\n" + childStderr);
  }
});
