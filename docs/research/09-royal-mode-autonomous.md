# Design: "Royal" Mode — Full Autonomy, OS + Browser Access, Self-Healing (July 2026)

Scope: design only, no implementation. Grounded in `agent/src/loop.ts`, `server.ts`, `tools.ts`, `product/koder-chat/extension.js`, and research docs 01–08 (sandboxing options actually live in `03-oss-building-blocks.md` §5, not 01 — corrected pointer, cited accordingly below). External grounding: Devin (Cognition), OpenHands, Anthropic's Claude Code Auto Mode engineering post, Claude in Chrome's permission model, and the kill-switch/self-healing-memory literature — all fetched fresh for this pass (sources §8).

---

## 0. The core tension, resolved

"Zero human intervention during execution" and "safe, trustworthy autonomy" only look contradictory if you conflate two different things:

- **(a) Real-time interruption for permission** — a synchronous `await cb.onPermission(...)` that blocks the loop until a human clicks. Royal mode removes this. Full stop.
- **(b) Safety rails that operate without blocking execution** — sandboxing, audit logging, automatic checkpointing, hard-coded floors, a kill switch, async notification. Royal mode does **not** remove these. It depends on them more than any other mode, because (a) is gone.

**The one-line thesis for this whole document: removing the human backstop means the deterministic rails have to get stricter, not looser.** Every design decision below follows from that. Where the user's framing implies "Royal should have fewer restrictions because it's more trusted," the correct engineering answer is usually "Royal needs the same restrictions as Auto, enforced as code instead of prompt text, plus a few new ones that only make sense once there's no human watching."

---

## 1. Where today's floor actually lives — and why it doesn't hold

This is the load-bearing fact for the whole design. Read `loop.ts:199–210`:

```ts
let allowed = true;
if (spec.dangerous && session.mode === "review") {
  allowed = false; // hard gate: review mode never modifies anything
} else if (spec.dangerous && session.mode !== "auto") {
  allowed = await cb.onPermission({ id: tc.id, name: tc.name, input: tc.input, title, kind: spec.kind });
}
```

In `auto` mode, `spec.dangerous && session.mode !== "auto"` is false, so `allowed` stays `true` unconditionally. **Nothing inspects `tc.input.command`.** The "no force-push, no history rewrites, no rm -rf outside the workspace, no package publishes" floor (`loop.ts:74–77`, inside `modeBlock()`) is a **system-prompt string handed to the model**, not code the harness enforces. The model is trusted to self-censor.

This is the exact failure mode the codebase already names as a threat elsewhere: `ANTI_INJECTION` (`loop.ts:60`) exists precisely because tool output — file contents, command output, a cloned dependency's README — can carry "ignore previous instructions" payloads that override prompt-level rules. A prompt-level floor is bypassable by the same injection vector the prompt already warns about. In `approve` mode this is survivable because a human still sees the `bash $ rm -rf /` permission prompt and says no (`extension.js` permission bar, `onPermissionRequest` at `extension.js:376–389`). In `auto` mode today it is already a soft spot, papered over by the fact that a human is at least watching the transcript stream by. **In Royal mode, with no human watching at all, a prompt-level floor is not a floor.**

**Conclusion:** Royal mode requires converting the floor from prompt text into a deterministic, unconditional, pre-execution check in the harness — and that check should apply in *every* mode, not just Royal, since it's a correctness fix independent of autonomy level. Royal is where it becomes load-bearing; Phase A ships it for everyone (§6).

---

## 2. What Royal actually changes vs. `auto` today

| Dimension | `auto` today | `royal` (proposed) |
|---|---|---|
| Permission prompt on dangerous tools | Bypassed (`loop.ts:202`) | Bypassed — identical, no change here |
| Destructive-command floor | System-prompt text only | **Deterministic pre-execution `floorCheck()`, unconditional, cannot be reasoned around** (§3.1) |
| Sandboxing around `bash`/OS tools | None — `execAsync` runs directly on the host (`tools.ts:195–203`) | **Mandatory** srt (Seatbelt/bubblewrap) or microVM, tiered by capability (§3.2) |
| Pre-mutation checkpoint | Not built (designed in doc 07, not wired) | **Mandatory** shadow-git commit before every mutating tool call (§3.3) |
| Audit trail | Session transcript only (`~/.koder/sessions/*.json`, conversation-shaped, mutable) | **Append-only, security-shaped** audit log outside the workspace (§3.4) |
| Kill switch | `session/cancel` aborts the loop's `AbortController` (`server.ts:216–218`), which propagates to `bash`'s `signal` option and SIGTERMs the child | **Hardened**: process-group SIGKILL escalation, sandbox teardown, browser session teardown, always-visible UI affordance (§3.5) |
| Tool surface | `read_file, write_file, edit_file, list_dir, grep, bash` (`tools.ts`) | Same six **plus** OS-process tools, package-install, browser tools — gated by mode in the `allowedTools` filter (`loop.ts:133–134`) |
| Cross-turn oversight | Human reads the transcript live | **Async notification** channel (`koder/royal_notice`), non-blocking, for "needs review" / "blocked" events |
| Self-correction on repeated failure | Identical-call loop detection only (`loop.ts:212–219`), no cross-session memory of *why* something failed | **Extended** to outcome-signature loops (not just identical calls) + unconditional causal-lesson write to doc 08's memory store (§5) |
| Session/task duration | Bounded by `MAX_ITERATIONS = 60` **per prompt turn** (`loop.ts:41`); no self-continuation past `end_turn` (`loop.ts:184–186`) — the loop waits for the next `session/prompt` call | **v1: no self-continuation either.** A raised per-turn iteration cap plus a wall-clock/tool-count ceiling *within that turn*; at `end_turn` (or ceiling breach) Royal hard-stops and async-notifies rather than re-prompting itself. See §7 item 6 for why self-continuation is deliberately out of scope, not an oversight. |
| Activation | One of three buttons in the mode switcher (`extension.js:592–595`) | Same switcher, but gated behind an **informed-consent step** the first time per workspace (§6, Phase A) |

