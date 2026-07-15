/**
 * Shadow-git checkpointing — the single mechanism serving BOTH Royal mode's
 * passive safety net (doc 09 §3.3, `checkpointBeforeMutation`) and the
 * prompt-ID-granular checkpoint/undo feature (doc 11,
 * `docs/research/11-prompt-checkpoints-undo.md`).
 *
 * History: Royal mode landed first and needed a checkpoint primitive before
 * doc 11's fuller system existed, so `checkpointBeforeMutation` below was
 * originally written as a deliberately minimal, standalone version (single
 * commit per mutating tool call, no prompt-ID granularity, no locking, no
 * undo). Doc 11's implementation (this revision) extends the SAME module —
 * same `~/.lakshx/checkpoints/<hash>/shadow.git` location, same git-plumbing
 * helpers (`shadowPaths`, `git`, `ensureShadowRepo`) — rather than
 * duplicating a second shadow-git implementation. `checkpointBeforeMutation`
 * is untouched (Royal mode's tests already cover it); everything below is
 * additive.
 *
 * Two-kind commit model (doc 11 §2.3), for non-royal modes:
 *  1. `checkpointBaseline(cwd, promptId)` — once per prompt, before its first
 *     mutating tool runs.
 *  2. `commitAfterTool(cwd, promptId, toolCallId, toolName, path?)` — after
 *     every successful mutating tool call; returns `{sha, files}` where
 *     `files` is derived from `git diff --raw` against the previous shadow
 *     HEAD (doc 11 §2.4 — never from the tool's declared input path), with
 *     gitlink entries (mode 160000) filtered out (doc 11 §2.2/§2.4).
 *
 * Undo (doc 11 §4/§5): `undoFile`/`undoPaths` are path-scoped `git checkout
 * <sha> -- <paths>` calls, gated by `hasConflict` unless `force` is passed.
 * These are never called by the model — only by `lakshx/undo_file` /
 * `lakshx/undo_prompt` request handlers in `server.ts`, dispatched from a
 * user action.
 *
 * Safety guards carried in from doc 11: an exclusive lock file per workspace
 * (§2.5, cross-*process* concern — two windows on the same workspace, NOT an
 * intra-process concern since tool calls are already sequential) and a
 * >50k-tracked-files probe (§2.2) that disables checkpointing entirely for
 * huge workspaces rather than silently eating an unbounded per-call `git add
 * -A` cost.
 *
 * Failure here is always best-effort: a checkpoint/undo failure must never
 * crash a turn. Every exported function catches its own errors.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Same `~/.lakshx/checkpoints/<hash>/shadow.git` location doc 11 §2.1 specifies. */
function shadowPaths(cwd: string): { dir: string; gitDir: string } {
  const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  const dir = join(homedir(), ".lakshx", "checkpoints", hash);
  return { dir, gitDir: join(dir, "shadow.git") };
}

async function git(gitDir: string, worktree: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", [`--git-dir=${gitDir}`, `--work-tree=${worktree}`, ...args], {
    cwd: worktree,
    maxBuffer: 8 * 1024 * 1024,
  });
}

/** Idempotent: creates + configures the shadow repo on first use, no-ops after. */
async function ensureShadowRepo(cwd: string): Promise<string> {
  const worktree = resolve(cwd);
  const { dir, gitDir } = shadowPaths(worktree);
  if (existsSync(gitDir)) return gitDir;
  mkdirSync(dir, { recursive: true });
  // Explicit --git-dir only (matching doc 11 §2.2's explicit-flags style) — deliberately NOT
  // --separate-git-dir, which would drop a `.git` file into the user's own workspace.
  await execFileAsync("git", [`--git-dir=${gitDir}`, "init", "-q"]);
  await git(gitDir, worktree, ["config", "user.email", "royal-checkpoints@lakshx.local"]);
  await git(gitDir, worktree, ["config", "user.name", "lakshx-royal-checkpoints"]);
  return gitDir;
}

export interface CheckpointResult {
  sha: string | null;
}

