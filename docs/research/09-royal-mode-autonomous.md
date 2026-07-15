# Design: "Royal" Mode — Full Autonomy, OS + Browser Access, Self-Healing (July 2026)

Scope: design + Phase A implementation (this revision). Grounded in `agent/src/loop.ts`, `floor.ts`, `checkpoint.ts`, `audit.ts`, `server.ts`, `tools.ts`, `product/lakshx-chat/extension.js`, and research docs 01–08 (sandboxing options actually live in `03-oss-building-blocks.md` §5, not 01 — corrected pointer, cited accordingly below). External grounding: Devin (Cognition), OpenHands, Anthropic's Claude Code Auto Mode engineering post, Claude in Chrome's permission model, and the kill-switch/self-healing-memory literature — all fetched fresh for the original pass (sources §8).

**Revision note (July 2026, same day): the core thesis below is reversed from the first draft.** The first draft of this doc argued "Royal needs the same restrictions as Auto, enforced as code instead of prompt text, plus more" — i.e. more autonomy demands *stricter* deterministic rails. The product direction is the opposite, and explicit: **Auto is the locked mode. Royal is the dangerous one.** In the user's own words: *"Auto mode should be locked. Royal should be fully bypassable — full machine/OS-level access. Royal should be dangerous, not Auto."* Asked to clarify exactly how far "fully bypassable" goes — zero safety net at all, including no logging/undo? — the answer was a specific, narrower thing: *"Nothing is blocked, nothing asks permission, nothing slows the agent down — but every action is still logged and checkpointed in the background, so if something goes wrong you have a record and an undo button. This costs zero restriction, it's purely a recorder."*

That single sentence is now this doc's spec for Royal mode. Sections §0–§2 are rewritten to state the reversed thesis directly. §3.1 (floor), §3.3 (checkpoint), §3.4 (audit log) are rewritten to describe what Phase A actually built (`agent/src/floor.ts`'s `royalTamperCheck`, `agent/src/checkpoint.ts`, `agent/src/audit.ts`), not what a stricter Royal would have needed. §3.2 (sandboxing tiers) and §4 (OS/browser tools) are kept as *research*, not as Royal's design — see the callouts in each for exactly how they're now scoped (mostly: rejected for Royal, still possibly useful for a future, different, *more* restricted mode this doc does not propose). §5 (self-healing), §8 (sources), and the external-grounding material are unaffected by the reversal and kept as-is. §6 (phased plan) and §7 (pushback) are rewritten to match.

---

## 0. The core tension, resolved — reversed from the original draft

The original framing: "zero human intervention" and "safe, trustworthy autonomy" only look contradictory if you conflate two different things — (a) real-time permission blocking, and (b) passive safety rails (logging, checkpointing, a kill switch). The original draft's conclusion was that removing (a) means (b) has to get *stricter*: more logging, mandatory sandboxing, a broader floor, off-device execution by default. That conclusion is not what's being built. The reversal doesn't change the (a)/(b) distinction — it changes which modes get which:

- **Auto is where (a) stays gone but (b) gets load-bearing and strict.** Auto already ran with no permission prompts (`spec.dangerous && session.mode !== "auto"` was always false for auto). What was missing, and now exists (`agent/src/floor.ts`, shipped in commit `9349319`, before this revision), is a deterministic, code-enforced, unconditional floor: `floorCheck()` runs before the mode branch in `loop.ts`'s `runPrompt()`, in `review`/`approve`/`auto` alike, and blocks force-push, history rewrites, `rm -rf` outside the workspace, package publishes, disk-destructive commands, and piped-remote-script execution — regardless of what the model reasons its way into or what a prompt-injected tool output tells it to do. **This is what "Auto is locked" means concretely: `floorCheck()` is unconditional and Auto cannot opt out of it.**
- **Royal is a new, distinct mode where (a) AND the floor from (b) are both gone.** Royal does not call `floorCheck()` at all — not a looser version of it, not the same rules with more exceptions, *not called*. No permission prompts (matches Auto). No pre-execution blocking of any kind on the user's project. Force-push, `rm -rf` anywhere on disk, history rewrites, package publishes, arbitrary destructive commands: these all run exactly as issued. This is the literal meaning of "fully bypassable — full machine/OS-level access" and "Royal should be dangerous."
- **What Royal keeps from (b) is deliberately narrow and entirely passive**, per the accepted design: an audit log (§3.4) and a pre-mutation checkpoint (§3.3), both of which *record*, never *block*. Plus a kill switch (§3.5) — not a rail on individual actions, but a way to stop the whole loop. None of these slow the agent down or ask it anything; they run alongside/before the action, not instead of it.
- **The one narrow exception** is self-tamper protection on the passive net's own storage (§3.1) — not a restriction on what Royal can do to the user's project, but what keeps the audit log and checkpoint history honest. Argued in full in §3.1; it is deliberately not implemented via `floorCheck()`, to keep "Royal does not call `floorCheck()`" a literally, testably true statement.

