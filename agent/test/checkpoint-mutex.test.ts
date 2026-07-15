/**
 * Unit tests for checkpoint.ts's in-process concurrency lock
 * (`withProcessMutex`, added alongside `dispatch_subtasks` — parallel
 * subagents can now be mid-tool-call in the SAME process, and the
 * pre-existing `withLock` disk lock alone is not enough: see its doc
 * comment for why). Two layers of coverage, per the task:
 *  1. A focused, deterministic test on the mutex PRIMITIVE itself — proves
 *     mutual exclusion directly (max one concurrent runner), independent of
 *     git or timing assumptions.
 *  2. A real test against `commitAfterTool` — N concurrent callers hitting
 *     the SAME shadow git repo — proving the actual mechanism this was
 *     built to protect doesn't lose or corrupt commits under real
 *     concurrent use, not just that the primitive is correct in isolation.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  _resetGuardCacheForTests,
  _withProcessMutexForTests,
  checkpointBaseline,
  commitAfterTool,
  shadowGitDirFor,
} from "../src/checkpoint.js";

const execFileAsync = promisify(execFile);

test("_withProcessMutexForTests: serializes concurrent callers — at most one runs at a time", async () => {
  let running = 0;
  let maxRunning = 0;
  const order: number[] = [];
  const N = 25;

  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      _withProcessMutexForTests(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        // yield the event loop briefly so a broken (non-serializing) mutex
        // would have a real window to let another caller's `running++` land
        // while this one is still "inside" — a synchronous body alone
        // wouldn't reliably expose a race.
        await new Promise((r) => setTimeout(r, 2));
        running--;
        order.push(i);
      }),
    ),
  );

  assert.equal(maxRunning, 1, "no two callers were ever inside the mutex at the same time");
  assert.equal(order.length, N, "every queued caller eventually ran — the mutex never drops work");
  // FIFO: callers should complete in the order they queued, since each one
  // is a simple fixed-delay body queued synchronously before the next.
  assert.deepEqual(order, Array.from({ length: N }, (_, i) => i));
});

test("_withProcessMutexForTests: a throwing caller doesn't wedge the queue for later callers", async () => {
  const results = await Promise.allSettled([
    _withProcessMutexForTests(async () => {
      throw new Error("boom");
    }),
    _withProcessMutexForTests(async () => "after-the-throw"),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal((results[1] as PromiseFulfilledResult<string>).value, "after-the-throw");
});

test("commitAfterTool: N concurrent calls against the SAME shadow repo all land as distinct commits — no lost/corrupted commits", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "koder-cpmutex-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "koder-cpmutex-ws-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  _resetGuardCacheForTests();

  try {
    const promptId = "pr_concurrent_commits";
    const N = 12;

    // Baseline against the pristine (empty) workspace — mirrors the real
    // flow: the baseline commit lands once, up front, before any mutating
    // tool call runs (doc 11 §2.3), and every subsequent commit is diffed
    // against the PREVIOUS shadow-repo HEAD, not against disk state taken at
    // an arbitrary time.
    const baseline = await checkpointBaseline(workspace, promptId);
    assert.ok(baseline.sha, "baseline commit must land before the concurrent batch");

    // N concurrent "tool calls," each writing then committing a DIFFERENT
    // path — this is exactly the shape `dispatch_subtasks`'s children
    // produce when they each successfully complete a mutating tool call
    // around the same wall-clock moment, all sharing one promptId (Part
    // 1.6). The file write happens inside each task (not hoisted out front)
    // so the writes themselves race freely against each other (different
    // files, no conflict) while only the commit bookkeeping serializes.
    const results = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        await writeFile(join(workspace, `f${i}.txt`), `content-${i}`, "utf8");
        return commitAfterTool(workspace, promptId, `call${i}`, "write_file", `f${i}.txt`);
      }),
    );

    // Every call must have succeeded with a real sha and reported its own file.
    for (let i = 0; i < N; i++) {
      assert.ok(results[i].sha, `call ${i} must produce a commit sha (git operations must not have raced each other)`);
      assert.deepEqual(results[i].files, [`f${i}.txt`], `call ${i} must report exactly the file it committed`);
    }

    // No two calls collapsed onto the same commit (a lost-commit symptom) —
    // N distinct SHAs for N distinct calls.
    const shas = new Set(results.map((r) => r.sha));
    assert.equal(shas.size, N, "every concurrent call must have produced its OWN commit, none lost");

    // The shadow repo's actual commit count is baseline + N — nothing was
    // silently skipped, and nothing extra/corrupted was created either.
    const gitDir = shadowGitDirFor(workspace);
    const { stdout: logOut } = await execFileAsync("git", [`--git-dir=${gitDir}`, `--work-tree=${workspace}`, "log", "--oneline"], {
      cwd: workspace,
    });
    const commitCount = logOut.trim().split("\n").filter(Boolean).length;
    assert.equal(commitCount, N + 1, "expected exactly baseline + N commits in the shadow repo's history");

    // And the final tree genuinely contains all N files with their correct
    // content — not just N commit objects with a corrupted/partial index.
    const { stdout: treeOut } = await execFileAsync(
      "git",
      [`--git-dir=${gitDir}`, `--work-tree=${workspace}`, "ls-tree", "-r", "--name-only", "HEAD"],
      { cwd: workspace },
    );
    const files = treeOut.trim().split("\n");
    for (let i = 0; i < N; i++) {
      assert.ok(files.includes(`f${i}.txt`), `HEAD tree must include f${i}.txt`);
      const { stdout: blob } = await execFileAsync(
        "git",
        [`--git-dir=${gitDir}`, `--work-tree=${workspace}`, "show", `HEAD:f${i}.txt`],
        { cwd: workspace },
      );
      assert.equal(blob, `content-${i}`, `HEAD's f${i}.txt content must match what was written, uncorrupted`);
    }
  } finally {
    process.env.HOME = realHome;
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
