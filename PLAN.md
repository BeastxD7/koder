# LakshX — Implementation Plan

**Mission:** The world's best IDE for agentic development — where "best" is measured by the **shipping quality of the software its users produce**, delivered through world-class software performance and UI/UX.

Backed by four research reports in `docs/research/` (editor foundation, agent intelligence, OSS building blocks, UX patterns — all sourced, state of the art as of July 2026).

---

## 1. Positioning: what we learned, in one paragraph

Generation speed is solved and SWE-bench is saturated; ~20% of "solved" benchmark tasks are semantically wrong. Cursor won on distribution, not editor quality; the OSS AI-IDE graveyard (Void, Melty, Roo, Fleet) proves the shell is not the moat. The two under-served axes are exactly ours: **(a) shipped-code quality** — verification loops, deterministic quality gates, and critic passes that make "agent says done" actually mean done — and **(b) review throughput** — the human approval queue is the real bottleneck (93% of permission prompts get rubber-stamped today). LakshX wins by making the agent *provably* finish work, and making the human's review of that work fast, legible, and safe.

## 2. Foundation decision

**Decision: a deliberately THIN fork of code-oss (VS Code open source), Electron-based, extension-first.**

Why (see `docs/research/01-editor-foundation.md`):
- Only route with repeated startup-scale existence proofs (Cursor: ~1 yr, <10 people → shipped). Time-to-market dominates for a small team.
- Costs are known and budgetable: 1–3 FTE upstream-merge tax, Open VSX registry (now 1.0, AWS/Google/Cursor-backed), ship replacements for Pylance/C++/Remote-SSH (BasedPyright, clangd — same gap Cursor lives with).
- Discipline rule: **everything that can be an extension IS an extension.** Fork-only changes are confined to what extensions cannot do: inline diff rendering, agent chrome, the review multi-buffer, shadow workspaces. Divergence discipline is the entire game (Cursor's 5-month-stale-base revolts are what indiscipline looks like).
- **Adopt ACP (Agent Client Protocol) from day one** — our agent runtime stays editor-independent, and Claude Code / Codex CLI / Gemini CLI plug in as first-class alternative runtimes. This hedges the foundation bet itself.

**Documented escape hatch:** if raw editor speed ever becomes the wedge, the path is a GPL open-core Zed fork (native 2–10ms latency band, unreachable on Electron). Because our agent layer speaks ACP and lives out-of-process, it ports. We are not choosing this now: our differentiator is shipped-product quality, not keystroke latency, and Electron is where the ecosystem is.

Rejected: Theia (no consumer-devtool precedent, same Electron ceiling, not-quite-VS Code friction), from-scratch web (12–24 months rebuilding commodity chrome), Tauri (triple-webview inconsistency — disqualifying for an editor), from-scratch native (Zed's actuals: 5 years, $42M, 20 elite engineers).

## 3. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  LakshX Shell (thin code-oss fork, Electron)                │
│  • Review multi-buffer (fork-level)  • Agent threads UI    │
│  • Inline diff decorations           • Command palette     │
│  • Permission ladder UI              • Context rail        │
├────────────────────────── ACP ─────────────────────────────┤
│  LakshX Agent Runtime (own process, TypeScript or Rust)     │
│  • Thin loop: gather → act → verify (mini-SWE-agent-sized) │
│  • Event-sourced state + deterministic replay (OpenHands   │
│    SDK pattern, MIT)                                       │
│  • Hooks: PreToolUse / PostToolUse / Stop (quality gates)  │
│  • MCP client (Playwright, Chrome DevTools, custom)        │
│  • Model router: Opus-class brain / Fable-class escalation │
│    + critic / Sonnet-Flash tier subagents / Zeta tab model │
├────────────────────────────────────────────────────────────┤
│  Context Engine (local-first)                              │
│  • ripgrep primary  • tree-sitter symbol graph + PageRank  │
│    repo map  • NATIVE LSP bridge (diagnostics, refs,       │
│    go-to-def fed to agent — our unfair advantage)          │
│  • Optional: LanceDB + fastembed embeddings, Merkle-tree   │
│    incremental indexing (large repos only)                 │
├────────────────────────────────────────────────────────────┤
│  Safety Substrate                                          │
│  • Shadow-git checkpoints (every mutation, instant rollback)│
│  • Worktree per parallel agent                             │
│  • OS sandbox: Anthropic srt (Seatbelt/bubblewrap)         │
│  • Cloud tier later: Firecracker microVMs (E2B/self-host)  │
└────────────────────────────────────────────────────────────┘
```

### 3.1 The Quality Engine (the moat)

This is the differentiator. Quality is enforced by the **harness, not the prompt**:

1. **Verify contract per project** (`lakshx.verify.json` / auto-detected): ordered fastest-first — typecheck → lint → targeted tests → full suite → build. The agent **cannot declare done** until the contract passes (Stop-hook enforced).
2. **Critic pass**: a separate fresh-context agent audits the final diff against the original intent before it ever reaches the human — catches "plausible but wrong."
3. **Runtime verification** for UI-affecting changes: Playwright/Chrome-DevTools MCP drives the actual app; screenshots and console errors feed back into the loop.
4. **Loop detection**: N failed edit-run-fail cycles → agent escalates to human as "stuck," never spins.
5. **Receipts everywhere**: every tool call records command, diff, permission tier, rollback link — auditable and replayable (event-sourced state).

### 3.2 Retrieval (layered, agentic-first)

Grep won the primary-retrieval war (Anthropic data), but hybrid is the frontier (+12.5% on large codebases, Cursor data). Layers: ripgrep → tree-sitter repo map (Aider-style PageRank) → native LSP (precision "who-calls-this") → optional local embeddings. All local-first; nothing leaves the machine by default.

### 3.3 Permission ladder (Claude Code model, the proven best practice)

Plan (read-only) → Ask → Accept-edits → Auto (classifier-backed) → Bypass. One chord cycles. Risk-tiered: in-project edits free, shell/network/out-of-tree gated. Never prompt for what 93% of users rubber-stamp.

## 4. UX architecture (three-zone shell)

- **Left — Agent Threads sidebar** (Zed model): per-thread state badges (planning / working / blocked / awaiting-review / done), per-thread folder permissions, "needs me" triage queue at top. This IS the multi-agent inbox.
- **Center — Editor + Review multi-buffer**: a real, fast editor always one keystroke away. Agent changesets open as an editable unified multi-buffer — all hunks, all files — with per-hunk **accept / reject / "instruct instead."** Follow-the-agent viewport toggle. Streamed edits for visibility, atomic apply for safety, shadow-git restore underneath.
- **Right — Context rail** (collapsible): editable plan, tool receipts, live preview with click-element-to-agent-context (Windsurf's best feature), terminal.
- **Command palette as the spine**; every action bindable; keyboard-first.
- Semantic-token theming system, light+dark designed together; motion only to explain state changes.

### Performance budgets (commitments, CI-enforced where possible)

| Interaction | Budget |
|---|---|
| Keystroke → glyph | ≤16ms end-to-end (Electron floor; measure with Typometer) |
| Palette / tab switch / panel toggle | <50ms |
| Local action feedback (optimistic UI) | <100ms |
| First streamed token | <1s |
| Streaming re-parse | 50–100ms debounce, incremental parser |
| All lists/trees/diffs | virtualized |
| Checkpoint restore | <500ms perceived |

## 5. Build vs. adopt (final)

| Layer | Decision |
|---|---|
| Shell | Fork code-oss via VSCodium build recipe (MIT) |
| Extensions | Open VSX + vetting; ship BasedPyright/clangd replacements |
| Agent loop | **Build** (thin), event-sourced; ACP client for Claude Code/Codex/Gemini interop; study Cline (Apache-2.0) |
| Parsing/structural | tree-sitter + ast-grep (MIT) |
| Search | ripgrep; LanceDB + fastembed for optional embeddings |
| LSP catalog | mason-registry data (Apache-2.0) for one-click server installs |
| Terminal | xterm.js + node-pty (already in code-oss) |
| Git | git CLI as source of truth + gitoxide hot read paths; VS Code's MIT merge editor |
| Sandbox | Anthropic srt now; E2B/Firecracker for cloud tier later |
| Tab completion | Zeta (Apache-2.0, open weights) — don't train our own on day one |
| Fast-apply | Morph/Relace behind a deletable abstraction |
| **Never** | WebContainers (proprietary), Zed app crates (GPL), Warp client (AGPL), stack-graphs (dead), sqlite-vec (stalled) |

## 6. Roadmap

### Phase 0 — Foundations (weeks 1–4)
- Fork code-oss with VSCodium recipe: rebrand, product.json, Open VSX wiring, build/sign/notarize/update pipeline for macOS first.
- Run Typometer baseline across VS Code/Cursor/Zed/LakshX — establish the perf dashboard from day one.
- Spike: ACP client in the shell talking to Claude Code via `claude-agent-acp` — proves the architecture and gives us a working frontier agent in week ~2.
- Import-from-VS Code/Cursor settings wizard (the proven migration killer-feature).

### Phase 1 — MVP: one great agent, one great review loop (weeks 5–14)
- LakshX Agent Runtime v1: thin loop, event-sourced state, hooks, model router, shadow-git checkpoints, srt sandbox.
- **Verify contract v1** (auto-detect npm/cargo/pytest/etc.) + Stop-hook enforcement.
- Review multi-buffer v1 (fork-level): unified changeset, per-hunk accept/reject/instruct.
- Permission ladder (Plan/Ask/Accept-edits; Auto comes later).
- Agent threads sidebar, plan-first flow, streaming UX to budget.
- Context engine v1: ripgrep + tree-sitter repo map + LSP diagnostics feedback.
- Zeta tab completion.
- **Exit criteria:** an agent completes a real multi-file task in a real repo, passes the verify contract, and the human reviews and lands it entirely inside LakshX — measurably faster and with fewer post-merge defects than the same task in Cursor.

### Phase 2 — The quality moat (weeks 15–26)
- Critic pass on final diffs; loop detection + stuck-escalation.
- Runtime verification: Playwright/DevTools MCP, live preview panel with click-element-to-context.
- Auto permission mode (classifier-backed, receipts, escalation backstop).
- Parallel agents on worktrees + triage inbox (capped default parallelism).
- Local embeddings tier (LanceDB + Merkle incremental) for monorepos.
- Skills/AGENTS.md conventions; per-project memory.
- Windows/Linux builds; Open VSX extension vetting pipeline.

### Phase 3 — Scale & polish (weeks 27+)
- Cloud/background agents (Firecracker tier) delivering changesets into the same review multi-buffer.
- Team features: shared verify contracts, shared skills, quality dashboards ("defect escape rate" as the headline metric).
- Deep perf pass against budgets; upstream-merge cadence locked (≤2 months behind, always).
- Pricing: transparent per-token + real BYOK (the community's #1 unmet demand; Replit's bill-shock and Cursor's crippled BYOK are the anti-patterns).

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Upstream merge tax compounds | Thin-fork discipline; extension-first; ≤2-month lag SLO; budget 1 FTE from day one |
| Microsoft hostility escalates | Already planned around: Open VSX, OSS language-server replacements |
| Model vendor lock/pricing shifts | ACP multi-runtime + own loop + model router; fast-apply behind deletable abstraction |
| "Fastest IDE" claim vs Electron ceiling | Reframe: fastest *agentic workflow* (task→verified→reviewed→merged), publish honest benchmarks; Zed-fork escape hatch documented |
| Review-queue debt in multi-agent | Triage inbox ships BEFORE fleet features; capped parallelism |
| Agent hangs/runaway loops destroy trust | Visible per-agent state machine, hard stop, loop detection, receipts |
| OSS AI-IDE graveyard pattern (shell ≠ moat) | Moat = quality engine + review UX + verify contracts, all deep product work, not shell reskinning |

## 8. Success metrics

1. **Defect escape rate**: bugs found after agent-authored code lands (the "end product quality" north star).
2. **Verify-pass-first-try rate**: % of agent tasks passing the contract without human intervention.
3. **Review throughput**: median time from agent-done → human-landed.
4. Keystroke latency & frame-time percentiles vs budgets (Typometer in CI).
5. Task-completion benchmark vs Cursor/Claude Code on identical real-repo tasks.