// ---- in-process concurrency lock (parallel subagents, loop.ts's dispatch_subtasks) ----

/**
 * In-process async mutex serializing only the shadow-git MUTATING calls in
 * this file (`checkpointBeforeMutation` immediately below, `checkpointBaseline`,
 * `commitAfterTool`).
 *
 * Why this exists on top of `withLock` (further below): `withLock` is a
 * CROSS-PROCESS disk lock (`mkdirSync`/EEXIST, 100ms polling backoff) sized
 * for "two VS Code windows open on the same workspace" — contention there is
 * rare and brief, so it's fine that its retry loop gives up after ~2s and
 * proceeds WITHOUT the lock rather than hang a tool call forever. That
 * escape hatch is exactly wrong for intra-process contention:
 * `dispatch_subtasks` can now have up to 6 subagents mid-tool-call in the
 * SAME process, and if several finish a mutating call within the same
 * second, whichever ones lose the disk-lock race for more than 2s would
 * silently commit UNLOCKED — the lost-commit/corrupted-index race this
 * whole file exists to prevent. A promise-chain queue costs nothing (no new
 * dependency, no polling, no timeout) and is exact: it fully serializes
 * access to the functions above for callers in this process, so contention
 * never even reaches `withLock`'s fallible retry loop. It does NOT replace
 * `withLock` — a second LakshX window in another process still needs the
 * disk lock — the two compose: this queue first, `withLock` still runs
 * inside it.
 *
 * Tool EXECUTION (file reads/writes, bash commands, LLM round-trips) for
 * different subtasks is NOT covered by this and runs fully concurrently —
 * that is where parallel subagents actually win wall-clock time. Only the
 * git-commit bookkeeping itself serializes here, and it's brief, so it
 * doesn't meaningfully erode that benefit.
 *
 * What this does NOT protect against: two subtasks writing to the literal
 * SAME file at the same time. That race lives one level below git commits
 * entirely — it's a shared-working-tree conflict (last writer to touch the
 * file on disk wins, before either subtask's commit even runs) that no
 * commit-level lock can fix. Solving it for real needs per-worker git
 * worktrees (one isolated working tree per subagent), which is a bigger
 * lift explicitly out of scope here — same conclusion docs/architecture.md
 * §10 reaches for full parallelism. `dispatch_subtasks`'s tool description
 * (tools.ts) tells the model not to fan out tasks likely to edit the same
 * file, since this is the only mitigation available without that lift.
 */
let mutexTail: Promise<unknown> = Promise.resolve();
function withProcessMutex<T>(fn: () => Promise<T>): Promise<T> {
  // Chain onto the tail regardless of whether the previous link resolved or
  // rejected — a failed prior commit must never wedge every subsequent one.
  const run = mutexTail.then(fn, fn);
  mutexTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test-only: exercise the in-process mutex directly, same naming convention as `_resetGuardCacheForTests`. */
export function _withProcessMutexForTests<T>(fn: () => Promise<T>): Promise<T> {
  return withProcessMutex(fn);
}

/**
 * Commit the current workspace state to the shadow repo. Call this BEFORE a
 * mutating tool runs, in royal mode only. `label` is a short, human-readable
 * description of the upcoming action (tool name + a fragment of its input),
 * used only as the commit message — not parsed back by anything.
 *
 * Never throws: on any git/filesystem failure this returns `{ sha: null }`
 * so the caller can proceed with the (unblocked, per Royal's design) tool
 * call regardless.
 */
export async function checkpointBeforeMutation(cwd: string, label: string): Promise<CheckpointResult> {
  return withProcessMutex(async () => {
    try {
      const worktree = resolve(cwd);
      const gitDir = await ensureShadowRepo(worktree);
      // Magic pathspec exclude, matching doc 11 §2.2's verified-safe alternative to Cline's
      // nested-.git rename trick — never touches any real or nested .git directory.
      await git(gitDir, worktree, ["add", "-A", "--", ".", ":!**/.git", ":!**/.git/**"]);
      // --allow-empty: a checkpoint must exist at every mutation boundary even if the
      // previous tool call produced no net diff (e.g. a no-op edit), so "the commit
      // immediately before this tool call" is always a well-defined target.
      await git(gitDir, worktree, ["commit", "-q", "--allow-empty", "-m", `royal-checkpoint: ${label}`.slice(0, 500)]);
      const { stdout } = await git(gitDir, worktree, ["rev-parse", "HEAD"]);
      return { sha: stdout.trim() || null };
    } catch {
      return { sha: null };
    }
  });
}

/** Exposed for tests: resolve the shadow git-dir a given cwd would use, without creating it. */
export function shadowGitDirFor(cwd: string): string {
  return shadowPaths(cwd).gitDir;
}

// ---------------------------------------------------------------------------
// Doc 11: prompt-ID-granular checkpoint/undo, built on the primitives above.
// ---------------------------------------------------------------------------

const MAX_TRACKED_FILES = 50_000;
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", ".next", ".turbo", "coverage",
]);

