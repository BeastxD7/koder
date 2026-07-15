// LakshX Agent panel — ACP client + webview UI. Plain CJS, zero dependencies:
// a minimal ndjson JSON-RPC client speaks ACP to the LakshX Agent Runtime.
const vscode = require("vscode");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CHANGELOG } = require("./changelog.js");

// ---------- minimal ACP (JSON-RPC over ndjson/stdio) client ----------
class AcpClient {
  constructor(command, args, cwd, env, handlers) {
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = handlers;
    this.child = cp.spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (d) => handlers.onLog?.(String(d)));
    this.child.on("error", (err) => handlers.onError?.(err));
    this.child.on("exit", (code) => handlers.onExit?.(code));
    let buf = "";
    this.child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this._onMessage(JSON.parse(line));
      }
    });
  }
  _send(msg) {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }
  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }
  async _onMessage(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    } else if (msg.method && msg.id !== undefined) {
      try {
        const result = await this.handlers.onRequest(msg.method, msg.params);
        this._send({ jsonrpc: "2.0", id: msg.id, result });
      } catch (err) {
        this._send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } });
      }
    } else if (msg.method) {
      this.handlers.onNotification(msg.method, msg.params);
    }
  }
  kill() {
    try { this.child.kill(); } catch {}
  }
}

// ---------- runtime discovery ----------
const isWin = process.platform === "win32";

function runtimeEnv() {
  // point the agent's grep tool at the editor's bundled ripgrep so it works
  // on machines without rg installed (all platforms)
  const rg = path.join(vscode.env.appRoot, "node_modules", "@vscode", "ripgrep", "bin", isWin ? "rg.exe" : "rg");
  const env = { ...process.env };
  if (fs.existsSync(rg)) env.LAKSHX_RG_PATH = rg;
  return env;
}

