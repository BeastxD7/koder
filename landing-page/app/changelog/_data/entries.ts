export type ChangelogCategory = "Agent" | "Security" | "Databases" | "Docs" | "Build/Distribution" | "UI";

export interface ChangelogEntry {
  /** Committer date, YYYY-MM-DD (matches `git log --date=short`). */
  date: string;
  /** Short commit hash — links straight to the commit on GitHub. */
  hash: string;
  category: ChangelogCategory;
  text: string;
}

/**
 * Sourced directly from this repo's real commit history — captured with
 * `git log --format="%ad|%h|%s" --date=short` across the whole tree, every
 * commit from the initial commit through the latest at the time this page
 * was written (164 commits, 2026-07-14 through 2026-07-17). Every entry
 * below traces to exactly one commit hash; nothing here is invented.
 *
 * Subjects are lightly re-cased for readability (the repo's own scope
 * prefixes — `ci:`, `landing-page:`, `lakshx-db:`, etc. — are expanded into
 * a readable label, e.g. `ci: fix X` -> "CI: Fix X") but never reworded in a
 * way that changes the underlying claim. Baked in at build time; this file
 * is not fetched from GitHub at runtime.
 *
 * To refresh after new commits land, re-run:
 *   git log --format="%ad|%h|%s" --date=short --reverse
 * and extend the array below (newest commits go at the end — the page sorts
 * for display, this array's own order doesn't matter).
 */