/** Capped readdir walk for non-git workspaces — bails as soon as the cap is crossed. */
async function countFilesWalk(dir: string, cap: number): Promise<number> {
  let n = 0;
  const stack = [dir];
  while (stack.length && n < cap) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (n >= cap) break;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(join(d, e.name));
      } else {
        n++;
      }
    }
  }
  return n;
}

async function countTrackedFiles(worktree: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", worktree, "ls-files"], { maxBuffer: 64 * 1024 * 1024 });
    const n = stdout.split("\n").filter(Boolean).length;
    if (n > 0) return n;
  } catch {
    /* not a git workspace (or git failed) — fall through to the walk */
  }
  return countFilesWalk(worktree, MAX_TRACKED_FILES + 1);
}

export interface ShadowInitResult {
  ok: boolean;
  reason?: string;
}

// cwd -> allowed; probed once per process per workspace, not on every call
const guardCache = new Map<string, boolean>();

/**
 * Probe + initialize the shadow repo for a workspace. Must be called (and
 * checked) before any baseline/tool commit — a workspace over the 50k-file
 * threshold gets `{ok:false}` so the caller can surface "undo not available
 * here" once instead of silently paying an unbounded per-call scan cost.
 */
export async function initShadowRepo(cwd: string): Promise<ShadowInitResult> {
  const worktree = resolve(cwd);
  const reason = "workspace has more than 50,000 files — checkpointing/undo is disabled here to avoid an unbounded per-call scan cost";
  const cached = guardCache.get(worktree);
  if (cached !== undefined) return cached ? { ok: true } : { ok: false, reason };
  try {
    const n = await countTrackedFiles(worktree);
    const ok = n <= MAX_TRACKED_FILES;
    guardCache.set(worktree, ok);
    if (!ok) return { ok: false, reason };
    await ensureShadowRepo(worktree);
    return { ok: true };
  } catch {
    // probe itself failed — best-effort: don't hard-disable the feature over a transient error
    guardCache.set(worktree, true);
    return { ok: true };
  }
}

/** Test-only: reset the per-workspace large-repo guard cache between fixtures. */
export function _resetGuardCacheForTests(): void {
  guardCache.clear();
}

async function stageAll(gitDir: string, worktree: string): Promise<void> {
  try {
    await git(gitDir, worktree, ["add", "-A", "--", ".", ":!**/.git", ":!**/.git/**"]);
  } catch {
    /* best-effort */
  }
}