**The one-line thesis for this revision: Auto's safety is what makes Royal's danger acceptable to ship at all** — a user who wants zero friction has Auto with a real floor underneath it; Royal is the explicit, consent-gated escape hatch from that floor for people who want the friction gone entirely and are told, plainly, what that costs.

---

## 1. Where today's floor lives now — and what changed since the first draft

The load-bearing fact from the first draft was that `auto` mode's floor was prompt text only: `spec.dangerous && session.mode !== "auto"` stayed false, so nothing checked `tc.input.command`, and the "no force-push, no rm -rf outside the workspace" language in `modeBlock()` was just something the model was asked nicely to honor. That gap is closed. `agent/src/floor.ts` now exists (landed independently of this doc, commit `9349319`, before this revision), exporting `floorCheck(name, input, cwd): { blocked, reason? }`, and `loop.ts`'s `runPrompt()` calls it unconditionally, before the mode/permission branch, for `review`, `approve`, and `auto` alike. This is real, tested (`agent/test/floor.test.ts`), and unchanged by this revision — Auto's floor was already correct under the *old* thesis and remains correct, indeed becomes the anchor, under the *new* one.

What this revision adds is the fourth branch: `royal`. In `loop.ts`'s tool-call loop, the allow/deny decision is now two disjoint paths:

```ts
if (session.mode === "royal") {
  // No floorCheck(). No onPermission(). Only the narrow tamper guard.
  const tamper = royalTamperCheck(tc.name, tc.input ?? {});
  if (tamper.blocked) { allowed = false; /* ... */ }
  else if (spec.dangerous) { checkpointSha = (await checkpointBeforeMutation(session.cwd, ...)).sha; }
} else {
  // Unchanged from before this revision: floorCheck() unconditional, then
  // review's hard gate, then approve's onPermission(), then auto's silent-allow.
  const floor = floorCheck(tc.name, tc.input ?? {}, session.cwd);
  /* ... exactly the logic floor.ts's original comment describes ... */
}
```

The `else` branch is byte-for-byte the pre-existing logic — this is deliberate and load-bearing: it is what keeps the regression guarantee "Auto's floor is unchanged" true by construction, not by discipline. `agent/test/server-e2e.test.ts`'s existing "auto mode: destructive-command floor hard-blocks force-push" test asserts on this branch and was not modified for this revision; it still passes. The inverse test, "royal mode: force-push is NOT blocked," asserts on the `royal` branch and proves the opposite outcome for the identical scripted command.

---

## 2. What Royal actually changes vs. `auto` — rewritten table