export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  { date: "2026-07-14", hash: "9ccd209", category: "UI", text: "Initial commit: plan, research, thin-fork repo skeleton" },
  { date: "2026-07-14", hash: "aba55ed", category: "Build/Distribution", text: "Phase 0: build pipeline (fetch/prepare/dev), Koder+Open VSX overlay, ACP spike passing" },
  { date: "2026-07-14", hash: "87f3b47", category: "UI", text: "Add perf budgets + Typometer baseline protocol" },
  { date: "2026-07-14", hash: "a8bacd8", category: "UI", text: "Koder UI revamp: Koder Dark theme, modern defaults, CSS animation layer" },
  { date: "2026-07-14", hash: "d4979ac", category: "Agent", text: "Koder Agent Runtime v1: BYOK providers, tool loop, ACP server" },
  { date: "2026-07-14", hash: "1f9da7d", category: "UI", text: "Koder AI engine surface + de-VSCode pass" },
  { date: "2026-07-14", hash: "198f39d", category: "Agent", text: "Round 2: right-side agent panel, in-panel BYOK settings, icon de-VSCode" },
  { date: "2026-07-14", hash: "b86d683", category: "Agent", text: "Fix: Built-in chat resurrection + agent panel discoverability" },
  { date: "2026-07-14", hash: "34fcf46", category: "Agent", text: "Round 3: provider-dropdown BYOK UI, real icon render, bundled runtime" },
  { date: "2026-07-14", hash: "a9dc57e", category: "Build/Distribution", text: "Packaging: Skip copilot ripgrep shim, distributable build verified" },
  { date: "2026-07-14", hash: "4d21a07", category: "Agent", text: "Agent panel opens every startup; spawn errors surface in output channel" },
  { date: "2026-07-14", hash: "0137db1", category: "Build/Distribution", text: "Cross-platform fixes + CI build matrix" },
  { date: "2026-07-14", hash: "926bb67", category: "Build/Distribution", text: "Gitignore packaged build output" },
  { date: "2026-07-14", hash: "bc34967", category: "UI", text: "Koder letterpress watermark; hard-disable built-in chat on first run" },
  { date: "2026-07-14", hash: "cc5ad23", category: "Agent", text: "Live BYOK: key validation on save + real model lists from provider APIs" },
  { date: "2026-07-14", hash: "bd0ea08", category: "UI", text: "Fix stale webview: cache-bust panel resources by mtime" },
  { date: "2026-07-14", hash: "bf3ae48", category: "UI", text: "Fix: [hidden] must beat display:flex — the sheet was never visually closing" },
  { date: "2026-07-14", hash: "639f24f", category: "UI", text: "Enterprise chat panel v2: modes, thinking streams, history, markdown" },
  { date: "2026-07-14", hash: "e666d6e", category: "UI", text: "Wire markdown link clicks (open external/workspace files); research backlog doc" },
  { date: "2026-07-14", hash: "098b041", category: "UI", text: "Plan approval gate, clarifying questions, UI symmetry" },
  { date: "2026-07-14", hash: "0a67768", category: "UI", text: "Derive chat titles from first user message; backfill old untitled chats" },
  { date: "2026-07-14", hash: "4a98659", category: "Agent", text: "Fix 5 runtime bugs found by dedicated test agent; add unit+e2e test suite" },
  { date: "2026-07-14", hash: "d23b892", category: "Build/Distribution", text: "CI: Gate platform build matrix on a fast typecheck+test job" },
  { date: "2026-07-14", hash: "65e387a", category: "UI", text: "Fix CI/CD: shell portability bug + 3 platform build failures" },
  { date: "2026-07-14", hash: "b824542", category: "UI", text: "Fix sidebar/list content clipped at right edge (box-sizing overflow)" },
  { date: "2026-07-14", hash: "8389709", category: "UI", text: "Phase A: memory/context engineering quick wins" },
  { date: "2026-07-14", hash: "ba3ed4a", category: "Agent", text: "Fix: Opening the agent panel alone created a persisted \"Untitled chat\"" },
  { date: "2026-07-14", hash: "8397c34", category: "Build/Distribution", text: "CI: Raise macOS fd limit before upstream npm ci — fixes real ENOENT cause" },
  { date: "2026-07-14", hash: "fae3695", category: "Build/Distribution", text: "CI: Full 4-platform build only on release tags or manual dispatch" },
  { date: "2026-07-14", hash: "849d211", category: "Build/Distribution", text: "CI: Raise ulimit to hard ceiling + add before/after diagnostics" },
  { date: "2026-07-14", hash: "16fb15e", category: "Build/Distribution", text: "CI: Fix real macOS build failure — dirs.ts still lists deleted copilot dir" },
  { date: "2026-07-14", hash: "d657eec", category: "Docs", text: "Research: Royal mode, remote control, and prompt-checkpoints/undo designs" },
  { date: "2026-07-14", hash: "9349319", category: "Agent", text: "Enforce the auto-mode destructive-command floor in code, not just prompt text" },
  { date: "2026-07-14", hash: "c48f0ef", category: "Build/Distribution", text: "CI: Fix Windows build crash — product.json missing win32ContextMenu" },
  { date: "2026-07-14", hash: "81eba0d", category: "UI", text: "Add thumbs up/down, retry, and local feedback logging to the chat panel" },
  { date: "2026-07-14", hash: "6e33682", category: "Agent", text: "Fix: SSE streaming reads had no timeout, could hang the agent forever" },
  { date: "2026-07-14", hash: "d62929d", category: "Build/Distribution", text: "CI: Fix Windows build crash — signtool.exe not present on CI runners" },
  { date: "2026-07-14", hash: "1ce380b", category: "UI", text: "Add file drag-and-drop, @-mention autocomplete, and attach-current-file to the chat panel" },
  { date: "2026-07-14", hash: "d90d2f4", category: "UI", text: "Add remote-control server/QR/mobile-page modules (view-only, uncommitted wiring)" },
  { date: "2026-07-14", hash: "d6b3819", category: "UI", text: "Wire up Remote Access: QR pairing, mobile view, status bar + commands" },
  { date: "2026-07-14", hash: "41668d1", category: "UI", text: "Remote Access Phase B: control endpoints, mobile composer, permission sync" },
  { date: "2026-07-14", hash: "55b1190", category: "UI", text: "Fix: Desktop permission bar didn't clear when a phone resolved it first" },
  { date: "2026-07-14", hash: "31595d9", category: "UI", text: "Fix CI hang: stream-idle-timeout test never closed its fake SSE server" },
  { date: "2026-07-15", hash: "7bdef32", category: "Agent", text: "Implement prompt-checkpoints + undo (docs/research/11), unified with Royal mode's checkpoint.ts" },
  { date: "2026-07-15", hash: "9c33386", category: "UI", text: "Fix chat panel: composer overflow, emoji attach icon, uneven empty-state gaps" },
  { date: "2026-07-15", hash: "3d958ff", category: "UI", text: "Chat panel: bigger history icon, remove redundant composer settings button" },
  { date: "2026-07-15", hash: "5db3e7b", category: "UI", text: "Chat panel: remove empty-state New chat button (reverted per feedback)" },
  { date: "2026-07-15", hash: "c190ea1", category: "UI", text: "Chat panel: add per-file Undo buttons to the Files-changed card" },
  { date: "2026-07-15", hash: "ce2004f", category: "UI", text: "Add a close (X) button to the inline feedback form" },
  { date: "2026-07-15", hash: "c38288e", category: "Docs", text: "Add docs/architecture.md: how Koder is actually built, end to end" },
  { date: "2026-07-15", hash: "ee1742c", category: "Agent", text: "Fix Royal-mode checkpoints never reaching the UI; add session-wide undo bar + diff view" },
  { date: "2026-07-15", hash: "c0a5d21", category: "UI", text: "Remote chat: Fix composer hidden behind mobile keyboard, add tappable mode switcher" },
  { date: "2026-07-15", hash: "4cf01de", category: "UI", text: "Remote chat: Solidify mobile experience — auto-grow composer, reconnect escalation, permission alert" },
  { date: "2026-07-15", hash: "fcf0a65", category: "Agent", text: "Rebuild agent/server.cjs bundle for the Royal-mode checkpoint fix" },
  { date: "2026-07-15", hash: "5805c60", category: "UI", text: "Stop Source Control from tracking the vendored upstream/ git clone" },
  { date: "2026-07-15", hash: "dc7fedc", category: "UI", text: "Remote chat: Revert JS keyboard-avoidance, fix mobile composer with padding instead" },
  { date: "2026-07-15", hash: "17adcac", category: "UI", text: "Chat panel: Fix history button clipped off-edge in narrow panel" },
  { date: "2026-07-15", hash: "2b2ca29", category: "Docs", text: "Docs: Add reliability roadmap section grounded in SDK/protocol research" },
  { date: "2026-07-15", hash: "139e0c6", category: "Agent", text: "Add Langfuse tracing to the agent loop (reliability roadmap §10 item 1)" },
  { date: "2026-07-15", hash: "321e448", category: "Agent", text: "Add parallel multi-agent (dispatch_subtasks) capability + live subagent progress UI" },
  { date: "2026-07-15", hash: "ed74581", category: "Agent", text: "Merge parallel subagent architecture (dispatch_subtasks) into main" },
  { date: "2026-07-15", hash: "139336a", category: "Agent", text: "Fix dispatch_subtasks being unusable for parallel research in review mode" },
  { date: "2026-07-15", hash: "3c1e74e", category: "UI", text: "Chat panel: Add a What's New panel to the chat topbar" },
  { date: "2026-07-15", hash: "5cd35fa", category: "UI", text: "Chat panel: Replace 4-button mode segmented control with a dropdown" },
  { date: "2026-07-15", hash: "556894e", category: "Agent", text: "Chat panel: Fix subagent progress rows flickering instead of streaming" },
  { date: "2026-07-15", hash: "2046782", category: "Agent", text: "floor.ts: Cross-platform command coverage + close a real Auto-mode gap" },
  { date: "2026-07-15", hash: "0dfee31", category: "Agent", text: "Royal mode: stop overclaiming undo coverage for out-of-workspace edits" },
  { date: "2026-07-15", hash: "02518fe", category: "Build/Distribution", text: "CI: Drop macos-13 (Intel) from the build matrix" },
  { date: "2026-07-15", hash: "b188a1a", category: "UI", text: "Landing page: Wire real Vercel Blob download URLs" },
  { date: "2026-07-15", hash: "319fbd7", category: "UI", text: "Koder UI: Stop the app falling back to unbranded VS Code light theme" },
  { date: "2026-07-15", hash: "ae69a5c", category: "Build/Distribution", text: "CI: Build a real Windows installer instead of zipping loose files" },
  { date: "2026-07-15", hash: "e01ff4c", category: "UI", text: "Landing page: Add LakshX SEO metadata and hero-mirroring OG image" },
  { date: "2026-07-15", hash: "27803b9", category: "UI", text: "Landing page: Rebrand from Koder to LakshX" },
  { date: "2026-07-15", hash: "ce6f01c", category: "Build/Distribution", text: "CI: Fix Windows installer build — run inno-updater before system-setup" },
  { date: "2026-07-15", hash: "9263f4c", category: "UI", text: "Landing page: Fix OG image to use Koder spark logo, not old LakshX mark" },
  { date: "2026-07-15", hash: "d36ee0a", category: "UI", text: "Rebrand IDE product from Koder to LakshX (identity, config paths, internal wiring)" },
  { date: "2026-07-15", hash: "4837840", category: "Build/Distribution", text: "Landing page: Point Windows download at the real installer, not the old zip" },
  { date: "2026-07-15", hash: "43b58b0", category: "Build/Distribution", text: "Fix Windows installer showing a generic icon instead of LakshX branding" },
  { date: "2026-07-15", hash: "19002fb", category: "Build/Distribution", text: "CI: Build a real .deb package for Linux instead of a raw tarball" },
  { date: "2026-07-15", hash: "e37bc8c", category: "Build/Distribution", text: "CI: Retry Linux .deb build — transient spawn failure, same as macOS's npm ci fix" },
  { date: "2026-07-15", hash: "aff8f2f", category: "UI", text: "Chat panel: Fix unreadable mode/model dropdown options (light-on-light)" },
  { date: "2026-07-15", hash: "0025f98", category: "UI", text: "Rebrand product.overrides.json to LakshX; fix stock icon leaking into custom title bar" },
  { date: "2026-07-15", hash: "39cddce", category: "Build/Distribution", text: "CI: Fix Linux .deb build — clear LD_LIBRARY_PATH, not a transient retry" },
  { date: "2026-07-15", hash: "72aa1ba", category: "Build/Distribution", text: "CI: Fix real root causes for Linux .deb race and macOS Archive rebrand fallout" },
  { date: "2026-07-15", hash: "b7b196e", category: "Databases", text: "Recommend a DB client and call-graph extension on file open" },
  { date: "2026-07-15", hash: "f3583a8", category: "Build/Distribution", text: "Patches: Skip missing code-tunnel binary in Linux .deb dependency scan" },
  { date: "2026-07-15", hash: "d990c95", category: "Agent", text: "Center the Remote Access QR panel; sharpen royal mode's autonomy contract" },
  { date: "2026-07-15", hash: "0314477", category: "Build/Distribution", text: "CI: Fix patches/*.patch application on Windows (CRLF vs LF context mismatch)" },
  { date: "2026-07-15", hash: "bff95ba", category: "UI", text: "Chat panel: Add per-message undo icon next to thumbs-up/down/retry" },
  { date: "2026-07-15", hash: "e2da203", category: "Build/Distribution", text: "CI: Fix release asset glob, Windows installer race, and more CRLF/rebrand hardcodes" },
  { date: "2026-07-15", hash: "46a4818", category: "Agent", text: "Agent: Fix Stop button leaving dangling tool_use blocks on mid-batch cancel" },
  { date: "2026-07-15", hash: "d449f12", category: "Build/Distribution", text: "Scripts: Add generate-changelog.mjs to draft What's New entries from git log" },
  { date: "2026-07-15", hash: "85db67c", category: "UI", text: "Add native call-graph panel (product/koder-graph v1)" },
  { date: "2026-07-15", hash: "4ca03f4", category: "UI", text: "Ignore .lakshx/plans/ scratch drafts; remove dead plan_saved handler" },
  { date: "2026-07-15", hash: "4352fae", category: "UI", text: "Landing page: Re-encode OG image to JPEG, fixing WhatsApp preview" },
  { date: "2026-07-15", hash: "7b88fca", category: "Build/Distribution", text: "Patches: Disable first-launch Copilot sign-in onboarding dialog" },
  { date: "2026-07-15", hash: "d7d56f2", category: "UI", text: "Chat panel: Add diagnostic session report icon (copy full logs to clipboard)" },
  { date: "2026-07-15", hash: "19cb4e3", category: "Agent", text: "Agent: Add browser_preview tool (playwright-core, loopback-only, v1a)" },
  { date: "2026-07-15", hash: "8dfb8a7", category: "Databases", text: "Add MongoDB visualization (product/koder-db)" },
  { date: "2026-07-15", hash: "ee12604", category: "Build/Distribution", text: "Patches: Fix DMG volume title showing \"VS Code\" instead of LakshX" },
  { date: "2026-07-15", hash: "569e78a", category: "Build/Distribution", text: "Landing page: Point macOS download at the new .dmg installer" },
  { date: "2026-07-15", hash: "a13346f", category: "UI", text: "Rename Koder-named directories/IDs to LakshX" },
  { date: "2026-07-15", hash: "4a64edb", category: "UI", text: "Landing page: Add Gatekeeper \"damaged\" workaround note for macOS" },
  { date: "2026-07-15", hash: "192ccc5", category: "UI", text: "Landing page: Replace unreadable inline note with a real post-download modal" },
  { date: "2026-07-15", hash: "9a0c9f1", category: "UI", text: "Landing page: Restyle download modal to match site theme, real Apple logo, drop dead Intel link" },
  { date: "2026-07-15", hash: "841711a", category: "UI", text: "Fix diagnostic-report copy failure and stuck-at-thinking hang" },
  { date: "2026-07-15", hash: "324976a", category: "UI", text: "Stream tool-call input live, matching how thinking already streams" },
  { date: "2026-07-16", hash: "ba5784d", category: "Agent", text: "Render browser_preview screenshots inline in the chat (visual verification)" },
  { date: "2026-07-16", hash: "ddc9481", category: "Databases", text: "LakshX DB: Add status bar entry point (real discoverability gap)" },
  { date: "2026-07-16", hash: "188ca0a", category: "UI", text: "Add lakshx-commentary: cheeky cricket-style commentary with free OS voice" },
  { date: "2026-07-16", hash: "469298c", category: "UI", text: "Add Call Graph status bar icon; fix Commentary icon's stray priority" },
  { date: "2026-07-16", hash: "745c1a4", category: "Databases", text: "Fix lakshx-db/lakshx-graph status bar icons never appearing on startup" },
  { date: "2026-07-16", hash: "ddf8a1c", category: "UI", text: "Landing page: cache-bust download URLs (stale 30-day blob cache served old uploads)" },
  { date: "2026-07-16", hash: "35d0de1", category: "Agent", text: "Add slash commands to chat composer + Royal Mode 2.0 architecture doc" },
  { date: "2026-07-16", hash: "3ba2e9a", category: "UI", text: "De-VS-Code audit: hide stock Copilot/chat UI and built-in walkthroughs by default" },
  { date: "2026-07-16", hash: "1b4d1b9", category: "Agent", text: "Agent: Interactive browser (browser_act) + model-facing vision" },
  { date: "2026-07-16", hash: "3fda1af", category: "Databases", text: "LakshX DB: PostgreSQL, MySQL, SQLite support alongside MongoDB" },
  { date: "2026-07-16", hash: "8954b1b", category: "UI", text: "Conversation rewind (Accept/Reject) on user-message bubbles" },
  { date: "2026-07-16", hash: "c6829c9", category: "Databases", text: "Add db_query tool design doc (read real DB rows safely)" },
  { date: "2026-07-16", hash: "c048486", category: "Build/Distribution", text: "Add OS-Build per-platform native build scripts (dmg/exe/deb)" },
  { date: "2026-07-16", hash: "563343e", category: "Agent", text: "Fix agent mode-awareness: authoritative, injection-resistant mode declaration" },
  { date: "2026-07-16", hash: "327d0ae", category: "Docs", text: "Add voice-mode design doc (local Whisper; mic-permission spike gate)" },
  { date: "2026-07-16", hash: "746eed6", category: "Databases", text: "Db_query database layer: read-only query execution in lakshx-db" },
  { date: "2026-07-16", hash: "975ccee", category: "UI", text: "LakshX Commentary: LakshX FM background music (free, no-signup, cross-platform)" },
  { date: "2026-07-16", hash: "d31cb25", category: "Databases", text: "Db_query wiring: agent tool + ACP relay to lakshx-db" },
  { date: "2026-07-16", hash: "409554d", category: "Databases", text: "LakshX DB: Data view — browse actual rows, not just schema" },
  { date: "2026-07-16", hash: "44653cc", category: "UI", text: "LakshX Graph: Workspace dependency knowledge graph" },
  { date: "2026-07-16", hash: "7cb605f", category: "Build/Distribution", text: "Build preflight: fail-early requirements gate (fixes the Node-version bug)" },
  { date: "2026-07-17", hash: "41da840", category: "UI", text: "LakshX Commentary: Pivot to standalone LakshX Music player" },
  { date: "2026-07-17", hash: "d041b75", category: "UI", text: "Landing page: add /docs — themed documentation site" },
  { date: "2026-07-17", hash: "f1dfac8", category: "Docs", text: "Docs: Document architecture evolution + the complete multi-agent picture" },
  { date: "2026-07-17", hash: "fe5d880", category: "Docs", text: "Add IDE feature roadmap research (beyond the agent layer)" },
  {
    date: "2026-07-17",
    hash: "169890d",
    category: "Agent",
    text:
      "Stage 2a: background subagents. dispatch_subtasks gains a background: true flag so a dispatched subagent no longer blocks the parent turn — the model keeps working while children run under their own independent AbortControllers. Three new tools (check_tasks, send_to_task, wait_for_tasks) let the model poll, steer, or explicitly wait on them, with a tray UI surfacing live progress and completions queued into the next turn behind an explicit not-user-input frame.",
  },
  { date: "2026-07-17", hash: "a2f978f", category: "Docs", text: "Docs: Mark background subagents as shipped in architecture.md §12.2" },
  { date: "2026-07-17", hash: "97c5cbf", category: "UI", text: "Add a custom LakshX Welcome screen; replace the remaining stock Help-menu items" },
  { date: "2026-07-17", hash: "ce318fd", category: "UI", text: "Roadmap #4: Tab / next-edit prediction (product/lakshx-tab)" },
  { date: "2026-07-17", hash: "eef2f76", category: "UI", text: "Roadmap #2: Default-on inline test results + coverage gutter (product/lakshx-testing)" },
  { date: "2026-07-17", hash: "228fb3e", category: "UI", text: "Roadmap #5: Universal command bar v1 (product/lakshx-commandbar)" },
  { date: "2026-07-17", hash: "2d84a11", category: "UI", text: "Roadmap #3: Terminal command blocks (product/lakshx-terminal)" },
  { date: "2026-07-17", hash: "cb8f3d9", category: "UI", text: "Roadmap #10: Curated/vetted extension panel (product/lakshx-extensions)" },
  { date: "2026-07-17", hash: "0926f26", category: "Security", text: "Roadmap #1: Inline dependency-vulnerability hints (lakshx-graph), backed by a live OSV.dev lookup" },
  { date: "2026-07-17", hash: "572ab95", category: "UI", text: "Landing page: Add /changelog, sourced from real git history" },
  { date: "2026-07-17", hash: "78ed7d2", category: "UI", text: "Roadmap #9: Structural search & replace (product/lakshx-structural-search)" },
  { date: "2026-07-17", hash: "f3312e7", category: "UI", text: "Roadmap #8: AI-powered crash explanation" },
  { date: "2026-07-17", hash: "bc8ba07", category: "UI", text: "Roadmap #7: Semantic/embedding codebase search (product/lakshx-search)" },
  { date: "2026-07-17", hash: "f7ade8b", category: "Build/Distribution", text: "Wire up 7 extensions built today that were never registered for bundling" },
  { date: "2026-07-17", hash: "dd61f18", category: "Agent", text: "Roadmap #6: AI-assisted merge conflict resolution" },
  { date: "2026-07-17", hash: "aa00ef7", category: "Security", text: "LakshX Extensions: Allow-list check before installExtension (defense-in-depth)" },
  { date: "2026-07-17", hash: "67c28ce", category: "Docs", text: "Add round-2 IDE feature roadmap research" },
  { date: "2026-07-17", hash: "003aa6c", category: "Docs", text: "Docs: Fold external validation into Royal Mode 2.0 design (round-2 research)" },
  { date: "2026-07-17", hash: "e93550d", category: "Docs", text: "Add cloud/SaaS pivot research (accounts, billing, auto-update, India market)" },
  { date: "2026-07-17", hash: "847a3f0", category: "Security", text: "Security fix: Escape ALL boundary tags in background-task notifications" },
  { date: "2026-07-17", hash: "fd0030c", category: "Databases", text: "Db_query: Add MongoDB support (was deferred in v1)" },
  { date: "2026-07-17", hash: "c26ba70", category: "Agent", text: "Rebuild agent bundle (server.cjs) — was stale since before this session's work" },
  { date: "2026-07-17", hash: "560f24b", category: "UI", text: "Voice mode: Patches + STT pipeline code (live mic verification still blocked on disk)" },
  { date: "2026-07-17", hash: "66c790c", category: "Security", text: "Security fix: Escape untrusted values in panel.js innerHTML templates" },
  {
    date: "2026-07-17",
    hash: "3d43967",
    category: "Agent",
    text:
      "Royal Mode 2.0 Stage A: a new set_verification_spec / declare_done tool pair — the model records a content-hashed VerificationSpec (real shell checks + how to judge them) up front, and declare_done actually re-runs those checks server-side rather than trusting the model's own claim of completion, refusing to pass with no spec set or in read-only review mode. A session-scoped stand-in for Stage B's full PLAN-phase gating (below), covered by a dedicated declare-done test suite.",
  },
  { date: "2026-07-17", hash: "6c5ff1b", category: "Security", text: "SAST-lite pattern scanning: SQLi/XSS-class shape detection" },
  { date: "2026-07-17", hash: "7313192", category: "Security", text: "Offline pre-commit secret scanning (product/lakshx-secrets)" },
  {
    date: "2026-07-17",
    hash: "597761d",
    category: "Agent",
    text:
      "Royal Mode 2.0 Stage B: the complete phase-machine orchestrator — INTAKE → RECON → PLAN → [checkpoint] → EXECUTE → VERIFY, with FIX (up to 2 retries) and a checkpoint-based REWIND back to the PLAN baseline (capped at 2 re-entries) on failure — replacing royal mode's old flat loop with the floor simply turned off. Gated to top-level royal sessions only, so a subagent inheriting royal mode still runs the flat loop rather than recursively phase-managing itself; verified end-to-end by 5 dedicated tests including a full non-trivial run through every phase and a REWIND proof checked against a real git diff, not a status string.",
  },
  { date: "2026-07-17", hash: "19ef621", category: "Docs", text: "Docs: Mark Royal Mode 2.0 phase machine as shipped in architecture.md §12.3" },
  { date: "2026-07-17", hash: "b51823e", category: "Agent", text: "Regional-language / Hinglish explain toggle" },
  { date: "2026-07-17", hash: "af0c9d7", category: "UI", text: "Codebase Guided Tour mode (product/lakshx-graph)" },
  { date: "2026-07-17", hash: "7adbdcf", category: "UI", text: "PR walkthrough auto-generator (/walkthrough slash command)" },
  { date: "2026-07-17", hash: "85b2794", category: "Agent", text: "Agent trace/observability inspector (closes the Langfuse-gated visibility gap)" },
  { date: "2026-07-17", hash: "dcc3b60", category: "Docs", text: "Deep-dive rewrite of architecture.md (agentic loop, memory, context, a full worked example)" },
  { date: "2026-07-17", hash: "94bc678", category: "Build/Distribution", text: "prepare.sh: reset upstream to pristine HEAD before applying patches (fixes a stuck-dirty-tree re-run failure)" },
  { date: "2026-07-17", hash: "2eda6f3", category: "Build/Distribution", text: "build-windows.ps1: add a Spectre-mitigated-libs gate check with a self-elevating auto-fix" },
  { date: "2026-07-17", hash: "c7d27bf", category: "Build/Distribution", text: "Fix build-windows.ps1 gate crashes (Python Store-alias stub, bash-not-on-PATH); document the one-command Windows build" },
  { date: "2026-07-17", hash: "dca8b36", category: "Build/Distribution", text: "OS-Build/README: copy-paste per-OS build commands + the stale-lockfile gotcha" },
  { date: "2026-07-17", hash: "8caf2fd", category: "Build/Distribution", text: "Regenerate lakshx-chat's package-lock.json (fixes a smart-whisper dependency mismatch)" },
  { date: "2026-07-17", hash: "c57ab45", category: "Build/Distribution", text: "Fix a real Windows build failure: an em-dash broke PowerShell 5.1's BOM-less file parsing" },
  { date: "2026-07-17", hash: "fa702c1", category: "Build/Distribution", text: "gitignore build artifacts (.dmg/.exe/.deb) at the repo root, now that both Mac and Windows produce them from the same clone" },
  { date: "2026-07-17", hash: "1c99daa", category: "UI", text: "Fix lakshx-extensions activation crash on a frozen ExtensionContext (was silently breaking the Recommended Extensions panel on every launch)" },
  { date: "2026-07-17", hash: "8cd114e", category: "Build/Distribution", text: "apply-ui.mjs: skip smart-whisper's non-PE .node file in the Windows rcedit version-stamp glob (was failing the whole build at the last step)" },
  { date: "2026-07-17", hash: "a675104", category: "UI", text: "Fix a stale CSP hash that silently blanked every webview app-wide (chat, DB, graph, search, remote access) — one voice-mode patch edited the shared webview host's inline script without recomputing its CSP hash" },
  { date: "2026-07-17", hash: "882e3b5", category: "Build/Distribution", text: "Apply patches EOL-agnostically: CRLF-safe prepare.sh + .gitattributes (Windows checkouts were corrupting patch files with CRLF line endings)" },
  { date: "2026-07-17", hash: "1d2afeb", category: "UI", text: "Fix voice mode's UX ordering: check model/addon readiness before arming the recorder, not after a full record-and-stop for nothing" },
  { date: "2026-07-17", hash: "c6558dc", category: "Databases", text: "Fix the Data tab always failing to browse MongoDB collections — a branch-order bug routed every Mongo browse through the SQL query path instead of Mongo's own cursor" },
  { date: "2026-07-17", hash: "81b4cfe", category: "UI", text: "Fix overlapping empty-state text and a stray title label in the Dependencies/Call Graph/Guided Tour panel" },
  { date: "2026-07-17", hash: "a0e1d2e", category: "UI", text: "Fix light-on-light dropdowns on Windows across six webviews (each followed the overall workbench theme instead of staying hardcoded dark); add an in-panel usage hint for \"Allow AI queries\"" },
  { date: "2026-07-17", hash: "1d2d270", category: "Agent", text: "Sync the composer's model dropdown to the persisted default model; explain Guided Tour's empty state instead of a bare \"No tour data yet\"" },
  { date: "2026-07-17", hash: "9e125df", category: "Docs", text: "Fix stale/inaccurate doc claims (MongoDB db_query support, two nonexistent \"suggests opening on file open\" features) and document the DB panel's Data tab and Guided Tour, neither of which was covered before" },
  { date: "2026-07-17", hash: "d0f060a", category: "Agent", text: "Fix the grep tool's bundled-ripgrep lookup — the editor's vendored ripgrep package changed to a per-platform layout, so the lookup silently never found it and every grep call failed outright" },
  { date: "2026-07-17", hash: "38c4924", category: "Build/Distribution", text: "Refresh the site's macOS/Windows download links to the day's rebuilt binaries — verified byte-for-byte against the local files before wiring them in, cache-busted so returning visitors don't get served stale bytes" },
];

