// LakshX Agent panel — ACP client + webview UI. Plain CJS, zero dependencies:
// a minimal ndjson JSON-RPC client speaks ACP to the LakshX Agent Runtime.
const vscode = require("vscode");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const { CHANGELOG } = require("./changelog.js");
const diagnostics = require("./diagnostics.js");
const { discoverCommands, expandCommandBody } = require("./commands.js");
const { EXPLAIN_LANGUAGES, normalizeExplainLanguage } = require("./explain-language.js");
const { AcpClient } = require("./acp-client.js");
const { buildCrashContext } = require("./crash-context.js");
const prWalkthrough = require("./pr-walkthrough.js");
const voice = require("./voice.js");
const lakshxAuth = require("./lakshx-auth.js");

// ---------- voice mode (docs/research/14-voice-mode.md) ----------
//
// panel.js postMessages the captured audio as `{ type: "transcribeAudio",
// pcm }` where `pcm` is meant to travel as a transferable ArrayBuffer (see
// media/panel.js's stopRecording()). This host side has NOT been exercised
// against a live webview in this build (no Extension Host here — see the
// report), so this conversion is defensive: it also accepts a plain array
// of numbers or a Node Buffer in case the webview postMessage bridge ends
// up JSON-serializing the payload instead of transferring a real
// ArrayBuffer, rather than assuming one exact shape untested.
function pcmFromMessage(raw) {
  if (raw instanceof Float32Array) return raw;
  if (raw instanceof ArrayBuffer) return new Float32Array(raw);
  if (ArrayBuffer.isView(raw)) return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  if (Array.isArray(raw)) return Float32Array.from(raw);
  throw new Error("unrecognized audio payload shape");
}

// ---------- runtime discovery ----------
const isWin = process.platform === "win32";

/**
 * Locate the editor's own bundled ripgrep binary, so the agent's grep tool
 * works on machines with no system-wide `rg` install (which was the actual,
 * always-reproducible failure mode reported: a fresh machine has no rg on
 * PATH, and this lookup was silently finding nothing, so LAKSHX_RG_PATH
 * never got set and the tool fell back to a bare "rg" that doesn't exist).
 *
 * VS Code has shipped this dependency under two different shapes across
 * versions — check both instead of assuming one:
 *   - @vscode/ripgrep (older): flat  .../ripgrep/bin/rg[.exe]
 *   - @vscode/ripgrep-universal (current, this build): per-platform
 *     .../ripgrep-universal/bin/<os>-<arch>/rg[.exe] — one npm package
 *     bundling every platform's binary, picked by folder name at runtime
 *     (mirrors that package's own lib/index.js: binPathFor({os, arch})).
 */
