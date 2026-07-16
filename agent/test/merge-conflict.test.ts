/**
 * Tests for AI-assisted merge conflict resolution
 * (docs/research/15-ide-feature-roadmap.md item #6): `src/merge.ts`'s pure
 * conflict-hunk parser, its git-native detection/stage-reading against a
 * REAL git merge conflict (not just synthetic marker strings), and the
 * `resolve_merge_conflict` tool's floor/permission/checkpoint gating driven
 * directly against `runPrompt()` (dispatch-subtasks.test.ts's/
 * mode-awareness.test.ts's style — a scripted OpenAI-compatible provider, no
 * ACP framing needed).
 *
 * Honesty note (per the task): only the "real git merge conflict" test below
 * exercises a genuine `git merge` producing real conflict markers end to end
 * (git init, two branches editing the same line, `git merge`, real
 * `<<<<<<<`/`=======`/`>>>>>>>` markers git itself wrote). The loop-level
 * tool tests further down use a synthetic conflicted file written directly
 * to disk (no real merge in progress in that workspace) — that's sufficient
 * to test floor/permission/checkpoint gating and the model round-trip, but
 * it means `readConflictStages` finds no git index stages there (the
 * workspace's shadow-git repo, used for checkpoints, is not a merge — see
 * `readConflictStages`'s own "not a git repo" fallback), which is fine: those
 * tests don't assert on base/ours/theirs, only on gating/write/checkpoint
 * behavior.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _resetGuardCacheForTests, shadowGitDirFor } from "../src/checkpoint.js";
import type { AgentSession, LoopCallbacks } from "../src/loop.js";
import { runPrompt } from "../src/loop.js";
import { listMergeConflicts, parseConflictHunks, proposeResolution, readConflictStages } from "../src/merge.js";
import { FakeOpenAI, textTurn, toolTurn } from "./helpers/fake-openai.js";

const execFileAsync = promisify(execFile);
const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Same discovery convention as tools.test.ts's findRg() — a real bundled binary, since a plain "rg" isn't necessarily on PATH as a real executable in every dev/CI environment (it may only exist as an interactive shell function/alias, invisible to execFile). */
function findRg(): string | undefined {
  const candidates = [
    process.env.LAKSHX_RG_PATH,
    "rg",
    "/opt/homebrew/bin/rg",
    "/usr/local/bin/rg",
    resolve(agentDir, "../upstream/node_modules/@vscode/ripgrep/bin/rg"),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return c;
    } catch {
      /* try next */
    }
  }
  return undefined;
}
const rgPath = findRg();

// ---------------------------------------------------------------------------
// 1. parseConflictHunks — pure function, synthetic strings, 1-3 hunks.
// ---------------------------------------------------------------------------

test("parseConflictHunks: single plain (ours/theirs) hunk", () => {
  const content = [
    "line before",
    "<<<<<<< HEAD",
    "our line",
    "=======",
    "their line",
    ">>>>>>> feature-branch",
    "line after",
  ].join("\n");
  const hunks = parseConflictHunks(content);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].ours, "our line");
  assert.equal(hunks[0].theirs, "their line");
  assert.equal(hunks[0].base, undefined);
  assert.equal(hunks[0].oursLabel, "HEAD");
  assert.equal(hunks[0].theirsLabel, "feature-branch");
  assert.equal(hunks[0].startLine, 2);
  assert.equal(hunks[0].endLine, 6);
});

test("parseConflictHunks: diff3-style hunk with a base section", () => {
  const content = [
    "<<<<<<< HEAD",
    "our line",
    "||||||| merged common ancestors",
    "original line",
    "=======",
    "their line",
    ">>>>>>> feature-branch",
  ].join("\n");
  const hunks = parseConflictHunks(content);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].ours, "our line");
  assert.equal(hunks[0].base, "original line");
  assert.equal(hunks[0].theirs, "their line");
});

test("parseConflictHunks: three hunks in one file, mixing plain and diff3 style, multi-line sides", () => {
  const content = [
    "unchanged 1",
    "<<<<<<< HEAD",
    "our A1",
    "our A2",
    "=======",
    "their A1",
    ">>>>>>> branch-a",
    "unchanged 2",
    "<<<<<<< HEAD",
    "our B",
    "||||||| merged common ancestors",
    "base B",
    "=======",
    "their B1",
    "their B2",
    ">>>>>>> branch-b",
    "unchanged 3",
    "<<<<<<< HEAD",
    "our C",
    "=======",
    "their C",
    ">>>>>>> branch-c",
    "unchanged 4",
  ].join("\n");
  const hunks = parseConflictHunks(content);
  assert.equal(hunks.length, 3);
  assert.equal(hunks[0].ours, "our A1\nour A2");
  assert.equal(hunks[0].theirs, "their A1");
  assert.equal(hunks[0].base, undefined);
  assert.equal(hunks[1].ours, "our B");
  assert.equal(hunks[1].base, "base B");
  assert.equal(hunks[1].theirs, "their B1\ntheir B2");
  assert.equal(hunks[2].ours, "our C");
  assert.equal(hunks[2].theirs, "their C");
  // hunks appear in file order
  assert.ok(hunks[0].startLine < hunks[1].startLine);
  assert.ok(hunks[1].startLine < hunks[2].startLine);
});

