/**
 * End-to-end tests for prompt-ID checkpoints + undo
 * (docs/research/11-prompt-checkpoints-undo.md), driven the same way
 * `server-e2e.test.ts` and `session-persistence.test.ts` already do: spawn
 * the real `src/server.ts` over ACP, script a fake provider, assert on real
 * filesystem + real shadow-git state — not just the pure functions in
 * isolation. This mechanism has real data-loss risk if wrong, so per doc 11
 * §9 the E2E scenarios matter more than unit coverage of the git plumbing.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as acp from "@agentclientprotocol/sdk";
import { FakeOpenAI, textTurn, toolTurn } from "./helpers/fake-openai.js";

const execFileAsync = promisify(execFile);
const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(agentDir, "node_modules", ".bin", "tsx");
const serverPath = join(agentDir, "src", "server.ts");

/** Same hash/location scheme as `checkpoint.ts`'s `shadowPaths()`, recomputed against a fake HOME. */
function shadowGitDirFor(fakeHome: string, worktree: string): string {
  const hash = createHash("sha256").update(resolve(worktree)).digest("hex").slice(0, 16);
  return join(fakeHome, ".lakshx", "checkpoints", hash, "shadow.git");
}

async function shadowGit(fakeHome: string, worktree: string, args: string[]): Promise<string> {
  const gitDir = shadowGitDirFor(fakeHome, worktree);
  const { stdout } = await execFileAsync("git", [`--git-dir=${gitDir}`, `--work-tree=${worktree}`, ...args], { cwd: worktree });
  return stdout;
}