function findBundledRg() {
  const binaryName = isWin ? "rg.exe" : "rg";
  const candidates = [
    path.join(vscode.env.appRoot, "node_modules", "@vscode", "ripgrep-universal", "bin", `${process.platform}-${process.arch}`, binaryName),
    path.join(vscode.env.appRoot, "node_modules", "@vscode", "ripgrep", "bin", binaryName),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function runtimeEnv() {
  const rg = findBundledRg();
  const env = { ...process.env };
  if (rg) env.LAKSHX_RG_PATH = rg;
  return env;
}

function agentSpawnSpec(context) {
  const custom = vscode.workspace.getConfiguration("lakshx").get("agent.command");
  if (custom) {
    return isWin
      ? { command: "cmd.exe", args: ["/d", "/c", custom], env: runtimeEnv() }
      : { command: "/bin/zsh", args: ["-lc", custom], env: runtimeEnv() };
  }
  // dev layout: <repo>/upstream/extensions/lakshx-chat → runtime at <repo>/agent
  const candidates = [
    path.resolve(context.extensionPath, "..", "..", "..", "agent"),
    path.resolve(context.extensionPath, "..", "..", "agent"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "src", "server.ts")) && fs.existsSync(path.join(dir, "node_modules"))) {
      return { command: isWin ? "npx.cmd" : "npx", args: ["tsx", "src/server.ts"], cwd: dir, env: runtimeEnv() };
    }
  }
  // packaged: bundled runtime, run with the app's own Electron-as-Node —
  // works on machines with no Node.js installed
  const bundled = path.join(context.extensionPath, "agent", "server.cjs");
  if (fs.existsSync(bundled)) {
    return {
      command: process.execPath,
      args: [bundled],
      cwd: undefined,
      env: { ...runtimeEnv(), ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return null;
}

const PROVIDERS_TEMPLATE = `{
  // LakshX BYOK — add API keys for any provider you use.
  // Model strings are "provider/model", e.g. "anthropic/claude-sonnet-5",
  // "openrouter/deepseek/deepseek-chat", "ollama/qwen3-coder".
  "defaultModel": "lakshx/gpt-5-mini",
  "providers": {
    // "lakshx" is managed automatically by "LakshX: Sign In" — don't edit its apiKey by hand, it's a rotating session token, not a real API key.
    "lakshx":     { "apiKey": "" },
    "anthropic":  { "apiKey": "" },
    "openai":     { "apiKey": "" },
    "openrouter": { "apiKey": "" },
    "gemini":     { "apiKey": "" },
    "deepseek":   { "apiKey": "" },
    "groq":       { "apiKey": "" },
    "xai":        { "apiKey": "" }
  }
}
`;

// ---------- BYOK provider state (~/.lakshx/providers.json) ----------
// "lakshx" is the free hosted model (no user-supplied key — its "apiKey" is
// a Supabase session token, kept fresh by scheduleLakshxRefresh() below) —
// listed first since it's the default, zero-setup option on a fresh install.
const PROVIDER_IDS = ["lakshx", "anthropic", "openai", "openrouter", "gemini", "deepseek", "groq", "xai"];

function providersFile() {
  return path.join(os.homedir(), ".lakshx", "providers.json");
}

function readProvidersJson() {
  try {
    return JSON.parse(fs.readFileSync(providersFile(), "utf8"));
  } catch {
    return { defaultModel: "anthropic/claude-sonnet-5", providers: {} };
  }
}

/** For the settings UI: which providers have keys (never send the keys). */
function readProviderState() {
  const cfg = readProvidersJson();
  const state = { defaultModel: cfg.defaultModel ?? "anthropic/claude-sonnet-5", set: {} };
  for (const id of PROVIDER_IDS) {
    state.set[id] = Boolean(cfg.providers?.[id]?.apiKey);
  }
  return state;
}

function saveProviderState(keys, defaultModel) {
  const cfg = readProvidersJson();
  cfg.providers = cfg.providers ?? {};
  for (const [id, key] of Object.entries(keys)) {
    if (!key) continue; // empty input = leave existing key untouched
    cfg.providers[id] = { ...(cfg.providers[id] ?? {}), apiKey: key.trim() };
  }
  if (defaultModel) cfg.defaultModel = defaultModel.trim();
  fs.mkdirSync(path.dirname(providersFile()), { recursive: true });
  fs.writeFileSync(providersFile(), JSON.stringify(cfg, null, 2));
}

// ---------- LakshX hosted-model session (separate from manual BYOK keys —
// this "apiKey" is a rotating Supabase access token, not a real API key) ----------
function saveLakshxToken(accessToken) {
  const cfg = readProvidersJson();
  cfg.providers = cfg.providers ?? {};
  cfg.providers.lakshx = { apiKey: accessToken };
  fs.mkdirSync(path.dirname(providersFile()), { recursive: true });
  fs.writeFileSync(providersFile(), JSON.stringify(cfg, null, 2));
}

function clearLakshxToken() {
  const cfg = readProvidersJson();
  if (cfg.providers?.lakshx) delete cfg.providers.lakshx;
  fs.mkdirSync(path.dirname(providersFile()), { recursive: true });
  fs.writeFileSync(providersFile(), JSON.stringify(cfg, null, 2));
}

/**
 * Supabase access tokens expire in 1h with single-use ROTATING refresh
 * tokens — a naive "store the refresh token once" implementation silently
 * logs the user out the second time it's used, because the old one gets
 * invalidated the moment a new one is issued. Every refresh here persists
 * BOTH the new access token and the new rotated refresh token.
 *
 * Runs an immediate check on activation (covers "app was closed past the
 * 1h expiry, last session's access token is stale") plus a 5-minute poll
 * that only actually calls Supabase once within 10 minutes of expiry.
 */
function scheduleLakshxRefresh(context) {
  async function tick() {
    const refreshToken = await context.secrets.get("lakshx.refreshToken");
    if (!refreshToken) return;
    const expiresAt = Number((await context.secrets.get("lakshx.tokenExpiresAt")) ?? "0");
    if (expiresAt && expiresAt - Date.now() > 10 * 60 * 1000) return;
    try {
      const session = await lakshxAuth.refreshSession(refreshToken);
      saveLakshxToken(session.access_token);
      await context.secrets.store("lakshx.refreshToken", session.refresh_token);
      await context.secrets.store("lakshx.tokenExpiresAt", String(Date.now() + session.expires_in * 1000));
    } catch {
      // refresh token itself is dead (expired, or already-replayed after a
      // crash mid-rotation) — clear everything so the UI honestly shows
      // "logged out" instead of silently retrying against a dead token
      // forever.
      clearLakshxToken();
      await context.secrets.delete("lakshx.refreshToken");
      await context.secrets.delete("lakshx.tokenExpiresAt");
    }
  }
  tick();
  const interval = setInterval(tick, 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

// ---------- @-mention file search + attachment (chip) expansion ----------
// Caps mirror the agent's own read_file tool (agent/src/tools.ts: 800-line
// default, 48k-char clip) so a chip never hands the model more context than
// a normal tool call would.
const MAX_ATTACH_LINES = 800;
const MAX_ATTACH_CHARS = 48_000;

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function toWorkspaceRelative(absPath) {
  const root = workspaceRoot();
  return root && absPath.startsWith(root) ? path.relative(root, absPath).split(path.sep).join("/") : absPath;
}

function toAbsoluteUri(relPath) {
  const root = workspaceRoot() ?? "";
  return vscode.Uri.file(path.join(root, relPath));
}

/**
 * Read-only virtual-document backing for "open diff" (docs/research/11 §7,
 * follow-up ask: clicking a changed file should show what changed, not just
 * open it blind). Materializes a file's shadow-git content at a checkpoint's
 * baseline as an in-memory `lakshx-checkpoint:` document, so `vscode.diff`
 * can compare it against the real, live file on disk — no temp files, no
 * git access needed client-side (only the agent process touches the
 * shadow-git plumbing; content is fetched over ACP, see
 * `lakshx/checkpoint_file_before` in server.ts).
 */
class CheckpointContentProvider {
  constructor() {
    this.store = new Map(); // uri string -> content
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;
  }
  /** A fresh nonce per call so VS Code never serves stale cached content for the same path across repeated diffs. */
  uriFor(relPath, content) {
    const uri = vscode.Uri.parse(`lakshx-checkpoint:/${relPath}`).with({ query: `t=${Date.now()}` });
    this.store.set(uri.toString(), content);
    return uri;
  }
  provideTextDocumentContent(uri) {
    return this.store.get(uri.toString()) ?? "";
  }
}

/**
 * Editor-side signal (doc 11 §8 Phase C stretch, shipped now — cheap and
 * well-isolated): a small badge in the file tree/tabs for any file with an
 * available checkpoint, visible before the file is even opened. Reads
 * straight off `AgentViewProvider.fileCheckpoints`, the same map the
 * editor-title command's `lakshx.fileHasCheckpoint` context key already uses.
 */
class CheckpointDecorationProvider {
  constructor(provider) {
    this.provider = provider;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChange.event;
  }
  refresh(uris) {
    this._onDidChange.fire(uris);
  }
  provideFileDecoration(uri) {
    if (uri.scheme !== "file") return undefined;
    if (!this.provider.fileCheckpoints.has(toWorkspaceRelative(uri.fsPath))) return undefined;
    return {
      badge: "●",
      color: new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      tooltip: "Changed by LakshX this session — undo from the editor title bar or the chat panel",
    };
  }
}

const checkpointContentProvider = new CheckpointContentProvider();

/**
 * Resolve a chip's path to an absolute, readable path. Relative paths are
 * joined to the workspace root and rejected if they'd escape it (mirrors
 * the "openLink" guard below); absolute paths (e.g. a file dragged in from
 * outside the workspace) are allowed as-is but only if they exist — the
 * user already pointed at a concrete file on disk, so there's no traversal
 * risk to guard against.
 */
function resolveAttachmentPath(relPath) {
  if (!relPath) return null;
  if (path.isAbsolute(relPath)) return fs.existsSync(relPath) ? relPath : null;
  const root = workspaceRoot();
  if (!root) return null;
  const abs = path.resolve(root, relPath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;
  return fs.existsSync(abs) ? abs : null;
}

/** Build a `<file>` prompt block for one attachment chip; null if unreadable. */
function buildFileBlock(att) {
  const abs = resolveAttachmentPath(att.path);
  if (!abs) return null;
  try {
    let lines = fs.readFileSync(abs, "utf8").split("\n");
    let rangeAttr = "";
    if (att.startLine != null && att.endLine != null) {
      const start = Math.max(1, att.startLine);
      const end = Math.min(lines.length, att.endLine);
      lines = lines.slice(start - 1, end);
      rangeAttr = ` lines="${start}-${end}"`;
    } else if (lines.length > MAX_ATTACH_LINES) {
      lines = lines.slice(0, MAX_ATTACH_LINES);
      lines.push(`… (truncated at ${MAX_ATTACH_LINES} lines)`);
    }
    let body = lines.join("\n");
    if (body.length > MAX_ATTACH_CHARS) body = body.slice(0, MAX_ATTACH_CHARS) + "\n… (truncated)";
    return `<file path="${att.path}"${rangeAttr}>\n${body}\n</file>`;
  } catch {
    return null;
  }
}

/** Simple ordered-subsequence fuzzy match; lower score = tighter match. -1 = no match. */
function fuzzyScore(q, target) {
  if (!q) return 0;
  let ti = 0, first = -1, last = -1;
  for (const c of q) {
    const idx = target.indexOf(c, ti);
    if (idx === -1) return -1;
    if (first === -1) first = idx;
    last = idx;
    ti = idx + 1;
  }
  return last - first + 1;
}

/** Workspace file search for the @-mention popup: fuzzy-filtered, capped, node_modules/.git excluded. */
async function searchWorkspaceFiles(q) {
  const query = String(q ?? "").toLowerCase();
  try {
    const uris = await vscode.workspace.findFiles(
      "**/*",
      "**/{node_modules,.git,.venv,venv,__pycache__,dist,build,out,.next,target,.pytest_cache}/**",
      500,
    );
    const scored = [];
    for (const u of uris) {
      const rel = toWorkspaceRelative(u.fsPath);
      const score = fuzzyScore(query, rel.toLowerCase());
      if (score !== -1) scored.push({ rel, score });
    }
    scored.sort((a, b) => a.score - b.score || a.rel.length - b.rel.length);
    return scored.slice(0, 20).map((s) => s.rel);
  } catch {
    return [];
  }
}

// ---------- PR walkthrough auto-generator (docs/research/16-ide-feature-roadmap-round2.md §"PR walkthrough auto-generator") ----------
// Prompt assembly lives in pr-walkthrough.js (pure, unit-tested); this side
// only gathers the raw inputs it needs — `git diff` text and a bounded set of
// workspace file contents for the lightweight dependents/test-coverage scan —
// then hands them to pr-walkthrough.js exactly like the crash-explanation
// flow hands DAP results to crash-context.js. This is the one place in this
// extension that shells out to git directly: everywhere else (checkpoint
// diffing, undo, the merge-conflict UI) that touches git does so through the
// agent process's shadow-git plumbing over ACP (`lakshx/checkpoint_file_before`,
// `lakshx/undo_file`, etc.), because those flows need the agent's own
// checkpoint history. A PR walkthrough only needs the user's REAL, current
// working-tree diff against HEAD — plain read-only `git` commands are the
// right tool, and running them here (instead of a round-trip through the
// agent) keeps this a client-side "compose context, then send it through the
// normal prompt path" feature, same as crash-explanation, not a new agent tool.
const GIT_EXEC_OPTS = { maxBuffer: 10 * 1024 * 1024 }; // 10MB — generous for even a large diff/log, never unbounded

/** Run `git <args>` in `cwd`; resolves to stdout, or "" on any failure (not a git repo, git not on PATH, etc.) — never rejects/throws. */
function execGit(args, cwd) {
  return new Promise((resolve) => {
    cp.execFile("git", args, { cwd, ...GIT_EXEC_OPTS }, (err, stdout) => {
      resolve(err ? "" : stdout);
    });
  });
}

/** True if `cwd` has at least one commit (HEAD resolves) — see gatherWalkthroughDiff's doc comment for why this matters. */
function hasHeadCommit(cwd) {
  return new Promise((resolve) => {
    cp.execFile("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd }, (err) => resolve(!err));
  });
}

/**
 * Fetch the current working-tree diff (staged + unstaged combined) as ONE
 * unified diff, suitable for pr-walkthrough.js's getDiffSummary().
 *
 * Deliberately `git diff HEAD` rather than concatenating `git diff --cached`
 * + `git diff` separately: those two commands each emit their OWN
 * `diff --git a/X b/X` block for any file that has BOTH staged and unstaged
 * hunks (stage part of a file, then keep editing it — a common flow), which
 * would make getDiffSummary() see two separate entries for the same path and
 * double-count/double-list it in the walkthrough. `git diff HEAD` compares
 * the working tree directly against HEAD (bypassing the index entirely), so
 * it always emits exactly one block per changed path — verified directly
 * against a real repo with a file in that mixed state before choosing this.
 *
 * `git diff HEAD` needs an existing commit, so a brand-new repo (no commits
 * yet) falls back to `git diff --cached` + `git diff` concatenated — the
 * double-listing risk there is real but narrow (a file can only be "staged
 * and further edited" pre-first-commit too, just a rarer combination to hit
 * in a repo that has nothing committed at all).
 */
async function gatherWalkthroughDiff(cwd) {
  if (await hasHeadCommit(cwd)) return execGit(["diff", "HEAD"], cwd);
  const [staged, unstaged] = await Promise.all([execGit(["diff", "--cached"], cwd), execGit(["diff"], cwd)]);
  return [staged, unstaged].filter(Boolean).join("\n");
}

/**
 * Read a bounded set of JS/TS workspace files as `{path, text}` for
 * pr-walkthrough.js's findLightweightDependents()/hasTestCoverage() scan.
 * Same exclusion globs as searchWorkspaceFiles's @-mention search; capped at
 * pr-walkthrough.js's own MAX_SCAN_FILES so this can't blow up on a huge repo.
 * Unreadable individual files are skipped, not fatal.
 */
async function gatherWorkspaceFilesForScan() {
  let uris = [];
  try {
    uris = await vscode.workspace.findFiles(
      "**/*.{js,jsx,ts,tsx,mjs,cjs}",
      "**/{node_modules,.git,.venv,venv,__pycache__,dist,build,out,.next,target,.pytest_cache}/**",
      prWalkthrough.MAX_SCAN_FILES,
    );
  } catch {
    return [];
  }
  const files = [];
  for (const u of uris) {
    try {
      files.push({ path: toWorkspaceRelative(u.fsPath), text: fs.readFileSync(u.fsPath, "utf8") });
    } catch {
      // unreadable (permissions, race with a delete, binary misdetected as text, ...) — skip, not fatal
    }
  }
  return files;
}

// ---------- webview view ----------
// transcript events that get replayed when the webview is rebuilt
// "checkpointReverted" is replayed the same event-sourced way "checkpoint" is
// (see notifyReverted below) so a chat reload nets out to the same "does
// this file currently have an undoable agent change" state live sessions
// converge to, instead of resurrecting already-reverted files after reload.
// "toolImage" is the LIGHTWEIGHT marker only (id/path/mimeType, no pixel
// data) — see onToolImage below for why the heavy base64 payload is
// deliberately kept OUT of this set, same live-only treatment as
// "toolInputDelta".
// "rewindAccepted" persists the purely-visual Accept dismissal of a user
// message's rewind row (conversation-rewind feature) so a reload keeps the
// row dismissed — replayed the same event-sourced way "checkpointReverted" is.
// "taskStart"/"taskActivity"/"taskDone"/"taskSteered" are the background-
// subtask (Royal Mode 2.0) equivalents of "subagentsStart"/"subagentActivity"/
// "subagentsEnd" above — replayed the same way so the running-agents tray
// (panel.js) rebuilds on reload, then gets reconciled against the live
// registry via a "tasksReconcile" round-trip (NOT itself replayable — see
// the "replayRequest" handler below).
const REPLAYABLE = new Set(["user", "chunk", "thought", "tool", "toolUpdate", "toolImage", "system", "modeChanged", "turnEnd", "checkpoint", "checkpointReverted", "rewindAccepted", "subagentsStart", "subagentActivity", "subagentsEnd", "taskStart", "taskActivity", "taskDone", "taskSteered", "phaseState"]);

function chatsDir() {
  const dir = path.join(os.homedir(), ".lakshx", "chats");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- "What's new" changelog (see changelog.js) ----------
// Newest-first, stable within a date (Array#sort is stable) so the curated
// order in changelog.js — most user-visible entry first per date — survives.
function sortedChangelog() {
  return [...CHANGELOG].sort((a, b) => b.date.localeCompare(a.date));
}

// "Have there been entries shipped after the user last opened the panel?"
// Empty-string lastSeen (never opened) sorts before every real date, so a
// first-time user correctly sees the badge.
function whatsNewHasUnseen(context) {
  const lastSeen = context.globalState.get("lakshx.whatsNew.lastSeenDate", "");
  const newest = sortedChangelog()[0]?.date ?? "";
  return newest > lastSeen;
}

// ---------- local feedback log (~/.lakshx/feedback/<yyyy-mm>.jsonl) ----------
// Local write here is unconditional and always happens, regardless of sign-in
// state or model — it is the reliable on-disk copy. Cloud sync is a
// deliberately separate, explicit path (uploadFeedbackEvent, below) rather
// than an extension of this function, and only ever fires for the hosted
// "lakshx" model — a BYOK user's own-key prompts/responses are never
// uploaded just because they also happen to be signed in.
function feedbackDir() {
  const dir = path.join(os.homedir(), ".lakshx", "feedback");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function feedbackFile(date = new Date()) {
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  return path.join(feedbackDir(), `${ym}.jsonl`);
}

/**
 * Cloud mirror of a feedback entry — POSTs to the same backend that hosts
 * the free "lakshx" model, authenticated with the same rotating Supabase
 * access token used for chat requests (saveLakshxToken/scheduleLakshxRefresh
 * above). Scoped to the hosted model only (see the comment on feedbackDir):
 * gate on entry.model rather than "is the user signed in at all", since a
 * signed-in user can still be chatting through their own BYOK key in the
 * same session. Best-effort and fire-and-forget — a network failure here
 * must never surface to the user or affect the local JSONL write, which
 * already succeeded by the time this is called.
 */
function uploadFeedbackEvent(entry) {
  if (!entry.model?.startsWith("lakshx/")) return;
  const token = readProvidersJson().providers?.lakshx?.apiKey;
  if (!token) return;
  fetch("https://lakshx.in/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      rating: entry.rating,
      model: entry.model,
      mode: entry.mode,
      chatId: entry.chatId,
      sessionId: entry.sessionId,
      userPromptText: entry.userPromptText,
      assistantResponseText: entry.assistantResponseText,
      toolCalls: entry.toolCalls,
      comment: entry.comment,
      expected: entry.expected,
      wentWrong: entry.wentWrong,
    }),
  }).catch(() => {});
}

// ---------- Royal mode informed-consent gate (per workspace, not per session) ----------
// Royal mode bypasses the destructive-command floor entirely (agent/src/floor.ts,
// agent/src/loop.ts) — no blocking, no permission prompts, full machine access.
// The one thing standing between that and a silent surprise is this one-time
// confirmation, shown once per workspace (not once per app install, not once
// per chat session — switching machines or projects re-asks). The ack is
// stored outside the workspace tree (~/.lakshx/, not <workspace>/.lakshx/) for
// the same reason royal-audit/checkpoints live outside it: a marker the agent
// itself could edit via a Royal-mode tool call would defeat the point of
// "informed consent" being a human's decision, not the agent's.
function royalConsentDir() {
  const dir = path.join(os.homedir(), ".lakshx", "royal-consent");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function royalConsentPath(cwd) {
  const hash = crypto.createHash("sha256").update(cwd || "").digest("hex").slice(0, 16);
  return path.join(royalConsentDir(), `${hash}.json`);
}

function hasRoyalConsent(cwd) {
  try {
    return fs.existsSync(royalConsentPath(cwd));
  } catch {
    return false;
  }
}

function grantRoyalConsent(cwd) {
  try {
    fs.writeFileSync(royalConsentPath(cwd), JSON.stringify({ cwd, consentedAt: new Date().toISOString() }, null, 2));
  } catch {
    // best-effort — a write failure here shouldn't hard-block enabling Royal;
    // worst case the user is asked to confirm again next time
  }
}

// ---------- Remote Access (LAN mobile view, view-only — docs/research/10) ----------
// Off by default; only ever starts from the "LakshX: Enable Remote Access"
// command below. The server itself lives in remote-server.js (plain Node
// http, no vscode dependency, independently unit-testable); this file's only
// job is the VS Code-side plumbing: the command, the one-time warning, and
// the QR/pairing-info panel.
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function remoteAccessQrHtml(info, workspaceName) {
  const { renderQrSvg } = require("./remote-qr.js");
  const svg = renderQrSvg(info.url, 5);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0e1116; color: #c8cede;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    min-height: 100vh; box-sizing: border-box; padding: 32px 24px; text-align: center; }
  h2 { font-size: 15px; margin: 0 0 6px; color: #fff; }
  .ws { color: #8a93a8; font-size: 12px; margin-bottom: 18px; }
  .qr { background: #fff; display: inline-flex; padding: 16px; border-radius: 14px; }
  .qr svg { display: block; }
  .url { font-family: "SF Mono", Menlo, monospace; font-size: 12px; word-break: break-all; margin-top: 18px;
    background: rgba(255,255,255,0.06); padding: 10px 12px; border-radius: 8px; user-select: all; display: inline-block;
    max-width: 380px; }
  .warn { color: #ffb454; font-size: 12px; margin: 20px auto 0; max-width: 380px; line-height: 1.5; }
  .stop { color: #8a93a8; font-size: 11.5px; margin-top: 10px; }
</style></head><body>
  <h2>Scan to view and control this chat from your phone</h2>
  <div class="ws">${escapeHtml(workspaceName)} &middot; same WiFi network required &middot; full control</div>
  <div class="qr">${svg}</div>
  <div class="url">${escapeHtml(info.url)}</div>
  <div class="warn">Anyone who scans this code or gets this link can watch this chat live — including file paths and
    tool output — AND send prompts, approve/deny permission requests, and switch modes, exactly as if they were
    sitting at this keyboard, until you turn Remote Access off. Don't share it outside a network you trust.</div>
  <div class="stop">Run &ldquo;LakshX: Disable Remote Access&rdquo; from the command palette to stop and invalidate this link.</div>
</body></html>`;
}

function showRemoteAccessPanel(info, workspaceName) {
  const panel = vscode.window.createWebviewPanel(
    "lakshxRemoteAccess",
    "LakshX Remote Access",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: false },
  );
  panel.webview.html = remoteAccessQrHtml(info, workspaceName);
  return panel;
}

/** Best-effort text extraction from a tool_call_update's ACP `content` array. */
function extractToolOutputText(u) {
  try {
    const c = u.content?.[0]?.content;
    return c?.type === "text" ? c.text : undefined;
  } catch {
    return undefined;
  }
}

// ---------- "Explain this crash" (docs/research/15-ide-feature-roadmap.md
// item #8): hook the debug-adapter-protocol exception event to the existing
// agent — no new debugger UI, no new agent-side tool. Detection lives here
// (vscode.debug + raw DAP messages); prompt assembly is crash-context.js
// (pure, unit-tested); sending reuses AgentViewProvider.sendPrompt() exactly
// like a typed message, via its extraContext param (see above). ----------
//
// Skips absurdly large files for the crash-line excerpt — a stack frame
// pointing at a huge generated/data file isn't a useful source excerpt
// anyway, and reading it in full on every exception stop would be wasteful.
const MAX_CRASH_EXCERPT_FILE_BYTES = 5_000_000;

// A completed background task or a runaway loop can throw the same
// exception on nearly every iteration — this debounce keeps a single
// hot-looping crash from spamming one notification per exception. Purely a
// UX nicety on top of the real noise control (the notification never
// auto-sends to the agent by itself; see debugExplain.enabled/autoSend).
const CRASH_NOTIFY_DEBOUNCE_MS = 4000;

/** True only for a DAP `stopped` event whose `body.reason` is `"exception"` — every other field on `message` is left untouched/unchecked here. */
function isDapExceptionStop(message) {
  return message?.type === "event" && message.event === "stopped" && message.body?.reason === "exception";
}

/** Best-effort read of `absPath` for the crash excerpt. Never throws; returns null for anything unreadable/oversized. */
function readExcerptSourceText(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_CRASH_EXCERPT_FILE_BYTES) return null;
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

/** True only if `absPath` is a real path inside the current workspace root — the excerpt is never read for a file outside it. */
function isPathInWorkspace(absPath) {
  const root = workspaceRoot();
  if (!root || typeof absPath !== "string") return false;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return absPath === root || absPath.startsWith(rootWithSep);
}

/**
 * Fetch `exceptionInfo` + `stackTrace` over DAP while `session` is still
 * stopped on the exception — both customRequests are only valid in that
 * window, so this MUST run synchronously off the `stopped` event, never
 * deferred to "whenever the user clicks the notification" (see
 * AgentViewProvider.lastCrashContext's doc comment: capture is eager, send
 * is lazy off the cache). Never throws — every DAP field here is optional
 * and adapter-dependent (task requirement: degrade gracefully rather than
 * assume a rigid schema); a request that fails or an adapter that doesn't
 * implement it just yields less context, not an error.
 */
async function captureCrashContext(session, threadId) {
  let exceptionInfo = null;
  try {
    exceptionInfo = await session.customRequest("exceptionInfo", { threadId });
  } catch {
    // adapter doesn't implement it, or the session already moved on — degrade
  }
  let stackFrames = null;
  try {
    const res = await session.customRequest("stackTrace", { threadId, startFrame: 0, levels: 20 });
    stackFrames = res?.stackFrames ?? null;
  } catch {
    // same degrade-gracefully rule as above
  }
  const topPath = stackFrames?.[0]?.source?.path;
  const excerptText = topPath && isPathInWorkspace(topPath) ? readExcerptSourceText(topPath) : null;
  return buildCrashContext({ exceptionInfo, stackFrames, excerptText });
}

/**
 * Send a captured crash context through the EXISTING send path — focuses/
 * opens the chat panel first (same "focus then post" precedent as
 * `lakshx.addSelectionToChat` below), then calls `sendPrompt()` exactly like
 * a typed message would, just with `extraContext` carrying the `<exception>`
 * block instead of file-attachment chips.
 */
async function triggerExplainCrash(provider, ctx) {
  const use = ctx ?? provider.lastCrashContext;
  if (!use) {
    vscode.window.showInformationMessage(
      "LakshX: no crash details captured yet — this works right after an exception stops the debugger.",
    );
    return;
  }
  await vscode.commands.executeCommand("lakshx.chatView.focus");
  await provider.sendPrompt(use.displayText, [], use.promptBlock);
}

/**
 * Runs once per DAP `stopped`/exception event: capture, cache, then either
 * auto-send (`lakshx.debugExplain.autoSend`), show a dismissible notification
 * with an action button (`lakshx.debugExplain.enabled`, the default), or do
 * neither (still leaves the cache populated so the manual
 * `lakshx.explainCrash` command works even with the notification off or
 * already dismissed).
 */
async function handleExceptionStop(provider, session, threadId) {
  const ctx = await captureCrashContext(session, threadId);
  provider.lastCrashContext = ctx;

  const cfg = vscode.workspace.getConfiguration("lakshx");
  const autoSend = cfg.get("debugExplain.autoSend", false);
  const enabled = cfg.get("debugExplain.enabled", true);

  if (autoSend) {
    await triggerExplainCrash(provider, ctx);
    return;
  }
  if (!enabled) return;

  // Debounce identical repeat notifications (e.g. an exception re-thrown on
  // every loop iteration) — keyed on the crash context's own text since DAP
  // doesn't hand us a stable exception identity to key on instead.
  const key = ctx.displayText + "|" + ctx.promptBlock;
  const now = Date.now();
  if (provider._lastCrashNotifyKey === key && now - provider._lastCrashNotifyAt < CRASH_NOTIFY_DEBOUNCE_MS) return;
  provider._lastCrashNotifyKey = key;
  provider._lastCrashNotifyAt = now;

  const label = ctx.displayText.replace(/^Explain this crash:\s*/, "");
  const message = label
    ? `LakshX: unhandled exception detected (${label}) — Explain with LakshX?`
    : "LakshX: unhandled exception detected — Explain with LakshX?";
  const choice = await vscode.window.showInformationMessage(message, "Explain with LakshX");
  if (choice) await triggerExplainCrash(provider, ctx);
}

/**
 * Registers the one hook this whole feature needs: a
 * `DebugAdapterTrackerFactory` for every debug type (`"*"`), watching raw DAP
 * messages for a `stopped`/`reason:"exception"` event via
 * `onDidSendMessage`. This is deliberately the ONLY new vscode.debug surface
 * touched — no new views, no new debugger UI, per the feature's scope.
 *
 * `onDidSendMessage` is synchronous or must behave as if it is — the actual
 * work (`handleExceptionStop`) is async, so it's kicked off fire-and-forget
 * with its own `.catch`, and the whole body is wrapped in try/catch too:
 * this tracker must NEVER throw, since an uncaught exception here would come
 * from inside VS Code's own debug-adapter message pump, not from user code.
 */
function registerCrashExplainTracker(context, provider) {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory("*", {
      createDebugAdapterTracker(session) {
        return {
          onDidSendMessage(message) {
            try {
              if (!isDapExceptionStop(message)) return;
              const threadId = message.body?.threadId;
              handleExceptionStop(provider, session, threadId).catch((err) => {
                provider.log.appendLine(`explain-crash: failed to handle exception stop: ${err.message}`);
              });
            } catch (err) {
              provider.log.appendLine(`explain-crash: tracker error: ${err.message}`);
            }
          },
        };
      },
    }),
  );
}

class AgentViewProvider {
  constructor(context) {
    this.context = context;
    this.acp = null;
    this.sessionId = null;
    this.permissionWaiters = new Map();
    this.log = vscode.window.createOutputChannel("LakshX Agent");
    this.transcript = [];
    this.chatId = `chat-${Date.now()}`;
    this.chatTitle = null;
    this.mode = "review";
    this.currentModel = null; // best-effort, for feedback-log context only
    this.customCommands = []; // discovered .lakshx/commands/*.md — see refreshCustomCommands()
    this.remote = null; // RemoteServer instance, only set while "LakshX: Enable Remote Access" is on
    this.turnInProgress = false; // set for the duration of a session/prompt turn — see sendPrompt(); the one guard
    // shared by the desktop composer and the phone's POST /control/send so the two can't race each other into two
    // concurrent session/prompt calls (docs/research/10-remote-control.md Phase B, race-handling item).

    // ---------- prompt-checkpoints + undo (docs/research/11) ----------
    // path (workspace-relative, same shape `lakshx/checkpoint` notifications
    // use) -> { promptId, sha, toolCallId } for the MOST RECENT prompt that
    // touched it — latest-wins, per doc 11 §3.3/§4.1. This is what the
    // editor-title undo button's `lakshx.fileHasCheckpoint` context key and
    // "undo this file" action read from; the chat panel's per-turn card gets
    // its own file lists straight off the "checkpoint" transcript events
    // (grouped by promptId), not from this map.
    this.fileCheckpoints = new Map();

    // ---------- "Explain this crash" (docs/research/15 item #8) ----------
    // Most recently captured DAP exception-stop context (see
    // captureCrashContext() below), cached here so BOTH the notification's
    // action button AND the manually-triggered `lakshx.explainCrash` command
    // can send it — capture must happen eagerly while the adapter is still
    // stopped (exceptionInfo/stackTrace only work then), but sending is
    // always lazy, off this cache, never re-fetched at click time.
    this.lastCrashContext = null;
    this._lastCrashNotifyKey = null;
    this._lastCrashNotifyAt = 0;
  }

  /** Snapshot handed to a freshly (re)connecting phone — see remote-server.js's GET /state. */
  remoteSnapshot() {
    return {
      workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? "LakshX",
      mode: this.mode,
      transcript: this.transcript,
    };
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m) => this.onWebviewMessage(m));

    // First time the agent panel is actually shown (not just extension
    // activation — activation can fire before any panel is visible, which
    // would make a nudge here feel context-less): open the walkthrough
    // instead of a one-shot toast, since a dismissed toast is gone for good
    // while the walkthrough stays reachable later from the Command Palette
    // ("Welcome: Open Walkthrough...") or Help > Get Started.
    if (!this.context.globalState.get("lakshx.loginPrompted.v1")) {
      this.context.globalState.update("lakshx.loginPrompted.v1", true);
      const state = readProviderState();
      const hasAnyProvider = PROVIDER_IDS.some((id) => state.set[id]);
      if (!hasAnyProvider) {
        vscode.commands.executeCommand("workbench.action.openWalkthrough", "lakshx.lakshx-chat#lakshxGettingStarted", false);
      }
    }
  }

  post(msg) {
    if (REPLAYABLE.has(msg.type)) {
      // `ts` is stamped here — at the moment this event is observed, not
      // re-derived later — so buildDiagnosticReport() can show real
      // wall-clock times and per-block durations with no protocol change:
      // every REPLAYABLE event already funnels through this one function.
      // Kept OFF the object handed to postMessage/broadcast so the live
      // webview/remote payload shape is unchanged — only the transcript's
      // stored copy gains the field.
      this.transcript.push({ ...msg, ts: Date.now() });
      this.persistSoon();
    }
    this.view?.webview.postMessage(msg);
    this.remote?.broadcast(msg); // Remote Access mirror — see remote-server.js
  }

  persistSoon() {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      // never persist a chat that has no real user message yet — a session
      // spawned/opened but never prompted (or one that only hit a "system"
      // error/notice before the user typed anything) must not show up in
      // history as an "Untitled chat"
      if (!this.transcript.some((e) => e.type === "user")) return;
      const title =
        this.chatTitle ??
        this.transcript.find((e) => e.type === "user")?.text?.slice(0, 48) ??
        "Untitled chat";
      const file = path.join(chatsDir(), `${this.chatId}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({
          id: this.chatId,
          title,
          updatedAt: Date.now(),
          mode: this.mode,
          sessionId: this.sessionId, // lets "open old chat" resume real agent memory, not just the view
          events: this.transcript,
        }),
      );
    }, 400);
  }

  listChats() {
    try {
      return fs.readdirSync(chatsDir())
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(chatsDir(), f), "utf8"));
            const userEvent = j.events?.find((e) => e.type === "user");
            // stale/leftover chats with no real prompt (e.g. from before this
            // fix, or a system-error-only session) shouldn't show up at all
            if (!userEvent) return null;
            let title = j.title;
            if (!title || title === "Untitled chat") {
              title = userEvent.text?.slice(0, 48) ?? "Untitled chat";
            }
            return { id: j.id, title, updatedAt: j.updatedAt };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50);
    } catch { return []; }
  }

  /**
   * Connect to the runtime if needed, then either resume `resumeSessionId`
   * (real agent memory restored server-side) or open a fresh session.
   * Already-connected + already-on-the-right-session is the fast path.
   */
  async ensureAgent(resumeSessionId) {
    if (this.acp && this.sessionId && (!resumeSessionId || resumeSessionId === this.sessionId)) return true;

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

    if (this.acp) {
      // already connected, just switching which chat's session is active
      await this.loadOrNewSession(resumeSessionId, cwd);
      return true;
    }

    const spec = agentSpawnSpec(this.context);
    if (!spec) {
      this.post({ type: "system", text: "LakshX Agent Runtime not found. Set lakshx.agent.command in settings." });
      return false;
    }
    this.log.appendLine(`spawning agent: ${spec.command} ${spec.args.join(" ")}`);
    this.acp = new AcpClient(spec.command, spec.args, spec.cwd ?? cwd, spec.env, {
      onLog: (line) => this.log.append(line),
      onError: (err) => {
        this.log.appendLine(`SPAWN ERROR: ${err.message}`);
        this.post({ type: "system", text: `agent failed to start: ${err.message}` });
        this.acp = null;
      },
      onExit: (code) => {
        this.log.appendLine(`agent exited (${code})`);
        this.post({ type: "system", text: `agent exited (${code}) — will restart on next message` });
        this.acp = null;
        this.sessionId = null;
      },
      onNotification: (method, params) => {
        if (method === "session/update") this.onSessionUpdate(params.update);
        if (method === "lakshx/plan_ready") this.onPlanReady(params.path);
        if (method === "lakshx/usage") this.post({ type: "usage", ...params });
        if (method === "lakshx/checkpoint") this.onCheckpoint(params);
        if (method === "lakshx/checkpoint_compacted") {
          this.post({ type: "system", text: "Older undo history was compacted to bound disk usage — very old turns may no longer be undoable." });
        }
        if (method === "lakshx/subagents_start") this.onSubagentsStart(params);
        if (method === "lakshx/subagent_activity") this.onSubagentActivity(params);
        if (method === "lakshx/subagents_end") this.onSubagentsEnd(params);
        if (method === "lakshx/phase_state") this.onPhaseState(params);
        if (method === "lakshx/tool_input_delta") this.onToolInputDelta(params);
        if (method === "lakshx/tool_image") this.onToolImage(params);
        if (method === "lakshx/task_start") this.onTaskStart(params);
        if (method === "lakshx/task_activity") this.onTaskActivity(params);
        if (method === "lakshx/task_done") this.onTaskDone(params);
        if (method === "lakshx/task_steered") this.onTaskSteered(params);
      },
      onRequest: async (method, params) => {
        if (method === "session/request_permission") return this.onPermissionRequest(params);
        if (method === "lakshx/db_query") return this.onDbQuery(params);
        throw new Error(`unhandled ${method}`);
      },
    });
    await this.acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const models = await this.acp.request("lakshx/models", {});
    this.currentModel ??= models.defaultModel;
    await this.loadOrNewSession(resumeSessionId, cwd);
    this.post({ type: "ready", models });
    return true;
  }

  /** Resume a saved session's real history, falling back to a fresh one if it's gone/corrupt. */
  async loadOrNewSession(resumeSessionId, cwd) {
    if (resumeSessionId) {
      try {
        const res = await this.acp.request("session/load", { sessionId: resumeSessionId, cwd, mcpServers: [] });
        this.sessionId = resumeSessionId;
        // The agent's persisted session.mode is authoritative on resume — the
        // mode selector must reflect it, not whatever the client last had
        // (e.g. a chat-JSON `mode` that drifted from the agent's). Push a
        // modeChanged so the dropdown honors ground truth and the two can't
        // silently diverge across reconnect/load (auto:false — this is a
        // sync, not a plan-driven auto-switch, so no "switched to X" notice).
        if (res?.modes?.currentModeId) {
          this.mode = res.modes.currentModeId;
          this.view?.webview.postMessage({ type: "modeChanged", mode: this.mode, auto: false });
          this.remote?.broadcast({ type: "modeChanged", mode: this.mode, auto: false });
        }
        await this.pushExplainLanguage();
        return;
      } catch (err) {
        this.log.appendLine(`session/load failed for ${resumeSessionId}, starting fresh: ${err.message}`);
      }
    }
    const s = await this.acp.request("session/new", { cwd, mcpServers: [] });
    this.sessionId = s.sessionId;
    // A fresh agent session always starts in review (server.ts session/new).
    // Sync the mode selector to that ground truth: after an agent crash +
    // respawn, onExit nulls the session but leaves `this.mode` (e.g. "auto"),
    // so without this the dropdown would keep showing the pre-crash mode while
    // the new session actually runs review — a silent UI/agent divergence
    // (requirement: dropdown reflects the real session.mode). Mirrors the
    // resume branch above; never auto-restores royal (a fresh session is
    // review, so the royal consent gate is untouched).
    const fresh = s?.modes?.currentModeId ?? "review";
    if (this.mode !== fresh) {
      this.mode = fresh;
      this.view?.webview.postMessage({ type: "modeChanged", mode: fresh, auto: false });
      this.remote?.broadcast({ type: "modeChanged", mode: fresh, auto: false });
    }
    await this.pushExplainLanguage();
  }

  /**
   * Push the current `lakshx.explainLanguage` setting to the live agent
   * session over the same `lakshx/set_*` wire `setModel` uses
   * (`lakshx/set_explain_language`, server.ts). Not persisted server-side
   * (a fresh/loaded session always starts unset = "english" — server.ts's
   * `session/new`/`session/load` don't know about this setting), so this
   * must re-run on every `session/new`/`session/load`, same reasoning as why
   * `loadOrNewSession` re-syncs `mode` above instead of trusting a stale
   * client-side value.
   */
  async pushExplainLanguage() {
    if (!this.acp || !this.sessionId) return;
    const explainLanguage = normalizeExplainLanguage(vscode.workspace.getConfiguration("lakshx").get("explainLanguage", "english"));
    try {
      await this.acp.request("lakshx/set_explain_language", { sessionId: this.sessionId, explainLanguage });
    } catch (err) {
      this.log.appendLine(`set_explain_language failed: ${err.message}`);
    }
  }

  onSessionUpdate(u) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") this.post({ type: "chunk", text: u.content.text });
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") this.post({ type: "thought", text: u.content.text });
        break;
      case "current_mode_update":
        this.mode = u.currentModeId;
        this.post({ type: "modeChanged", mode: u.currentModeId, auto: true });
        break;
      case "tool_call":
        // rawInput is carried through (previously dropped) so the feedback
        // log can show what a tool was actually called with, not just its
        // display title.
        this.post({ type: "tool", id: u.toolCallId, title: u.title, kind: u.kind, status: u.status, input: u.rawInput });
        break;
      case "tool_call_update":
        this.post({ type: "toolUpdate", id: u.toolCallId, status: u.status, output: extractToolOutputText(u) });
        break;
    }
  }

  /**
   * `lakshx/checkpoint` notification (doc 11 §3.2) — fired once per
   * successful mutating tool call. Feeds BOTH UI surfaces from the same
   * data: the chat panel gets the raw event (grouped/rendered by promptId in
   * panel.js); `fileCheckpoints` tracks, per path, only the LATEST prompt
   * that touched it (doc 11 §4.1 — the editor button always means "undo
   * what the most recent prompt did to this file").
   */
  onCheckpoint(params) {
    // Never posted with an empty files list — loop.ts only fires
    // `onCheckpoint` when a tool call actually changed something (see its
    // doc comment), but guard here too since this is the one place that
    // could resurrect a stale "Files changed (0)" state if that upstream
    // invariant ever slipped.
    if (!params.files?.length) return;
    this.post({ type: "checkpoint", promptId: params.promptId, toolCallId: params.toolCallId, toolName: params.toolName, sha: params.sha, files: params.files });
    for (const f of params.files) {
      this.fileCheckpoints.set(f, { promptId: params.promptId, sha: params.sha, toolCallId: params.toolCallId });
    }
    this.refreshFileHasCheckpointContext();
    this.checkpointDecorationProvider?.refresh(params.files.map(toAbsoluteUri));
  }

  /**
   * `lakshx/subagents_start`/`lakshx/subagent_activity`/`lakshx/subagents_end`
   * (agent/src/loop.ts's `dispatch_subtasks` — parallel subagent fan-out) —
   * same pattern as `onCheckpoint` above: forward the notification's params
   * straight through to the webview as a transcript event, `panel.js` does
   * the actual card rendering keyed off `batchId`. No extension-side state
   * to maintain here (unlike `fileCheckpoints` above) — these three events
   * are pure progress relay, nothing else in this file reads them.
   */
  onSubagentsStart(params) {
    this.post({ type: "subagentsStart", batchId: params.batchId, promptId: params.promptId, tasks: params.tasks });
  }

  onSubagentActivity(params) {
    this.post({
      type: "subagentActivity",
      batchId: params.batchId,
      taskId: params.taskId,
      kind: params.kind,
      detail: params.detail,
      path: params.path,
      isError: params.isError,
    });
  }

  onSubagentsEnd(params) {
    this.post({ type: "subagentsEnd", batchId: params.batchId, results: params.results });
  }

  /**
   * `lakshx/phase_state` (agent/src/loop.ts's `runRoyalPhaseTurn` — Royal
   * Mode 2.0 Stage B) — fired on every phase transition and task-status
   * change during a top-level royal turn. Same pure-relay pattern as
   * `onSubagentsStart` et al above: panel.js's phase card does the actual
   * rendering, keyed by there being at most one live phase machine per turn
   * (no batchId needed, unlike subagents/background tasks).
   */
  onPhaseState(params) {
    this.post({
      type: "phaseState",
      phase: params.phase,
      taskList: params.taskList,
      currentTaskId: params.currentTaskId,
      fixRound: params.fixRound,
      planReentries: params.planReentries,
      verificationResult: params.verificationResult,
      note: params.note,
    });
  }

  /**
   * `lakshx/task_start`/`lakshx/task_activity`/`lakshx/task_done`/
   * `lakshx/task_steered` (agent/src/tasks.ts's BackgroundTaskRegistry —
   * `dispatch_subtasks {background:true}`, Royal Mode 2.0). Same pure-relay
   * pattern as `onSubagentsStart` et al above: panel.js's running-agents tray
   * does the actual rendering, keyed off `taskId`. The one thing that IS
   * extension.js's own job, unlike the blocking-subagent notifications: these
   * can arrive with NO turn in flight at all (the whole point of background
   * work), so `lakshx/task_done` also schedules the client-driven auto-wake
   * (see `scheduleAutoWake`/`triggerWake` below) — a completed background task
   * needs to reach the model even if nobody is actively chatting right now.
   */
  onTaskStart(params) {
    this.post({
      type: "taskStart",
      taskId: params.taskId,
      batchId: params.batchId,
      promptId: params.promptId,
      prompt: params.prompt,
      mode: params.mode,
      startedAt: params.startedAt,
    });
  }

  onTaskActivity(params) {
    this.post({
      type: "taskActivity",
      taskId: params.taskId,
      batchId: params.batchId,
      kind: params.kind,
      detail: params.detail,
      path: params.path,
      isError: params.isError,
    });
  }

  onTaskDone(params) {
    this.post({
      type: "taskDone",
      taskId: params.taskId,
      batchId: params.batchId,
      status: params.status,
      durationMs: params.durationMs,
      result: params.result,
    });
    this.scheduleAutoWake();
  }

  onTaskSteered(params) {
    this.post({ type: "taskSteered", taskId: params.taskId, message: params.message });
  }

  /**
   * Client-driven auto-wake (Royal Mode 2.0 §6): debounce ~1.5s so several
   * background completions arriving close together coalesce into ONE wake
   * turn rather than one per task. Deliberately does NOT check
   * `this.turnInProgress` here — that's `triggerWake()`'s job, re-checked at
   * fire time (a real user prompt may well start during the debounce window).
   */
  scheduleAutoWake() {
    clearTimeout(this._autoWakeTimer);
    this._autoWakeTimer = setTimeout(() => void this.triggerWake(), 1500);
  }

  /**
   * Send a `_meta:{wake:true}` prompt so a completed background task's
   * notification (injected server-side ahead of the drained queue's user
   * text — see server.ts's `session/prompt` handler) actually reaches the
   * model even though nobody is actively chatting. Guarantees mirrored from
   * server.ts: a wake NEVER fires while a real turn is in progress (checked
   * here AND server-side, which also never calls `session.pending?.abort()`
   * for a wake — belt and suspenders, since this client-side check alone
   * can't rule out a race with a just-started real turn) and is capped at 10
   * per chat (reset whenever a real user prompt is sent — see `sendPrompt`)
   * so a pathological completion loop can't auto-wake forever unattended.
   * Posts a "system" transcript line, NEVER a fake "user" bubble — the
   * turn's actual content (whatever the model does with the notification)
   * streams in normally through the same onSessionUpdate path a real turn
   * uses.
   */
  async triggerWake() {
    if (this.turnInProgress) return;
    if (!this.acp || !this.sessionId) return;
    if ((this.autoWakeCount ?? 0) >= 10) return;
    this.autoWakeCount = (this.autoWakeCount ?? 0) + 1;
    this.turnInProgress = true;
    try {
      this.post({ type: "system", text: "Background task finished — reviewing results" });
      this.post({ type: "turnStart" });
      const res = await this.acp.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: "(background task completed — see the notification above)" }],
        _meta: { wake: true },
      });
      this.post({ type: "turnEnd", stopReason: res.stopReason });
    } catch (err) {
      this.post({ type: "system", text: `auto-wake failed: ${err.message}` });
      this.post({ type: "turnEnd", stopReason: "error" });
    } finally {
      this.turnInProgress = false;
    }
  }

  /**
   * `lakshx/tool_input_delta` (agent/src/loop.ts's `onToolInputDelta` — live
   * tool-input streaming, throttled server-side) — deliberately NOT added to
   * REPLAYABLE: this is a live-only "watch it type" affordance, not part of
   * the durable transcript. The `tool` event (already REPLAYABLE, already
   * carries full `rawInput`) is the record a reload/replay reconstructs the
   * card from; persisting every throttled fragment too would bloat the
   * per-chat JSON file for no benefit (a replayed transcript shows the
   * FINISHED tool call, never the typing animation). `post()` still reaches
   * the live webview and any paired Remote Access phone the normal way —
   * only the `REPLAYABLE`/persist-to-disk path is skipped.
   */
  onToolInputDelta(params) {
    this.post({ type: "toolInputDelta", id: params.toolCallId, name: params.name, field: params.field, value: params.value, path: params.path });
  }

  /**
   * `lakshx/tool_image` (agent/src/server.ts, fired from `LoopCallbacks.onToolEnd`'s
   * `image` field — currently only `browser_preview`'s screenshot, see
   * agent/src/tools.ts's `ToolImageAttachment`) — the human-visible half of
   * "browser visuals" (the gap this whole feature closes: the agent already
   * ran browser_preview, but nobody ever saw the screenshot happen). Split
   * into two webview message types with deliberately different durability,
   * mirroring `onToolInputDelta`'s live-only precedent for the heavy part:
   *
   *  - "toolImage" (REPLAYABLE): id/path/mimeType ONLY, no pixel data. This
   *    is what persists to the per-chat JSON and what a paired phone's
   *    reconnect snapshot replays — cheap enough to keep around indefinitely,
   *    and enough for panel.js to render a "screenshot saved — click to
   *    open" affordance after a reload even though the inline picture itself
   *    is gone.
   *  - "toolImageData" (NOT REPLAYABLE, live only): the actual base64
   *    pixels, sent straight to the webview + any connected remote phone via
   *    postMessage/broadcast, bypassing `post()` so it never lands in
   *    `this.transcript`/disk/the reconnect snapshot. A chat with several
   *    browser_preview calls would otherwise rewrite a multi-MB blob into
   *    the chat's JSON file on every single persistSoon() and re-send it in
   *    full to every reconnecting phone — this is the same trade-off
   *    `onToolInputDelta` already makes for its own (smaller, but same
   *    shape) live-only payload.
   *
   * `params.dataBase64` is `undefined` when server.ts's size cap dropped it
   * (screenshot too large to inline) — "toolImageData" is simply not sent in
   * that case, and panel.js's placeholder affordance says so.
   */
  onToolImage(params) {
    this.post({ type: "toolImage", id: params.toolCallId, path: params.path, mimeType: params.mimeType, truncated: !params.dataBase64 });
    if (params.dataBase64) {
      const payload = { type: "toolImageData", id: params.toolCallId, path: params.path, mimeType: params.mimeType, dataBase64: params.dataBase64 };
      this.view?.webview.postMessage(payload);
      this.remote?.broadcast(payload);
    }
  }

  /**
   * Fan-out for "an undo just succeeded" — called from every place a
   * `lakshx/undo_file`/`lakshx/undo_prompt` request (chat-panel buttons OR the
   * editor-title command) returns `ok:true`. Removes the reverted paths from
   * every piece of state that tracks "this file currently has an
   * agent-made change to undo," so all three surfaces (editor-title button +
   * badge, chat-panel per-turn card, composer-anchored summary bar) drop
   * back out of view together — zero remaining changes means zero undo UI,
   * not a stale, still-visible-but-empty card left behind on any surface.
   * Persisted as a REPLAYABLE event so a chat reload converges to the same
   * state a live session would.
   */
  notifyReverted(paths) {
    if (!paths?.length) return;
    for (const p of paths) this.fileCheckpoints.delete(p);
    this.refreshFileHasCheckpointContext();
    this.checkpointDecorationProvider?.refresh(paths.map(toAbsoluteUri));
    this.post({ type: "checkpointReverted", paths });
  }

  /**
   * A `lakshx/rewind_to_prompt` request just succeeded server-side (files
   * reverted + agent history truncated). Mirror it client-side: truncate the
   * REPLAYABLE transcript at the matching user event (the user message itself
   * is removed too, matching the server dropping it from history — the next
   * prompt continues from just before it), rebuild the checkpoint-tracking
   * state from what remains, append a system receipt, persist, and push a
   * full replay to the webview — the simplest correct way to make every
   * rendered surface (bubbles, tool cards, checkpoint cards, session bar)
   * converge on the truncated state at once.
   */
  applyRewind(promptId, res) {
    const idx = this.transcript.findIndex((e) => e.type === "user" && e.promptId === promptId);
    const removedUser = idx >= 0 ? this.transcript[idx] : null;
    if (idx >= 0) this.transcript = this.transcript.slice(0, idx);
    // Every checkpoint event at/after the rewind point was just truncated
    // away, so an in-order rebuild converges all three editor-side surfaces
    // (title button, badge, context key) to exactly the surviving changes.
    this.rebuildFileCheckpoints();
    const label = String(removedUser?.text ?? "").slice(0, 60);
    const n = res.truncatedMessages ?? 0;
    const f = res.revertedFiles?.length ?? 0;
    this.post({
      type: "system",
      text: `Rewound to: "${label}" — ${n} message${n === 1 ? "" : "s"} removed, ${f} file${f === 1 ? "" : "s"} reverted.`,
    });
    this.persistSoon();
    this.view?.webview.postMessage({ type: "replay", events: this.transcript });
    this.remote?.broadcast({ type: "replay", events: this.transcript }); // bypasses post() — mirror explicitly, see loadChat
  }

  /** Rebuild `fileCheckpoints` from a loaded/replayed transcript's "checkpoint"/"checkpointReverted" events, in order, latest-wins per path. */
  rebuildFileCheckpoints() {
    this.fileCheckpoints.clear();
    for (const e of this.transcript) {
      if (e.type === "checkpoint") {
        for (const f of e.files ?? []) this.fileCheckpoints.set(f, { promptId: e.promptId, sha: e.sha, toolCallId: e.toolCallId });
      } else if (e.type === "checkpointReverted") {
        for (const f of e.paths ?? []) this.fileCheckpoints.delete(f);
      }
    }
    this.refreshFileHasCheckpointContext();
    this.checkpointDecorationProvider?.refresh(undefined);
  }

  /** Recompute the `lakshx.fileHasCheckpoint` `when`-clause context key for whatever editor is currently active. */
  refreshFileHasCheckpointContext() {
    const editor = vscode.window.activeTextEditor;
    const has = Boolean(editor && this.fileCheckpoints.has(toWorkspaceRelative(editor.document.uri.fsPath)));
    vscode.commands.executeCommand("setContext", "lakshx.fileHasCheckpoint", has);
  }

  /**
   * "Open diff" (follow-up ask: clicking a changed file should show what
   * changed, not just open it blind). Fetches the pre-turn content from the
   * agent process (only it touches the shadow-git plumbing) and hands it to
   * VS Code's built-in diff editor against the live file on disk.
   */
  async openCheckpointDiff(promptId, relPath) {
    if (!this.acp || !this.sessionId) return;
    // Accept an absolute path too — every existing caller here (the
    // checkpoint card's own `files` list) already passes a workspace-relative
    // path, so this is normally a no-op, but the merge-conflict tool card's
    // "Open diff" button (panel.js) forwards whatever `filePath` the MODEL
    // used calling resolve_merge_conflict, which is very often absolute
    // (list_merge_conflicts itself returns absolute paths). Without this,
    // both `toAbsoluteUri` (below) and the agent-side `git show <sha>:<path>`
    // lookup silently fail/misresolve against an absolute path.
    if (path.isAbsolute(relPath)) relPath = toWorkspaceRelative(relPath);
    const rightUri = toAbsoluteUri(relPath);
    let content = null;
    try {
      const res = await this.acp.request("lakshx/checkpoint_file_before", { sessionId: this.sessionId, promptId, path: relPath });
      content = res?.content ?? null;
    } catch (err) {
      this.post({ type: "system", text: `Could not load the pre-change version of ${relPath} (${err.message}) — opening the file instead.` });
      try {
        await vscode.window.showTextDocument(rightUri);
      } catch (openErr) {
        this.post({ type: "system", text: `Could not open ${relPath}: ${openErr.message}` });
      }
      return;
    }
    const leftUri = checkpointContentProvider.uriFor(relPath, content ?? "");
    const title = `${path.basename(relPath)} (before this turn ↔ working tree)`;
    try {
      await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title);
    } catch (err) {
      // e.g. the live file was deleted since (a later bash `rm`, or the
      // agent removed it) — vscode.diff can't open a nonexistent right side.
      // Degrade to just the "before" content read-only rather than a dead click.
      try {
        await vscode.workspace.openTextDocument(leftUri).then((doc) => vscode.window.showTextDocument(doc));
      } catch {
        this.post({ type: "system", text: `Could not open a diff for ${relPath}: ${err.message}` });
      }
    }
  }

  async onPlanReady(planPath) {
    this.pendingPlan = planPath;
    const rel = path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", planPath);
    this.post({ type: "system", text: `Plan saved: ${rel}` });
    this.view?.webview.postMessage({ type: "planReady", path: rel });
    try {
      const doc = await vscode.workspace.openTextDocument(planPath);
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
    } catch {}
  }

  async planDecision(decision) {
    this.pendingPlan = null;
    if (decision === "approve") {
      this.mode = "approve";
      if (this.acp && this.sessionId) {
        await this.acp.request("session/set_mode", { sessionId: this.sessionId, modeId: "approve" });
      }
      this.post({ type: "modeChanged", mode: "approve", auto: true });
      await this.onWebviewMessage({ type: "send", text: "The plan is approved. Implement it step by step, verifying as you go." });
    } else if (decision === "reject") {
      await this.onWebviewMessage({ type: "send", text: "I am rejecting this plan. Ask me what direction you should take instead — do not start over on your own." });
    }
    // "enhance" is handled entirely in the webview (prefills the input)
  }

  /**
   * Handle a `lakshx/db_query` ACP request from the agent runtime (the
   * db_query tool's relay — docs/research/13 §8). This is the ONLY hop that
   * knows how to reach the lakshx-db extension, which owns both the DB drivers
   * and the per-extension credentials. lakshx-chat itself has neither, so it
   * just forwards to lakshx-db's exported `runReadOnlyQuery`.
   *
   * Graceful degradation is REQUIRED: if lakshx-db isn't installed, is an
   * older version without the AI-query export, or throws for any reason, this
   * returns a clean `{text, isError}` the model can act on — it must NEVER let
   * an exception cross back over the ACP boundary.
   *
   * `maxRows` is marshalled as an OBJECT PROPERTY of the third argument
   * (`{ maxRows }`), not positionally — passing it positionally would silently
   * default it to 50 inside runReadOnlyQuery.
   */
  async onDbQuery(params) {
    try {
      const ext = vscode.extensions.getExtension("lakshx.lakshx-db");
      if (!ext) return { text: "db_query: the LakshX Database extension isn't installed.", isError: true };
      const api = ext.isActive ? ext.exports : await ext.activate();
      if (!api || typeof api.runReadOnlyQuery !== "function") {
        return { text: "db_query: this LakshX Database version doesn't support AI queries.", isError: true };
      }
      const res = await api.runReadOnlyQuery(
        params.connectionRef ?? params.engineId,
        params.query,
        { maxRows: params.maxRows },
      );
      return { text: String(res?.text ?? ""), isError: !!res?.isError };
    } catch (e) {
      return { text: `db_query failed: ${e && e.message ? e.message : String(e)}`, isError: true };
    }
  }

  onPermissionRequest(params) {
    const id = params.toolCall.toolCallId;
    this.post({
      type: "permission",
      id,
      title: params.toolCall.title,
      options: params.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })),
    });
    return new Promise((resolve) => {
      this.permissionWaiters.set(id, (optionId) =>
        resolve({ outcome: { outcome: "selected", optionId } }),
      );
    });
  }

  /**
   * Send a prompt as a brand-new turn (used by both the composer's "send"
   * and the retry button — retry is just this replayed with the recovered
   * original prompt text). `attachments` are the composer's file chips
   * (drag-drop / @-mention / attach-current-file) — deliberately kept OUT
   * of the displayed/persisted "user" text (which stays exactly what the
   * user typed) and instead expanded into `<file>` blocks that are
   * prepended only to the text actually sent to the runtime. This is a
   * pure text-assembly step — no protocol/runtime changes.
   *
   * `extraContext`, if given, is a single already-built block of text (e.g.
   * the "Explain this crash" flow's `<exception>...</exception>` block from
   * crash-context.js) prepended to the outgoing prompt the same way — kept
   * out of the displayed/persisted `text` exactly like an attachment's
   * `<file>` block is. This is the ONLY hook a non-composer caller needs:
   * everything else about the turn (turnInProgress guard, promptId, event
   * posting, error handling) is identical to a normal typed send.
   */
  async sendPrompt(text, attachments = [], extraContext = "") {
    // Race guard (docs/research/10 Phase B): the desktop composer and the
    // phone's POST /control/send both funnel through here. Whichever call
    // gets here first wins the turn; the other is a silent no-op rather than
    // a second overlapping session/prompt call corrupting turn state. The
    // remote server also checks this flag before dispatching (returns 409
    // to the phone without ever reaching this method), but the check is
    // repeated here too since this is the one choke point both the webview
    // and the HTTP handler actually call.
    if (this.turnInProgress) return;
    if (!(await this.ensureAgent())) return;
    const displayText = text || (attachments.length ? attachments.map((a) => `@${a.path}`).join(" ") : "");
    if (!displayText) return;
    this.turnInProgress = true;
    // A genuine user prompt resets the auto-wake budget (Royal Mode 2.0 §6) —
    // the 10-per-chat cap guards against a pathological unattended completion
    // loop, not against a human who is actively back in the conversation.
    this.autoWakeCount = 0;
    // doc 11 §1: minted client-side, before the request goes out, so it can
    // be attached to this same optimistic "user" post — the client already
    // knows it just sent one prompt and is receiving updates until turnEnd,
    // so no round-trip is needed to associate the ID with this turn.
    const promptId = "pr_" + crypto.randomUUID();
    try {
      this.post({ type: "user", text: displayText, promptId });
      if (!this.chatTitle) this.chatTitle = displayText.slice(0, 48);
      this.post({ type: "turnStart" });
      const blocks = attachments.map(buildFileBlock).filter(Boolean);
      if (extraContext) blocks.unshift(extraContext);
      const promptText = blocks.length ? `${blocks.join("\n\n")}\n\n${displayText}` : displayText;
      try {
        const res = await this.acp.request("session/prompt", {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: promptText }],
          // `_meta` is the ACP spec's own extension-data bag — a bare
          // top-level `promptId` field gets silently stripped by the
          // runtime's built-in `session/prompt` schema validation (verified
          // against the ACP SDK directly; see agent/src/server.ts).
          _meta: { promptId },
        });
        this.post({ type: "turnEnd", stopReason: res.stopReason });
      } catch (err) {
        this.post({ type: "system", text: `error: ${err.message}` });
        this.post({ type: "turnEnd", stopReason: "error" });
        // Best-effort: whatever made session/prompt reject client-side —
        // including AcpClient.request()'s own timeout above — the runtime
        // may still be churning away on this turn with nobody listening
        // anymore. A stray notify to an already-dead/wedged child is
        // harmless (fire-and-forget, no response expected), but if the
        // process is merely slow rather than truly dead this at least gives
        // it a chance to actually stop instead of burning tokens/compute on
        // a turn the UI has already given up on.
        this.acp?.notify("session/cancel", { sessionId: this.sessionId });
      }
    } finally {
      this.turnInProgress = false;
    }
  }

  /**
   * Editor-title undo (doc 11 §6): revert `relPath` to its state before the
   * most recent prompt that touched it. Shared conflict-confirm flow — an
   * editor-buffer dirty check first (client-side, catches the most visible
   * case before even asking the runtime), then the shadow-git conflict check
   * server-side (doc 11 §5), each with its own confirm-and-retry-with-force
   * step. Returns `{ok, reverted}` / `{ok:false}` / `null` if the user
   * cancelled at either step, or if there is nothing to undo.
   */
  async undoFileWithConfirm(relPath) {
    if (!this.acp || !this.sessionId) return null;
    if (!this.fileCheckpoints.has(relPath)) return null;

    const doc = vscode.workspace.textDocuments.find((d) => toWorkspaceRelative(d.uri.fsPath) === relPath);
    if (doc?.isDirty) {
      const pick = await vscode.window.showWarningMessage(
        "This file has unsaved changes in the editor. Undo will discard them.",
        { modal: true },
        "Discard and Undo",
      );
      if (pick !== "Discard and Undo") return null;
    }

    try {
      let res = await this.acp.request("lakshx/undo_file", { sessionId: this.sessionId, path: relPath });
      if (!res.ok && res.conflict) {
        const pick = await vscode.window.showWarningMessage(
          "This file has been edited since the agent last changed it. Undo will overwrite that edit.",
          { modal: true },
          "Overwrite and Undo",
        );
        if (pick !== "Overwrite and Undo") return null;
        res = await this.acp.request("lakshx/undo_file", { sessionId: this.sessionId, path: relPath, force: true });
      }
      return res;
    } catch (err) {
      this.post({ type: "system", text: `undo failed: ${err.message}` });
      return { ok: false };
    }
  }

  /** Build an attachment chip from an editor's current selection (or whole file if no selection). */
  attachmentFromEditor(editor) {
    const rel = toWorkspaceRelative(editor.document.uri.fsPath);
    const sel = editor.selection;
    if (sel && !sel.isEmpty) {
      return { path: rel, startLine: sel.start.line + 1, endLine: sel.end.line + 1 };
    }
    return { path: rel };
  }

  /**
   * v1 turn correlation for feedback/retry: there is no formal promptId
   * system yet (a separate, later feature), so "the response being rated"
   * is approximated as everything in the transcript after the most recent
   * "user" event. Good enough for now, but it means feedback/retry always
   * refers to the latest turn even if the user clicks controls on an older
   * message further up in a long session — worth revisiting once turns
   * carry real IDs.
   */
  turnContext() {
    let uIdx = -1;
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      if (this.transcript[i].type === "user") { uIdx = i; break; }
    }
    const userPromptText = uIdx >= 0 ? this.transcript[uIdx].text : "";
    const after = uIdx >= 0 ? this.transcript.slice(uIdx + 1) : [];
    const assistantResponseText = after.filter((e) => e.type === "chunk").map((e) => e.text).join("");
    const toolsById = new Map();
    for (const e of after) {
      if (e.type === "tool") {
        toolsById.set(e.id, { name: e.title, kind: e.kind, input: e.input, isError: false, outputSummary: undefined });
      } else if (e.type === "toolUpdate") {
        const t = toolsById.get(e.id);
        if (t) {
          t.isError = e.status === "failed";
          if (e.output) t.outputSummary = String(e.output).slice(0, 500);
        }
      }
    }
    return { userPromptText, assistantResponseText, toolCalls: [...toolsById.values()] };
  }

  /** Append one structured entry to this month's local feedback JSONL. */
  logFeedback(fields) {
    const entry = {
      ts: new Date().toISOString(),
      chatId: this.chatId,
      sessionId: this.sessionId,
      model: this.currentModel,
      mode: this.mode,
      ...fields,
    };
    try {
      fs.appendFileSync(feedbackFile(), JSON.stringify(entry) + "\n");
    } catch (err) {
      this.log.appendLine(`feedback log write failed: ${err.message}`);
    }
    return entry;
  }

  /**
   * Assembles a full, human-readable diagnostic dump of this chat session
   * for the "copy diagnostics" composer button. Actual report assembly
   * lives in diagnostics.js (pure, no vscode dependency, unit-testable) —
   * this method just supplies the vscode-derived bits (the workspace
   * folder name) and this instance's own state. See diagnostics.js's
   * buildDiagnosticReport doc comment for the full design rationale,
   * including why this stays synchronous (must still work when the
   * session is hung) and how thinking/assistant text is capped.
   */
  buildDiagnosticReport() {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? "(no workspace)";
    return diagnostics.buildDiagnosticReport({
      transcript: this.transcript,
      workspace,
      chatTitle: this.chatTitle,
      chatId: this.chatId,
      sessionId: this.sessionId,
      currentModel: this.currentModel,
      mode: this.mode,
    });
  }

  // ---------- custom slash commands (Royal Mode 2.0 Stage 1b, docs/research/12) ----------
  // Discovery + templating live in commands.js (pure, unit-tested); this
  // side only decides WHERE to look (workspace dir first — it wins name
  // clashes over ~/.lakshx) and ships the result to the popover. Bodies stay
  // extension-side: the webview only ever sees {name, description, source},
  // and asks for execution by name ("runCommand" below), which re-scans so a
  // just-edited .md file runs its current content without a reload.
  commandSources() {
    const sources = [];
    const root = workspaceRoot();
    if (root) sources.push({ dir: path.join(root, ".lakshx", "commands"), source: "workspace" });
    sources.push({ dir: path.join(os.homedir(), ".lakshx", "commands"), source: "user" });
    return sources;
  }

  refreshCustomCommands() {
    this.customCommands = discoverCommands(this.commandSources());
    // pure UI state — deliberately NOT post(): not a transcript event, not
    // replayable, not mirrored to a paired phone (the phone has no composer
    // popover to feed).
    this.view?.webview.postMessage({
      type: "commands",
      commands: this.customCommands.map((c) => ({ name: c.name, description: c.description, source: c.source })),
    });
  }

  // ---------- /walkthrough — PR/diff walkthrough auto-generator ----------
  // (docs/research/16-ide-feature-roadmap-round2.md §"PR walkthrough
  // auto-generator"). Gathers `git diff` text + a bounded workspace-file scan
  // (see execGit/gatherWorkspaceFilesForScan above), hands it all to
  // pr-walkthrough.js's pure functions, then sends the composed result
  // through the exact same sendPrompt() path a normal typed message uses —
  // no new agent tool, just a richer client-composed prompt, mirroring the
  // "Explain this crash" flow (see explainCrash() below) exactly.
  async runPrWalkthrough() {
    const root = workspaceRoot();
    if (!root) {
      this.view?.webview.postMessage({ type: "system", text: "No workspace folder open — nothing to walk through." });
      return;
    }
    // sendPrompt() itself no-ops on turnInProgress too, but checking first
    // avoids doing the git/file-scan work at all when a turn is already
    // running, and lets us give the user an actual toast/system message
    // instead of a silent no-op.
    if (this.turnInProgress) {
      this.view?.webview.postMessage({ type: "system", text: "Agent is busy — wait for the turn to finish." });
      return;
    }

    const diffText = await gatherWalkthroughDiff(root);
    if (!diffText.trim()) {
      // Graceful "nothing to do" case — a clean system message, never an
      // empty/confusing walkthrough request sent to the model.
      this.view?.webview.postMessage({ type: "system", text: "No staged or unstaged changes to walk through." });
      return;
    }

    const diffSummary = prWalkthrough.getDiffSummary(diffText);
    const workspaceFiles = await gatherWorkspaceFilesForScan();
    const allPaths = workspaceFiles.map((f) => f.path);
    const dependents = {};
    const testCoverage = {};
    for (const f of diffSummary.files) {
      dependents[f.path] = prWalkthrough.findLightweightDependents(f.path, workspaceFiles);
      testCoverage[f.path] = prWalkthrough.hasTestCoverage(f.path, allPaths);
    }
    const logOut = await execGit(["log", "--oneline", "-n", String(prWalkthrough.MAX_COMMITS)], root);
    const commitMessages = logOut.split("\n").map((s) => s.trim()).filter(Boolean);

    const { displayText, promptBlock } = prWalkthrough.buildWalkthroughPrompt({
      diffSummary,
      dependents,
      testCoverage,
      commitMessages,
    });
    await this.sendPrompt(displayText, [], promptBlock);
  }

  async onWebviewMessage(m) {
    switch (m.type) {
      case "send":
        await this.sendPrompt(m.text, m.attachments);
        break;
      case "refreshCommands":
        this.refreshCustomCommands();
        break;
      case "runCommand": {
        // A custom command IS a normal user turn — expandCommandBody's
        // result goes through the exact same sendPrompt path the composer
        // uses, so it renders as a user message, persists/replays as one,
        // and starts a turn. Only the text differs.
        this.customCommands = discoverCommands(this.commandSources()); // pick up on-disk edits since the last scan
        const name = String(m.name ?? "").toLowerCase();
        const cmd = this.customCommands.find((c) => c.name.toLowerCase() === name);
        if (!cmd) {
          this.view?.webview.postMessage({ type: "system", text: `Unknown command: /${m.name}` });
          break;
        }
        await this.sendPrompt(expandCommandBody(cmd.body, m.args));
        break;
      }
      case "walkthrough":
        await this.runPrWalkthrough();
        break;
      case "permissionChoice": {
        const w = this.permissionWaiters.get(m.id);
        if (w) {
          this.permissionWaiters.delete(m.id);
          w(m.optionId);
          // Tell BOTH the desktop webview and any paired phone that this
          // permission is now resolved — whichever side answered it first.
          // Without this, the side that didn't click keeps showing a live
          // (now-stale) Allow/Deny bar until the next turnEnd. post() fans
          // out to both (extension.js:post()), so one call covers both UIs.
          this.post({ type: "permissionResolved", id: m.id });
        }
        break;
      }
      case "setModel":
        this.currentModel = m.model;
        // Also persists as the new default (providers.json), not just this
        // session's in-memory model — previously this only updated
        // this.currentModel, so picking a model from the composer dropdown
        // silently diverged from Settings' "default model": reopening
        // Settings kept showing whatever was last saved there, not what the
        // composer was actually using. One "current model", one place it
        // lives, same as Settings' own "Use as default model" checkbox.
        if (typeof m.model === "string" && m.model.includes("/")) {
          saveProviderState({}, m.model);
        }
        if (this.acp && this.sessionId) {
          await this.acp.request("lakshx/set_model", { sessionId: this.sessionId, model: m.model });
        }
        break;
      case "setMode": {
        if (m.mode === "royal") {
          const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
          if (!hasRoyalConsent(cwd)) {
            const confirmLabel = "I understand — enable Royal mode";
            const choice = await vscode.window.showWarningMessage(
              "Royal mode gives the agent full, unrestricted access to this machine: no safety floor, no permission prompts — force-push, deleting files anywhere, running any command all run exactly as issued. Every action is still logged in the background (never blocked), but the undo/checkpoint safety net only covers this workspace — a change to a file outside it is logged but NOT checkpointed, so there's no undo button for that specific change. Nothing stops any of this in the moment.",
              { modal: true },
              confirmLabel,
            );
            if (choice !== confirmLabel) {
              // the panel's mode button already flipped optimistically on click — reset it
              this.post({ type: "modeChanged", mode: this.mode, auto: false });
              break;
            }
            grantRoyalConsent(cwd);
          }
        }
        this.mode = m.mode;
        if (this.acp && this.sessionId) {
          await this.acp.request("session/set_mode", { sessionId: this.sessionId, modeId: m.mode });
        }
        this.post({ type: "modeChanged", mode: m.mode, auto: false });
        break;
      }
      case "history":
        this.view?.webview.postMessage({ type: "historyList", chats: this.listChats() });
        break;
      case "whatsNew": {
        const entries = sortedChangelog();
        this.view?.webview.postMessage({ type: "whatsNewList", entries });
        // Clear the badge: mark everything up to the newest shipped entry as
        // seen (not "today") so a later addUnseen check compares dates the
        // same way whatsNewHasUnseen() does above.
        const newest = entries[0]?.date ?? "";
        await this.context.globalState.update("lakshx.whatsNew.lastSeenDate", newest);
        break;
      }
      case "loadChat": {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(chatsDir(), `${m.id}.json`), "utf8"));
          this.chatId = j.id;
          this.chatTitle = j.title;
          this.mode = j.mode ?? "review";
          this.transcript = j.events ?? [];
          this.rebuildFileCheckpoints();
          this.view?.webview.postMessage({ type: "replay", events: this.transcript });
          this.view?.webview.postMessage({ type: "modeChanged", mode: this.mode, auto: false });
          // these two bypass post() (they don't go through the transcript-push
          // path), so mirror them to Remote Access explicitly — otherwise a
          // paired phone would keep showing the previous chat after the
          // desktop user switches to a different saved one (doc 10 §0/§5).
          this.remote?.broadcast({ type: "replay", events: this.transcript });
          this.remote?.broadcast({ type: "modeChanged", mode: this.mode, auto: false });
          const resumed = await this.ensureAgent(j.sessionId);
          this.view?.webview.postMessage({
            type: "system",
            text: resumed && this.sessionId === j.sessionId
              ? "Chat restored — agent memory resumed."
              : "Chat restored (agent memory could not be resumed — starting fresh from here).",
          });
        } catch (err) {
          this.view?.webview.postMessage({ type: "system", text: `could not load chat: ${err.message}` });
        }
        break;
      }
      case "replayRequest":
        if (this.transcript.length) this.view?.webview.postMessage({ type: "replay", events: this.transcript });
        if (this.pendingPlan) {
          const rel = path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", this.pendingPlan);
          this.view?.webview.postMessage({ type: "planReady", path: rel });
        }
        // Running-agents tray reconcile (Royal Mode 2.0 §8): the replay above
        // rebuilds whatever task cards the persisted transcript remembers,
        // purely client-side and with no idea whether the agent PROCESS
        // behind them is still alive. If it's a fresh process (crash/restart —
        // the in-memory registry is v1's deliberate persistence boundary, see
        // agent/src/tasks.ts's module doc), `lakshx/tasks_list` simply won't
        // know those taskIds, and panel.js flips any card still showing
        // "running" to "lost — agent restarted" rather than spinning forever.
        // Only attempted when a connection already exists — this must never
        // itself spawn the agent runtime (same "boot never spawns" rule the
        // "boot" case above documents).
        if (this.acp && this.sessionId) {
          try {
            const res = await this.acp.request("lakshx/tasks_list", { sessionId: this.sessionId });
            this.view?.webview.postMessage({ type: "tasksReconcile", tasks: res?.tasks ?? [] });
          } catch (err) {
            this.log.appendLine(`lakshx/tasks_list reconcile failed: ${err.message}`);
          }
        }
        break;
      case "planDecision":
        await this.planDecision(m.decision);
        break;
      case "feedback": {
        // thumbs up/down submitted from the review form under a message.
        const ctx = this.turnContext();
        const entry = this.logFeedback({
          rating: m.rating, // "up" | "down"
          comment: m.comment,
          expected: m.expected,
          wentWrong: m.wentWrong,
          ...ctx,
        });
        uploadFeedbackEvent(entry);
        break;
      }
      case "retryMessage": {
        // Log what the retry is reacting to, then resend the original user
        // prompt as a fresh turn. v1 scope only: this does NOT remove the
        // prior (unhelpful) response from history/context, it just appends
        // a new attempt after it — a real "regenerate that rewinds history"
        // is a separate, larger feature (docs/research/07, P0.6).
        const ctx = this.turnContext();
        uploadFeedbackEvent(this.logFeedback({ rating: "retry", ...ctx }));
        if (ctx.userPromptText) {
          await this.sendPrompt(ctx.userPromptText);
        } else {
          this.post({ type: "system", text: "Nothing to retry yet." });
        }
        break;
      }
      case "openFeedbackLog":
        vscode.commands.executeCommand("lakshx.openFeedbackLog");
        break;
      case "undoPrompt": {
        // Chat-panel surface (doc 11 §7): "Undo all N files" under a turn's
        // Files-changed card. Never a tool the model can call — dispatched
        // only from this user-initiated webview message.
        if (!this.acp || !this.sessionId) break;
        try {
          const res = await this.acp.request("lakshx/undo_prompt", {
            sessionId: this.sessionId,
            promptId: m.promptId,
            force: Boolean(m.force),
          });
          if (!res.ok && (res.conflict || res.overlap)) {
            // panel.js shows one shared confirm dialog for both cases (doc
            // 11 §5/§4.3) and re-sends this same message with force: true.
            this.view?.webview.postMessage({ type: "undoConflict", promptId: m.promptId, conflict: res.conflict, overlap: res.overlap });
            break;
          }
          this.notifyReverted(res.reverted);
          this.post({ type: "system", text: `Reverted ${res.reverted?.length ?? 0} file(s) from that turn.` });
        } catch (err) {
          this.post({ type: "system", text: `undo failed: ${err.message}` });
        }
        break;
      }
      case "undoFile": {
        // Chat-panel surface (doc 11 §7): a per-file "Undo" button next to
        // each path in the Files-changed card, alongside "Undo all". Same
        // shared inline confirm-then-force flow as undoPrompt, scoped to one
        // path — kept separate from undoFileWithConfirm (editor-title
        // command, doc 11 §6), which uses native modal dialogs instead of
        // this panel's own inline confirm UI.
        if (!this.acp || !this.sessionId) break;
        try {
          const res = await this.acp.request("lakshx/undo_file", {
            sessionId: this.sessionId,
            path: m.path,
            force: Boolean(m.force),
          });
          if (!res.ok && res.conflict) {
            this.view?.webview.postMessage({ type: "undoConflict", promptId: m.promptId, path: m.path, conflict: res.conflict });
            break;
          }
          this.notifyReverted(res.reverted);
          this.post({ type: "system", text: `Reverted ${m.path}.` });
        } catch (err) {
          this.post({ type: "system", text: `undo failed: ${err.message}` });
        }
        break;
      }
      case "rewindToPrompt": {
        // Conversation rewind (the control under each USER message bubble,
        // plus the repointed /undo slash command): revert all file changes
        // made since that message and truncate the conversation there. Never
        // a tool the model can call — dispatched only from this
        // user-initiated webview message, and refused outright while a turn
        // is running (the server refuses too; this is the client-side half).
        if (!this.acp || !this.sessionId) break;
        if (this.turnInProgress) {
          this.post({ type: "system", text: "Can't rewind while a turn is running — stop it first." });
          break;
        }
        try {
          const res = await this.acp.request("lakshx/rewind_to_prompt", {
            sessionId: this.sessionId,
            promptId: m.promptId,
            force: Boolean(m.force),
          });
          if (!res.ok && res.conflicts) {
            // panel.js shows the confirm dialog and re-sends this same
            // message with force: true — same flow undoPrompt uses.
            this.view?.webview.postMessage({ type: "rewindConflict", promptId: m.promptId, conflicts: res.conflicts });
            break;
          }
          this.applyRewind(m.promptId, res);
        } catch (err) {
          this.post({ type: "system", text: `rewind failed: ${err.message}` });
        }
        break;
      }
      case "acceptTurn":
        // Accept is a purely visual, NON-BLOCKING acknowledgment — it never
        // pauses or gates a turn; it only dismisses that user message's
        // rewind row, persisted as a REPLAYABLE event so a reload keeps it
        // dismissed.
        if (m.promptId) this.post({ type: "rewindAccepted", promptId: m.promptId });
        break;
      case "openCheckpointFile":
        this.openCheckpointDiff(m.promptId, m.path);
        break;
      case "openToolImage":
        // Clicking a `browser_preview` thumbnail — `m.path` is already the
        // absolute on-disk path (agent/src/browser.ts saves it under
        // `.lakshx/tmp/`, outside `localResourceRoots`, so this deliberately
        // does NOT go through `asWebviewUri`). "vscode.open" (same idiom as
        // the "vscode.diff" command used for checkpoint diffs above) lets
        // VS Code pick the right editor for a PNG — its built-in image
        // preview, full resolution — instead of forcing it through
        // showTextDocument (which treats everything as text).
        if (typeof m.path === "string" && m.path) {
          vscode.commands.executeCommand("vscode.open", vscode.Uri.file(m.path));
        }
        break;
      case "cancel":
        this.acp?.notify("session/cancel", { sessionId: this.sessionId });
        break;
      case "cancelTask":
        // Tray "Stop" on one background task (Royal Mode 2.0 §7) — explicit
        // kill, deliberately separate from "cancel" above: session/cancel
        // never touches detached background children, only session.pending.
        if (this.acp && this.sessionId) {
          try {
            await this.acp.request("lakshx/task_cancel", { sessionId: this.sessionId, taskId: m.taskId });
          } catch (err) {
            this.view?.webview.postMessage({ type: "system", text: `Could not stop ${m.taskId}: ${err.message}` });
          }
        }
        break;
      case "sendToTask":
        // Tray steer input (mirrors the send_to_task tool the model itself has).
        if (this.acp && this.sessionId) {
          try {
            const res = await this.acp.request("lakshx/task_send", { sessionId: this.sessionId, taskId: m.taskId, message: m.message });
            if (!res?.ok) {
              this.view?.webview.postMessage({ type: "system", text: `Could not steer ${m.taskId}: ${res?.reason ?? "unknown error"}` });
            }
          } catch (err) {
            this.view?.webview.postMessage({ type: "system", text: `send_to_task failed: ${err.message}` });
          }
        }
        break;
      case "newChat":
        this.newChat();
        break;
      case "openSettings":
        this.post({
          type: "showSettings",
          providers: {
            ...readProviderState(),
            explainLanguages: EXPLAIN_LANGUAGES,
            explainLanguage: normalizeExplainLanguage(vscode.workspace.getConfiguration("lakshx").get("explainLanguage", "english")),
          },
        });
        break;
      case "setExplainLanguage": {
        const explainLanguage = normalizeExplainLanguage(m.value);
        await vscode.workspace.getConfiguration("lakshx").update("explainLanguage", explainLanguage, vscode.ConfigurationTarget.Global);
        await this.pushExplainLanguage();
        break;
      }
      case "saveProviders": {
        saveProviderState(m.keys, m.defaultModel);
        if (!this.acp) await this.ensureAgent();
        // validate the key that was just saved, live against the provider
        const savedProvider = Object.keys(m.keys)[0];
        if (savedProvider && this.acp) {
          this.post({ type: "system", text: `checking ${savedProvider} key…` });
          const result = await this.acp.request("lakshx/validate", { provider: savedProvider });
          if (result.ok) {
            this.post({ type: "system", text: `✓ ${savedProvider} key valid — ${result.models?.length ?? 0} models available` });
            this.post({ type: "providerModels", provider: savedProvider, models: result.models ?? [] });
          } else {
            this.post({ type: "system", text: `✗ ${savedProvider}: ${result.error}. Check the key and save again.` });
          }
        }
        if (this.acp) {
          const models = await this.acp.request("lakshx/models", {});
          this.post({ type: "ready", models });
        }
        break;
      }
      case "validateProvider": {
        if (!this.acp) await this.ensureAgent();
        if (!this.acp) break;
        const result = await this.acp.request("lakshx/validate", { provider: m.provider });
        this.post({ type: "providerStatus", provider: m.provider, ...result });
        break;
      }
      case "lakshxLogin":
        vscode.commands.executeCommand("lakshx.login");
        break;
      case "lakshxLogout":
        vscode.commands.executeCommand("lakshx.logout");
        break;
      case "getLakshxUsage": {
        const token = readProvidersJson().providers?.lakshx?.apiKey;
        const usage = token ? await lakshxAuth.getMyUsage(token) : null;
        this.post({ type: "lakshxUsageResult", usage });
        break;
      }
      case "openSettingsFile":
        vscode.commands.executeCommand("lakshx.openProviderSettings");
        break;
      case "openLink": {
        const href = String(m.href ?? "");
        if (/^https?:/.test(href)) vscode.env.openExternal(vscode.Uri.parse(href));
        else if (href && !href.includes("..")) {
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (root) {
            vscode.workspace.openTextDocument(path.join(root, href)).then(
              (doc) => vscode.window.showTextDocument(doc),
              () => {},
            );
          }
        }
        break;
      }
      case "searchFiles": {
        // @-mention popup: fuzzy-filtered workspace file list, tagged with
        // the panel's request seq so a slow response for an earlier
        // keystroke can't clobber the results of a newer one.
        const files = await searchWorkspaceFiles(m.q);
        this.view?.webview.postMessage({ type: "fileResults", seq: m.seq, files });
        break;
      }
      case "attachActiveFile": {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          this.view?.webview.postMessage({ type: "system", text: "No file is open to attach." });
          break;
        }
        this.view?.webview.postMessage({ type: "addAttachment", attachment: this.attachmentFromEditor(editor) });
        break;
      }
      case "resolveDroppedUri": {
        // Explorer/editor-tab drags land here as text/uri-list; see the
        // drop handler in panel.js for what the webview sandbox actually
        // exposes on dataTransfer.
        try {
          const uri = vscode.Uri.parse(m.uri);
          if (uri.scheme !== "file") break;
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type === vscode.FileType.Directory) {
            this.view?.webview.postMessage({ type: "system", text: "Folders can't be attached yet — drop individual files." });
            break;
          }
          this.view?.webview.postMessage({ type: "addAttachment", attachment: { path: toWorkspaceRelative(uri.fsPath) } });
        } catch (err) {
          this.log.appendLine(`drop resolve failed: ${err.message}`);
        }
        break;
      }
      case "transcribeAudio": {
        // Wrapped so a bad payload or a transcription failure NEVER crashes
        // the host — it becomes a clean `system` chat message instead, per
        // docs/research/14-voice-mode.md's wiring notes. voice.js's own
        // handleTranscribeAudio() already wraps its network/native-addon
        // work in the same discipline; this outer try/catch only guards
        // the payload conversion, which runs before that.
        let pcm;
        try {
          pcm = pcmFromMessage(m.pcm);
        } catch (err) {
          // Same terminal "transcribeAudioDone" contract as
          // handleTranscribeAudio below — panel.js needs it here too, or a
          // malformed payload leaves the mic button stuck in "Transcribing…".
          this.view?.webview.postMessage({ type: "system", text: `Voice transcription failed: could not read the recording (${err.message}).` });
          this.view?.webview.postMessage({ type: "transcribeAudioDone" });
          break;
        }
        try {
          await voice.handleTranscribeAudio({
            pcm,
            isModelDownloaded: () => voice.isModelDownloaded(),
            ensureModel: (opts) => voice.ensureModel(opts),
            runTranscribe: (buf) => voice.transcribe(buf),
            post: (msg) => this.view?.webview.postMessage(msg),
          });
        } catch (err) {
          // Belt-and-suspenders: handleTranscribeAudio already try/catches
          // internally (including its own transcribeAudioDone) and should
          // never reject, but never let voice mode take the extension host
          // down if it somehow does.
          this.view?.webview.postMessage({ type: "system", text: `Voice transcription failed: ${err.message}` });
          this.view?.webview.postMessage({ type: "transcribeAudioDone" });
        }
        break;
      }
      case "setupVoice": {
        // Fired from a click on the mic button while it's showing its
        // not-ready state (model not downloaded, or the addon never built) —
        // never from the actual hold-to-record gesture. Same never-throws,
        // always-terminal-message discipline as "transcribeAudio" above.
        try {
          await voice.handleSetupVoice({
            isModelDownloaded: () => voice.isModelDownloaded(),
            ensureModel: (opts) => voice.ensureModel(opts),
            isAddonAvailable: () => voice.isAddonAvailable(),
            post: (msg) => this.view?.webview.postMessage(msg),
          });
        } catch (err) {
          this.view?.webview.postMessage({ type: "system", text: `Voice setup failed: ${err.message}` });
          this.view?.webview.postMessage({ type: "voiceSetupDone", ok: false });
        }
        break;
      }
      case "boot": {
        // Do NOT spawn the agent runtime just because the panel loaded —
        // that used to call ensureAgent() unconditionally on every webview
        // boot, which spun up the runtime process and issued session/new
        // before the user had typed anything. If that spawn (or the
        // session it opened) ever emitted so much as a "system" notice, it
        // would land in the transcript and get persisted as a titleless
        // "Untitled chat". Instead, populate the model dropdown from a
        // cheap local read of ~/.lakshx/providers.json (no process spawn),
        // and defer the real runtime connection + live model list to the
        // first actual "send" (which already calls ensureAgent()) or to
        // opening the settings sheet.
        const state = readProviderState();
        const providers = PROVIDER_IDS.filter((id) => state.set[id]);
        this.currentModel ??= state.defaultModel;
        // Both checks are cheap/synchronous (stat + require.resolve, no
        // network, no loading the native addon) — safe to always run so the
        // mic button can show its real state before the user ever clicks it,
        // instead of only discovering "not actually ready" after a full
        // record-and-stop round trip (docs/research/14-voice-mode.md).
        this.post({
          type: "ready",
          models: { defaultModel: state.defaultModel, providers },
          voice: { modelDownloaded: voice.isModelDownloaded(), addonAvailable: voice.isAddonAvailable() },
        });
        // webview-ready is also when the slash-command popover gets its
        // initial command list (spec: scan on webview ready + on any
        // "refreshCommands"). Cheap local dir scan, no process spawn.
        this.refreshCustomCommands();
        break;
      }
      case "copyDiagnostics": {
        // Composer clipboard/diagnostics icon. Deliberately synchronous
        // (build from this.transcript, no `await this.acp.request(...)`) —
        // see buildDiagnosticReport's doc comment: this must still work
        // when the session is hung, which is the whole reason it exists.
        // Copies via vscode.env.clipboard (the extension-host clipboard
        // API), NOT navigator.clipboard from the webview — panel.js already
        // uses navigator.clipboard for small code-snippet copies, but a
        // full session report can be large and this path is the documented
        // reliable one from an extension host, so it's used here instead.
        try {
          const report = this.buildDiagnosticReport();
          await vscode.env.clipboard.writeText(report);
          this.view?.webview.postMessage({ type: "diagnosticsCopied", ok: true, chars: report.length });
        } catch (err) {
          this.log.appendLine(`copyDiagnostics failed: ${err.message}`);
          this.view?.webview.postMessage({ type: "diagnosticsCopied", ok: false, error: err.message });
        }
        break;
      }
    }
  }

  async newChat() {
    this.transcript = [];
    this.chatId = `chat-${Date.now()}`;
    this.chatTitle = null;
    this.mode = "review";
    this.fileCheckpoints.clear();
    this.refreshFileHasCheckpointContext();
    this.checkpointDecorationProvider?.refresh(undefined);
    if (this.acp) {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
      const s = await this.acp.request("session/new", { cwd, mcpServers: [] });
      this.sessionId = s.sessionId;
    }
    this.view?.webview.postMessage({ type: "clear" });
    this.remote?.broadcast({ type: "clear" }); // bypasses post() — mirror explicitly, see loadChat above
  }

  html(webview) {
    // webviews cache resources by URL — version the URLs by file mtime so
    // every extension update is picked up immediately
    const stamp = (f) => {
      try { return Math.round(fs.statSync(path.join(this.context.extensionPath, "media", f)).mtimeMs); }
      catch { return Date.now(); }
    };
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "panel.css")) + "?v=" + stamp("panel.css");
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "panel.js")) + "?v=" + stamp("panel.js");
    const mdjs = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "markdown.js")) + "?v=" + stamp("markdown.js");
    const mdcss = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "markdown.css")) + "?v=" + stamp("markdown.css");
    const hasMd = fs.existsSync(path.join(this.context.extensionPath, "media", "markdown.js"));
    // Voice mode (docs/research/14-voice-mode.md): the button renders on
    // every build (patched or stock) whenever this config is on — it just
    // fails gracefully with a clear "microphone access denied" message on a
    // stock/unpatched Electron build, since getUserMedia is blocked there
    // (microsoft/vscode#250568). This config only controls whether the
    // button exists in the composer at all, not whether it will work.
    const voiceEnabled = vscode.workspace.getConfiguration("lakshx").get("voice.enabled", true);
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${css}">
${hasMd ? `<link rel="stylesheet" href="${mdcss}">` : ""}
</head><body>
<div id="app">
  <div id="settingsPanel" hidden>
    <div class="settings-head">
      <span>AI Providers</span>
      <button id="settingsClose" class="ghost" title="Close">&#10005;</button>
    </div>
    <div class="settings-body" id="settingsBody"></div>
    <div class="settings-foot">
      <button id="settingsFile" class="ghost">Edit JSON</button>
      <div class="spacer"></div>
      <button id="settingsSave">Save</button>
    </div>
  </div>
  <div id="historyPanel" hidden>
    <div class="settings-head">
      <span>Chat history</span>
      <button id="historyClose" class="ghost" title="Close">&#10005;</button>
    </div>
    <div class="settings-body" id="historyBody"></div>
  </div>
  <div id="whatsNewPanel" hidden>
    <div class="settings-head">
      <span>What's new</span>
      <button id="whatsNewClose" class="ghost" title="Close">&#10005;</button>
    </div>
    <div class="settings-body" id="whatsNewBody"></div>
  </div>
  <div id="topbar">
    <select id="modeSelect" title="Agent mode">
      <option value="review" selected title="Read-only: research and produce a plan">Review</option>
      <option value="approve" title="Edits ask for approval">Approve</option>
      <option value="auto" title="Agent acts without asking">Auto</option>
      <option value="royal" title="Full autonomy, full machine access — no floor, no restrictions. Logged and checkpointed, not blocked.">Royal</option>
    </select>
    <div class="spacer"></div>
    <button id="whatsNewBtn" class="ghost${whatsNewHasUnseen(this.context) ? " unseen" : ""}" title="What's new" aria-label="What's new">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3z"/></svg>
    </button>
    <button id="historyBtn" class="ghost" title="Chat history" aria-label="Chat history">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>
    </button>
  </div>
  <div id="messages"></div>
  <div id="composer">
    <div id="planBar" hidden></div>
    <div id="permissionBar" hidden></div>
    <div id="attachRow" hidden></div>
    <div id="checkpointBar" class="checkpointbar" hidden>
      <button id="cpbarHead" class="cpbar-head" type="button"></button>
      <div id="cpbarBody" class="cpbar-body" hidden></div>
    </div>
    <div id="taskTray" class="tasktray" hidden>
      <button id="trayHead" class="tray-head" type="button"></button>
      <div id="trayBody" class="tray-body" hidden></div>
    </div>
    <div class="input-wrap">
      <div id="mentionPopup" class="mention-popup" hidden></div>
      <div id="slashPopup" class="mention-popup" hidden></div>
      <textarea id="input" rows="3" placeholder="Describe a task. Type @ to reference a file, / for commands. Review mode plans first; Approve executes with your OK."></textarea>
    </div>
    <div id="toolbar">
      <select id="model" title="Model"></select>
      <button id="diagBtn" class="ghost" title="Copy full diagnostic session report to clipboard" aria-label="Copy full diagnostic session report to clipboard">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
      </button>
      <button id="attachBtn" class="ghost" title="Attach current file or selection" aria-label="Attach current file or selection">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
      </button>
      <div class="spacer"></div>
      ${voiceEnabled ? `<button id="micBtn" class="ghost" title="Hold to dictate (push-to-talk)" aria-label="Hold to dictate">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>
      </button>` : ""}
      <button id="stop" class="ghost" hidden>Stop</button>
      <button id="send">Send</button>
    </div>
  </div>