| Dimension | `auto` (locked) | `royal` (dangerous, by design) |
|---|---|---|
| Permission prompt on dangerous tools | Bypassed (unchanged) | Bypassed (unchanged) — no difference here, both modes already didn't ask |
| Destructive-command floor | **`floorCheck()`, unconditional, cannot be reasoned around** — this is what "locked" means | **Not called at all.** Force-push, history rewrites, `rm -rf` anywhere on disk (not just outside the workspace), package publishes, disk-destructive commands, piped-remote-script execution — none of it is pre-execution-blocked |
| Sandboxing around `bash`/OS tools | None today (unchanged; a future hardening candidate for Auto specifically, not addressed by this revision) | **Deliberately not added.** Mandatory sandboxing is a *containment/restriction* mechanism — it directly contradicts "full machine access, nothing slows the agent down." See §3.2 for why the original draft's sandboxing-tiers research is kept as reference but not adopted for Royal |
| Pre-mutation checkpoint | Not built for Auto (out of scope for this revision — Auto's safety story is the floor, not undo) | **Built, Phase A** (`agent/src/checkpoint.ts`): workspace state committed to a shadow git repo before every mutating (`dangerous: true`) tool call. Passive — never blocks, best-effort, failure is swallowed |
| Audit trail | Session transcript only (`~/.lakshx/sessions/*.json`), same as always | **Built, Phase A** (`agent/src/audit.ts`): append-only JSONL, `~/.lakshx/royal-audit/<yyyy-mm>.jsonl`, one line per tool call (name, scrubbed input, decision, checkpoint sha, output summary, timing), outside the workspace |
| Kill switch | `session/cancel` aborts the loop's `AbortController`, SIGTERMs the `bash` child via Node's `exec({signal})` | Same mechanism, same code path — see §3.5 for the escalation-to-SIGKILL hardening status |
| Tool surface | `read_file, write_file, edit_file, list_dir, grep, bash` | **Same six tools in Phase A.** OS-level tools (`process_manage`, `package_install`) and browser automation are the literal meaning of "full machine/OS-level access" the user asked for, but they are new capabilities that don't exist in the codebase yet — Phase A does not invent them under time pressure; see §6 for why that's a sequencing choice, not a scope walk-back |
| Self-tamper protection | N/A — Auto's floor already covers this ground generally | **Narrow, explicit exception**: `royalTamperCheck()` (§3.1) blocks writes/deletes/shell-references aimed at `~/.lakshx/royal-audit/` and `~/.lakshx/checkpoints/` only. Everything else in the user's project is fair game |
| Activation | Default; no gate | **Informed-consent gate**, once per workspace (§6 Phase A) |

Net: Royal is not "Auto with more tools." It is Auto's tool surface with the floor *removed*, not tightened, plus a recorder that never gets in the way. The user asked for a mode that is genuinely dangerous, told to them plainly, with a record left behind — not a differently-shaped safety mechanism that still amounts to restriction by another name.

---

## 3. Safety architecture

### 3.1 The floor — Auto keeps it unconditional; Royal doesn't call it; one narrow exception

`agent/src/floor.ts`'s `floorCheck(name, input, cwd)` is unchanged by this revision (see §1) and continues to cover: git force-push; history rewrites (`reset --hard`, `filter-branch`, `rebase`, ref-deletion push); `rm -rf`/`find -delete` outside the workspace or at a dangerous root; package publishes (`npm`/`yarn`/`pnpm`/`cargo publish`, `twine upload`, `gem push`); disk-destructive commands (`mkfs*`, `dd` to a device path, `diskutil eraseDisk`); and piping a remote download directly into a shell interpreter. `review`, `approve`, and `auto` call it unconditionally, before the mode/permission branch. **Nothing about this changes for those three modes.** This is Auto's lock, and this revision does not touch it, weaken it, or add an escape hatch to it for any mode except Royal.

**Royal does not call `floorCheck()`.** Not a parameterized "royal mode" bypass flag threaded through it, not a subset of its rules — the function is simply never invoked on the `royal` branch of `loop.ts`'s tool-call loop. This is intentional and testable: `agent/test/server-e2e.test.ts`'s "royal mode: force-push is NOT blocked" test scripts the exact same `git push --force origin main` command the Auto-mode floor test blocks, and asserts the tool result contains a *real* git error (`fatal: not a git repository...`, since the test workspace has no `.git`) rather than the deterministic `"Blocked by safety floor"` string — i.e., it asserts the command *reached execution*, not merely that it wasn't rejected for some other reason.

**The one narrow exception — `royalTamperCheck()`, not `floorCheck()`.** A log Royal can erase, or a checkpoint history Royal can delete, isn't a safety net — it's theater. So `agent/src/floor.ts` also exports a second, much smaller function:

```ts
export function royalTamperCheck(name: string, input: any): FloorResult
```

It inspects only `write_file`/`edit_file` paths and `bash` command strings, and blocks only references to two directories: `~/.lakshx/royal-audit/` (the audit log) and `~/.lakshx/checkpoints/` (the shadow-git checkpoint history). Everything else — the user's actual project, any path inside or outside the workspace, any other command — is unrestricted. This is deliberately **not** folded into `floorCheck()` and deliberately **not** called from the non-royal branch (Auto/Approve/Review never need it; their own floor already covers destructive action broadly, and this check is scoped to paths that are specifically Royal's own bookkeeping). Keeping it separate means "Royal does not call `floorCheck()`" stays a plain, checkable fact rather than a claim with an asterisk.

**Disclosed limitation, stated plainly rather than silently glossed over**: `royalTamperCheck()` does not protect the harness's own *source code* (`agent/src/floor.ts`, `loop.ts`, `tools.ts` etc.) the way the first draft's §7 item 4 claimed a Royal-mode floor would ("no self-modification of the safety substrate, ever, even with full filesystem access"). That claim depended on a `floorCheck()`-based path rule Royal no longer calls. If a user runs Royal mode with `cwd` set to (or containing) the LakshX repo itself, nothing stops `write_file`/`bash` from editing `agent/src/*.ts` directly — that is a real, accepted consequence of "full machine access," not an oversight. The only thing that remains structurally protected is the passive net's own storage, because that storage lives outside any workspace `cwd` a user would plausibly point Royal at (`~/.lakshx/royal-audit`, `~/.lakshx/checkpoints`), not because of a path rule that special-cases the harness's source tree.

### 3.2 Sandboxing tiers — kept as research, not adopted for Royal