function spawnServer(home: string, workspace: string) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  return spawn(tsxBin, [serverPath], { cwd: workspace, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
}

async function setupHome(fake: FakeOpenAI): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lakshx-cp-home-"));
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

test("prompt checkpoints + undo — round trip, per-file isolation, overlap, conflict", { timeout: 120_000 }, async (t) => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-cp-ws-"));

  // doc 11 §9 item 8: this workspace has no .git at all — the shadow-git
  // mechanism must not depend on the workspace having its own version control.
  assert.ok(!existsSync(join(workspace, ".git")), "sanity: workspace has no real .git");

  const child = spawnServer(home, workspace);
  let childStderr = "";
  child.stderr!.on("data", (d) => (childStderr += d));
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);

  const checkpoints: any[] = [];

  try {
    await acp
      .client({ name: "lakshx-checkpoint-test" })
      .onRequest(acp.methods.client.session.requestPermission, async () => ({
        outcome: { outcome: "selected", optionId: "allow" },
      }))
      .onNotification("lakshx/checkpoint", (v: unknown) => v as any, async (ctx) => void checkpoints.push(ctx.params))
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

        await t.test("round trip: baseline + per-tool commits, undo_prompt reverts everything, second undo is a safe no-op", () =>
          ctx.buildSession(workspace).withSession(async (session: any) => {
            const sessionId = session.sessionId;
            await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: "auto" });

            await writeFile(join(workspace, "a.txt"), "orig-a");
            await writeFile(join(workspace, "b.txt"), "orig-b");

            fake.enqueue(
              toolTurn("call_a", "write_file", { path: "a.txt", content: "new-a" }),
              toolTurn("call_b", "write_file", { path: "b.txt", content: "new-b" }),
              textTurn("Updated both files."),
            );
            const before = checkpoints.length;
            const res = await ctx.request<{ stopReason: string }>(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "update a.txt and b.txt" }],
              _meta: { promptId: "pr_round1" },
            });
            assert.equal(res.stopReason, "end_turn");

            await new Promise((r) => setTimeout(r, 50)); // let debounced notifies land
            const mine = checkpoints.slice(before);
            assert.equal(mine.length, 2, "one lakshx/checkpoint notification per mutating tool call");
            assert.ok(mine.every((c) => c.promptId === "pr_round1"));
            assert.ok(mine.every((c) => typeof c.sha === "string" && c.sha.length > 0));
            assert.deepEqual(mine.map((c) => c.files).flat().sort(), ["a.txt", "b.txt"]);

            assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "new-a");
            assert.equal(await readFile(join(workspace, "b.txt"), "utf8"), "new-b");

            // "open diff": the pre-turn content the client would hand to
            // `vscode.diff` against the live file — must reflect the
            // baseline (before this prompt ran), not the current on-disk content.
            const beforeContent = await ctx.request<{ content: string | null }>("lakshx/checkpoint_file_before", {
              sessionId,
              promptId: "pr_round1",
              path: "a.txt",
            });
            assert.equal(beforeContent.content, "orig-a");

            const undo1 = await ctx.request<any>("lakshx/undo_prompt", { sessionId, promptId: "pr_round1" });
            assert.equal(undo1.ok, true);
            assert.deepEqual([...undo1.reverted].sort(), ["a.txt", "b.txt"]);
            assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "orig-a");
            assert.equal(await readFile(join(workspace, "b.txt"), "utf8"), "orig-b");

            // idempotency: undoing the same prompt again is a safe no-op
            const undo2 = await ctx.request<any>("lakshx/undo_prompt", { sessionId, promptId: "pr_round1" });
            assert.equal(undo2.ok, true);
            assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "orig-a");
            assert.equal(await readFile(join(workspace, "b.txt"), "utf8"), "orig-b");
          }),
        );

        await t.test("per-file undo does not touch other files touched by the same prompt", () =>
          ctx.buildSession(workspace).withSession(async (session: any) => {
            const sessionId = session.sessionId;
            await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: "auto" });
            await writeFile(join(workspace, "c.txt"), "orig-c");
            await writeFile(join(workspace, "d.txt"), "orig-d");

            fake.enqueue(
              toolTurn("call_c", "write_file", { path: "c.txt", content: "new-c" }),
              toolTurn("call_d", "write_file", { path: "d.txt", content: "new-d" }),
              textTurn("Updated c and d."),
            );
            await ctx.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "update c.txt and d.txt" }],
              _meta: { promptId: "pr_perfile" },
            });

            const res = await ctx.request<any>("lakshx/undo_file", { sessionId, path: "c.txt" });
            assert.equal(res.ok, true);
            assert.equal(await readFile(join(workspace, "c.txt"), "utf8"), "orig-c", "c.txt reverted");
            assert.equal(await readFile(join(workspace, "d.txt"), "utf8"), "new-d", "d.txt must be untouched");
          }),
        );

        await t.test("cross-prompt overlap: undoing an earlier prompt warns if a later prompt also touched the file", () =>
          ctx.buildSession(workspace).withSession(async (session: any) => {
            const sessionId = session.sessionId;
            await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: "auto" });
            await writeFile(join(workspace, "e.txt"), "orig-e");

            fake.enqueue(toolTurn("call_e1", "write_file", { path: "e.txt", content: "e-from-prompt1" }), textTurn("Wrote e."));
            await ctx.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "write e.txt v1" }],
              _meta: { promptId: "pr_ov1" },
            });

            fake.enqueue(toolTurn("call_e2", "write_file", { path: "e.txt", content: "e-from-prompt2" }), textTurn("Wrote e again."));
            await ctx.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "write e.txt v2" }],
              _meta: { promptId: "pr_ov2" },
            });

            const warned = await ctx.request<any>("lakshx/undo_prompt", { sessionId, promptId: "pr_ov1" });
            assert.equal(warned.ok, false);
            assert.ok(warned.overlap, "expected an overlap warning, not a plain failure");
            assert.ok(warned.overlap["e.txt"]?.includes("pr_ov2"));
            assert.equal(await readFile(join(workspace, "e.txt"), "utf8"), "e-from-prompt2", "no change without force");

            const forced = await ctx.request<any>("lakshx/undo_prompt", { sessionId, promptId: "pr_ov1", force: true });
            assert.equal(forced.ok, true);
            assert.equal(await readFile(join(workspace, "e.txt"), "utf8"), "orig-e", "force reverts to pr_ov1's baseline");
          }),
        );

        await t.test("manual-edit conflict: undo refuses (and does not touch the file) unless forced", () =>
          ctx.buildSession(workspace).withSession(async (session: any) => {
            const sessionId = session.sessionId;
            await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: "auto" });
            await writeFile(join(workspace, "f.txt"), "orig-f");

            fake.enqueue(toolTurn("call_f", "write_file", { path: "f.txt", content: "agent-f" }), textTurn("Wrote f."));
            await ctx.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "write f.txt" }],
              _meta: { promptId: "pr_conflict" },
            });

            // simulate the user hand-editing the file in the IDE after the agent's last touch
            await writeFile(join(workspace, "f.txt"), "user-edited-f");

            const blocked = await ctx.request<any>("lakshx/undo_file", { sessionId, path: "f.txt" });
            assert.equal(blocked.ok, false);
            assert.deepEqual(blocked.conflict?.paths, ["f.txt"]);
            assert.equal(await readFile(join(workspace, "f.txt"), "utf8"), "user-edited-f", "must not touch the file without force");

            const forced = await ctx.request<any>("lakshx/undo_file", { sessionId, path: "f.txt", force: true });
            assert.equal(forced.ok, true);
            assert.equal(await readFile(join(workspace, "f.txt"), "utf8"), "orig-f");
          }),
        );

        await t.test("shadow repo self-describes via commit messages (defense in depth per doc 11 §2.4)", async () => {
          const log = await shadowGit(home, workspace, ["log", "--grep=pr_round1", "--format=%s"]);
          assert.match(log, /baseline:pr_round1/);
          assert.match(log, /tool:pr_round1:call_a:write_file/);
          assert.match(log, /tool:pr_round1:call_b:write_file/);
        });
      });
  } finally {
    child.kill();
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    if (process.exitCode && childStderr) console.error("--- server stderr ---\n" + childStderr);
  }
});