</div>
${hasMd ? `<script src="${mdjs}"></script>` : ""}
<script src="${js}"></script>
</body></html>`;
  }
}

async function activate(context) {
  const provider = new AgentViewProvider(context);
  const checkpointDecorationProvider = new CheckpointDecorationProvider(provider);
  provider.checkpointDecorationProvider = checkpointDecorationProvider;

  // LakshX ships its own agent — make sure the leftover built-in chat surfaces
  // stay off even where extension configurationDefaults don't reach (packaged
  // builds' setup views). One-time, respects later manual changes.
  if (!context.globalState.get("lakshx.chatDisabled.v1")) {
    const cfg = vscode.workspace.getConfiguration();
    try {
      await cfg.update("chat.disableAIFeatures", true, vscode.ConfigurationTarget.Global);
      await cfg.update("chat.commandCenter.enabled", false, vscode.ConfigurationTarget.Global);
    } catch {}
    context.globalState.update("lakshx.chatDisabled.v1", true);
  }

  // ---------- LakshX hosted-model login (magic-link via lakshx:// deep link) ----------
  scheduleLakshxRefresh(context);

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri) {
        const parsed = lakshxAuth.parseAuthCallback(uri);
        if (parsed.error) {
          vscode.window.showErrorMessage(`LakshX sign-in failed: ${parsed.error}`);
          return;
        }
        saveLakshxToken(parsed.access_token);
        context.secrets.store("lakshx.refreshToken", parsed.refresh_token);
        context.secrets.store("lakshx.tokenExpiresAt", String(Date.now() + parsed.expires_in * 1000));
        vscode.window.showInformationMessage("Signed in to LakshX.");
        provider.post({ type: "lakshxAuthChanged", providers: readProviderState() });
        const readyState = readProviderState();
        provider.post({
          type: "ready",
          models: { defaultModel: readyState.defaultModel, providers: PROVIDER_IDS.filter((id) => readyState.set[id]) },
          voice: { modelDownloaded: voice.isModelDownloaded(), addonAvailable: voice.isAddonAvailable() },
        });
      },
    }),
  );

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusItem.text = "✦ LakshX";
  statusItem.tooltip = `Open LakshX Agent (${isWin ? "Ctrl+L" : "⌘L"})`;
  statusItem.command = "lakshx.openAgent";
  statusItem.show();

  // agent-first IDE: the agent panel is part of the default layout — open it
  // on every startup unless the user turned that off
  if (vscode.workspace.getConfiguration("lakshx").get("agent.openOnStartup", true)) {
    setTimeout(() => vscode.commands.executeCommand("lakshx.chatView.focus"), 900);
  }

  // ---------- Remote Access status bar toggle (off by default) ----------
  const remoteStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999);
  const updateRemoteStatus = () => {
    if (provider.remote?.isRunning) {
      remoteStatusItem.text = `$(radio-tower) Remote: ${provider.remote.port}`;
      remoteStatusItem.tooltip = `LakshX Remote Access is ON (view + control) — ${provider.remote.info().url}\nClick to show the QR code again.`;
      remoteStatusItem.command = "lakshx.showRemoteAccessQr";
    } else {
      remoteStatusItem.text = "$(radio-tower) Remote: off";
      remoteStatusItem.tooltip = "LakshX Remote Access — view and control this chat from your phone over WiFi (off by default)";
      remoteStatusItem.command = "lakshx.enableRemoteAccess";
    }
  };
  updateRemoteStatus();
  remoteStatusItem.show();

  let remoteQrPanel = null;

  async function startRemoteAccess() {
    if (provider.remote?.isRunning) {
      remoteQrPanel?.dispose();
      remoteQrPanel = showRemoteAccessPanel(provider.remote.info(), vscode.workspace.workspaceFolders?.[0]?.name ?? "LakshX");
      return;
    }
    // This warning was strengthened for Phase B (docs/research/10 §2.4/§3):
    // a paired phone can now approve/deny permission prompts and send new
    // prompts, not just watch — full blast radius of the desktop panel
    // itself, minus BYOK key management. It is re-shown once even to users
    // who already acked the older view-only wording (distinct globalState
    // key), because the risk it describes materially changed.
    if (!context.globalState.get("lakshx.remoteAccess.controlWarningAcked")) {
      const choice = await vscode.window.showWarningMessage(
        "Remote Access starts a small server on your WiFi/LAN so you can view AND control this chat from your " +
          "phone: a paired phone can watch the conversation live, send new prompts, approve or deny permission " +
          "requests, and switch modes — exactly as if it were sitting at this keyboard. Anyone who scans the QR " +
          "code or gets the link gets that full access until you turn Remote Access off — treat it like a " +
          "password on shared or public WiFi, and only enable this on a network you trust.",
        { modal: true },
        "Enable Remote Access",
      );
      if (choice !== "Enable Remote Access") return;
      await context.globalState.update("lakshx.remoteAccess.controlWarningAcked", true);
    }
    const { RemoteServer } = require("./remote-server.js");
    provider.remote = new RemoteServer({
      getSnapshot: () => provider.remoteSnapshot(),
      isBusy: () => provider.turnInProgress,
      // The phone is just another caller of the exact same dispatch the
      // desktop webview's postMessage already drives — see remote-server.js
      // header and docs/research/10-remote-control.md Phase B.
      onControl: (msg) => provider.onWebviewMessage(msg),
    });
    try {
      const info = await provider.remote.start();
      updateRemoteStatus();
      remoteQrPanel?.dispose();
      remoteQrPanel = showRemoteAccessPanel(info, vscode.workspace.workspaceFolders?.[0]?.name ?? "LakshX");
      remoteQrPanel.onDidDispose(() => { remoteQrPanel = null; });
      vscode.window.showInformationMessage(`LakshX Remote Access is on: ${info.url}`);
    } catch (err) {
      provider.remote = null;
      vscode.window.showErrorMessage(`Could not start LakshX Remote Access: ${err.message}`);
    }
  }

  function stopRemoteAccess() {
    if (!provider.remote) {
      vscode.window.showInformationMessage("LakshX Remote Access is already off.");
      return;
    }
    provider.remote.stop();
    provider.remote = null;
    updateRemoteStatus();
    remoteQrPanel?.dispose();
    remoteQrPanel = null;
    vscode.window.showInformationMessage("LakshX Remote Access is off.");
  }

  context.subscriptions.push(
    statusItem,
    remoteStatusItem,
    { dispose: () => provider.remote?.stop() },
    vscode.commands.registerCommand("lakshx.enableRemoteAccess", startRemoteAccess),
    vscode.commands.registerCommand("lakshx.showRemoteAccessQr", startRemoteAccess),
    vscode.commands.registerCommand("lakshx.disableRemoteAccess", stopRemoteAccess),
    vscode.window.registerWebviewViewProvider("lakshx.chatView", provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand("lakshx.openAgent", () =>
      vscode.commands.executeCommand("lakshx.chatView.focus"),
    ),
    vscode.commands.registerCommand("lakshx.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("lakshx.configureProviders", async () => {
      await vscode.commands.executeCommand("lakshx.chatView.focus");
      provider.post({ type: "showSettings", providers: readProviderState() });
    }),
    vscode.commands.registerCommand("lakshx.login", () => {
      vscode.env.openExternal(vscode.Uri.parse("https://lakshx.in/login"));
    }),
    vscode.commands.registerCommand("lakshx.logout", async () => {
      clearLakshxToken();
      await context.secrets.delete("lakshx.refreshToken");
      await context.secrets.delete("lakshx.tokenExpiresAt");
      vscode.window.showInformationMessage("Signed out of LakshX.");
      provider.post({ type: "lakshxAuthChanged", providers: readProviderState() });
      const readyState = readProviderState();
      provider.post({
        type: "ready",
        models: { defaultModel: readyState.defaultModel, providers: PROVIDER_IDS.filter((id) => readyState.set[id]) },
        voice: { modelDownloaded: voice.isModelDownloaded(), addonAvailable: voice.isAddonAvailable() },
      });
    }),
    vscode.commands.registerCommand("lakshx.openProviderSettings", async () => {
      const dir = path.join(os.homedir(), ".lakshx");
      const file = path.join(dir, "providers.json");
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, PROVIDERS_TEMPLATE);
      const doc = await vscode.workspace.openTextDocument(file);
      vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand("lakshx.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const attachment = provider.attachmentFromEditor(editor);
      await vscode.commands.executeCommand("lakshx.chatView.focus");
      provider.view?.webview.postMessage({ type: "addAttachment", attachment });
    }),
    vscode.commands.registerCommand("lakshx.openFeedbackLog", async () => {
      // Opens this month's local feedback JSONL — the "give you the log
      // file" step from a one-click command, no file-hunting required.
      const file = feedbackFile();
      if (!fs.existsSync(file)) fs.writeFileSync(file, "");
      const doc = await vscode.workspace.openTextDocument(file);
      vscode.window.showTextDocument(doc);
    }),
    // ---------- editor-title undo (doc 11 §6) ----------
    vscode.commands.registerCommand("lakshx.undoFileChanges", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const relPath = toWorkspaceRelative(editor.document.uri.fsPath);
      const res = await provider.undoFileWithConfirm(relPath);
      if (!res) return; // cancelled, or nothing to undo
      if (!res.ok) {
        provider.post({ type: "system", text: `Could not undo ${relPath}.` });
        return;
      }
      provider.notifyReverted(res.reverted);
      // receipt shows in chat too, same pattern doc 11 §6 sketches
      provider.post({ type: "system", text: `Reverted ${relPath}.` });
    }),
    vscode.window.onDidChangeActiveTextEditor(() => provider.refreshFileHasCheckpointContext()),
    vscode.workspace.registerTextDocumentContentProvider("lakshx-checkpoint", checkpointContentProvider),
    vscode.window.registerFileDecorationProvider(checkpointDecorationProvider),
    // ---------- "Explain this crash" (docs/research/15 item #8) ----------
    vscode.commands.registerCommand("lakshx.explainCrash", () => triggerExplainCrash(provider)),
  );
  registerCrashExplainTracker(context, provider);
}

function deactivate() {}

module.exports = { activate, deactivate };