The original draft proposed mandatory OS-level sandboxing (srt/Seatbelt/bubblewrap) for Royal's `bash` and future OS/browser tools, tiered by capability (workspace-scoped shell → OS-level tools → browser → system settings, the last explicitly rejected). That research (doc 03 §5's OSS survey, PLAN.md's architecture box naming srt as the intended default) is still accurate and worth keeping as a citation, but **it is not Royal's design**. A sandbox is, definitionally, a containment/restriction mechanism: it confines writes to declared paths, allowlists network destinations, denies syscalls. All of that is exactly what "nothing is blocked, nothing is restricted, nothing slows the agent down" rules out for Royal. Wiring mandatory sandboxing into Royal today would silently reintroduce the "stricter rails" thesis the user explicitly reversed, under a different name.

This table is retained for reference only — e.g. if a future, different, deliberately-*more*-restricted mode is ever wanted (something between Auto and Royal), this research would still be the right starting point:

| Tier | Scope | Mechanism | Where this could apply (not Royal) |
|---|---|---|---|
| 0 | Read-only tools, in-workspace edits | No sandbox needed | N/A — no mode needs this |
| 1 | Workspace-scoped shell | srt profile confined to `cwd` | Would only make sense for a mode that *wants* scope restriction — the opposite of Royal's premise |
| 2 | OS-level tools (process mgmt, package install) | Broader srt profile or disposable container | Not proposed for Royal; see §4.1 |
| 3 | Browser automation | Ephemeral, isolated profile | Reconsidered for Royal specifically — see §4.2's updated framing |
| 4 | System settings | Not sandboxable to an acceptable risk level | Still not implemented, still not proposed anywhere |

**No sandboxing ships in Phase A.** `bash`'s `execAsync` runs directly on the host in every mode, exactly as it does today — this was already true for Auto and remains true for Royal; Royal does not make this worse, it just also removes the floor that used to catch the worst of it.

### 3.3 Checkpoint — built, Phase A, minimal version

New module `agent/src/checkpoint.ts`. Before this revision, `docs/research/11-prompt-checkpoints-undo.md` had *designed* a fuller shadow-git checkpoint system (prompt-ID granularity, locking, size-triggered compaction, conflict detection, two undo UI surfaces) but — verified via `grep -ri checkpoint agent/src` and `git log` before writing this module — that design had not landed in `agent/src` as of Phase A. Rather than block Royal's passive net on that larger system shipping first, `checkpoint.ts` implements exactly one thing, using the **same storage location and git-plumbing conventions** doc 11 §2.1/§2.2 already specifies, so a future doc-11 implementation can absorb or supersede this module without a rewrite or data migration:

- `~/.lakshx/checkpoints/<sha256(resolve(cwd)).slice(0,16)>/shadow.git`, explicit `--git-dir`/`--work-tree` flags on every call (never a repo-local `.git`, never touches the user's own git state).
- `checkpointBeforeMutation(cwd, label)` — called from `loop.ts` in the `royal` branch, immediately before any `spec.dangerous` tool runs (`write_file`, `edit_file`, `bash`): `git add -A -- . ':!**/.git' ':!**/.git/**'` (the same magic-pathspec exclude doc 11 §2.2 verified is safe against nested `.git` directories, without Cline's documented rename-corruption risk), then `git commit --allow-empty -q -m "royal-checkpoint: <label>"`, then `rev-parse HEAD`. The resulting SHA is threaded into the audit entry for that same tool call (§3.4).
- **Best-effort, always.** Every failure path returns `{ sha: null }` instead of throwing — a checkpoint failure must never block a Royal action, since blocking anything at all would violate the mode's entire premise.
- **Tested, not just asserted**: `agent/test/server-e2e.test.ts`'s "royal mode: checkpoints workspace state BEFORE a mutating tool call runs" test seeds a file, has Royal create a *new* file via `write_file`, then inspects the shadow repo directly (`git ls-tree`) and asserts the checkpoint commit contains the seed file but **not** the new one — proving "before," not just "a commit exists somewhere."

**Deliberately not built in this minimal version** (left to doc 11's fuller system if/when it lands, and explicitly not something Phase A should invent under time pressure): prompt-ID/tool-call-ID granularity and the `{sha, files}` diff-return shape; the exclusive lock file (not needed yet — `runPrompt`'s tool-call loop is already single-threaded per session, so the cross-process race doc 11 §2.5 guards against doesn't arise here); size-triggered orphan-root compaction/retention; any undo/restore command (nothing in `checkpoint.ts` lets the model or the harness roll anything back — that stays a human-triggered future UI action, never a tool Royal can call on itself); the >50k-tracked-files large-repo guard.

### 3.4 Audit log — built, Phase A

New module `agent/src/audit.ts`. **Location**: `~/.lakshx/royal-audit/<yyyy-mm>.jsonl` — one file per calendar month, outside the workspace, append-only (opened in append mode only, never truncated or rewritten by the harness). This deliberately mirrors the exact convention `product/lakshx-chat/extension.js`'s local feedback log already uses for `~/.lakshx/feedback/<yyyy-mm>.jsonl`, rather than the first draft's `<sessionId>.jsonl` scheme — one fewer pattern in the product, and month-based rotation is simpler to reason about than per-session files that could grow unboundedly within a single long-lived Royal session.

**One line per tool call**, logged unconditionally whether the call was allowed or blocked by `royalTamperCheck()`:

```jsonc
{"ts":"2026-07-14T21:32:10.512Z","tool":"bash","input":"{\"command\":\"git push --force origin main\"}","cwd":"/path/ws","decision":"allowed","checkpointSha":"a1b2c3d...","outputSummary":"EXIT 128\nfatal: not a git repository...","isError":true,"durationMs":41}
{"ts":"2026-07-14T21:33:02.001Z","tool":"write_file","input":"{\"path\":\"~/.lakshx/royal-audit/2026-07.jsonl\",...}","cwd":"/path/ws","decision":"blocked","reason":"Blocked: Royal's own safety-net storage (...) cannot be written to..."}
```

- `input` and `outputSummary` are run through `scrubSecrets` (reused from `agent/src/context.ts`, the same secret-shape deny-regex already used for tool-output wrapping in `loop.ts`) and size-capped — never the raw object, so a stray token in a command string doesn't land in a plaintext file outside the workspace.
- `decision` ∈ `allowed | blocked` (only `royalTamperCheck()` produces `blocked` in Royal mode — there is no floor-blocked category here, unlike Auto).
- Writes are best-effort (swallowed on failure), matching checkpoint's "never block the action" rule.
- **Tested**: "royal mode: audit log gets a real entry with the right shape" reads the actual JSONL file back and asserts on `tool`, `input`, `decision`, `checkpointSha`, `outputSummary`, `isError`, `durationMs`, and a parseable `ts` — for both an allowed call and, separately, confirms the force-push from the bypass test was also logged (logging is unconditional, not just for successful actions).

Deliberately not built (out of scope for Phase A, no explicit ask): rotation/pruning beyond one-file-per-month (a very long-lived, high-volume Royal session could produce a large single-month file; revisit if this proves real), a `sandboxTier`/`decision: sandbox_denied` field (no sandboxing exists — see §3.2), a session-start summary line.

### 3.5 Kill switch

`session/cancel` (`server.ts`) aborts `session.pending`'s `AbortController`; the signal is checked at the top of `runPrompt`'s loop and before each tool call, and threaded into `bash`'s `execAsync({ signal })`, which relies on Node's `exec` honoring `signal` by SIGTERM-ing the child on abort (Node's default `killSignal`). This is unchanged by Royal and applies identically in every mode — the kill switch was never mode-gated, and there's no reason to start now (Royal being harder to stop would be exactly backwards).

**Status of the SIGKILL-escalation hardening flagged in the original draft** (§3.5 item 1: a child that ignores SIGTERM, or a grandchild the shell spawned, survives a plain single SIGTERM): tracked as a real gap, sequenced deliberately *after* the floor-bypass/checkpoint/audit core in this revision's implementation order, per the reasoning in §6 — it touches the `bash` execution path for every mode, not just Royal, making it the highest-regression-risk single change in this revision, and the explicit test requirements for this pass (floor-bypass proof, checkpoint-before-mutation proof, audit-shape proof, Auto-floor-unchanged regression) don't depend on it. If it shipped in this same pass, it's a separable, dedicated change to `tools.ts`'s `bash` tool (detached process group + SIGTERM → short grace period → `process.kill(-pid, 'SIGKILL')`); if it didn't make this pass, it remains open and should not be read as "the kill switch doesn't work" — the existing SIGTERM path still functions, it just isn't escalation-hardened yet.

---

## 4. OS-level and browser tool additions — Phase B, unimplemented; framing updated

Not built in this revision. Kept here because this is the literal shape of "full machine/OS-level access" the user asked for, and because the original draft's comparative research (bundled-Playwright-vs-claude-in-chrome, sandbox tiers for process/package tools) is still useful — but the **framing has to change** given the reversal, and that tension is worth stating explicitly rather than silently carrying forward containment assumptions that no longer fit.

### 4.1 OS-level tools (unbuilt)

`process_manage` (`{action, pid?, command?, name?}`) and `package_install` (`{manager, packages, global?}`) — sketched in the original draft, gated to `royal`-only in the `allowedTools` filter when they exist. The original draft defaulted these to a disposable off-device container/microVM "because zero oversight + arbitrary process control + the user's real machine is the riskiest combination in this design space." That reasoning was sound under the *old* thesis (Royal as a stricter-rails mode) and is now in direct tension with the *new* one (Royal as literally full machine access, on the user's actual machine, by explicit request). This doc does not resolve that tension by fiat here — it's flagged as the first open question Phase B's design pass needs to answer on purpose, not an oversight carried over from before the reversal.

### 4.2 Browser access (unbuilt) — the same tension, more concretely

The original draft argued for a bundled, ephemeral, unauthenticated Playwright profile over reusing the user's real logged-in Chrome (the claude-in-chrome pattern), specifically because Royal was supposed to be the *more* contained mode. Under the reversed thesis, "full machine access" plausibly *does* mean Royal should be able to act inside the user's real, authenticated browser session if that's what a task needs — the ephemeral-profile argument was a safety argument for a Royal that no longer exists in this form. Two honest options for Phase B, neither adopted here:

1. **Keep the ephemeral/ isolated profile anyway**, as a "Royal is dangerous on the filesystem/shell but browser actions specifically stay contained" carve-out — inconsistent with "full access" but arguably the single highest-blast-radius category (real purchases, real emails, real accounts) worth treating differently even in a mode that's otherwise unrestricted.
2. **Follow the reversal to its conclusion** and let Royal drive the user's real browser session, accepting that blast radius as part of what "dangerous, by design, with informed consent" means.

Not resolving this here is a deliberate scope boundary for this revision, not an accident — Phase A ships no browser tools either way, so the question doesn't block anything shipping today.

---

## 5. Self-learning / self-healing mechanism — unaffected by the reversal, kept as-is

Nothing about the thesis reversal changes this section; it's included unmodified from the original draft because it's still accurate and still not built.

**What exists today** (do not reinvent — extend):

- `loop.ts`'s `lastToolSig`/`toolRepeatCount` catches **identical** tool call + input repeated consecutively; at 4 repeats it force-ends the turn.
- `loop.ts`'s `editFails` map: per-path consecutive `edit_file` failures get an escalating hint ("re-read the file" → "stop retrying, use write_file instead"), reset on success or on any `read_file` of that path.
- Doc 08 §2.2's designed (not-yet-built) `remember` tool + `~/.lakshx/memory/MEMORY.md` (global) / `<workspace>/.lakshx/memory.md` (project): model-writable, dated bullets, injected into `systemPrompt()` at an 8 KiB cap, scrubbed of secrets, with an opt-in end-of-task reflection pass that writes ≤3 auto-memories per session, always visible in the transcript.

**The gap both mechanisms share**: they catch *the same action repeated*, not *different actions failing for the same underlying reason* — Devin's documented "infinite edit-run-fail loops" failure mode (doc 04) is exactly this: the agent keeps trying superficially different fixes for a problem it has fundamentally misdiagnosed. Identical-call detection never fires because each attempt looks different at the tool-call level.

### 5.1 In-session: outcome-signature loop detection (extends `loop.ts`)

Generalize `toolRepeatCount` from `sig = name + JSON(input)` to also track a **verification-outcome signature**: after a verify-style command (`bash` running test/build/typecheck) fails, extract a normalized error signature and track it in a small rolling window (last 8 tool calls). If the **same error signature** recurs 3 times across *different* edit attempts:

1. Force a read-only reflection step (no tools that turn): "You've hit this error 3 times with different fixes. State your hypothesis for the root cause before trying again."
2. If it recurs a 4th time: in `royal` mode specifically (no human watching the transcript live — that hasn't changed with the reversal, Royal still runs unattended), immediately trigger the cross-session write in §5.2 and pause the task, surfacing an async notification rather than burning tool calls unattended. In `approve`/`auto`, the existing transcript-visible escalation is sufficient since a human is already watching.

This is ~30–40 lines added to `loop.ts`, reusing the exact same `Map`-based tracking shape as `editFails`, not a new subsystem.

### 5.2 Cross-session: causal-lesson writes (extends doc 08's memory, not a new store)

On the trigger in §5.1 (or on any task that ends without the verify contract passing), write a structured bullet through the **same** `remember` tool / `MEMORY.md` path doc 08 designs:

```
- [2026-07-14] [project] symptom: TS2345 on AnthropicAdapter.runTurn arg — cause: assumed `usage` was always defined, provider omits it on non-streamed calls — fix: `usage?.inputTokens ?? estimate()` — verified: typecheck+test pass
```

**The one behavioral difference from doc 08's default**: in `royal`, the causal-lesson write is unconditional on the specific trigger (repeated-failure-signature or unverified task end), since there's no human present to explicitly ask for it the way `approve`/`auto` allow. The "always visible in the transcript" guarantee is kept and becomes more important, since it's the only way the user finds out later that a lesson was written at all.

**Explicitly not proposed, unaffected by the reversal**: no agent-authored changes to its own prompt, floor rules, or `royalTamperCheck()`'s guarded paths, no matter how well-justified a given "lesson" might sound — the causal-lesson memory writes to project/global *memory* files only. This is worth restating post-reversal specifically: even though Royal now has literal filesystem access to `agent/src/floor.ts` if the workspace contains it (§3.1's disclosed limitation), the *self-learning mechanism itself* must never be the thing that proposes or drives such an edit. That's a distinction between "the user's own choice to run Royal against the LakshX repo, eyes open" and "the agent decided, on its own reflection, to rewrite the rules that govern it" — the former is the user's call to make; the latter is exactly the failure mode the kill-switch literature (§8) warns against ("kill switches don't work if the agent writes the policy").

---

## 6. Phased implementation plan

### Phase A — floor-bypass core, checkpoint, audit log, mode wiring, consent gate (this revision)

| # | Change | File | Status |
|---|---|---|---|
| A1 | `royalTamperCheck()` — narrow self-tamper guard on the passive net's own storage | `agent/src/floor.ts` | Built. Separate from `floorCheck()`, called only on the `royal` branch |
| A2 | `checkpointBeforeMutation()` — minimal shadow-git checkpoint before every mutating tool call in royal mode | new `agent/src/checkpoint.ts` | Built, minimal version (§3.3). Same storage location/conventions as doc 11 §2.1–2.2, so it's absorbable, not throwaway |
| A3 | `logRoyalAudit()` — append-only JSONL audit log | new `agent/src/audit.ts` | Built (§3.4) |
| A4 | `royal` mode added: `AgentMode` union, `modeBlock()` branch, tool-loop branch that skips `floorCheck()`/`onPermission()` and calls A1–A3 | `agent/src/loop.ts` | Built. The non-royal branch is untouched (byte-identical logic to before this revision) — this is what keeps Auto's floor a regression-tested invariant, not a hope |
| A5 | `royal` added to the mode list surfaced over ACP | `agent/src/server.ts`'s `MODES` | Built |
| A6 | Informed-consent gate, once per workspace | `product/lakshx-chat/extension.js`, `product/lakshx-chat/media/panel.js` | Built where safe to touch without conflicting with concurrent, unrelated in-flight work on those files (see the commit for exact scope); a one-time `vscode.window.showWarningMessage` confirm gates the `setMode` call to `royal`, ack stored per-workspace outside the workspace tree |
| A7 | Kill-switch SIGKILL escalation | `agent/src/tools.ts`, `server.ts` | Tracked, sequenced last/separable per §3.5 — see the commit for whether it landed in this pass |

**Explicitly not attempted in Phase A, by design, not oversight**: OS-level tools, browser tools (§4 — both need their post-reversal framing resolved first, not just an implementation), mandatory sandboxing for Royal (§3.2 — rejected, not deferred), doc 11's fuller checkpoint system (prompt-ID granularity, undo UI, compaction — a distinct, larger feature this revision's minimal `checkpoint.ts` is compatible with but does not replace).

### Phase B — OS tools, browser tools, doc-11 checkpoint convergence (unscheduled)

1. Resolve §4.1/§4.2's open tension (real machine/real browser vs. some residual containment for the highest-blast-radius categories) as an explicit design decision, not a default.
2. `process_manage`, `package_install` — `royal`-only in the `allowedTools` filter, each still passing through `royalTamperCheck()` (protecting the net's own storage) but nothing else.
3. Browser tools per whichever framing §4.2 resolves to.
4. If/when doc 11's fuller checkpoint system lands, migrate `royal`'s `checkpointBeforeMutation()` call site onto it (same storage location, so this should be closer to a swap than a rewrite) and gain prompt-scoped undo for Royal actions as a byproduct.

### Phase C — self-healing loop (depends on doc 08 Phase C shipping first)

Unaffected by the reversal — see §5.

---

## 7. What should NOT be in Royal mode — rewritten pushback, post-reversal

The first draft's §7 was pushback against building Royal exactly as a naive reading of "zero intervention, OS access, browser access" would suggest, under a thesis where more autonomy demanded more restriction. Several of those items were themselves restrictions-on-Royal that the reversal directly overturns; keeping them unchanged here would quietly reintroduce the old thesis. Restated per-item:

1. ~~No `system_settings` tool.~~ **Still true, but no longer because Royal needs restricting** — this is unchanged because no real use case has emerged for it (doc's original reasoning: it isn't required by "shipped software quality," LakshX's actual mission), not because Royal specifically can't be trusted with it. If a real use case emerges, it's a normal feature-scoping decision like any other new tool, not a special Royal carve-out.
2. ~~OS-level tools should default to off-device.~~ **Superseded — flagged as unresolved in §4.1, not asserted.** The old reasoning ("zero oversight + real machine is the riskiest combination") is exactly the stricter-rails thesis the user reversed. Phase B has to make this call explicitly, not inherit the old default.
3. ~~No reuse of the user's live, authenticated browser.~~ **Superseded — flagged as unresolved in §4.2, not asserted**, for the same reason as item 2.
4. **No self-modification of the passive safety net's own storage — kept, narrowed, honestly scoped.** This is the one item that survives the reversal essentially intact, but restated accurately: `royalTamperCheck()` protects `~/.lakshx/royal-audit/` and `~/.lakshx/checkpoints/` only. It does **not** protect the harness's own source code from a Royal session pointed at a workspace that contains it (§3.1's disclosed limitation) — the first draft's broader claim ("no self-modification of the safety substrate, ever, even with full filesystem access") no longer holds and this doc says so plainly rather than leaving stale language that overclaims.
5. ~~No purchases, payments, account creation, or contractual actions.~~ **Superseded — folded into §4.2's unresolved question.** These were Claude-in-Chrome-derived hard bans specifically for the browser tool family that doesn't exist yet; whether Royal keeps any of them is part of the same open design question, not a settled floor rule.
6. **No self-continuation across turns — kept, unaffected by the reversal.** This was never a trust restriction on Royal specifically; it's a runaway-process/resource-exhaustion concern that applies regardless of permission model. `runPrompt` still stops at `end_turn` and waits for the next `session/prompt` call in every mode, Royal included. A self-continuing agent composes badly with an unattended, unblocked mode particularly badly (burns through checkpoints and audit volume unattended) — if anything, this item matters *more* post-reversal, not less.
7. **No agent-authored changes to its own policy via the self-learning mechanism — kept, restated in §5.2.** Also not a trust restriction on Royal's capability; it's a boundary on what the *reflection/memory-writing mechanism specifically* is allowed to do, independent of what the user themselves chooses to let Royal touch via ordinary tool calls.

Items 2, 3, and 5 are the ones this revision genuinely changes — they're not soft-pedaled into "still mostly true" language, because they were load-bearing parts of the old thesis and pretending otherwise would misrepresent what "Royal is dangerous, not Auto" actually commits the design to.

---

## 8. Sources

- **This codebase**: `agent/src/loop.ts`, `agent/src/floor.ts`, `agent/src/checkpoint.ts`, `agent/src/audit.ts`, `agent/src/server.ts`, `agent/src/tools.ts`, `product/lakshx-chat/extension.js`, `docs/research/01-editor-foundation.md`, `02-agent-intelligence.md`, `03-oss-building-blocks.md` §5, `04-ux-patterns-performance.md` §2–3, `07-enterprise-chat-panel.md`, `08-memory-context-engineering.md`, `11-prompt-checkpoints-undo.md`, `PLAN.md`.
- **Anthropic, "How we built Claude Code auto mode: a safer way to skip permissions"** — two-stage classifier (Stage 1 single-token, 8.5% FP tuned for recall; Stage 2 chain-of-thought, reduces to 0.4% FP), reasoning-blind design, three-tier allowlist, escalation after 3 consecutive or 20 total blocked actions, 17% false-negative rate on documented overeager actions — `anthropic.com/engineering/claude-code-auto-mode`.
- **Cognition (Devin)** — plan-then-execute with dynamic re-planning, sandboxed cloud environment, custom `blockdiff` VM snapshot format, checkpoint restore rolls back files *and* memory, streaming updates with in-flight correction — Cognition product-update blog posts, `docs.devin.ai`.
- **OpenHands** — Docker-container-per-task runtime, action/observation protocol, bind-mount/overlay filesystem control, port-allocation isolation; notably no explicit dangerous-action policy at the runtime layer — confirms containment and policy are separate concerns, which this design also keeps separate (§3.1 vs §3.2) — `docs.openhands.dev/openhands/usage/architecture/runtime`.
- **Claude in Chrome permissions** — site-level gating, site blocklists, action confirmations for high-risk actions, and a hard ban list — the reference point for §4.2's still-open browser-tool question — `support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide`, `support.claude.com/en/articles/12902428-use-claude-in-chrome-safely`.
- **Kill-switch design literature** — infrastructure-level, deterministic, outside the agent's own reasoning, state-capture + immutable logging, rollback-and-quarantine; **"Kill Switches Don't Work If the Agent Writes the Policy"** (Stanford CodeX, Berkeley Agentic AI Profile analysis) — the direct source for §5.2/§7 item 7's framing — `law.stanford.edu/2026/03/07/kill-switches-dont-work-if-the-agent-writes-the-policy...`, general survey across `miniorange.com/blog/ai-kill-switch-architecture`, `93days.me`, `theproductjourney.substack.com`.
- **Self-healing/causal memory literature** — episodic/semantic/procedural memory layering, causal chains, reflect→extract→store→retrieve lesson loops — `mindstudio.ai/blog/claude-code-source-leak-memory-architecture`, `blog.gopenai.com`, `medium.com/@kumaran.isk`.