test("royal mode: tool calls also fire lakshx/checkpoint (files-changed UI parity with non-royal modes)", { timeout: 60_000 }, async (t) => {
  // Confirmed root cause: loop.ts's royal branch only ever called
  // checkpointBeforeMutation (its own passive audit checkpoint), never
  // cb.onCheckpoint — so a genuine on-disk edit made in Royal mode never
  // produced a "Files changed" card or an undo button in either UI surface,
  // even though the shadow-git commit and audit-log entry were both there.
  // This test drives a real write_file call in royal mode and asserts the
  // same `lakshx/checkpoint` notification (and, downstream, a working
  // `lakshx/undo_file` round trip) that auto/approve modes already produce.
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-cp-royal-ws-"));

  const child = spawnServer(home, workspace);
  let childStderr = "";
  child.stderr!.on("data", (d) => (childStderr += d));
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);

  const checkpoints: any[] = [];

  try {
    await acp
      .client({ name: "lakshx-checkpoint-royal-test" })
      .onRequest(acp.methods.client.session.requestPermission, async () => ({
        outcome: { outcome: "selected", optionId: "allow" },
      }))
      .onNotification("lakshx/checkpoint", (v: unknown) => v as any, async (ctx) => void checkpoints.push(ctx.params))
      .connectWith(stream, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

        await t.test("royal mode write_file fires lakshx/checkpoint with a real sha and the touched file", () =>
          ctx.buildSession(workspace).withSession(async (session: any) => {
            const sessionId = session.sessionId;
            await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: "royal" });

            await writeFile(join(workspace, "royal-seed.txt"), "seed");

            fake.enqueue(
              toolTurn("call_royal_wf", "write_file", { path: "royal.txt", content: "hello-royal-checkpoint" }),
              textTurn("Wrote it."),
            );
            const before = checkpoints.length;
            const res = await ctx.request<{ stopReason: string }>(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "create royal.txt" }],
              _meta: { promptId: "pr_royal1" },
            });
            assert.equal(res.stopReason, "end_turn");

            await new Promise((r) => setTimeout(r, 50)); // let debounced notifies land
            const mine = checkpoints.slice(before);
            assert.equal(mine.length, 1, "royal mode must fire lakshx/checkpoint just like non-royal modes");
            assert.equal(mine[0].promptId, "pr_royal1");
            assert.equal(mine[0].toolName, "write_file");
            assert.ok(typeof mine[0].sha === "string" && mine[0].sha.length > 0);
            assert.deepEqual(mine[0].files, ["royal.txt"]);

            // and the resulting checkpoint record is actually undoable —
            // same UI-facing data non-royal tool calls produce, not just a
            // notification with no real effect behind it
            assert.equal(await readFile(join(workspace, "royal.txt"), "utf8"), "hello-royal-checkpoint");
            const undo = await ctx.request<any>("lakshx/undo_file", { sessionId, path: "royal.txt" });
            assert.equal(undo.ok, true);
            assert.deepEqual(undo.reverted, ["royal.txt"]);
            // royal.txt never existed before this prompt — "undo" a brand-new
            // file means delete it, not error out on a pathspec absent from
            // the target tree
            assert.equal(existsSync(join(workspace, "royal.txt")), false);
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

test("crash mid-checkpoint: killing the server during a mutating tool call never corrupts the shadow repo or blocks the next operation", { timeout: 60_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-cp-crash-ws-"));

  try {
    // --- process 1: start a turn with a slow bash tool call, kill mid-flight ---
    const child1 = spawnServer(home, workspace);
    const stream1 = acp.ndJsonStream(Writable.toWeb(child1.stdin!), Readable.toWeb(child1.stdout!) as ReadableStream<Uint8Array>);

    // NOTE: must NOT await the whole connectWith call before killing — its
    // callback keeps the connection open only until the callback's promise
    // settles, and a fire-and-forget request issued right before the
    // callback returns races the connection teardown (observed: the request
    // never actually reached the server in time). Instead the callback stays
    // "busy" (via a long timeout, cut short by killing the child) so the
    // connection — and the in-flight prompt — are genuinely still alive
    // during the kill window below.
    const connectPromise = acp
      .client({ name: "lakshx-crash-test-1" })
      .onRequest(acp.methods.client.session.requestPermission, async () => ({
        outcome: { outcome: "selected", optionId: "allow" },
      }))
      .connectWith(stream1, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        await ctx.buildSession(workspace).withSession(async (session: any) => {
          await ctx.request(acp.methods.agent.session.setMode, { sessionId: session.sessionId, modeId: "auto" });

          // sleep long enough that the tool call (and its checkpoint commits,
          // baseline before + tool-commit after) is still in flight when we
          // kill -9 the process — this is the crash window doc 11 §9 item 3
          // targets: a checkpoint operation interrupted mid-flight.
          fake.enqueue(toolTurn("call_slow", "bash", { command: "sleep 2 && echo done > crash-marker.txt" }), textTurn("done"));

          // fire-and-forget: this request will never resolve because we kill
          // the child before the server can reply
          void ctx
            .request(acp.methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "run the slow command" }],
              _meta: { promptId: "pr_crash" },
            })
            .catch(() => {});

          // keep the connection (and thus the in-flight request) alive until
          // the outer scope kills the child process
          await new Promise((r) => setTimeout(r, 5000));
        });
      })
      .catch(() => {}); // the connection itself dies with the child — expected

    // give the baseline commit (which runs synchronously before the sleep)
    // time to actually land, then kill mid-sleep — squarely inside the
    // "baseline exists, tool commit does not yet" crash window
    await new Promise((r) => setTimeout(r, 600));
    child1.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    await connectPromise; // settles quickly once the child (and stream) are gone

    // --- assert the shadow repo survived: still a valid, parseable git repo ---
    const gitDir = shadowGitDirFor(home, workspace);
    assert.ok(existsSync(gitDir), "shadow repo must exist (the baseline commit ran before the kill)");
    await execFileAsync("git", [`--git-dir=${gitDir}`, "fsck", "--no-progress"]); // throws if corrupt
    await execFileAsync("git", [`--git-dir=${gitDir}`, "log", "-1"]); // throws if unparseable/no valid HEAD

    // (Not asserting on crash-marker.txt's absence: SIGKILL-ing the server
    // process does not kill its already-spawned bash grandchild — POSIX does
    // not propagate a signal to orphaned children — so "sleep 2 && echo ...
    // > crash-marker.txt" can still complete on its own after the parent
    // dies. That's a real, separate property of how `bash` tool calls are
    // spawned, not something this checkpoint-crash-safety test is about; the
    // properties that actually matter are asserted above/below: the shadow
    // repo survives uncorrupted, and a fresh server can still checkpoint/undo
    // normally afterward.)

    // --- process 2: fresh runtime, same HOME/workspace — must not hang on a stale lock ---
    const child2 = spawnServer(home, workspace);
    const stream2 = acp.ndJsonStream(Writable.toWeb(child2.stdin!), Readable.toWeb(child2.stdout!) as ReadableStream<Uint8Array>);
    try {
      await acp
        .client({ name: "lakshx-crash-test-2" })
        .onRequest(acp.methods.client.session.requestPermission, async () => ({
          outcome: { outcome: "selected", optionId: "allow" },
        }))
        .connectWith(stream2, async (ctx) => {
          await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
          await ctx.buildSession(workspace).withSession(async (session: any) => {
            const sessionId = session.sessionId;
            await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: "auto" });
            await writeFile(join(workspace, "post-crash.txt"), "orig-post-crash");

            fake.enqueue(toolTurn("call_pc", "write_file", { path: "post-crash.txt", content: "written-after-crash" }), textTurn("ok"));
            const start = Date.now();
            const res = await ctx.request<{ stopReason: string }>(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: "text", text: "write post-crash.txt" }],
              _meta: { promptId: "pr_after_crash" },
            });
            const elapsed = Date.now() - start;
            assert.equal(res.stopReason, "end_turn");
            // a dead pid's stale lock is detected and stolen immediately (no
            // reason to wait out the ~2s contention backoff) — a generous
            // bound here still proves we did not hang on a dangling lock
            assert.ok(elapsed < 10_000, `checkpoint operation after a crash must not hang on a stale lock (took ${elapsed}ms)`);

            assert.equal(await readFile(join(workspace, "post-crash.txt"), "utf8"), "written-after-crash");
            const undo = await ctx.request<any>("lakshx/undo_prompt", { sessionId, promptId: "pr_after_crash" });
            assert.equal(undo.ok, true, "the shadow repo must still be fully functional for new checkpoints/undo after the crash");
            assert.equal(await readFile(join(workspace, "post-crash.txt"), "utf8"), "orig-post-crash");
          });
        });
    } finally {
      child2.kill();
    }
  } finally {
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