function agentSpawnSpec(context) {
  const custom = vscode.workspace.getConfiguration("lakshx").get("agent.command");
  if (custom) {
    return isWin
      ? { command: "cmd.exe", args: ["/d", "/c", custom], env: runtimeEnv() }
      : { command: "/bin/zsh", args: ["-lc", custom], env: runtimeEnv() };
  }
  // dev layout: <repo>/upstream/extensions/koder-chat → runtime at <repo>/agent
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
  "defaultModel": "anthropic/claude-sonnet-5",
  "providers": {
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
const PROVIDER_IDS = ["anthropic", "openai", "openrouter", "gemini", "deepseek", "groq", "xai"];

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

// ---------- webview view ----------
// transcript events that get replayed when the webview is rebuilt
// "checkpointReverted" is replayed the same event-sourced way "checkpoint" is
// (see notifyReverted below) so a chat reload nets out to the same "does
// this file currently have an undoable agent change" state live sessions
// converge to, instead of resurrecting already-reverted files after reload.
const REPLAYABLE = new Set(["user", "chunk", "thought", "tool", "toolUpdate", "system", "modeChanged", "turnEnd", "checkpoint", "checkpointReverted", "subagentsStart", "subagentActivity", "subagentsEnd"]);

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
// Intentionally 100% local: no network calls, no telemetry, no cloud sync of
// any kind. This is the entire mechanism — nothing here phones home, and
// nothing here is a stub or hook for a future sync feature. If cloud sync is
// ever built, it will be a separate, explicit feature, not an extension of
// this file.
function feedbackDir() {
  const dir = path.join(os.homedir(), ".lakshx", "feedback");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function feedbackFile(date = new Date()) {
  const ym = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  return path.join(feedbackDir(), `${ym}.jsonl`);
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
      },
      onRequest: async (method, params) => {
        if (method === "session/request_permission") return this.onPermissionRequest(params);
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
        if (res?.modes?.currentModeId) this.mode = res.modes.currentModeId;
        return;
      } catch (err) {
        this.log.appendLine(`session/load failed for ${resumeSessionId}, starting fresh: ${err.message}`);
      }
    }
    const s = await this.acp.request("session/new", { cwd, mcpServers: [] });
    this.sessionId = s.sessionId;
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
   */
  async sendPrompt(text, attachments = []) {
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
   * for the "copy diagnostics" composer button — every REPLAYABLE event in
   * `this.transcript`, chronologically, with timestamps/durations, full
   * tool inputs/outputs, full thinking/assistant text, mode changes,
   * checkpoints, and subagent activity. Built entirely from state
   * extension.js already holds — synchronously, no request to the agent
   * runtime — DELIBERATELY: the whole point of this tool is to capture a
   * session that's HUNG (the "stuck and cut off at thinking phase"
   * complaint this was built for). A stalled provider stream never fires
   * `turnEnd`, so there is nothing safe to await here; if this ever grows
   * an `await this.acp.request(...)`, it will hang exactly when someone
   * needs it most.
   *
   * Consecutive same-type "chunk" (assistant text) / "thought" (thinking)
   * events are coalesced into one block each — they arrive one small
   * streamed delta at a time, so a raw one-line-per-delta dump would be
   * hundreds of near-empty lines. Concatenating loses no content (every
   * character is preserved) and turns the run into exactly the datum a
   * "how long did thinking/generation take" question needs: first-chunk ts
   * to last-chunk ts.
   */
  buildDiagnosticReport() {
    const events = this.transcript;
    const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? "(no workspace)";
    const hasTs = events.some((e) => typeof e.ts === "number");
    const firstTs = hasTs ? events.find((e) => typeof e.ts === "number").ts : null;
    const lastTsEvent = hasTs ? [...events].reverse().find((e) => typeof e.ts === "number") : null;
    const lastTs = lastTsEvent ? lastTsEvent.ts : null;
    const now = Date.now();

    const fmtAbs = (ts) => (typeof ts === "number" ? new Date(ts).toISOString() : "unknown time");
    const fmtRel = (ts) =>
      typeof ts === "number" && firstTs != null ? `+${((ts - firstTs) / 1000).toFixed(3)}s` : "";
    const fmtDur = (ms) => (typeof ms === "number" && !Number.isNaN(ms) ? `${(ms / 1000).toFixed(2)}s` : "unknown");
    const tag = (ts) => `[${fmtAbs(ts)} ${fmtRel(ts)}]`.replace(" ]", "]");

    // ---- coalesce chunk/thought runs; pair tool -> toolUpdate(s) ----
    const blocks = [];
    const openTools = new Map(); // toolCallId -> its block, so a later toolUpdate (possibly several) attaches
    for (let i = 0; i < events.length; ) {
      const e = events[i];
      if (e.type === "chunk" || e.type === "thought") {
        let j = i;
        let text = "";
        while (j < events.length && events[j].type === e.type) {
          text += events[j].text ?? "";
          j++;
        }
        blocks.push({ kind: e.type, startTs: e.ts, endTs: events[j - 1].ts, count: j - i, text });
        i = j;
        continue;
      }
      if (e.type === "tool") {
        const block = { kind: "tool", id: e.id, title: e.title, toolKind: e.kind, input: e.input, startTs: e.ts, updates: [] };
        openTools.set(e.id, block);
        blocks.push(block);
        i++;
        continue;
      }
      if (e.type === "toolUpdate") {
        const block = openTools.get(e.id);
        if (block) block.updates.push({ status: e.status, output: e.output, ts: e.ts });
        else blocks.push({ kind: "toolUpdateOrphan", raw: e });
        i++;
        continue;
      }
      blocks.push({ kind: e.type, raw: e });
      i++;
    }

    const lines = [];
    const push = (s = "") => lines.push(s);
    const rule = (ch = "=") => ch.repeat(72);

    // ---------------- header ----------------
    push(rule());
    push("LakshX Diagnostic Session Report");
    push(rule());
    push(`Workspace:        ${workspace}`);
    push(`Chat title:       ${this.chatTitle ?? "(untitled)"}`);
    push(`Chat id:          ${this.chatId}`);
    push(`Session id:       ${this.sessionId ?? "(none)"}`);
    push(`Current model:    ${this.currentModel ?? "(unknown)"}`);
    const modes = new Set([this.mode]);
    for (const e of events) if (e.type === "modeChanged") modes.add(e.mode);
    push(`Mode(s) used:     ${[...modes].join(", ")}`);
    push(`Session started:  ${hasTs ? fmtAbs(firstTs) : "unknown (session predates diagnostic timestamps)"}`);
    push(`Report generated: ${new Date(now).toISOString()}`);
    push(`Total duration:   ${hasTs ? fmtDur((lastTs ?? now) - firstTs) : "unknown"}`);
    push(`Total events:     ${events.length}`);

    // ---------------- stuck/incomplete-turn detection ----------------
    // A hung turn never posts turnEnd (server.ts only posts it after
    // session/prompt resolves — see sendPrompt in this file), so the
    // transcript just stops. Same signature for a tool call with no
    // matching toolUpdate. Surface both explicitly rather than making
    // whoever reads this infer it from a chronology that just ends.
    const warnings = [];
    let openUserTs = null;
    for (const e of events) {
      if (e.type === "user") openUserTs = e.ts;
      if (e.type === "turnEnd") openUserTs = null;
    }
    if (openUserTs != null) {
      warnings.push(
        `The last turn never completed (no turnEnd event) — stuck for ${hasTs ? fmtDur(now - openUserTs) : "unknown"}.`,
      );
    }
    for (const b of blocks) {
      if (b.kind === "tool" && b.updates.length === 0) {
        warnings.push(`Tool call "${b.title}" (id ${b.id}) started at ${fmtAbs(b.startTs)} and never returned (no toolUpdate).`);
      }
    }
    if (blocks.length) {
      const last = blocks[blocks.length - 1];
      if (last.kind === "thought") {
        warnings.push(
          `Session ends mid-THINKING (${last.count} thought chunk(s), last at ${fmtAbs(last.endTs)}) with no further activity — the "stuck at thinking" signature.`,
        );
      }
    }
    if (warnings.length) {
      push("");
      push(rule("-"));
      push("ANOMALIES DETECTED");
      push(rule("-"));
      for (const w of warnings) push(`  - ${w}`);
    }

    push("");
    push(
      "NOTE: tool call OUTPUT is capped at 4000 characters upstream (agent/src/server.ts onToolEnd,",
    );
    push(
      "shared with the live tool-call card) before it ever reaches this transcript — this report",
    );
    push(
      "cannot show more than that. Thinking and assistant text are NOT capped and appear in full below.",
    );

    push("");
    push(rule());
    push("CHRONOLOGICAL EVENT LOG");
    push(rule());

    for (const b of blocks) {
      push("");
      switch (b.kind) {
        case "thought":
          push(`${tag(b.startTs)} THINKING  (${b.count} chunk(s), duration ${fmtDur(b.endTs - b.startTs)})`);
          push(rule("-").slice(0, 50));
          push(b.text || "(empty)");
          break;
        case "chunk":
          push(`${tag(b.startTs)} ASSISTANT TEXT  (${b.count} chunk(s), duration ${fmtDur(b.endTs - b.startTs)})`);
          push(rule("-").slice(0, 50));
          push(b.text || "(empty)");
          break;
        case "tool": {
          const last = b.updates[b.updates.length - 1];
          push(`${tag(b.startTs)} TOOL CALL: ${b.title}  (id: ${b.id}, kind: ${b.toolKind ?? "?"})`);
          push(rule("-").slice(0, 50));
          push("Input:");
          push(indentBlock(safeJson(b.input)));
          if (last) {
            push(`Result (${last.status}, duration ${fmtDur(last.ts - b.startTs)}):`);
            push(indentBlock(last.output ?? "(no output text)"));
            if (b.updates.length > 1) push(`(${b.updates.length} status updates received; showing the final one)`);
          } else {
            push("Result: *** NEVER RETURNED — no toolUpdate event followed this call ***");
          }
          break;
        }
        case "toolUpdateOrphan":
          push(`${tag(b.raw.ts)} TOOL RESULT (no matching tool-call event in this transcript): id ${b.raw.id}, status ${b.raw.status}`);
          push(indentBlock(b.raw.output ?? ""));
          break;
        case "user":
          push(`${tag(b.raw.ts)} USER PROMPT`);
          push(rule("-").slice(0, 50));
          push(b.raw.text ?? "");
          break;
        case "system":
          push(`${tag(b.raw.ts)} SYSTEM NOTICE`);
          push(`  ${b.raw.text ?? ""}`);
          break;
        case "modeChanged":
          push(`${tag(b.raw.ts)} MODE CHANGED -> ${b.raw.mode}${b.raw.auto ? " (auto)" : " (user)"}`);
          break;
        case "turnEnd":
          push(`${tag(b.raw.ts)} TURN END  (stopReason: ${b.raw.stopReason ?? "?"})`);
          break;
        case "checkpoint":
          push(`${tag(b.raw.ts)} CHECKPOINT  tool: ${b.raw.toolName}, sha: ${b.raw.sha}`);
          push(`  files: ${(b.raw.files ?? []).join(", ")}`);
          break;
        case "checkpointReverted":
          push(`${tag(b.raw.ts)} CHECKPOINT REVERTED`);
          push(`  files: ${(b.raw.paths ?? []).join(", ")}`);
          break;
        case "subagentsStart":
          push(`${tag(b.raw.ts)} SUBAGENTS START  batch ${b.raw.batchId}`);
          push(`  tasks: ${(b.raw.tasks ?? []).map((t) => t.id ?? t).join(", ")}`);
          break;
        case "subagentActivity":
          push(
            `${tag(b.raw.ts)} SUBAGENT ACTIVITY  batch ${b.raw.batchId}, task ${b.raw.taskId}, kind ${b.raw.kind}${b.raw.isError ? " (ERROR)" : ""}`,
          );
          push(`  ${b.raw.detail ?? ""}${b.raw.path ? ` (${b.raw.path})` : ""}`);
          break;
        case "subagentsEnd":
          push(`${tag(b.raw.ts)} SUBAGENTS END  batch ${b.raw.batchId}`);
          push(indentBlock(safeJson(b.raw.results)));
          break;
        default:
          push(`${tag(b.raw?.ts)} ${String(b.kind).toUpperCase()}`);
          push(indentBlock(safeJson(b.raw)));
      }
    }

    push("");
    push(rule());
    push("END OF REPORT");
    push(rule());
    return lines.join("\n");
  }

  async onWebviewMessage(m) {
    switch (m.type) {
      case "send":
        await this.sendPrompt(m.text, m.attachments);
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
        break;
      case "planDecision":
        await this.planDecision(m.decision);
        break;
      case "feedback": {
        // thumbs up/down submitted from the review form under a message.
        const ctx = this.turnContext();
        this.logFeedback({
          rating: m.rating, // "up" | "down"
          comment: m.comment,
          expected: m.expected,
          wentWrong: m.wentWrong,
          ...ctx,
        });
        break;
      }
      case "retryMessage": {
        // Log what the retry is reacting to, then resend the original user
        // prompt as a fresh turn. v1 scope only: this does NOT remove the
        // prior (unhelpful) response from history/context, it just appends
        // a new attempt after it — a real "regenerate that rewinds history"
        // is a separate, larger feature (docs/research/07, P0.6).
        const ctx = this.turnContext();
        this.logFeedback({ rating: "retry", ...ctx });
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
      case "openCheckpointFile":
        this.openCheckpointDiff(m.promptId, m.path);
        break;
      case "cancel":
        this.acp?.notify("session/cancel", { sessionId: this.sessionId });
        break;
      case "newChat":
        this.newChat();
        break;
      case "openSettings":
        this.post({ type: "showSettings", providers: readProviderState() });
        break;
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
        this.post({ type: "ready", models: { defaultModel: state.defaultModel, providers } });
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
    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; font-src ${webview.cspSource};">
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
    <div class="input-wrap">
      <div id="mentionPopup" class="mention-popup" hidden></div>
      <textarea id="input" rows="3" placeholder="Describe a task. Type @ to reference a file. Review mode plans first; Approve executes with your OK."></textarea>
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

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusItem.text = "✦ LakshX";
  statusItem.tooltip = "Open LakshX Agent (⌘L)";
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
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