async function currentHead(gitDir: string, worktree: string): Promise<string | null> {
  try {
    const { stdout } = await git(gitDir, worktree, ["rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** True if staging produced a diff vs the shadow repo's current HEAD (empty repo counts as dirty). */
async function hasStagedChanges(gitDir: string, worktree: string): Promise<boolean> {
  try {
    await git(gitDir, worktree, ["diff", "--cached", "--quiet"]);
    return false; // exit 0 = no diff
  } catch {
    return true; // non-zero exit = there is a diff (or no HEAD yet)
  }
}

/**
 * Parse `git diff --raw` output into a plain path list, dropping gitlink
 * entries (mode 160000, submodule/nested-repo references, §2.2/§2.4) so
 * neither UI surface can ever offer a no-op "undo" on a path that was never
 * really captured. Shared by `diffFiles` (two-ref, committed-to-committed)
 * and `filesChangedSinceCommit` (one-ref, committed-to-working-tree) below —
 * same raw-line shape either way.
 */
function parseDiffRaw(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const m = line.match(/^:(\d+) (\d+) [0-9a-f]+\.* [0-9a-f]+\.* \S+\t(.+)$/);
    if (!m) continue;
    const [, oldMode, newMode, path] = m;
    if (oldMode === "160000" || newMode === "160000") continue; // gitlink — never surfaced
    files.push(path);
  }
  return files;
}

/**
 * File list between two shadow-repo SHAs, derived from `git diff --raw` (not
 * from any tool's declared input path — doc 11 §2.4).
 */
async function diffFiles(gitDir: string, worktree: string, a: string, b: string): Promise<string[]> {
  try {
    const { stdout } = await git(gitDir, worktree, ["diff", "--raw", "--no-renames", a, b]);
    return parseDiffRaw(stdout);
  } catch {
    return [];
  }
}

/** `git diff --name-only <a> <b>` filtered for gitlinks — the primitive both UI surfaces read from (doc 11 §2.4). */
export async function fileListBetween(cwd: string, a: string, b: string): Promise<string[]> {
  const worktree = resolve(cwd);
  const gitDir = shadowPaths(worktree).gitDir;
  return diffFiles(gitDir, worktree, a, b);
}

/**
 * Files that differ between a shadow-repo commit and the CURRENT on-disk
 * working tree — no staging, no committing. This is Royal mode's
 * counterpart to `commitAfterTool`'s `{sha, files}` diff: Royal's own
 * passive checkpoint (`checkpointBeforeMutation`) commits BEFORE a mutation
 * runs and must keep doing only that — the shadow-repo HEAD staying at the
 * pre-mutation commit afterward is exactly what
 * "royal mode: checkpoints workspace state BEFORE a mutating tool call
 * runs" (agent/test/server-e2e.test.ts) asserts. So unlike `commitAfterTool`,
 * this never advances HEAD; it just reads what changed on disk relative to
 * a commit that's already there. `sha` should be the checkpoint taken
 * immediately before the tool ran — the returned files are exactly what
 * that tool call changed.
 */
export async function filesChangedSinceCommit(cwd: string, sha: string): Promise<string[]> {
  try {
    const worktree = resolve(cwd);
    const { gitDir } = shadowPaths(worktree);
    // `git diff <ref>` (no second ref, i.e. "ref vs working tree") only
    // considers paths already in the INDEX — a brand-new file the tool just
    // created is untracked and silently invisible to it until staged. `git
    // add` only touches the index, never a commit, so this is still safe
    // against advancing HEAD (verified against the shadow repo's actual
    // `ls-tree HEAD`, unaffected by index state) — the same magic-pathspec
    // exclude used everywhere else in this file.
    await git(gitDir, worktree, ["add", "-A", "--", ".", ":!**/.git", ":!**/.git/**"]);
    const { stdout } = await git(gitDir, worktree, ["diff", "--raw", "--no-renames", sha]);
    const files = parseDiffRaw(stdout);
    // Royal's own `hasConflict` check needs a reliable "what did the
    // mechanism itself last write here" reference, same as non-royal gets
    // for free from `commitAfterTool` advancing HEAD — see
    // `advanceRoyalMirror`'s doc comment for why this can't just be HEAD
    // for royal mode. Best-effort: a failure here must never lose the
    // `files` result the caller's `lakshx/checkpoint` notification needs.
    if (files.length) await advanceRoyalMirror(gitDir, worktree, sha);
    return files;
  } catch {
    return [];
  }
}

/** Never the checked-out branch — see `advanceRoyalMirror`. */
const ROYAL_MIRROR_REF = "refs/lakshx/royal-mirror";

/**
 * Advance `refs/lakshx/royal-mirror` — a side-ref, never the checked-out
 * branch/HEAD — to a commit reflecting whatever `filesChangedSinceCommit`
 * just staged into the shadow repo's index. Royal mode's before-mutation
 * commits deliberately never advance HEAD (`checkpointBeforeMutation`'s doc
 * comment; the "checkpoints workspace state BEFORE a mutating tool call"
 * e2e test asserts HEAD stays at the pre-mutation commit), so `hasConflict`'s
 * HEAD-based "does disk still match what the mechanism itself last wrote"
 * check is blind for royal-sourced checkpoints — every royal undo would
 * otherwise misreport a plain, ordinary revert as a manual-edit conflict.
 * This ref is Royal's equivalent of that same fact, built with
 * `commit-tree`/`update-ref` plumbing specifically because those never touch
 * HEAD or require a checkout, unlike `git commit`. Best-effort: `hasConflict`
 * tolerates a missing or behind-the-times mirror ref (falls through to its
 * other checks) rather than depending on this succeeding.
 */
async function advanceRoyalMirror(gitDir: string, worktree: string, fallbackParent: string): Promise<void> {
  try {
    const { stdout: treeOut } = await git(gitDir, worktree, ["write-tree"]);
    const tree = treeOut.trim();
    let parent = fallbackParent;
    try {
      const { stdout: curOut } = await git(gitDir, worktree, ["rev-parse", ROYAL_MIRROR_REF]);
      if (curOut.trim()) parent = curOut.trim();
    } catch {
      /* no mirror ref yet in this workspace — anchor it off the before-mutation commit */
    }
    const { stdout: commitOut } = await git(gitDir, worktree, ["commit-tree", tree, "-p", parent, "-m", "royal-mirror"]);
    await git(gitDir, worktree, ["update-ref", ROYAL_MIRROR_REF, commitOut.trim()]);
  } catch {
    /* best-effort */
  }
}

/**
 * Blob content of `path` at shadow-repo commit `sha` — read-only. Used by
 * the "open diff" UI action (both chat surfaces, see server.ts's
 * `lakshx/checkpoint_file_before`) to materialize the pre-checkpoint version
 * of a file so the client can hand it to `vscode.diff` against the live
 * file on disk, without needing git access client-side (only the agent
 * process touches the shadow-git plumbing). Returns `null` if the path
 * didn't exist at that commit (e.g. the file was newly created after it) —
 * a brand-new file's "before" state is legitimately "nothing," not an error.
 */
export async function readFileAtCommit(cwd: string, sha: string, path: string): Promise<string | null> {
  try {
    const worktree = resolve(cwd);
    const { gitDir } = shadowPaths(worktree);
    const { stdout } = await git(gitDir, worktree, ["show", `${sha}:${path}`]);
    return stdout;
  } catch {
    return null;
  }
}

// ---- cross-process lock (doc 11 §2.5) --------------------------------------

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exclusive lock via atomic `mkdirSync` (EEXIST on contention). Guards
 * against two windows on the same workspace racing shadow-git commands —
 * NOT an intra-process concern (tool calls in one `runPrompt()` are already
 * sequential). Steals a stale lock (dead pid) immediately; otherwise retries
 * with backoff for ~2s, then proceeds anyway with a swallowed warning rather
 * than hanging the caller's tool call indefinitely.
 */
async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = join(dir, "lakshx.lock");
  const deadline = Date.now() + 2000;
  let acquired = false;
  for (;;) {
    try {
      mkdirSync(lockPath, { recursive: false });
      writeFileSync(join(lockPath, "info.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      acquired = true;
      break;
    } catch (err: any) {
      if (err?.code !== "EEXIST") break; // unexpected fs error — proceed unlocked rather than hang
      try {
        const info = JSON.parse(readFileSync(join(lockPath, "info.json"), "utf8"));
        if (typeof info.pid === "number" && !isAlive(info.pid)) {
          rmSync(lockPath, { recursive: true, force: true }); // stale — steal it
          continue;
        }
      } catch {
        /* unreadable lock info — treat as contention, fall through to backoff */
      }
      if (Date.now() > deadline) break; // give up waiting, proceed without the lock
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

export interface BaselineResult {
  sha: string | null;
}

/**
 * Once per prompt, before its first mutating tool call: commit whatever the
 * worktree currently looks like (captures any out-of-band/manual edit made
 * between turns as part of the record). No-op (HEAD reused) if there is no
 * diff vs the shadow repo's current HEAD.
 */
export async function checkpointBaseline(cwd: string, promptId: string): Promise<BaselineResult> {
  return withProcessMutex(async () => {
    try {
      const worktree = resolve(cwd);
      const init = await initShadowRepo(worktree);
      if (!init.ok) return { sha: null };
      const { dir, gitDir } = shadowPaths(worktree);
      return await withLock(dir, async () => {
        await stageAll(gitDir, worktree);
        const dirty = await hasStagedChanges(gitDir, worktree);
        if (!dirty) {
          const head = await currentHead(gitDir, worktree);
          if (head) return { sha: head };
        }
        await git(gitDir, worktree, ["commit", "-q", "--allow-empty", "-m", `baseline:${promptId}`]);
        return { sha: await currentHead(gitDir, worktree) };
      });
    } catch {
      return { sha: null };
    }
  });
}

export interface ToolCommitResult {
  sha: string | null;
  files: string[];
}

/**
 * After a successful mutating tool call: commit and return `{sha, files}`,
 * `files` derived from the diff against the shadow repo's PREVIOUS head
 * (doc 11 §2.4), not from `path`. `path`, when given (write_file/edit_file's
 * own known single path), narrows the `git add` to just that path — faster,
 * though it does not fully sidestep the nested-repo gitlink gap (doc 11
 * §2.2). Omit `path` for tools with no static path relationship to what they
 * touched (bash) — those stage the whole tree.
 */
export async function commitAfterTool(
  cwd: string,
  promptId: string,
  toolCallId: string,
  toolName: string,
  path?: string,
): Promise<ToolCommitResult> {
  return withProcessMutex(async () => {
    try {
      const worktree = resolve(cwd);
      const init = await initShadowRepo(worktree);
      if (!init.ok) return { sha: null, files: [] };
      const { dir, gitDir } = shadowPaths(worktree);
      return await withLock(dir, async () => {
        const prevHead = await currentHead(gitDir, worktree);
        if (path) {
          try {
            await git(gitDir, worktree, ["add", "--", path]);
          } catch {
            await stageAll(gitDir, worktree); // fall back to a full scan rather than silently miss the edit
          }
        } else {
          await stageAll(gitDir, worktree);
        }
        await git(gitDir, worktree, ["commit", "-q", "--allow-empty", "-m", `tool:${promptId}:${toolCallId}:${toolName}`]);
        const sha = await currentHead(gitDir, worktree);
        const files = prevHead && sha ? await diffFiles(gitDir, worktree, prevHead, sha) : [];
        return { sha, files };
      });
    } catch {
      return { sha: null, files: [] };
    }
  });
}

async function diffQuiet(gitDir: string, worktree: string, ref: string, path: string): Promise<boolean> {
  try {
    await git(gitDir, worktree, ["diff", "--quiet", ref, "--", path]);
    return true; // exit 0 — clean, disk matches ref's content for this path
  } catch (err: any) {
    if (err?.code === 1) return false; // genuine diff
    return true; // can't tell (e.g. ref doesn't exist yet) — don't block undo on an inconclusive check
  }
}

/**
 * True if `path` has a genuine manual edit that undoing to `targetSha` would
 * silently discard — doc 11 §5, corrected: checking disk only against shadow
 * HEAD is wrong, because undo itself (a path-scoped checkout that never
 * moves the branch pointer) legitimately leaves disk at an OLDER sha while
 * HEAD still points at the last tool commit. A naive HEAD-only check would
 * misreport that expected divergence as a "manual edit" on every repeat/retry
 * of the same undo — a false positive, not a real conflict.
 *
 * Two-step check instead:
 *   1. disk vs `targetSha` clean → already at the target state; a no-op,
 *      never a conflict, regardless of what HEAD says.
 *   2. only if (1) is dirty: disk vs HEAD clean → disk still holds exactly
 *      what the agent itself last wrote (or an earlier, expected checkpoint
 *      state) — not an external edit, safe to overwrite. Dirty here too →
 *      disk matches neither the target nor the checkpoint mechanism's own
 *      last known state, i.e. something external (the user) changed it.
 */
export async function hasConflict(cwd: string, path: string, targetSha: string): Promise<boolean> {
  const worktree = resolve(cwd);
  const { gitDir } = shadowPaths(worktree);
  if (await diffQuiet(gitDir, worktree, targetSha, path)) return false; // already at target — no-op
  if (await diffQuiet(gitDir, worktree, "HEAD", path)) return false; // matches the checkpoint mechanism's own last write
  // Royal-sourced checkpoints: HEAD alone doesn't capture "what the
  // mechanism itself last wrote" the way it does for non-royal (Royal's
  // before-mutation commits deliberately never advance HEAD — see
  // `advanceRoyalMirror`'s doc comment). `refs/lakshx/royal-mirror` is
  // Royal's equivalent fact — but ONLY consult it when it actually exists:
  // `diffQuiet`'s own "ref unresolvable, can't tell" fallback treats an
  // error as "clean," which would be correct in isolation but, chained as a
  // third OR'd condition here, would make EVERY workspace that has never
  // used royal mode (i.e. almost all of them) report "no conflict"
  // unconditionally — silently defeating checks 1/2 above. Gating on
  // existence first keeps this purely additive.
  if (await royalMirrorExists(gitDir, worktree)) {
    if (await diffQuiet(gitDir, worktree, ROYAL_MIRROR_REF, path)) return false;
  }
  return true; // matches none of the above — genuine external edit
}

async function royalMirrorExists(gitDir: string, worktree: string): Promise<boolean> {
  try {
    await git(gitDir, worktree, ["rev-parse", "--verify", "--quiet", ROYAL_MIRROR_REF]);
    return true;
  } catch {
    return false;
  }
}

export type UndoResult = { ok: true; reverted: string[] } | { ok: false; conflict: { paths: string[] } };

/**
 * Path-scoped `git checkout <targetSha> -- <paths>` — one invocation for all
 * paths, so it's atomic at the git level (doc 11 §4.2). Unless `force`, every
 * path is checked for a manual-edit conflict first and the whole call is
 * refused (nothing reverted) if any path conflicts — never a partial/silent
 * overwrite. Idempotent: undoing the same prompt twice in a row is a safe
 * no-op, not a false-positive conflict (see `hasConflict` above).
 */
export async function undoPaths(cwd: string, paths: string[], targetSha: string, force = false): Promise<UndoResult> {
  const worktree = resolve(cwd);
  const { dir, gitDir } = shadowPaths(worktree);
  if (paths.length === 0) return { ok: true, reverted: [] };
  if (!force) {
    const conflicts: string[] = [];
    for (const p of paths) if (await hasConflict(worktree, p, targetSha)) conflicts.push(p);
    if (conflicts.length) return { ok: false, conflict: { paths: conflicts } };
  }
  return withLock(dir, async () => {
    // `git checkout <sha> -- <path>` refuses (errors, doesn't delete) when
    // <path> is a pathspec absent from <sha>'s tree — the very common case
    // of undoing a file the agent created FROM NOTHING (it never existed at
    // the target, so "restore it" means "remove it," which this form of
    // checkout does not do on its own). Split accordingly: existing-at-target
    // paths go through the normal one-invocation checkout (still atomic for
    // that subset); newly-created paths are deleted directly and the
    // deletion staged into the shadow index so future diffs/undos see it.
    const existed: string[] = [];
    const created: string[] = [];
    for (const p of paths) {
      if (await existsAtCommit(gitDir, worktree, targetSha, p)) existed.push(p);
      else created.push(p);
    }
    if (existed.length) await git(gitDir, worktree, ["checkout", targetSha, "--", ...existed]);
    for (const p of created) {
      await rm(join(worktree, p), { force: true }).catch(() => {});
      await git(gitDir, worktree, ["add", "-A", "--", p]).catch(() => {});
    }
    return { ok: true, reverted: paths };
  });
}

/** Whether `path` exists in the shadow repo's tree at `sha` — `git cat-file -e` (existence-only, no content read). */
async function existsAtCommit(gitDir: string, worktree: string, sha: string, path: string): Promise<boolean> {
  try {
    await git(gitDir, worktree, ["cat-file", "-e", `${sha}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

/** Undo a single file — same primitive as `undoPaths`, one path (doc 11 §4.1). */
export async function undoFile(cwd: string, path: string, targetSha: string, force = false): Promise<UndoResult> {
  return undoPaths(cwd, [path], targetSha, force);
}

// ---- size-triggered orphan-root compaction (doc 11 §2.6) -------------------

const COMPACT_THRESHOLD_BYTES = 250 * 1024 * 1024;

async function dirSizeBytes(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  const { stat } = await import("node:fs/promises");
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += (await stat(full)).size;
        } catch {
          /* ignore races with concurrent writers */
        }
      }
    }
  }
  return total;
}

/**
 * Opportunistic, called after a prompt's checkpoint commits land. Only fires
 * past the size threshold; this is the ONLY thing that actually bounds
 * shadow-repo disk growth (doc 11 §2.6 — `git gc`/reflog-expire alone do not,
 * since nothing is ever unreachable in this design until this runs). Destroys
 * the ability to undo anything before the compaction point — an explicit,
 * logged tradeoff, never silent; callers should surface the returned
 * `compacted` flag as a `system` transcript note.
 */
export async function maybeCompact(cwd: string): Promise<{ compacted: boolean }> {
  try {
    const worktree = resolve(cwd);
    const { dir, gitDir } = shadowPaths(worktree);
    if (!existsSync(gitDir)) return { compacted: false };
    const size = await dirSizeBytes(gitDir);
    if (size < COMPACT_THRESHOLD_BYTES) return { compacted: false };
    return await withLock(dir, async () => {
      // capture the real current branch name (whatever `init.defaultBranch` gave
      // it) rather than assume "main" — this repo is never user-facing but we
      // still shouldn't hardcode a name git itself didn't choose.
      const { stdout: curBranchOut } = await git(gitDir, worktree, ["symbolic-ref", "--short", "HEAD"]).catch(() => ({
        stdout: "master",
      }));
      const mainBranch = curBranchOut.trim() || "master";
      const tmpBranch = `lakshx-compact-${Date.now()}`;
      await git(gitDir, worktree, ["checkout", "--orphan", tmpBranch]);
      await git(gitDir, worktree, ["commit", "-q", "--allow-empty", "-m", "checkpoint history compacted"]);
      // -M with a single arg renames the CURRENT branch (tmpBranch) to that name,
      // forcing overwrite of the previous branch ref of the same name — this is
      // the actual moment old commits become unreachable.
      await git(gitDir, worktree, ["branch", "-M", mainBranch]);
      // `refs/lakshx/royal-mirror` (advanceRoyalMirror) is a side-ref this
      // orphan-root dance never touches — left alone, it would keep every
      // pre-compaction commit it ever pointed through reachable forever,
      // silently defeating the whole point of compacting. Drop it; the next
      // royal tool call recreates it fresh, anchored off a commit that
      // descends from the new orphan root.
      await git(gitDir, worktree, ["update-ref", "-d", ROYAL_MIRROR_REF]).catch(() => {});
      await git(gitDir, worktree, ["reflog", "expire", "--expire=now", "--all"]);
      await git(gitDir, worktree, ["gc", "--prune=now", "--quiet"]);
      return { compacted: true };
    });
  } catch {
    return { compacted: false };
  }
}