export const REPO_URL = "https://github.com/BeastxD7/koder";

/**
 * Optional per-date phase framing, lifted from docs/architecture.md §11
 * ("Architecture evolution"). Not every date needs one — omit rather than
 * force a caption that doesn't fit the day's actual commits.
 */
export const DATE_BLURBS: Record<string, string> = {
  "2026-07-14":
    "Foundation — forking VS Code, the agent tool loop, BYOK providers, and the first real chat panel.",
  "2026-07-15":
    "Royal mode, remote control, checkpoints/undo, the Koder → LakshX rebrand, and a long tail of CI/build fixes.",
  "2026-07-16":
    "This cycle's feature sprint — multi-engine database tools, the interactive browser tool, native distribution builds.",
  "2026-07-17":
    "The biggest single day yet: background subagents and the full Royal Mode 2.0 phase machine, a round of real security work (secret scanning, SAST-lite, escaping fixes, dependency-vuln hints), the first ten items of the IDE feature roadmap (tab prediction, testing gutter, command bar, terminal blocks, structural search, semantic search, crash explanation, merge-conflict resolution, curated extensions, guided tour), voice mode, Hinglish explain, a PR walkthrough generator, this changelog itself, and the cloud/SaaS pivot research — followed by a real hardening pass once the app was actually rebuilt and used: a webview-wide CSP regression, the Data tab's MongoDB browsing being completely broken, the grep tool's bundled ripgrep silently failing on every call, Windows-only dropdown theming, and a first cross-machine Windows build getting fixed end to end — and closing with a refreshed download link for both platforms, verified against the exact bytes just built.",
};