test("parseConflictHunks: no markers at all -> empty; a malformed/truncated hunk is dropped, not thrown", () => {
  assert.deepEqual(parseConflictHunks("just a normal file\nwith no conflicts\n"), []);
  // <<<<<<< with no ======= before EOF — malformed, must not throw
  const malformed = "<<<<<<< HEAD\nsome content\nno end marker here\n";
  assert.deepEqual(parseConflictHunks(malformed), []);
});

// ---------------------------------------------------------------------------
// 2. Real git merge conflict — git-native detection + index-stage reading,
//    end to end against an actual `git merge` (not a synthetic marker string).
// ---------------------------------------------------------------------------

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

test("listMergeConflicts + readConflictStages against a REAL git merge conflict", { timeout: 30_000 }, async () => {
  // `realpath` because macOS's tmpdir() returns an unresolved `/var/...` path
  // that's actually a symlink to `/private/var/...` — git's own
  // `rev-parse --show-toplevel` returns the RESOLVED path, so comparisons
  // below need the same resolution (functionally identical file either way;
  // this is a test-assertion detail, not a real path-handling bug).
  const repo = await realpath(await mkdtemp(join(tmpdir(), "lakshx-merge-realgit-")));
  try {
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@lakshx.local"]);
    await git(repo, ["config", "user.name", "lakshx-test"]);

    await writeFile(join(repo, "shared.ts"), "line1\nline2\nORIGINAL\nline4\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "base"]);

    await git(repo, ["checkout", "-q", "-b", "feature"]);
    await writeFile(join(repo, "shared.ts"), "line1\nline2\nFEATURE-CHANGE\nline4\n");
    await git(repo, ["commit", "-q", "-am", "feature change"]);

    await git(repo, ["checkout", "-q", "main"]);
    await writeFile(join(repo, "shared.ts"), "line1\nline2\nMAIN-CHANGE\nline4\n");
    await git(repo, ["commit", "-q", "-am", "main change"]);

    // Real `git merge` producing a real, git-recognized unmerged conflict —
    // not a hand-written marker string. `git merge` exits non-zero on a
    // conflict; the actual proof this is a genuine conflict (not some other
    // failure) is the assertions below: real markers on disk, real stage
    // 1/2/3 index entries, git-status detection finding exactly this file.
    await assert.rejects(git(repo, ["merge", "feature", "-m", "merge feature"]));

    const onDisk = await readFile(join(repo, "shared.ts"), "utf8");
    assert.match(onDisk, /<<<<<<</, "sanity: git actually left real conflict markers on disk");

    const scan = await listMergeConflicts(repo);
    assert.equal(scan.method, "git-status", "a real git repo must use git-status detection, not the marker-scan fallback");
    assert.equal(scan.files.length, 1);
    assert.equal(scan.files[0], join(repo, "shared.ts"));

    const stages = await readConflictStages(repo, join(repo, "shared.ts"));
    assert.ok(stages.base?.includes("ORIGINAL"), "stage 1 (base) should be the common ancestor");
    assert.ok(stages.ours?.includes("MAIN-CHANGE"), "stage 2 (ours) should be main's version");
    assert.ok(stages.theirs?.includes("FEATURE-CHANGE"), "stage 3 (theirs) should be feature's version");

    // The file's own inline markers agree with the same ours/theirs split.
    const hunks = parseConflictHunks(onDisk);
    assert.equal(hunks.length, 1);
    assert.match(hunks[0].ours, /MAIN-CHANGE/);
    assert.match(hunks[0].theirs, /FEATURE-CHANGE/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test(
  "listMergeConflicts: a non-git workspace falls back to the marker scan, honestly labeled",
  { skip: rgPath ? false : "ripgrep not available", timeout: 15_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "lakshx-merge-nogit-"));
    const realRgPath = process.env.LAKSHX_RG_PATH;
    process.env.LAKSHX_RG_PATH = rgPath;
    try {
      await writeFile(join(dir, "conflicted.txt"), "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n");
      await writeFile(join(dir, "clean.txt"), "nothing to see here\n");
      const scan = await listMergeConflicts(dir);
      assert.equal(scan.method, "marker-scan");
      assert.deepEqual(scan.files, [join(dir, "conflicted.txt")]);
    } finally {
      process.env.LAKSHX_RG_PATH = realRgPath;
      await rm(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// 3. proposeResolution's own safety checks (direct unit tests, not through
//    the loop) — a bad/truncated model response must never be treated as a
//    writable result.
// ---------------------------------------------------------------------------

async function setupHome(fake: FakeOpenAI): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "lakshx-merge-home-"));
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

const CONFLICTED = "before\n<<<<<<< HEAD\nour line\n=======\ntheir line\n>>>>>>> branch\nafter\n";

test("proposeResolution: rejects a response missing the <resolved_file> tags", { timeout: 15_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fake.enqueue(textTurn("### Reasoning\nI resolved it.\n(forgot the tags)"));
    const hunks = parseConflictHunks(CONFLICTED);
    await assert.rejects(
      proposeResolution("f.ts", CONFLICTED, hunks, {}),
      /resolved_file/i,
    );
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("proposeResolution: rejects a resolution that still contains conflict markers", { timeout: 15_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fake.enqueue(
      textTurn(
        "### Reasoning\nkept both.\n<resolved_file>\nbefore\n<<<<<<< HEAD\nour line\n=======\ntheir line\n>>>>>>> branch\nafter\n</resolved_file>",
      ),
    );
    const hunks = parseConflictHunks(CONFLICTED);
    await assert.rejects(
      proposeResolution("f.ts", CONFLICTED, hunks, {}),
      /still contains conflict markers/i,
    );
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
  }
});

test("proposeResolution: a clean resolution round-trips reasoning + resolved content", { timeout: 15_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    fake.enqueue(
      textTurn(
        "### Reasoning\nTheir change is a superset of ours, took theirs.\n\n<resolved_file>\nbefore\ntheir line\nafter\n</resolved_file>",
      ),
    );
    const hunks = parseConflictHunks(CONFLICTED);
    const result = await proposeResolution("f.ts", CONFLICTED, hunks, {});
    assert.equal(result.resolvedContent, "before\ntheir line\nafter\n");
    assert.match(result.reasoning, /superset/);
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Loop-level: floor/permission gating + full round trip via runPrompt().
// ---------------------------------------------------------------------------

const noopCallbacks = (): LoopCallbacks => ({
  onText: () => {},
  onThinking: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  onPermission: async () => true,
});

function findToolMessage(fake: FakeOpenAI, toolCallId: string) {
  for (const req of fake.requests) {
    const m = req.messages.find((mm: any) => mm.role === "tool" && mm.tool_call_id === toolCallId);
    if (m) return m;
  }
  return undefined;
}

const RESOLUTION_RESPONSE =
  "### Reasoning\nHunk 1: theirs adds real value, took it.\n\n<resolved_file>\nbefore\ntheir line\nafter\n</resolved_file>";

test("resolve_merge_conflict is blocked in review mode, exactly like write_file — nothing written", { timeout: 30_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-merge-review-ws-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  _resetGuardCacheForTests();

  try {
    const filePath = join(workspace, "conflicted.ts");
    await writeFile(filePath, CONFLICTED);

    const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "review", history: [] };
    fake.enqueue(toolTurn("call_resolve", "resolve_merge_conflict", { filePath }));
    fake.enqueue(textTurn("blocked, as expected"));

    const stop = await runPrompt(session, "resolve the conflict in conflicted.ts", noopCallbacks(), "pr_review");
    assert.equal(stop, "end_turn");

    const result = findToolMessage(fake, "call_resolve");
    assert.ok(result);
    assert.match(result!.content as string, /declined|review mode/i);

    // No sub-call to the model for a proposal ever happened — review mode's
    // hard gate stops this before `spec.run()` (and thus before
    // `proposeResolution`'s own model call) ever runs. Only the two
    // requests we scripted above should have been made.
    assert.equal(fake.requests.length, 2, "no extra request from a proposal sub-call in review mode");

    const onDisk = await readFile(filePath, "utf8");
    assert.equal(onDisk, CONFLICTED, "the file must be completely untouched in review mode");
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("resolve_merge_conflict in approve mode: denying the permission prompt leaves the file untouched", { timeout: 30_000 }, async () => {
  const fake = new FakeOpenAI();
  await fake.start();
  const home = await setupHome(fake);
  const workspace = await mkdtemp(join(tmpdir(), "lakshx-merge-approve-ws-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  _resetGuardCacheForTests();

  try {
    const filePath = join(workspace, "conflicted.ts");
    await writeFile(filePath, CONFLICTED);

    const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "approve", history: [] };
    let permissionAsked: { name: string } | undefined;
    const cb: LoopCallbacks = {
      ...noopCallbacks(),
      onPermission: async (call) => {
        permissionAsked = { name: call.name };
        return false; // deny
      },
    };
    fake.enqueue(toolTurn("call_resolve", "resolve_merge_conflict", { filePath }));
    fake.enqueue(textTurn("ok, denied"));

    const stop = await runPrompt(session, "resolve the conflict", cb, "pr_approve");
    assert.equal(stop, "end_turn");

    assert.equal(permissionAsked?.name, "resolve_merge_conflict", "must go through the SAME onPermission gate as write_file/edit_file");
    assert.equal(fake.requests.length, 2, "denied before the proposal sub-call ever ran");

    const result = findToolMessage(fake, "call_resolve");
    assert.match(result!.content as string, /declined/i);

    const onDisk = await readFile(filePath, "utf8");
    assert.equal(onDisk, CONFLICTED, "denying the permission prompt must leave the file untouched");
  } finally {
    process.env.HOME = realHome;
    await fake.stop();
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test(
  "resolve_merge_conflict in auto mode: proposes a resolution, writes it, and takes a real checkpoint before writing",
  { timeout: 30_000 },
  async () => {
    const fake = new FakeOpenAI();
    await fake.start();
    const home = await setupHome(fake);
    const workspace = await mkdtemp(join(tmpdir(), "lakshx-merge-auto-ws-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    _resetGuardCacheForTests();

    try {
      const filePath = join(workspace, "conflicted.ts");
      await writeFile(filePath, CONFLICTED);

      const session: AgentSession = { cwd: workspace, model: "fake/test-model", mode: "auto", history: [] };
      const baselines: (string | null)[] = [];
      const checkpoints: { toolName: string; sha: string; files: string[] }[] = [];
      const cb: LoopCallbacks = {
        ...noopCallbacks(),
        onBaseline: (sha) => baselines.push(sha),
        onCheckpoint: (info) => checkpoints.push({ toolName: info.toolName, sha: info.sha, files: info.files }),
      };

      // Main-turn tool call, then the tool's OWN dedicated sub-call for the
      // proposal, then the main turn's wrap-up — FIFO order matters here.
      fake.enqueue(toolTurn("call_resolve", "resolve_merge_conflict", { filePath }));
      fake.enqueue(textTurn(RESOLUTION_RESPONSE));
      fake.enqueue(textTurn("Resolved and wrote the file."));

      const stop = await runPrompt(session, "resolve the conflict in conflicted.ts", cb, "pr_auto");
      assert.equal(stop, "end_turn");
      assert.equal(fake.requests.length, 3, "main tool_use call + the tool's own proposal sub-call + the wrap-up turn");

      // The file was actually written with the model's resolved content —
      // markers gone, resolved text present.
      const onDisk = await readFile(filePath, "utf8");
      assert.equal(onDisk, "before\ntheir line\nafter\n");
      assert.doesNotMatch(onDisk, /<<<<<<<|=======|>>>>>>>/);

      // Checkpoint safety net: baseline BEFORE the write, tool commit AFTER,
      // reusing checkpoint.ts as-is (no parallel undo mechanism).
      assert.equal(baselines.length, 1);
      assert.ok(baselines[0], "baseline commit must have a real sha");
      assert.equal(checkpoints.length, 1);
      assert.equal(checkpoints[0].toolName, "resolve_merge_conflict");
      assert.ok(checkpoints[0].sha);
      assert.ok(checkpoints[0].files.some((f) => f.endsWith("conflicted.ts")));

      // Prove the checkpoint is a REAL shadow-git commit, not just a
      // reported sha — read it back from the actual shadow repo (same
      // primitive checkpoint.test.ts uses).
      const gitDir = shadowGitDirFor(workspace);
      const { stdout: log } = await execFileAsync("git", [`--git-dir=${gitDir}`, `--work-tree=${workspace}`, "log", "--oneline"]);
      assert.match(log, /tool:pr_auto:call_resolve:resolve_merge_conflict/);

      // The tool result text (what the UI's tool-card summary is built
      // from) reports the file and hunk count, plus the model's reasoning.
      const result = findToolMessage(fake, "call_resolve");
      assert.match(result!.content as string, /Resolved merge conflict in/);
      assert.match(result!.content as string, /1 hunk\b/);
      assert.match(result!.content as string, /superset|took it|real value/i);
    } finally {
      process.env.HOME = realHome;
      await fake.stop();
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
