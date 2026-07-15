# Design: Prompt IDs + Shadow-Git Checkpoints + Two-Surface Undo (July 2026)

Design only, no implementation. Grounded in `agent/src/loop.ts`, `agent/src/server.ts`, `agent/src/tools.ts`, `agent/src/store.ts`, `agent/src/context.ts`, `product/lakshx-chat/extension.js`, `product/lakshx-chat/media/panel.js`/`panel.css`, and `agent/test/session-persistence.test.ts`. Builds directly on `docs/research/07-enterprise-chat-panel.md` P1.1 (shadow-git checkpoints, Cline-derived) and `docs/research/09-royal-mode-autonomous.md` §3.3 (checkpoint/rollback) — this doc **reconciles** the two (they differ on commit timing, see §2.3) and is the first to actually spec the wire protocol, UI, and test plan. External grounding: Cursor checkpoints, Cline's shadow-git implementation (including its documented corruption bugs), VS Code `editor/title` menu contributions and `FileDecorationProvider` — sources §11.

`grep -ri checkpoint` across the repo before starting this doc turned up only doc 07/09/PLAN.md's *designs* — nothing built. This is genuinely greenfield; there is no existing mechanism to avoid duplicating.

---

## 0. Scope recap and the two UI surfaces

User's ask, restated precisely: every prompt gets a stable ID; every file the agent touches during that prompt is tracked against it; two undo affordances —

- **(a) Editor surface**: a file open in the center editor that the agent has modified shows an undo button right there, scoped to that one file.
- **(b) Chat surface**: under each prompt/turn in the chat panel, a "files changed" list with one button that undoes the whole turn's changes atomically.

Both surfaces read from **one underlying data structure** (per-prompt checkpoint records with a file list) — they are two views, not two mechanisms. That single-source-of-truth requirement drives most of the design below.

---

## 1. Prompt ID scheme

**Format**: `pr_<uuidv4>`, e.g. `pr_a1b2c3d4-...`. Prefixed (matches no existing convention in the codebase but mirrors the clarity of `chat-${Date.now()}` chat IDs in `extension.js:181`) so it's grep-able in shadow-git commit messages and log lines without ambiguity against session IDs or tool-call IDs.

**Minting point: client-side, in `extension.js`'s `onWebviewMessage` `"send"` case (`extension.js:392-409`), with a server-side fallback.** Reasoning:

- The task's own framing already identifies this as the simplest path: the client "already knows it just sent one prompt and is receiving updates until turnEnd." Minting client-side means the ID exists **before** the `session/prompt` request goes out, so it can be attached to the optimistic `post({type:"user", text: m.text})` call that already happens at `extension.js:395` — zero round-trip needed to associate the ID with that turn's transcript entry.
- The alternative (server mints in the `session/prompt` handler, `server.ts:127`, and notifies the ID back via a new `lakshx/prompt_started` notification before any tool events) works too but adds an extra message type and an ordering dependency (client must buffer/guess which turn a checkpoint notification belongs to until the notify arrives). Rejected for the extra moving part with no correctness benefit — either way the ID has to reach the server before the first tool call happens.
- **Wire path**: `extension.js` generates `promptId = "pr_" + crypto.randomUUID()` (Node's global `crypto`, already implicitly available — no new dependency), includes it as an extra field on the standard ACP `session/prompt` request: `{ sessionId, prompt: [...], promptId }`. This is a LakshX-specific extension field on a standard ACP method. Other ACP clients (Zed, JetBrains) simply won't send it — `server.ts`'s handler does `const promptId = ctx.params.promptId ?? randomUUID()` so the feature degrades to "still works, just not client-correlatable" for non-LakshX clients, never breaks.
- `runPrompt()`'s signature (`loop.ts:123-128`) gains a `promptId: string` parameter, threaded through to the new checkpoint hook (§3.2).

**Where it's persisted**: alongside `StoredSession.history` in `~/.lakshx/sessions/<id>.json` (§3.1) as the canonical source, and mirrored into the extension's own `~/.lakshx/chats/<chatId>.json` transcript (§3.3) so "open old chat" can render the files-changed UI without asking the runtime.

---

## 2. Checkpoint architecture

### 2.1 Storage location

`~/.lakshx/checkpoints/<workspace-hash>/` where `workspace-hash` = first 16 hex chars of `sha1(realpathSync(cwd))` — same keying pattern doc 07/09 already specified (Cline hashes the absolute workspace path into globalStorage; we do the same but under our own runtime-owned `~/.lakshx/` tree, not VS Code's `globalStorage`, because **the agent runtime, not the extension, owns git ops in LakshX's architecture** — `agent/src/server.ts` is a standalone ACP process usable from Zed/JetBrains too, so checkpoint state has to live somewhere the runtime controls regardless of which client is attached. This supersedes doc 07's "globalStorage" framing and matches doc 09 §3.3's `~/.lakshx/checkpoints/<workspace-hash>/`, keeping it consistent with `~/.lakshx/sessions/`, `~/.lakshx/chats/`, `~/.lakshx/memory/`.

The shadow repo is **fully independent of the workspace's own `.git`** (if any) — it works identically in a non-git workspace, which matters because LakshX is used on arbitrary folders, not only git projects.

### 2.2 Git plumbing — and why we deliberately do NOT copy Cline's nested-`.git` rename trick

Every shadow-git command is invoked with explicit `--git-dir`/`--work-tree` flags (no repo-local config, no ambiguity about which repo a bare `git` in the workspace might pick up):

```
GITDIR=~/.lakshx/checkpoints/<hash>/shadow.git
WORKTREE=<cwd>   # the real workspace root, absolute path

git --git-dir="$GITDIR" init -q                                    # one-time, idempotent
git --git-dir="$GITDIR" --work-tree="$WORKTREE" config user.email "checkpoints@lakshx.local"
git --git-dir="$GITDIR" --work-tree="$WORKTREE" config user.name  "lakshx-checkpoints"
git --git-dir="$GITDIR" --work-tree="$WORKTREE" config core.bigFileThreshold 4m
```

Default excludes live in `$GITDIR/info/exclude` (git-dir-local — never written into the workspace, never shows up as a stray `.gitignore` for the user):

```
.git/
**/.git/
node_modules/
dist/
build/
out/
target/
.venv/
venv/
__pycache__/
.next/
.turbo/
coverage/
*.log
```

If the workspace has its own `.gitignore`, chain it in with `--exclude-from="$WORKTREE/.gitignore"` on every `add`/`status` call (best-effort; skip silently if absent).

**Why not rename nested `.git` dirs (Cline's approach, endorsed by doc 07's sketch):** researched fresh for this doc — Cline's `GitOperations.renameNestedGitRepos` temporarily renames nested `.git` → `.git_disabled` before staging. The purpose of that rename is not merely to *suppress an error* — it's to remove the submodule boundary marker so git **recurses into the nested directory and stages its inner files as ordinary blobs**, i.e. so nested-repo contents are actually captured and become undoable. That rename is documented to **corrupt real repositories** when interrupted mid-operation: `cline/cline#9590` ("infinite nested .git in node_modules, permanently renames .git to .git_disabled"), `#4385`/`#4388` ("Fix Checkpoint System Git Repository Corruption"), `#9631`. The failure mode is exactly the crash-window you'd expect: process killed between rename-out and rename-back leaves the user's or a dependency's `.git` renamed, silently breaking their real git tooling until someone notices.

**LakshX's design deliberately does not attempt to match that capture behavior.** Verified empirically (not assumed) before committing to this: a magic-pathspec exclude on `git add -A -- . ':!**/.git' ':!**/.git/**'` does **not** make git descend into a directory containing a `.git` — git's directory-traversal-level gitlink detection fires regardless of pathspec filtering, so the nested directory is staged as a single **gitlink entry** (`git ls-files` shows `nested`, not `nested/inner.txt`), with a warning ("adding embedded git repository"). This is not equivalent to Cline's rename — it does not capture the nested repo's contents at all, gitlink or not. So the honest framing is a genuine scope tradeoff, not a free equivalence:

```
git --git-dir="$GITDIR" --work-tree="$WORKTREE" add -A -- . ':!**/.git' ':!**/.git/**'
git --git-dir="$GITDIR" --work-tree="$WORKTREE" status --porcelain -- . ':!**/.git' ':!**/.git/**'
```

**Decision: accept the coverage gap, keep the safety.** LakshX's shadow-git **does not checkpoint file contents inside nested git repositories/submodules** — full stop (stated again as an explicit limitation in §10). In exchange, it never renames anything, ever, which eliminates the crash-window and the entire class of documented corruption bugs above — there is no intermediate "half-migrated" `.git` state a kill-9 can catch it in. This is the correct trade for LakshX specifically: the vast majority of agent edits happen in the primary workspace tree, not inside a vendored nested repo, and doc 07/09's own default-ignore patterns (`node_modules/`, etc.) already exclude the subtrees most likely to *contain* a nested `.git` (a vendored dependency checked out as a git clone) in the first place. If a future need arises to checkpoint agent edits made *inside* a nested repo, that requires either Cline's rename approach (with its own hardened crash-safety: try/finally, the lock from §2.5, and a startup sweep that repairs any orphaned `.git_disabled` left by a prior crash) or treating that nested repo as its own independently-checkpointed shadow-git — not attempted here.

For `write_file`/`edit_file` (which always know their own single path, from `tools.ts:81-126`'s `input.path`), skip the tree-wide `add -A` entirely and `git add -- <path>` directly — narrower and faster. **This does not fully sidestep the gitlink gap**: if that single path happens to resolve inside a directory that has its own `.git` (the agent editing a file inside a vendored/nested repo), the scoped `add -- <path>` fails or is skipped by git's own submodule-pathspec handling exactly like the tree-wide case — so the nested-repo gap applies to `write_file`/`edit_file` too, not only `bash`. `bash` is simply the more likely way to hit it in practice (it can write anywhere, unprompted), not the only way structurally.

**Gitlink entries must never reach either UI surface.** Because `commitAfterTool`'s `git diff --name-only` (§2.4) is the single source of truth both undo surfaces render from, and because a nested repo's HEAD can still move as an inert gitlink update (e.g. the agent runs a `git` command *inside* a nested repo via `bash`, changing what commit the gitlink points at, which then shows up as a one-line diff for the path `nested`), the file-list derivation must **filter out any entry whose git index mode is `160000`** (git's mode for a gitlink/submodule reference) before it's returned to `commitAfterTool`'s caller or included in a `lakshx/checkpoint` notification. Without this filter, the chat card would show "Files changed (1): nested" with an "Undo all" button that does nothing on disk (checking out a gitlink path doesn't touch the submodule's own worktree) — precisely the silent-no-op confusion §10 exists to avoid. The once-only disclosure trigger in §10 should fire on **either** condition: a tool's resolved path falls inside a `.git`-bearing directory, **or** a `diff --name-only` result is filtered for containing a `160000`-mode entry — not only the tool-call-path heuristic, which alone would miss the aggregate-`add`/gitlink-move case.

**Large-repo guard (carried forward from doc 07, dropped in an earlier draft of this section — reinstated)**: the baseline commit (once per prompt) and every `bash`-triggered commit run a full-tree `add -A` scan. On a large monorepo this is a real per-prompt/per-bash-call cost, not free. Mirror doc 07's stated guard: **skip shadow-git checkpointing entirely for workspaces with >50k tracked files** (probe once at `initShadowRepo(cwd)` via `git -C <workspace> ls-files 2>/dev/null | wc -l` if the workspace has its own `.git`, else a capped `readdir` walk with an early-exit once the threshold is crossed), falling back to "undo not available in this workspace" (surfaced once, as a `system` transcript line, not a per-turn nag) rather than silently paying an unbounded scan cost on every mutating tool call.

### 2.3 Commit timing & granularity — reconciling doc 07 vs. doc 09

Doc 07 (Cline-derived) says commit **after** each mutating tool call. Doc 09 §3.3 says `checkpointBefore(tool, input)` — commit **before**. These describe the same set of world-states (state-after-tool-N ≡ state-before-tool-N+1) but they are **not** interchangeable as an implementation, because the client-facing UI needs a real commit SHA to exist immediately after a tool call succeeds (to notify "this edit is checkpointed, here's the undo target"), not lazily on the next tool call. Resolving this precisely:

**Two commit kinds, per prompt:**

1. **Baseline commit** — once per prompt, before its first mutating tool runs: `checkpointBaseline(cwd, promptId)`. Commits *whatever the worktree currently looks like* (which captures any out-of-band change — the user hand-editing a file between turns — as part of the record, see §5) with message `baseline:<promptId>`. If the worktree has no diff vs. the shadow repo's current HEAD, this is a no-op (empty commit is skipped, HEAD is reused as the baseline SHA).
2. **Tool commit** — after every tool call whose `spec.dangerous === true` succeeds (i.e. `write_file`, `edit_file`, `bash` — the same flag `tools.ts` already uses to gate permissions, reused here as "does this tool mutate files," see §2.4 for why `bash` needs special handling): `commitAfterTool(cwd, promptId, toolCallId, toolName)`, message `tool:<promptId>:<toolCallId>:<toolName>`.

This gives **per-tool-call precision** (every individual edit is its own SHA, diffable) while the **prompt-level aggregate** — what the chat UI's "undo all N files" needs — is just `git diff --name-only <baseline-SHA> <last-tool-SHA-of-this-prompt>`. Doc 09's "before" framing and doc 07's "after" framing are both satisfied: the *baseline* is captured before-the-fact (matching doc 09's safety intent — you always have a pre-prompt snapshot even if the very first tool call is the one that matters), and *tool* commits are captured after-the-fact (matching doc 07/Cline's pattern and giving an immediately-notifiable SHA per edit).

**Read-only tools (`read_file`, `list_dir`, `grep`) never trigger a checkpoint commit** — no mutation, nothing to snapshot. This is exactly `!spec.dangerous`, so the hook site is a one-line condition.

### 2.4 File-list derivation — single source of truth, not tool-input parsing

Per the advisor review of this design: **derive file lists from `git diff --name-only`, never from `tc.input.path`.** Reasons this matters:

- `bash` can touch files with no static relationship to its `command` string (a formatter, a codegen script, `npm install` rewriting `package-lock.json`) — parsing the command for paths is unreliable and incomplete.
- Even for `write_file`/`edit_file`, deriving from the diff (not the declared input path) is strictly more correct — it's what actually changed on disk, immune to a tool implementation bug or an unusual path normalization mismatch.

Concretely: `commitAfterTool()` returns `{ sha, files }` where `files = git --git-dir --work-tree diff --name-only <prevSha> <newSha>` — this is the **one function** both UI surfaces' file lists come from. A prompt's aggregate file list is `git diff --name-only <baselineSha> <lastToolShaOfPrompt>` (same primitive, different SHA pair) — no separate aggregation logic needed, no risk of the two lists drifting apart.

Every commit message also encodes `promptId`, `toolCallId`, `toolName` (§2.3) as a trailer-style body, so **the shadow repo is self-describing** — if the sidecar metadata in `StoredSession` (§3.1) is ever lost or corrupted, `git log --grep` over the shadow repo alone can reconstruct which commits belong to which prompt. This is deliberate defense in depth for a mechanism with real data-loss risk if the metadata layer breaks.

### 2.5 Locking & crash safety

**Cross-process concern, not cross-tool-call concern**: within one `runPrompt()` call, tool calls are already processed sequentially (the `for (const tc of result.toolCalls)` loop at `loop.ts:189` is not parallelized), so no intra-process race exists. The real risk is **two VS Code windows open on the same workspace** — each spawns its own `agent/src/server.ts` process (`extension.js`'s `AcpClient` is per-`AgentViewProvider`, `extension.js:173-184`), and both would target the *same* `~/.lakshx/checkpoints/<hash>/` directory (keyed by workspace path, not session ID) if the user has that workspace open twice.

Mitigation, matching Cline's own pattern (`tryAcquireCheckpointLockWithRetry`) but with plain Node (repo philosophy: zero new dependencies, `extension.js:1`/`panel.js:1`):

- Exclusive lock file `$GITDIR/../lakshx.lock`, acquired via `mkdirSync(lockPath)` (atomic exclusive create — `EEXIST` if held) before any checkpoint git command, released via `rmdirSync` after. Write `{pid, startedAt}` inside the lock dir for staleness detection.
- On `EEXIST`: check whether the recorded `pid` is alive (`process.kill(pid, 0)`, throws `ESRCH` if not); if dead, steal the lock (log a warning); if alive, retry with backoff up to ~2s, then proceed anyway with a logged warning rather than hanging a tool call indefinitely — checkpointing must never block or fail the actual file write it's checkpointing.
- **Why crash-safety is structurally easier here than Cline's**: because §2.2 already eliminated the rename/restore two-step, there is no intermediate "half-migrated" state a crash can leave behind in the *real* repo. The only crash-recoverable state is the shadow repo's own lock file (cleaned up per the staleness check above) and, at worst, an uncommitted `git add` in the shadow index — which is harmless (the next checkpoint operation just re-adds and commits; git object writes are individually atomic, there is no window where the shadow repo's `.git` itself is unparseable).

### 2.6 Pruning / retention

**Only one mechanism actually bounds disk growth here — say so plainly, don't imply otherwise.** The shadow repo is a single linear branch; every checkpoint commit is created by `git commit` on that branch's tip and every undo is a **path-scoped `checkout`** (§4), which never moves the branch pointer and never orphans a commit. That means every commit ever made stays reachable from the tip **forever** — `git reflog expire` / `git gc --prune=now` only collect objects that are already unreachable, and in this design there are none until something explicitly rewrites history. Running those commands at startup (mirroring `pruneSessions()`'s call site, `server.ts:23`) is cheap and harmless (repacks loose objects, trims genuinely stale reflog entries from the lock/staging dance) but **does not** bound the repo's growth over a long session — do not rely on it for that, and do not describe it to users as a retention mechanism.

- **The real cap: size-triggered orphan-root compaction.** Track `$GITDIR` size at server startup and opportunistically after each prompt's checkpoint commits; if it exceeds **250 MB**, compact by creating a new orphan root at current HEAD (`git checkout --orphan tmp && git commit -m "checkpoint history compacted"`, swap branches, `git gc --prune=now`) — this is the operation that actually frees disk, because it's the only point where old commits become unreachable. It intentionally **destroys the ability to undo prompts older than the compaction point**, an explicit, logged tradeoff (`system` transcript event: "older undo history was compacted to bound disk usage") rather than a silent one, and it only fires past a size threshold implying an unusually long-lived, edit-heavy session.
- **Session-file pruning (`store.ts`'s existing `pruneSessions(keepNewest=200, maxAgeDays=60)`) governs UI *reachability*, not shadow-repo disk usage** — once a `StoredSession` is pruned, its `promptId`s have no `PromptCheckpoint` entries left to look up, so neither UI surface can offer undo for that prompt anymore even though the underlying shadow-git commits may still physically exist untouched (harmless — they just sit inert until the next orphan-root compaction eventually subsumes them). This is fine as a design: the metadata layer, not the git object store, is what gates what the user can act on.
- No separate age-based or count-based cap beyond the above two — an age cutoff on a repo where nothing is ever unreachable would be a no-op (as just established), and a synthetic commit-count check is just a slower, less direct proxy for the size check that already exists.

---

## 3. Data model & wire protocol

### 3.1 `StoredSession` extension (`agent/src/store.ts`)

```ts
export interface PromptCheckpoint {
  promptId: string;
  baselineSha: string;
  tools: { toolCallId: string; toolName: string; sha: string; files: string[] }[];
  createdAt: number;
}

export interface StoredSession {
  v: 2;                       // bump: new field, old files still load (files array below)
  id: string;
  cwd: string;
  mode: AgentMode;
  model?: string;
  createdAt: number;
  updatedAt: number;
  history: ChatMessage[];
  checkpoints?: PromptCheckpoint[];   // absent/undefined on v1 files — treated as []
}
```

`loadSessionFile()` (`store.ts:93-101`) already guards on `raw?.v !== 1` — extend to accept `v === 1 || v === 2` and default `checkpoints` to `[]` when reading a v1 file, so existing session files on disk keep loading (no migration script needed, matches this codebase's existing tolerance for optional fields like `model?`).

`writeSessionNow()` (`store.ts:73-91`) gains the `checkpoints` field, sourced from a new in-memory field on the server's `Session` (`server.ts:16-18`, `interface Session extends AgentSession`) — `session.checkpoints: PromptCheckpoint[]`, appended to by the checkpoint hook (§3.2) exactly like `session.history` is appended to by `runPrompt`.

### 3.2 New ACP surface (`agent/src/server.ts`)

**Notification** (server → client, fired once per tool commit, so the chat UI can update live as a turn streams — not batched to turn-end, so a long multi-tool turn shows its files-changed list growing in real time, consistent with how `tool_call`/`tool_call_update` already stream per-call rather than per-turn):

```ts
ctx.client.notify("lakshx/checkpoint", {
  sessionId, promptId, toolCallId, toolName, sha, files,   // files: relative paths
});
```

Emitted from a new `LoopCallbacks.onCheckpoint?(info)` hook (`loop.ts:16-27` interface), called from `loop.ts` right after a successful `spec.run()` for a `dangerous` tool (near `loop.ts:222`, alongside the existing `cb.onToolEnd(...)` call at `loop.ts:244`) — this is the same seam the task description already flagged (`onToolStart`/`onToolEnd`/`onHistoryChanged` are "the natural hook points for checkpoint creation").

**Requests** (client → server, user-initiated only — never a tool the model can call, per doc 09 §3.3's "restore is user-triggered only, never a tool the model can call itself," which this design keeps unchanged and which is also what resolves the mode-interaction question, §4.4):

```ts
// undo one file to its state before the most recent prompt that touched it
.onRequest("lakshx/undo_file", (v) => v as { sessionId: string; path: string },
  async (ctx) => { ... })

// undo every file a specific prompt touched, atomically, back to that prompt's baseline
.onRequest("lakshx/undo_prompt", (v) => v as { sessionId: string; promptId: string; force?: boolean },
  async (ctx) => { ... })
```

Both return `{ ok: true, reverted: string[] }` or `{ ok: false, conflict: { paths: string[] } }` (§5) — the client shows a confirmation dialog and re-sends with `force: true` on user confirmation (mirrors the existing permission-request pattern's shape, `server.ts:177-187`, rather than inventing a new confirmation primitive).

### 3.3 Client-side association (`product/lakshx-chat/extension.js`)

- Add `"checkpoint"` to `REPLAYABLE` (`extension.js:165`) so it persists into `~/.lakshx/chats/<chatId>.json` and replays on reopen — the chat-panel UI (§7) needs it available immediately on chat load, not only during a live session.
- `onNotification` (`extension.js:287-292`) gains: `if (method === "lakshx/checkpoint") this.post({ type: "checkpoint", ...params });`
- `AgentViewProvider` maintains `this.fileCheckpoints = new Map<absPath, { promptId, sha, toolCallId }>()` (latest-wins per path — see §4's editor-undo semantics decision), rebuilt from `this.transcript`'s `checkpoint` events on `loadChat` (`extension.js:433-453`) exactly the same way `this.transcript` itself is restored, and updated live as `lakshx/checkpoint` notifications arrive during a session.
- On `vscode.window.onDidChangeActiveTextEditor`, look up the active file in `this.fileCheckpoints`; call `vscode.commands.executeCommand("setContext", "lakshx.fileHasCheckpoint", found)` — the context key `editor/title` button (§6) keys off.

---

## 4. Undo mechanics — exact commands and semantics

### 4.1 Undo one file to before the most recent prompt that touched it

**Decision on the editor-button's semantics** (the task's wording — "a button where the code has been changed" — doesn't disambiguate what happens when *multiple* prompts touched the same file): **the editor button always means "revert this file to its state before the most recent prompt that touched it."** Finer per-prompt control (revert to before an *older* prompt specifically) lives only in the chat panel, where each prompt's own row has its own scoped undo. Justification: the editor surface is a quick, file-scoped safety valve encountered while reading code — it should do the one obvious thing ("undo what the agent just did to this file") without asking the user to pick a point in history from inside the editor; picking a specific historical point is exactly what the chat panel's per-turn list is *for*, so there's no loss of capability, only a sensible division of labor between the two surfaces.

```
lastPromptForPath = fileCheckpoints.get(path).promptId       // maintained by §3.3
baselineSha = checkpoints[lastPromptForPath].baselineSha
git --git-dir="$GITDIR" --work-tree="$WORKTREE" checkout "$baselineSha" -- "$path"
```

`git checkout <sha> -- <path>` updates both the index and the working-tree file for that one path from the given tree-ish, in a single invocation — this is the primitive both undo surfaces use (§4.2 just passes more paths to the same command).

**Important correctness note, worth stating explicitly because it's the kind of thing that causes silent data loss if missed**: `git checkout <sha> -- <path>` does **not** refuse or warn on a dirty working tree the way `git checkout <branch>` does — path-scoped checkout-from-treeish unconditionally overwrites the worktree file. Git's own "protect uncommitted changes" behavior is specific to branch switching, not this form. **The dirty-check has to be implemented by us** (§5), not assumed from git's own defaults.

### 4.2 Undo all files touched by prompt N

```
files = git --git-dir="$GITDIR" --work-tree="$WORKTREE" diff --name-only "$baselineSha" "$lastToolSha"
git --git-dir="$GITDIR" --work-tree="$WORKTREE" checkout "$baselineSha" -- $files   # one invocation, all paths
```

Single `checkout` call with all paths as arguments — this is what makes it atomic *at the git level* (index and worktree for every listed path are updated as part of one command invocation, not N sequential calls that could partially fail leaving some files reverted and others not). If the process is killed mid-command, git's own object-level atomicity means either the whole checkout of that invocation lands or the command simply didn't complete and can be safely re-run (idempotent — checking out the same SHA twice is a no-op the second time for already-matching files).

### 4.3 Cross-prompt overlap warning

Before executing `lakshx/undo_prompt`, for every path in prompt N's file set, check whether any prompt with a **later** `createdAt` also touched that path (linear scan over `session.checkpoints` — sessions are bounded, this is cheap, no index needed):

```ts
function laterOverlap(checkpoints: PromptCheckpoint[], promptId: string): Record<string, string[]> {
  const target = checkpoints.find(c => c.promptId === promptId)!;
  const targetFiles = new Set(target.tools.flatMap(t => t.files));
  const overlaps: Record<string, string[]> = {};
  for (const c of checkpoints) {
    if (c.createdAt <= target.createdAt) continue;
    for (const t of c.tools) for (const f of t.files) {
      if (targetFiles.has(f)) (overlaps[f] ??= []).push(c.promptId);
    }
  }
  return overlaps; // {} = safe; non-empty = later prompts also touched these files
}
```

If non-empty, the response includes it and the client shows: *"Prompt N+1 also changed `src/foo.ts` after this. Undoing prompt N will discard those changes too. Continue?"* — same confirm-then-retry-with-`force` shape as §5's manual-edit conflict, so the client only needs one conflict-dialog code path for both cases (§7 unifies them into one confirmation component).

### 4.4 Mode interaction — undo is available in all modes, including review

Undo is **not a tool call subject to `loop.ts`'s mode/permission gate** (`loop.ts:199-210`, the `spec.dangerous && session.mode === "review"` hard block etc.) — it never enters `TOOLS` (`tools.ts:56-212`) at all, and the model can never invoke it. It's a **user action against the checkpoint store**, dispatched via its own `lakshx/undo_*` request handlers (§3.2), structurally identical to how doc 09 §3.3 already established restore must work ("never a tool the model can call itself"). Because it bypasses the mode gate entirely by construction, the "should it be available in review mode" question resolves itself: **yes, in every mode**, because mode governs what the *agent* is allowed to do, and undo is something the *user* does to files the agent already touched — a safety feature, not a mutation the agent is requesting. This needs no special-casing anywhere in `loop.ts`; it's a property of where the feature lives in the architecture, not a rule that has to be remembered and enforced.

---

## 5. Conflict handling — manual edits after the agent's last touch

**Detection**: before any checkout in §4.1/§4.2, for each target path run:

```
git --git-dir="$GITDIR" --work-tree="$WORKTREE" diff --quiet <target-sha> -- "$path"
```

**Checking only against HEAD is wrong — caught late, documented here so the fix isn't lost.** A single `diff --quiet HEAD -- "$path"` looks right at first (non-zero = disk differs from shadow-HEAD = something touched it outside the checkpoint mechanism) but produces a false-positive "manual edit" conflict on the second undo of the same prompt: undo is a path-scoped `checkout` (§4), which by design never moves the branch pointer, so after undoing once, disk now holds the *target* SHA's content while HEAD still points at the last tool commit — a real, expected divergence, not a manual edit. Re-triggering the same undo (double-click, stale button, retry after a transient error) would then diff disk against HEAD, see a mismatch, and wrongly show the user a scary "this file was edited since" dialog for a no-op.

**Correct check, two-part:**
1. `diff --quiet <target-sha> -- "$path"` — if this is clean (disk already matches what we're about to check out), it's a no-op: succeed trivially, no conflict, nothing to do.
2. Only if step 1 is dirty, then `diff --quiet HEAD -- "$path"` — if *this* is also dirty, that's the genuine signal: disk matches neither the target we're restoring to nor the last state the agent itself wrote, meaning something external changed it. Flag the conflict only here.

Since we commit after every mutating tool call (§2.3), shadow-HEAD for a given path is by definition "what the agent last wrote there" (or the baseline, if untouched since) — so failing both checks means **something changed the file outside the checkpoint mechanism**, almost always the user editing it in the IDE between agent turns (the one remaining gap: a manual edit made *between* two agent tool calls that both touch the same file gets silently folded into the next agent commit rather than flagged — a known limitation, not fixable without a file-system watcher, which is out of scope here).

**Chosen UX: warn and require explicit confirmation, never silent overwrite, never attempt a three-way merge.** Reasoning, directly answering the task's framing:

- *Silent overwrite* is unacceptable — it's the literal data-loss case this whole feature exists to prevent, just relocated to the undo path instead of the edit path.
- *Three-way merge* (agent's checkpoint vs. baseline vs. user's manual edit) sounds appealing but is the wrong reliability trade for this feature: text merges can silently produce plausible-looking-but-wrong code with no verification step (unlike the agent's own edits, which at least ran through the harness's verify contract), and implementing a merge UI is a much bigger surface to get right and test than a confirm dialog. Git's own posture is the precedent to mirror, not exceed: `git checkout` (branch form) *refuses* rather than merges when it would clobber uncommitted changes, and leaves the human to resolve it explicitly. We do the same — refuse-then-ask, not merge.
- Additionally, distinct from the git-level check above: the **editor-buffer level** check — if the target path is open and dirty (`vscode.workspace.textDocuments.find(d => d.uri.fsPath === path && d.isDirty)`) — is checked client-side before even sending the request, and surfaces its own, earlier warning ("this file has unsaved changes in the editor"), since that case is even more immediately visible to the user than the git-level one and deserves to be caught first.

**Conflict response shape** (both `lakshx/undo_file` and `lakshx/undo_prompt`): `{ ok: false, conflict: { paths: ["src/foo.ts"] } }`. Client renders one shared confirm dialog (used for both this case and §4.3's cross-prompt overlap case — they're presented identically: "these paths have changes undo would discard, continue?"), and on confirmation re-sends the same request with `force: true`, which skips the `diff --quiet` check and proceeds directly to checkout.

---

## 6. UI surface A — editor title bar (center editor)

**Placement**: `editor/title` menu group `navigation`, right-aligned icon button, `$(discard)` codicon, label "Undo agent changes" (tooltip; icon-only in the title bar per VS Code convention for that group).

**`package.json` contribution** (`product/lakshx-chat/package.json`, sketch):

```json
"contributes": {
  "commands": [{ "command": "lakshx.undoFileChanges", "title": "Undo Agent Changes", "icon": "$(discard)" }],
  "menus": {
    "editor/title": [{
      "command": "lakshx.undoFileChanges",
      "when": "lakshx.fileHasCheckpoint",
      "group": "navigation"
    }]
  }
}
```

**Context key lifecycle**: `lakshx.fileHasCheckpoint` is set/cleared exclusively from `extension.js` (§3.3) on `onDidChangeActiveTextEditor` and on every `lakshx/checkpoint`/undo-success event for the currently-active file — never read-then-assumed-stale, always recomputed from `this.fileCheckpoints` at the moment it's needed, same pattern as how `this.mode` already tracks server-pushed `modeChanged` events (`extension.js:329-332`).

**Command handler**:

```js
vscode.commands.registerCommand("lakshx.undoFileChanges", async () => {
  const path = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (!path) return;
  const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === path);
  if (doc?.isDirty) {
    const pick = await vscode.window.showWarningMessage(
      "This file has unsaved changes. Undo will discard them.", { modal: true }, "Discard and Undo",
    );
    if (pick !== "Discard and Undo") return;
  }
  const res = await provider.acp.request("lakshx/undo_file", { sessionId: provider.sessionId, path: relPath(path) });
  if (!res.ok && res.conflict) {
    const pick = await vscode.window.showWarningMessage(
      `This file has been edited since the agent last changed it. Undo will overwrite that edit.`,
      { modal: true }, "Overwrite and Undo",
    );
    if (pick !== "Overwrite and Undo") return;
    await provider.acp.request("lakshx/undo_file", { sessionId: provider.sessionId, path: relPath(path), force: true });
  }
  provider.post({ type: "system", text: `Reverted ${relPath(path)}.` }); // shows in chat too, receipt-style
});
```

VS Code's own file watcher picks up the on-disk change after checkout and reconciles the open editor automatically (reload if not dirty; conflict banner if it was — already handled by the pre-check above, which asks first). A **`FileDecorationProvider`** (small badge, capped at 2 characters per the VS Code API) on files present in `this.fileCheckpoints` is a natural Phase C nice-to-have — see §8 — giving a glance-ahead signal in the file tree/tab bar before a file is even opened, but is not required for the core feature to work and is scoped out of the first two phases to keep the surface area small.

---

## 7. UI surface B — chat panel per-turn "Files changed"

**Rendering location in `panel.js`**: a new element inserted into `#messages` right where `turnEnd` currently just calls `endStream()`/`setBusy(false)` (`panel.js:429-434`) — i.e. it appears once per turn, after the agent's final text and any tool cards, mirroring exactly where `planBar` (§ review-mode plan) already inserts itself relative to a turn's content.

**New event type `"checkpoint"`** flows through `applyEvent()` (`panel.js:249-267`) alongside the existing `tool`/`toolUpdate` cases — but rather than one row per tool commit (too noisy — a turn with 6 edits shouldn't show 6 rows), the panel **accumulates** checkpoint events per `promptId` into one card, updated live:

```js
// panel.js — new state alongside `tools` map (panel.js:118)
const checkpointCards = new Map(); // promptId -> { el, files: Set, promptId }

function applyCheckpoint(m) {
  let card = checkpointCards.get(m.promptId);
  if (!card) {
    const el = document.createElement("div");
    el.className = "checkpoint";
    messagesEl.appendChild(el);
    card = { el, files: new Set(), promptId: m.promptId };
    checkpointCards.set(m.promptId, card);
  }
  for (const f of m.files) card.files.add(f);
  renderCheckpointCard(card);
  scrollBottom();
}

function renderCheckpointCard(card) {
  const n = card.files.size;
  card.el.innerHTML = `
    <div class="cp-head">Files changed (${n})</div>
    <div class="cp-files">${[...card.files].map(f => `<div class="cp-file"><span class="cp-path"></span></div>`).join("")}</div>
    <button class="cp-undo-all">Undo all ${n} file${n === 1 ? "" : ""}</button>`;
  [...card.el.querySelectorAll(".cp-path")].forEach((el, i) => el.textContent = [...card.files][i]);
  card.el.querySelector(".cp-undo-all").addEventListener("click", () =>
    vscode.postMessage({ type: "undoPrompt", promptId: card.promptId }));
}
```

**Styling** (`panel.css`) — reuses the existing `.tool` card visual language (`panel.css:167-195`: left hairline border, muted color, monospace title) rather than inventing a new pattern, per the task's explicit ask to check `panel.css` for consistency:

```css
.checkpoint {
  border: 1px solid var(--hairline);
  border-radius: 8px;
  background: var(--card);
  padding: 8px 10px;
  font-size: 11.5px;
  animation: rise 0.14s var(--ease);       /* same entrance as .tool, .thought */
}
.checkpoint .cp-head { color: var(--muted); margin-bottom: 4px; }
.checkpoint .cp-file { font-family: var(--mono); color: var(--faint); padding: 1px 0; }
.checkpoint .cp-undo-all {
  margin-top: 6px;
  background: rgba(255, 255, 255, 0.08);   /* same visual weight as button.deny */
  color: var(--fg);
}
.checkpoint .cp-undo-all:hover { background: rgba(255, 255, 255, 0.14); }
```

**Extension-side wiring** (`extension.js` `onWebviewMessage`, alongside the existing `permissionChoice`/`setMode` cases at `extension.js:410-429`):

```js
case "undoPrompt": {
  const res = await this.acp.request("lakshx/undo_prompt", { sessionId: this.sessionId, promptId: m.promptId });
  if (!res.ok && (res.conflict || res.overlap)) {
    this.view?.webview.postMessage({ type: "undoConflict", promptId: m.promptId, conflict: res.conflict, overlap: res.overlap });
    break; // panel.js shows the shared confirm dialog (§5/§4.3), re-sends with force on confirm
  }
  this.post({ type: "system", text: `Reverted ${res.reverted.length} file(s) from that turn.` });
  break;
}
```

**Undo-all button, both conflict cases share one dialog** in `panel.js` (native `confirm()`-style in-webview modal, or a small inline banner reusing `#permissionBar`'s visual pattern — `panel.css:226-243` — since it's the same "are you sure, allow/deny" shape already built for permission prompts): title text differs (`"X was hand-edited since"` vs `"prompt N+1 also touched X"`), button label is always `Overwrite and Undo` / `Cancel`, and confirming re-sends `undoPrompt`/`undoFileChanges` with `force: true`.

---

## 8. Phased implementation plan

### Phase A — prompt IDs + checkpoint data layer, no UI (agent/src only, testable in isolation)

| # | Change | File | Sketch |
|---|---|---|---|
| A1 | `checkpoint.ts` — shadow-git plumbing: init, baseline commit, tool commit, file-list diff, path-scoped checkout, lock | new `agent/src/checkpoint.ts` | §2.1–2.5 verbatim: `initShadowRepo(cwd)`, `checkpointBaseline(cwd, promptId)`, `commitAfterTool(cwd, promptId, toolCallId, toolName)` → `{sha, files}`, `undoFile(cwd, path, targetSha, force)`, `undoPaths(cwd, paths, targetSha, force)`, `hasConflict(cwd, path)`, lock acquire/release helpers |
| A2 | `LoopCallbacks.onCheckpoint` hook + `promptId` param on `runPrompt` | `agent/src/loop.ts` | New optional field on the interface (`loop.ts:16-27`); `runPrompt(session, userText, cb, signal, promptId)`; call `await cb.onCheckpoint?.(...)` right after a successful dangerous-tool `spec.run()` (near `loop.ts:222/244`), only when `spec.dangerous` |
| A3 | `PromptCheckpoint` type + `StoredSession.checkpoints` (v2, backward-compatible load) | `agent/src/store.ts` | §3.1; `loadSessionFile` accepts `v === 1 \|\| v === 2`, defaults `checkpoints: []` |
| A4 | `session/prompt` mints/accepts `promptId`, calls `checkpointBaseline` before `runPrompt`, wires `onCheckpoint` → `lakshx/checkpoint` notify + push onto `session.checkpoints` + `saveSessionSoon` | `agent/src/server.ts` | `const promptId = ctx.params.promptId ?? randomUUID()`; new `Session.checkpoints: PromptCheckpoint[]` field on the `interface Session extends AgentSession` (`server.ts:16-18`) |
| A5 | `lakshx/undo_file`, `lakshx/undo_prompt` request handlers | `agent/src/server.ts` | §3.2/§4/§5: overlap check (§4.3), conflict check (§5), calls into `checkpoint.ts`, returns `{ok, reverted}` or `{ok:false, conflict/overlap}` |

No client changes in Phase A — this phase is done when `agent/test/` can drive `session/prompt` → mutate a file → `lakshx/undo_file` → assert the file is back to its pre-prompt content, entirely through ACP requests against a spawned server process, the same style `session-persistence.test.ts` already uses.

### Phase B — chat-panel "files changed + undo" per prompt

| # | Change | File | Sketch |
|---|---|---|---|
| B1 | `"checkpoint"` added to `REPLAYABLE`; `lakshx/checkpoint` notification handling; `undoPrompt`/conflict round-trip in `onWebviewMessage` | `extension.js` | §3.3, §7's `case "undoPrompt"` block; `REPLAYABLE` at `extension.js:165` |
| B2 | Client mints `promptId`, attaches to `post({type:"user", ...})` and the `session/prompt` request | `extension.js` | `onWebviewMessage` `"send"` case, `extension.js:392-409` |
| B3 | Checkpoint card rendering, live accumulation by `promptId`, shared conflict dialog | `media/panel.js` | §7's `applyCheckpoint`/`renderCheckpointCard`; new `"checkpoint"`/`"undoConflict"` cases in the top-level `message` listener switch (`panel.js:359-461`) |
| B4 | `.checkpoint` card styles | `media/panel.css` | §7's CSS block, appended near the existing `.tool` rules (`panel.css:167-195`) |

### Phase C — editor-level per-file undo affordance

| # | Change | File | Sketch |
|---|---|---|---|
| C1 | `lakshx.undoFileChanges` command + `editor/title` menu contribution + `lakshx.fileHasCheckpoint` context key | `product/lakshx-chat/package.json`, `extension.js` | §6; `activate()` registers the command alongside existing ones (`extension.js:646-667`) |
| C2 | `fileCheckpoints` map maintenance (live updates + rebuild on `loadChat`) + `onDidChangeActiveTextEditor` wiring | `extension.js` | §3.3, §6 |
| C3 | (stretch, not required for the core feature) `FileDecorationProvider` badge on files with an available checkpoint, visible in the file tree/tabs before opening | new small module in `product/lakshx-chat/` or inline in `extension.js` | 2-char badge cap noted in §6; register via `vscode.window.registerFileDecorationProvider`, fire `onDidChangeFileDecorations` when `fileCheckpoints` changes |

Sequencing: A is a hard prerequisite for B and C (no data, no UI to build on). B and C are independent of each other and could ship in either order or in parallel once A lands — B is likely higher value first since it's the surface the user asked for by name first ("in the chat UI... a specific undo button for that dedicated list of files").

---

## 9. What must be tested before this ships — data-loss risk is real here

This touches git plumbing with the explicit potential to silently destroy uncommitted user work if any of §2–§5 has a bug. It needs the same E2E rigor `agent/test/session-persistence.test.ts` already applies to session resume (spawn the real server process, drive it over real ACP, assert on real filesystem state) — unit-testing `checkpoint.ts`'s functions in isolation is necessary but not sufficient; the failure modes that matter are process-boundary and disk-state ones.

**Required E2E coverage, in priority order:**

1. **Round-trip correctness** (baseline case): spawn server, `auto` mode, prompt that edits 2 files across 3 tool calls, assert `session.checkpoints` has one entry with the right `baselineSha` and 3 `tools` entries; call `lakshx/undo_prompt`; assert both files' on-disk content exactly matches pre-prompt state; assert a *second* undo of the same prompt is a safe no-op (idempotency, per §4.2).
2. **Per-file undo does not touch other files**: prompt touches files A and B; `lakshx/undo_file` for A only; assert B is unchanged.
3. **Crash/interrupt mid-checkpoint**: kill the server process (`child.kill('SIGKILL')`, matching how `session-persistence.test.ts` already simulates a restart at line 80) *during* a `bash`-triggered multi-file checkpoint commit; on respawn, assert the shadow repo is still a valid git repo (`git --git-dir ... status` succeeds, no dangling lock file blocks the next operation past the staleness window). This is the direct test analog of Cline's documented corruption bugs (§2.2) — if LakshX ships this feature without this specific test, it is repeating a known, already-exploited failure class with a different implementation.
4. **Manual-edit conflict**: agent edits file X; test harness (simulating the user) writes different content to X directly via `fs.writeFile` (not through the agent); `lakshx/undo_file` without `force` must return `{ok:false, conflict}` and must **not** have modified the file; with `force: true` it must overwrite and succeed.
5. **Cross-prompt overlap warning**: prompt N edits file X; prompt N+1 also edits file X; `lakshx/undo_prompt` for N without `force` must return the overlap with N+1's `promptId` and must not modify X; with `force` it proceeds.
6. **Concurrent windows / lock contention**: two server processes pointed at the same workspace (simulating two VS Code windows) both attempt a checkpoint commit at nearly the same time; assert neither corrupts the shadow repo and both eventually succeed (lock retry, §2.5) rather than one silently losing its commit.
7. **Pruning doesn't touch live undo targets**: run `pruneCheckpoints()`/`git gc` (§2.6) immediately after creating a checkpoint still referenced by the current session; assert the checkpoint is still undoable (reachability-based expiry must never collect something a live session still points to).
8. **Non-git workspace**: run the full round-trip test (#1) in a workspace `mkdtemp`'d with no `.git` at all — the shadow-git mechanism must not depend on or interact with the workspace having its own version control.

Unit-level (fast, no process spawn) coverage that should exist alongside the above: `commitAfterTool`'s file-list-from-diff logic against a table of synthetic before/after trees; the cross-prompt-overlap pure function (§4.3) against constructed `PromptCheckpoint[]` fixtures; the magic-pathspec exclude behavior (§2.2) against a fixture directory containing a nested `.git` to confirm it's never staged, without needing a real crash scenario to prove it.

---

## 10. Explicitly out of scope for this doc

- **File contents inside nested git repositories/submodules are never checkpointed.** Established in §2.2: the shadow-git mechanism deliberately does not attempt Cline's rename-based capture of nested `.git` directories (that capability is exactly what makes the rename trick both useful *and* the source of its documented corruption bugs). A magic-pathspec exclude was verified (empirically, not assumed) to add a nested directory as an inert gitlink entry rather than its contents — so if the agent edits a file inside a vendored/nested repo, that edit is real on disk but **has no checkpoint and cannot be undone by either UI surface**. This should be surfaced once, plainly, rather than discovered by a user clicking "undo" and having nothing happen — e.g. a `system` transcript note the first time a tool call's resolved path falls inside a directory containing its own `.git`.
- **Undo of `bash`-caused changes outside the workspace root** (e.g. a global npm install) — the shadow-git worktree is scoped to `cwd`; anything a `bash` command does outside it is untracked and unundoable by this mechanism, same scope limit doc 09 §3.3 already states for its own checkpoint design ("shadow-git only covers the workspace directory").
- **Undo across a compaction/summarization boundary** (doc 08 §4.2) — if history gets compacted, old `promptId`s may no longer have a corresponding visible turn in the chat transcript to attach an "undo all" button to, even though the shadow-git commits and `StoredSession.checkpoints` entries still technically exist. Decide at Phase B time whether compacted-away turns should still show a (collapsed) checkpoint entry or simply become chat-panel-inaccessible while remaining reachable only via the editor surface (§6, which doesn't depend on the turn still being visible in the transcript).
- **Multi-file three-way merge** — deliberately rejected in §5, not deferred; if real usage shows the confirm-and-overwrite UX is too coarse, that's a future design pass, not an oversight here.

---

## 11. Sources

- **This codebase**: `agent/src/loop.ts` (`LoopCallbacks`, `AgentSession`, tool-call loop and mode gate at `loop.ts:199-210`), `agent/src/server.ts` (`session/prompt` handler `server.ts:127-215`, `session/load` replay `server.ts:56-100`), `agent/src/tools.ts` (`TOOLS`, `dangerous` flag), `agent/src/store.ts` (`StoredSession`, `saveSessionSoon`, `pruneSessions`), `agent/src/context.ts` (`scrubSecrets`, pattern to reuse for any checkpoint-adjacent logging), `agent/test/session-persistence.test.ts` (E2E test shape to mirror per §9), `product/lakshx-chat/extension.js` (`AgentViewProvider`, `REPLAYABLE`, `post()`/`persistSoon()`), `product/lakshx-chat/media/panel.js`/`panel.css` (`.tool` card pattern, `applyEvent`).
- **`docs/research/07-enterprise-chat-panel.md`** P1.1 — the original shadow-git-checkpoints design this doc builds on and reconciles (§2.3).
- **`docs/research/09-royal-mode-autonomous.md`** §3.3 — checkpoint/rollback design (`checkpointBefore`, `~/.lakshx/checkpoints/<workspace-hash>/`, "restore is user-triggered only, never a tool the model can call") — reused verbatim where it doesn't conflict with §2.3's reconciliation.
- **`docs/research/08-memory-context-engineering.md`** §2.1 — session persistence pattern (`~/.lakshx/sessions/<id>.json`, atomic debounced writes, `pruneSessions`) this design's `store.ts` extension and `checkpoint.ts` pruning both mirror.
- **Cline shadow-git implementation** — `docs.cline.bot/core-workflows/checkpoints`; `deepwiki.com/cline/cline/10.1-checkpoints-and-snapshots` (exact restore modes: `workspace`/`task`/`taskAndWorkspace`, `tryAcquireCheckpointLockWithRetry` exclusive locking, directory-safety refusal for home/Desktop/Documents/Downloads, 13-char workspace-path-hash keying). **Documented corruption bugs from the nested-`.git` rename trick** (the direct evidence base for §2.2's design decision to avoid it): `github.com/cline/cline` issues #9590 ("infinite nested .git in node_modules, permanently renames .git to .git_disabled"), #4385 ("Fix Checkpoint System Git Repository Corruption"), #4388 ("Fix Checkpoint System Issues"), #9631 ("CHECKPOINT CORRUPTION BUG REPORT").
- **Cursor checkpoints** — `forum.cursor.com` threads ("UX/UI confusion on restoring checkpoints," "Add Checkpoints-Restore to Chat," "Restore checkpoint button... not working") confirming: per-message restore point revealed on hover, restore snapshots "as of when the question was completed" (not started — a documented source of user confusion, worth avoiding by being explicit in our own UI about exactly which point in time an undo targets), confirmation step before restoring, and that checkpoint-restore-in-chat (vs. Composer) was itself a late/requested addition — informs this doc's decision to ship chat-panel undo (§7) as a first-class surface from the start rather than an afterthought.
- **VS Code extension API** — `code.visualstudio.com/api/references/contribution-points` (`editor/title` menu group `navigation`), `code.visualstudio.com/api/references/when-clause-contexts` (custom context keys via the `setContext` command, referenced in `when` clauses), `code.visualstudio.com/api/references/vscode-api` (`FileDecorationProvider`, `FileDecoration.badge` 2-character limit, `onDidChangeFileDecorations` for propagating updates).
- **Git plumbing semantics**: `git-scm.com/docs/git-checkout` — path-scoped `git checkout <tree-ish> -- <paths>` updates index + worktree for all given paths in one invocation and, unlike branch-switching checkout, does not itself refuse on a dirty worktree (the basis for §5's explicit statement that conflict-checking must be implemented by us, not assumed from git). Magic pathspec excludes (`:!pattern`) — git 1.9+, standard git documentation.
- **Nested-`.git`/gitlink behavior under a pathspec exclude vs. Cline's rename** — verified empirically for this doc, not assumed: `git add -A -- . ':!**/.git'` against a directory containing its own `.git` produces git's "adding embedded git repository" warning and stages the directory as a single gitlink entry (confirmed via `git ls-files` showing the directory name, not its inner file paths), i.e. it does **not** achieve parity with Cline's rename-based capture of nested-repo contents — this correction is why §2.2/§10 state the nested-repo gap as a deliberate, disclosed scope limitation rather than a solved equivalence.