Net: Royal is not "auto with the safety text deleted." It's auto's *permission bypass* plus a materially heavier safety substrate underneath it, because the substrate is now the only thing standing between a mistake and consequences.

---

## 3. Safety architecture

### 3.1 Destructive-action floor — exact rules, enforced as code

New module `agent/src/floor.ts`, exporting `floorCheck(name: string, input: any, cwd: string): { blocked: boolean; reason?: string }`, called in `loop.ts` **before** the mode branch at line 199 — i.e. it runs in `review`/`approve`/`auto`/`royal` alike:

```ts
let allowed = true;
const floor = floorCheck(tc.name, tc.input ?? {}, session.cwd);
if (floor.blocked) {
  allowed = false;
} else if (spec.dangerous && session.mode === "review") {
  allowed = false;
} else if (spec.dangerous && session.mode !== "auto" && session.mode !== "royal") {
  allowed = await cb.onPermission(...);
}
```

A blocked floor check returns the same shape as a denied permission (`"User declined this action..."` today, `loop.ts:206`) but with a reason string — the model sees it as data and can adjust, exactly like a permission denial, but it is **not negotiable**: no retry, no rephrase, no injected instruction changes the outcome, because it's a regex/path check, not a judgment call.

**Exact rule set (same content for `auto` and `royal` — the content doesn't loosen, only the enforcement mechanism changes):**

| Category | Rule | Mechanism |
|---|---|---|
| Filesystem scope | `write_file`/`edit_file` path must resolve (after symlink/`..` normalization) inside `cwd` or an explicit allowlist | path check, no regex needed |
| `rm -rf` / `rm -fr` | Blocked unless every resolved target path is inside `cwd` | parse `bash` command, resolve paths |
| History rewrite | `git push --force`, `push -f`, `push --force-with-lease` to a non-local remote; `filter-branch`; `reset --hard` when it would drop commits reachable from a remote-tracking branch | regex + `git` state check |
| `git clean -f` / `-fdx` | Blocked outside `cwd` | path check |
| Package publish | `npm publish`, `cargo publish`, `pip upload`/`twine upload`, `gem push`, `docker push` to non-local registries | regex on command |
| Privilege escalation | `sudo`, `su`, `doas`, anything that would require elevated OS privileges | regex |
| Disk-level destruction | `mkfs*`, `dd` writing to a block device path (`/dev/sd*`, `/dev/disk*`), `diskutil eraseDisk`, `Format-Volume` | regex |
| Pipe-to-shell of remote content | `curl ... \| sh`, `curl ... \| bash`, `wget -O- \| sh`, `iwr ... \| iex` | regex — this is the single most common real-world RCE vector for autonomous agents and is worth its own line even though it overlaps "arbitrary code exec" generally |
| Persistence mechanisms | Writes to shell rc files (`.zshrc`, `.bashrc`, `.profile`), crontab, `launchd`/`systemd` unit files, `~/Library/LaunchAgents` | path check on `write_file`/`edit_file`; regex on `crontab -e`/`systemctl enable` in `bash` |
| Credential paths | Direct `read_file`/`grep` of `~/.ssh/*`, `~/.aws/credentials`, `~/.koder/providers.json`, `.env*`, `*.pem`, `id_rsa*` | path check — blocked outright, not just scrubbed, because Royal has no human to notice an exfil attempt in progress |
| Safety-substrate tamper | Any write to `~/.koder/royal-audit/*`, the checkpoint git dir, the kill-switch sentinel, or (if running from source) `agent/src/floor.ts`/`loop.ts`/`tools.ts` themselves | path check — see §7 item 4, this is non-negotiable even for Royal |
| Browser hard bans | See §4.2 — separate table, same mechanism | — |

This list is deliberately closer to a **denylist of catastrophic, hard-to-reverse, or self-tamper actions** than a broad policy engine. It is not trying to be a general-purpose security sandbox (that's the sandbox's job, §3.2) — it's the last-line, zero-cost, un-reasonable-with backstop that fires even if the sandbox has a gap.

**Should Royal's floor be looser than Auto's?** No. Argued above: less human oversight demands *more* deterministic rails, not fewer. The two floor-worthy additions unique to Royal (self-tamper protection, credential-path blocking) exist specifically *because* there's no human to notice tampering or exfiltration in progress — they're not needed as hard floors in `approve` mode because a human permission prompt already surfaces `bash $ cat ~/.ssh/id_rsa` for a "wait, why" moment.

### 3.2 Sandboxing tiers

Doc 03 (`03-oss-building-blocks.md` §5, not 01 — correcting the task's pointer) already surveyed the options: Anthropic srt (Seatbelt on macOS, bubblewrap on Linux, Apache-2.0, purpose-built for exactly this), Firecracker/gVisor/E2B for heavier isolation. PLAN.md's architecture diagram already names srt as the intended default sandbox — **but it is not wired into `tools.ts` today.** `bash`'s `execAsync` (`tools.ts:195–203`) runs directly on the host with the harness process's own privileges. Royal mode is where this gap stops being acceptable to ship around.

| Tier | Scope | Mechanism | Applies to |
|---|---|---|---|
| 0 | Read-only tools, in-workspace edits | No sandbox needed; floor + shadow-git checkpoint suffice | `read_file`, `list_dir`, `grep`, `write_file`, `edit_file` — all modes |
| 1 | Workspace-scoped shell (builds, tests, git, package manager reads) | **Mandatory in Royal** (recommended for `auto` too): srt profile — FS writes confined to `cwd` + declared temp/cache dirs, network allowlisted to package registries + localhost, no access to other repos or `~/.ssh`/`~/.aws` | `bash` in `royal`, ideally `auto` |
| 2 | OS-level tools: process management beyond the workspace, package installation | Broader srt profile *or* escalate to a disposable container/microVM — **default to off-device** (§7 item 2) | new `process_manage`, `package_install` tools, `royal` only |
| 3 | Browser automation | Separate sandbox: bundled, ephemeral Playwright profile, isolated from the user's real browser session | new `browser_*` tools, `royal` only (§4) |
| 4 | System settings (OS preferences, credential stores, firewall, user accounts) | **Not sandboxable to an acceptable risk level for a zero-oversight agent** | **Not implemented** — see §7 item 1 |

Tiers 2–4 are exactly where "OS-level access" and "browser access" live, and exactly where the phased plan (§6) puts the real engineering weight, not Tier 0–1 which already has a design (doc 07) waiting to be built.

### 3.3 Checkpoint / rollback

Builds directly on doc 07's shadow-git design (`07-enterprise-chat-panel.md:16`: "git init in globalStorage w/ core.worktree=workspace; commit before each mutating tool") and PLAN.md's architecture box — **designed, not yet built**. Royal mode is blocked on this shipping for real (§6 sequencing).

- New `agent/src/checkpoint.ts`: a shadow git repo at `~/.koder/checkpoints/<workspace-hash>/` with `core.worktree` pointed at the real workspace, `.git` kept out-of-tree so it never collides with the user's own `.git`.
- `checkpointBefore(tool, input)` commits the current workspace state **before** any tool that passed the floor check and is `dangerous: true` runs — including `bash`, since bash can mutate arbitrarily and can't be pre-analyzed the way `edit_file`'s path can.
- The resulting commit SHA is recorded in the audit log entry for that tool call (§3.4), giving every logged action a concrete rollback target.
- Restore is **user-triggered only**, never a tool the model can call itself — surfaced in the extension as "restore to before this action" on any audit entry, or "restore to last checkpoint" as the kill-switch companion action (§3.5).
- **Scope limit, stated plainly**: shadow-git only covers the workspace directory. Tier 2/3 actions (installing a system package, navigating a browser to a real website, killing a system process) are **not** reversible by checkpoint — this is exactly why those tiers lean on containment (sandboxing, ephemeral browser profiles, off-device execution) instead of promising "we can always undo it." Where reversibility isn't available, containment has to substitute for it. Making this substitution explicit is the core safety argument for defaulting Tier 2 off-device (§7 item 2).

### 3.4 Audit log — format and location

Separate from `~/.koder/sessions/<id>.json` (doc 08 §2.1's conversation store, which is mutable-by-design as history grows and is meant for resume, not forensics). New, append-only, JSONL:

**Location**: `~/.koder/royal-audit/<sessionId>.jsonl` — outside the workspace (so the agent's own file tools can't reach it even before the floor check fires — belt and suspenders with §3.1's tamper rule), opened in append mode only, never truncated or rewritten by the harness.

**One line per tool call**:

```jsonc
{"ts":1789000123456,"seq":42,"sessionId":"…","tool":"bash","input":{"command":"npm test"},"decision":"allowed","sandboxTier":1,"checkpointSha":"a1b2c3d","durationMs":4210,"exitCode":0,"cwd":"/path/ws"}
{"ts":1789000129001,"seq":43,"sessionId":"…","tool":"bash","input":{"command":"git push --force origin main"},"decision":"floor_blocked","reason":"history rewrite to non-local remote"}
```

- `input` passes through the existing `scrubSecrets` (from `agent/src/context.ts`, already used in `loop.ts` for tool-output wrapping) before serialization — same secret-shape deny-regex doc 08 §2.3 specifies for memory writes, reused here rather than inventing a second scrubber.
- `decision` ∈ `allowed | floor_blocked | sandbox_denied | killed`.
- A session-start line records mode, cwd, model, and the workspace's `.koder/royal.enabled` consent timestamp (§6 Phase A).
- Rotation/pruning mirrors doc 08 §2.1's session pruning (keep N newest / M days) — audit logs are for recent forensics and postmortems, not indefinite compliance storage; if the product later needs the latter, that's a distinct, explicitly-scoped feature.

### 3.5 Kill switch

The seed already exists: `session/cancel` (`server.ts:216–218`) aborts `session.pending`, whose `AbortSignal` is threaded into `runPrompt` (checked at loop top and before each tool call, `loop.ts:142,190`) and into `bash`'s `execAsync({ signal })` (`tools.ts:197–203`), which relies on Node's `exec` honoring `signal` by SIGTERM-ing the child. This is a reasonable **in-loop** stop but has three gaps Royal must close:

1. **No escalation.** A child that ignores SIGTERM (or a grandchild process it spawned, since `exec` doesn't `detached: true`+kill the process group) survives. Royal's bash invocations need `detached: true` at spawn and `process.kill(-pid, 'SIGTERM')` → 2s grace → `process.kill(-pid, 'SIGKILL')` on the process group, not just the direct child.
2. **No sandbox/browser teardown.** Killing the loop doesn't tear down a Tier-1 srt sandbox process or close Tier-3 browser tabs/contexts the agent opened. The kill handler needs to own teardown of whatever containment layer is active for the in-flight tool call.
3. **No backstop above the protocol.** If the ACP connection itself is wedged (not just the tool call), `session/cancel` never arrives. `extension.js`'s `AcpClient.kill()` (`extension.js:61–63`, `this.child.kill()`) already exists as exactly this backstop — it needs to be surfaced as a **persistent, always-visible** "Stop Royal" control in the UI, not conditionally shown only mid-turn the way `#stop` is today (`extension.js:608`, `hidden` by default). For Royal specifically, this control should be visible for the entire lifetime of a Royal session, not just while a turn is streaming, since the whole point is the agent may be doing things between turns (spawned processes, background browser tasks) that outlive a single `session/prompt` call.

Per the kill-switch literature (§8): the switch must be **deterministic and outside the agent's own reasoning** — it cannot be a tool the model calls on itself, it cannot be negotiated via prompt, and per §3.1's tamper rule the agent cannot delete or disable it even with full filesystem access. On activation: write a final `"killed"` audit line with reason, leave the workspace exactly as it is (no auto-rollback — a human may need the in-progress state for postmortem), and surface a one-click "restore to last checkpoint" as a *separate*, explicit follow-up action.

---

## 4. OS-level and browser tool additions

### 4.1 OS-level tools (new, `royal`-only in the `allowedTools` filter at `loop.ts:133–134`)

| Tool | Schema (sketch) | `dangerous` | Sandbox tier | Notes |
|---|---|---|---|---|
| `process_manage` | `{ action: "list"\|"start"\|"stop"\|"restart", pid?, command?, name? }` | true | 1–2 | `list`/`stop` scoped to processes in the agent's own spawned process tree (tracked by PGID) — cannot see or kill arbitrary host PIDs; enforced by both the sandbox's process namespace and a floor check on `pid` ownership |
| `package_install` | `{ manager: "npm"\|"pip"\|"cargo"\|"brew"\|…, packages: string[], global?: boolean }` | true | 2 (default off-device, §7 item 2) | `global: true` or install paths outside the sandbox root floor-blocked; `sudo`-requiring installs floor-blocked per §3.1 |
| ~~`system_settings`~~ | — | — | — | **Deliberately not added.** §7 item 1. |
| ~~`fs_access` (beyond workspace)~~ | — | — | — | Not a Royal-autonomous capability. If ever needed, it's a per-path grant the *user* configures ahead of time (allowlist in workspace config), not something Royal requests or expands at runtime. |

`process_manage` and `package_install` only appear in `TOOLS` when `session.mode === "royal"`, mirroring how `loop.ts:134` already filters dangerous tools out entirely for `review`.

### 4.2 Browser access

**Recommendation: bundled Playwright instance in an ephemeral, isolated profile — not the existing claude-in-chrome-style shared-session extension.**

| | Bundled Playwright (recommended) | Reuse user's live Chrome (claude-in-chrome pattern) |
|---|---|---|
| Session/cookie exposure | None by default — fresh profile per Royal session, no access to the user's logged-in accounts unless explicitly provisioned | Full — the whole point of that tool family is acting inside the user's actual authenticated browser (bank sessions, personal email, work SSO) |
| Blast radius on agent error | Contained to a throwaway profile; worst case, discard it | Real accounts, real purchases, real emails sent |
| Fits "zero oversight" | Yes — matches the containment-over-trust posture this whole doc argues for | No — that tool family is explicitly designed for a human watching each site-permission prompt (`extension.js`-style permission bar equivalent), which is the opposite of Royal's premise |
| Auditability | Every action goes through our own tool wrapper → our audit log, HAR/screenshot capture straightforward | Would require intercepting an extension we don't control end-to-end |
| Setup cost | New dependency, own lifecycle management | Already exists in the product surface, zero new integration |

The claude-in-chrome pattern is the right tool for a *supervised* browsing task where a human is approving per-site access as they go (exactly its documented model: site-level gating, "allow once" vs "always allow this site," per Claude Help Center — §8). That supervision model is structurally incompatible with Royal's "no blocking approval" premise. Reusing it for Royal would mean either (a) silently auto-approving every site permission prompt — which defeats the extension's entire safety design — or (b) blocking on those prompts, which defeats Royal. Neither is acceptable, hence: separate, bundled, ephemeral, sandboxed browser surface for Royal, with the claude-in-chrome-style tools remaining available (unchanged) for `approve`/`auto` modes where their supervision model is intact.

**New tools**: `browser_navigate`, `browser_act` (click/type/scroll), `browser_extract` (text/DOM), `browser_screenshot` — all `dangerous: true`, Tier 3 sandbox, `royal`-only.

**Hard floor rules specific to browser actions** (directly adapted from Claude in Chrome's own published ban list, §8 — a real, battle-tested precedent for exactly this problem):

| Banned outright, all modes that have browser tools | Requires confirmation even inside Royal's "no blocking" model — logged + auto-declined by default, escalates async rather than executing |
|---|---|
| Purchases / payment submission | — (no confirmation path in Royal; permanently blocked, see below) |
| Account creation | — |
| Bypassing CAPTCHA / bot-auth | — |
| Executing trades | — |
| Permanent/irreversible deletion on third-party services | — |
| Submitting credentials to non-allowlisted domains | — |
| Anything matching a prompt-injection signature on the page (a site instructing the agent to take an action) | — |

Note the right column is empty by design: Royal has no synchronous confirmation channel (that's the whole premise), so anything Claude in Chrome would normally ask a human about, Royal must **decline outright** and log it, then surface it through the async notification channel (§3.5-adjacent, `koder/royal_notice`) for the user to handle later if they want the task to proceed. This is the concrete resolution of "no blocking, but not silent either": the agent never stalls waiting for an answer, but also never takes an action that class of task would normally require one for.

Every browser action gets a line in a `royal-audit` sub-log with a screenshot reference (stored alongside, path in the log entry) — browser state changes are the hardest category to reconstruct after the fact from text alone, so this is worth the extra storage.

---

## 5. Self-learning / self-healing mechanism

**What exists today** (do not reinvent — extend):

- `loop.ts:212–219`: `lastToolSig`/`toolRepeatCount` catches **identical** tool call + input repeated consecutively; at 4 repeats it force-ends the turn (`loop.ts:230–242`).
- `loop.ts:246–257` (`editFails` map): per-path consecutive `edit_file` failures get an escalating hint ("re-read the file" → "stop retrying, use write_file instead"), reset on success or on any `read_file` of that path.
- Doc 08 §2.2's designed (not-yet-built) `remember` tool + `~/.koder/memory/MEMORY.md` (global) / `<workspace>/.koder/memory.md` (project): model-writable, dated bullets, injected into `systemPrompt()` at an 8 KiB cap, scrubbed of secrets, with an opt-in end-of-task reflection pass (doc 08 §2.2 point 3) that writes ≤3 auto-memories per session, always visible in the transcript.

**The gap both mechanisms share**: they catch *the same action repeated*, not *different actions failing for the same underlying reason* — Devin's documented "infinite edit-run-fail loops" failure mode (doc 04, `04-ux-patterns-performance.md:30`) is exactly this: the agent keeps trying superficially different fixes for a problem it has fundamentally misdiagnosed. Identical-call detection never fires because each attempt looks different at the tool-call level.

### 5.1 In-session: outcome-signature loop detection (extends `loop.ts`)

Generalize `toolRepeatCount` from `sig = name + JSON(input)` to also track a **verification-outcome signature**: after a verify-style command (`bash` running test/build/typecheck, detected heuristically the same way doc 08's compaction rubric already asks the model to report verify status) fails, extract a normalized error signature (e.g. `TS2345` + file, or a specific failing test name) and track it in a small rolling window (last 8 tool calls, matching doc 08's loop-detection window framing). If the **same error signature** recurs 3 times across *different* edit attempts:

1. Force a read-only reflection step (no tools that turn): "You've hit this error 3 times with different fixes. State your hypothesis for the root cause before trying again."
2. If it recurs a 4th time after that: in `royal` mode specifically (no human to notice the thrash), immediately trigger the cross-session write in §5.2 and pause the task, surfacing an async notification — do not keep burning tool calls unattended. In `approve`/`auto`, the existing transcript-visible escalation (`loop.ts:236`, "stopped: repeated identical actions") is sufficient since a human is already watching.

This is ~30–40 lines added to `loop.ts`, reusing the exact same `Map`-based tracking shape as `editFails`, not a new subsystem.

### 5.2 Cross-session: causal-lesson writes (extends doc 08's memory, not a new store)

On the trigger in §5.1 (or on any task that ends without the verify contract passing), write a structured bullet through the **same** `remember` tool / `MEMORY.md` path doc 08 designs — not a parallel memory system:

```
- [2026-07-14] [project] symptom: TS2345 on AnthropicAdapter.runTurn arg — cause: assumed `usage` was always defined, provider omits it on non-streamed calls — fix: `usage?.inputTokens ?? estimate()` — verified: typecheck+test pass
```

Format: `symptom → cause → fix` (or, if unresolved: `symptom → tried: [X, Y] → unresolved, avoid retrying X`), directly mirroring the causal-memory pattern from the self-healing-agent literature (§8: "403 error → missing header → added header → success") but implemented as one more markdown bullet in the file doc 08 already specifies, injected the same way (system prompt, `<memory scope=project>`, 8 KiB cap, oldest-dropped) — **no new injection mechanism, no new store, no new file format.**

**The one behavioral difference from doc 08's design**: doc 08 §2.2 point 3 makes end-of-task reflection **opt-in** (a flag), because in `approve`/`auto` a human is present and can say "remember this" explicitly (point 2) — auto-writing by default would be noisy. In `royal`, there is no human to ask, so the causal-lesson write is **unconditional** on the specific trigger (repeated-failure-signature or unverified task end) — not a general "summarize what happened" pass, which would still be noisy, but scoped tightly to "something went wrong more than once, here's what was learned," which is exactly the situation where an absent human would most want a durable record. The "always visible in the transcript" guarantee (doc 08 §2.2) is kept and becomes more important, since it's the only way the user finds out later that a lesson was written at all.

**Consolidation**: reuses doc 08 §2.3/Phase-C's existing 32 KiB soft-cap + consolidation-into-topic-files mechanism verbatim — causal lessons are just more bullets in the same file, subject to the same pruning.

**Explicitly not proposed**: no vector-embedded causal graph, no fine-tuning, no agent-authored changes to its own prompt or floor rules (that would violate §3.1's tamper rule and the "kill switches don't work if the agent writes the policy" principle from the literature — §8). The mechanism is deliberately as boring as doc 08's own philosophy: **memory is files the model edits with ordinary, visible operations; the harness only mounts, injects, and caps it.**

---

## 6. Phased implementation plan

Sequencing note up front: shadow-git checkpointing (§3.3) and srt sandboxing (§3.2) are **designed in doc 07/03 but not built**. Royal mode's core promises — "contained blast radius," "any action reversible" — are not honest claims until both exist. Phase A therefore does **not** ship a feature-complete Royal mode; it ships the floor-hardening and audit-log pieces that are valuable independent of Royal, plus a minimally-scoped Royal that has *no new capability* beyond today's `auto` — just a real floor. Phase B is where sandboxing, checkpointing, OS tools, and browser access actually land. This is the honest ordering; do not let "Royal" ship as a marketing label before §3.2/§3.3 exist under it.

### Phase A — floor hardening + audit log + kill-switch fix (3–5 days, no new tools)

| # | Change | File | Sketch |
|---|---|---|---|
| A1 | `floorCheck()` — deterministic destructive-action denylist (§3.1 table) | new `agent/src/floor.ts` | Pure function, regex + path resolution, no I/O; called from `loop.ts` before the mode branch (line 199) in **all** modes |
| A2 | Audit log | new `agent/src/audit.ts` | `logAudit(entry)` appends JSONL to `~/.koder/royal-audit/<sessionId>.jsonl`; hook into the existing `onToolStart`/`onToolEnd` callback points already wired through `server.ts:161–176`; reuse `scrubSecrets` from `context.ts` |
| A3 | Kill-switch hardening | `tools.ts`, `server.ts`, `extension.js` | `bash` spawns `detached: true`; `session/cancel` escalates SIGTERM→SIGKILL on the process group after a 2s grace; extension surfaces a persistent Stop control for the session lifetime, not just mid-turn |
| A4 | `royal` mode added, tool-set identical to `auto` | `loop.ts` (`AgentMode`, `modeBlock`), `server.ts` (`MODES`) | Same six tools; the only functional delta vs `auto` at this phase is A1–A3 applying; `modeBlock()` gets a `royal` branch stating the floor is enforced, not advisory |
| A5 | Informed-consent gate | `extension.js`, new `~/.koder/royal-consent/<workspace-hash>.json` marker | First switch to Royal per workspace shows a one-time modal (what it can do, what the floor still blocks, where the audit log lives, and — Phase A specifically — that no sandbox exists yet so Royal is not for unattended OS-level use); writes the marker + consent timestamp outside the workspace (per §7 item 4's tamper boundary — a workspace-local marker the agent could itself edit would defeat the point of "informed consent"), logged as the audit session-start line |

Order: A1/A2 (mechanical, independent) → A3 (touches three files, do it once) → A4/A5 (wire the mode).

**Phase A caveat, stated plainly for the consent modal's copy**: at the end of Phase A, Royal has a real deterministic floor (A1) and a hardened kill switch (A3), but **no sandbox and no checkpoint** — those ship in Phase B. A regex/path floor is a last-line backstop, not a containment boundary (§3.1); until Phase B lands, it is the *only* barrier standing behind Royal's permission bypass. Phase A's Royal should therefore be scoped and marketed as "auto mode with a real floor and an audit trail," safe for the same class of tasks `auto` is safe for today — not as "unattended OS-level autonomy," which only becomes an honest claim once Phase B's sandboxing and checkpointing exist.

### Phase B — sandboxing, checkpointing, OS tools, browser (2–3 weeks)

1. **Wire srt around `bash`** (§3.2 Tier 1) — `tools.ts`'s bash tool gains a sandbox wrapper (Seatbelt profile on macOS, bubblewrap on Linux) confining writes to `cwd` + declared temp dirs, network allowlisted to package registries. Ship for `royal` first; evaluate promoting to `auto` once proven.
2. **Shadow-git checkpoint, for real** (§3.3) — implement doc 07's design: `agent/src/checkpoint.ts`, `~/.koder/checkpoints/<hash>/`, commit-before-mutation, SHA recorded in the A2 audit log, restore surfaced in the extension as a user action (never a model tool).
3. **OS-level tools** (§4.1) — `process_manage`, `package_install`; added to `TOOLS` only under `session.mode === "royal"` in the `loop.ts:133–134` filter; each floor-checked (A1) and sandboxed (Tier 2, defaulting off-device per §7 item 2 — this likely means Phase B's *local* implementation ships Tier-2 tools gated behind a separate "run on this machine" opt-in, with the off-device path as a fast-follow).
4. **Browser tools** (§4.2) — bundled Playwright, ephemeral profile per session, `browser_navigate/act/extract/screenshot`, hard-ban table enforced in the tool implementations themselves (belt-and-suspenders with A1's floor), screenshot-referenced audit sub-log.
5. **Async notification channel** — new ACP notification `koder/royal_notice` (`{level: "info"|"needs_review"|"blocked", text, auditRef}`), extension surfaces as an OS-level notification (not a blocking dialog) and a persistent "needs review" badge, matching the triage-inbox pattern doc 04 already recommends for multi-agent (`04-ux-patterns-performance.md` §3).

### Phase C — self-healing loop (1 week, depends on doc 08 Phase C shipping first)

1. Outcome-signature loop detection (§5.1) — extend `loop.ts`'s repeat-tracking `Map`s.
2. Unconditional causal-lesson write on trigger (§5.2) — routes through doc 08's `remember` tool/`MEMORY.md`, so **this phase has a hard dependency on doc 08 Phase C shipping first** (the memory store, injection, and consolidation mechanism must already exist; Royal only adds a new, stricter write-trigger to it).
3. Consolidation — no new work; doc 08 §2.3's existing 32 KiB cap/consolidation absorbs the extra volume.
4. Optional, human-facing (not agent-autonomous): a periodic rollup of `royal-audit` logs surfacing repeat floor-blocks as product-facing suggestions ("Royal has been blocked from force-pushing 4 times this week — enable it explicitly?") — this is a UX feedback loop for the *user*, deliberately kept out of the agent's own loop per §7 item 7.

---

## 7. What should NOT be in Royal mode — explicit pushback

The user asked for zero intervention, OS access, and browser access. Building all of that as asked, without pushback, would be a mistake. Here is where the line sits and why:

1. **No `system_settings` tool.** OS preferences, credential-store access (Keychain/Credential Manager), firewall rules, user/permission management. This tier can't be meaningfully sandboxed (changing system settings *is* escaping containment by definition) and isn't required by "shipped software quality," Koder's actual mission (PLAN.md §1). If a real use case emerges, it routes through async-approval, never silent Royal autonomy.
2. **OS-level tools (Tier 2) should default to a disposable off-device sandbox, not the user's real machine.** "Zero human oversight" + "arbitrary process/package control" + "the user's actual laptop" is the single riskiest combination in this design space. Running Tier 2 in a throwaway container/microVM (E2B/Firecracker, already in doc 02/03's toolkit) converts "trust the sandbox to be perfect" into "worst case, discard a VM and inspect the checkpoint diff." Local execution should require a separate, explicit opt-in beyond just enabling Royal mode.
3. **No reuse of the user's live, authenticated browser.** Argued in full in §4.2. A zero-oversight agent should never inherit the user's real logged-in sessions (bank, personal email, work SSO). Bundled + ephemeral + unauthenticated-by-default only; if a task genuinely needs authentication, that's a user-provisioned, scoped credential the agent uses without being able to read or exfiltrate it raw — not a handoff of the user's actual browser.
4. **No self-modification of the safety substrate, ever, even with full filesystem access.** The floor rules (`floor.ts`), the audit log, the kill-switch code, the mode/permission config, and the checkpoint mechanism must stay outside what Royal can edit or delete — enforced both by the path rule in §3.1's floor table and, ideally, by keeping these files genuinely outside the workspace tree (`~/.koder/`, not `<workspace>/.koder/`). This is the direct engineering answer to "kill switches don't work if the agent writes the policy" (§8) — it has to be true structurally, not by convention.
5. **No purchases, payments, account creation, or contractual actions (accepting ToS, signing up for paid services) — anywhere, any mode with browser or OS access.** Matches Claude in Chrome's own published ban list (§8) almost exactly; there's no reason Royal should be more permissive than a tool built for supervised use.
6. **No self-continuation across turns, v1.** `runPrompt` already stops issuing tool calls and returns `"end_turn"` when the model has nothing left to do (`loop.ts:184–186`), and `session/prompt` then waits for the next human-sent message — there is currently no mechanism for the agent to re-prompt itself into a new turn. Royal must **not** add one in v1: self-re-prompting is itself the runaway-process vector this item exists to prevent, and it composes badly with everything else in this doc (a self-continuing agent burns through checkpoints, audit volume, and sandbox lifetime unattended, exactly the scenario with the least oversight). So: Royal v1 is a single enriched turn — a raised `MAX_ITERATIONS`, plus a wall-clock/tool-count ceiling *within that turn* — that hard-stops and async-notifies at `end_turn` or ceiling breach, the same as any other mode, just with more headroom and no permission prompts along the way. A future multi-task queue is a distinct, explicitly-scoped feature with its own review, not an implicit consequence of "zero intervention."
7. **No agent-authored changes to its own policy, even via the "self-learning" mechanism.** The causal-lesson memory in §5.2 writes to project/global *memory* files only — it must never be permitted to propose or apply edits to the floor rules, the system prompt template, or its own permission/sandbox config, no matter how well-justified a given "lesson" might sound. This is the same tamper boundary as item 4, restated for the specific case where the mechanism generating the edit is the agent's own reflection rather than a direct tool call — the boundary has to hold regardless of which code path is trying to cross it.

None of these are "temporary until v2" hedges. They're the shape of the product's answer to "how autonomous is too autonomous" — Royal mode should be sold as *maximally autonomous within a hard containment boundary*, not *unrestricted*, and the marketing/UX (the informed-consent modal in Phase A, item A5) should say so explicitly rather than implying zero limits.

---

## 8. Sources

- **This codebase**: `agent/src/loop.ts`, `agent/src/server.ts`, `agent/src/tools.ts`, `product/koder-chat/extension.js`, `docs/research/01-editor-foundation.md`, `02-agent-intelligence.md`, `03-oss-building-blocks.md` §5, `04-ux-patterns-performance.md` §2–3, `07-enterprise-chat-panel.md`, `08-memory-context-engineering.md`, `PLAN.md`.
- **Anthropic, "How we built Claude Code auto mode: a safer way to skip permissions"** — two-stage classifier (Stage 1 single-token, 8.5% FP tuned for recall; Stage 2 chain-of-thought, reduces to 0.4% FP), reasoning-blind design (strips the agent's own messages/tool outputs before judging), three-tier allowlist (safe ops bypass entirely; in-project edits bypass the classifier as git-reviewable; shell/network/out-of-project hits the classifier), escalation after 3 consecutive or 20 total blocked actions, **17% false-negative rate on documented overeager actions** (the number that justifies not leaning on the classifier alone as Royal's safety mechanism) — `anthropic.com/engineering/claude-code-auto-mode`.
- **Cognition (Devin)** — plan-then-execute with dynamic re-planning, sandboxed cloud environment (shell/browser/editor/subagents), custom `blockdiff` VM snapshot format (30 min → ~200ms → ~15s snapshot time), checkpoint restore rolls back files *and* memory, streaming updates with in-flight correction (bidirectional but non-blocking) — Cognition product-update blog posts, `docs.devin.ai`.
- **OpenHands** — Docker-container-per-task runtime, action/observation protocol over a controller↔sandbox socket/REST boundary, bind-mount/overlay filesystem control, port-allocation isolation; notably **no explicit dangerous-action policy at the runtime layer** — confirms that containment (sandboxing) and policy (a floor) are separate concerns neither Devin's nor OpenHands' public docs conflate, which this design also keeps separate (§3.1 vs §3.2) — `docs.openhands.dev/openhands/usage/architecture/runtime`.
- **Claude in Chrome permissions** — site-level gating ("allow this action" vs "always allow actions on this site"), site blocklists, action confirmations for high-risk actions (downloads, sensitive-info entry), and a hard ban list (no purchases, no account creation, no bypassing bot-auth, no trades, no permanent deletion, refuses actions resembling prompt injection) — the direct precedent for §4.2's browser floor table — `support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide`, `support.claude.com/en/articles/12902428-use-claude-in-chrome-safely`.
- **Kill-switch design literature** — infrastructure-level, deterministic, outside the agent's own reasoning ("cannot ignore it, override it, or negotiate with it through prompts"), state-capture + immutable logging, rollback-and-quarantine, cooperative stopping over forceful kills, watchdog/sidecar patterns — general survey across `miniorange.com/blog/ai-kill-switch-architecture`, `93days.me`, `theproductjourney.substack.com`; **"Kill Switches Don't Work If the Agent Writes the Policy"** (Stanford CodeX, Berkeley Agentic AI Profile analysis) — the direct source for §7 item 7's framing, `law.stanford.edu/2026/03/07/kill-switches-dont-work-if-the-agent-writes-the-policy...`.
- **Self-healing/causal memory literature** — episodic/semantic/procedural memory layering, causal chains ("symptom → cause → fix"), reflect→extract→store→retrieve lesson loops, and Claude Code's own leaked three-layer `memory.md`-as-pointer-index architecture (which doc 08 already independently converges on) — `mindstudio.ai/blog/claude-code-source-leak-memory-architecture`, `blog.gopenai.com` (self-healing agents with causal memory), `medium.com/@kumaran.isk` ("your AI agent makes the same mistake twice").
