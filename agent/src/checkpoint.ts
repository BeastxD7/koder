/**
 * Minimal shadow-git checkpointing for Royal mode.
 *
 * Royal mode bypasses `floorCheck()` entirely (see `floor.ts`, `loop.ts`) —
 * nothing is blocked, nothing asks permission. The one thing that makes that
 * acceptable is a passive safety net: every mutating tool call is committed
 * to a shadow git repo BEFORE it runs, so a human always has an undo target
 * even though nothing stopped the action in the moment.
 *
 * This is deliberately the smallest viable version of that idea, not the
 * full system `docs/research/11-prompt-checkpoints-undo.md` designs
 * (prompt-ID granularity, locking, pruning/compaction, conflict detection,
 * two UI undo surfaces, gitlink filtering). Doc 11's implementation had not
 * landed in `agent/src` as of this module's creation (verified via `grep -ri
 * checkpoint agent/src` and `git log`) — rather than block Royal mode on that
 * larger system shipping first, this module does exactly one thing: commit
 * workspace state before a mutating tool call runs, in a shadow repo, using
 * the SAME storage location and git-plumbing conventions doc 11 §2.1/§2.2
 * specifies, so a future doc-11 implementation can absorb or replace this
 * module without a rewrite or a data-format migration.
 *
 * Deliberately NOT included here (out of scope for this minimal version,
 * left to doc 11's fuller implementation if/when it lands):
 *  - prompt-ID/tool-call-ID commit granularity and the `{sha, files}` diff
 *    return shape doc 11 §2.4 specifies
 *  - the exclusive lock file (doc 11 §2.5) — Royal mode's checkpoint calls
 *    are already serialized by `runPrompt`'s single-threaded tool-call loop,
 *    so the cross-process race doc 11 guards against doesn't arise here
 *  - size-triggered orphan-root compaction / retention (doc 11 §2.6)
 *  - undo/restore commands (doc 11 §4) — nothing in this module lets the
 *    model or the harness roll anything back; that is a human-triggered
 *    action for a future UI, never a tool the agent can call on itself
 *  - the >50k-tracked-files large-repo guard (doc 11 §2.2) — accepted as a
 *    known gap for this minimal version; a very large workspace will pay a
 *    real per-call `git add -A` cost in Royal mode until doc 11 lands
 *
 * Failure here is always best-effort: a checkpoint failure must never block
 * a Royal-mode action (that would reintroduce exactly the blocking behavior
 * Royal mode exists to remove). Every exported function swallows its own
 * errors and returns a null/empty result on failure instead of throwing.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Same `~/.koder/checkpoints/<hash>/shadow.git` location doc 11 §2.1 specifies. */
function shadowPaths(cwd: string): { dir: string; gitDir: string } {
  const hash = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  const dir = join(homedir(), ".koder", "checkpoints", hash);
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
  await git(gitDir, worktree, ["config", "user.email", "royal-checkpoints@koder.local"]);
  await git(gitDir, worktree, ["config", "user.name", "koder-royal-checkpoints"]);
  return gitDir;
}

export interface CheckpointResult {
  sha: string | null;
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
}

/** Exposed for tests: resolve the shadow git-dir a given cwd would use, without creating it. */
export function shadowGitDirFor(cwd: string): string {
  return shadowPaths(cwd).gitDir;
}
