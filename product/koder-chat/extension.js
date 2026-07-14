// Koder Agent panel — ACP client + webview UI. Plain CJS, zero dependencies:
// a minimal ndjson JSON-RPC client speaks ACP to the Koder Agent Runtime.
const vscode = require("vscode");
const cp = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
  if (fs.existsSync(rg)) env.KODER_RG_PATH = rg;
  return env;
}

function agentSpawnSpec(context) {
  const custom = vscode.workspace.getConfiguration("koder").get("agent.command");
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
  // Koder BYOK — add API keys for any provider you use.
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

// ---------- BYOK provider state (~/.koder/providers.json) ----------
const PROVIDER_IDS = ["anthropic", "openai", "openrouter", "gemini", "deepseek", "groq", "xai"];

function providersFile() {
  return path.join(os.homedir(), ".koder", "providers.json");
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
const REPLAYABLE = new Set(["user", "chunk", "thought", "tool", "toolUpdate", "system", "modeChanged", "turnEnd", "checkpoint"]);

function chatsDir() {
  const dir = path.join(os.homedir(), ".koder", "chats");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- local feedback log (~/.koder/feedback/<yyyy-mm>.jsonl) ----------
// Intentionally 100% local: no network calls, no telemetry, no cloud sync of
// any kind. This is the entire mechanism — nothing here phones home, and
// nothing here is a stub or hook for a future sync feature. If cloud sync is
// ever built, it will be a separate, explicit feature, not an extension of
// this file.
function feedbackDir() {
  const dir = path.join(os.homedir(), ".koder", "feedback");
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
// stored outside the workspace tree (~/.koder/, not <workspace>/.koder/) for
// the same reason royal-audit/checkpoints live outside it: a marker the agent
// itself could edit via a Royal-mode tool call would defeat the point of
// "informed consent" being a human's decision, not the agent's.
function royalConsentDir() {
  const dir = path.join(os.homedir(), ".koder", "royal-consent");
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
// Off by default; only ever starts from the "Koder: Enable Remote Access"
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
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0e1116; color: #c8cede;
    padding: 32px 24px; text-align: center; }
  h2 { font-size: 15px; margin: 0 0 6px; color: #fff; }
  .ws { color: #8a93a8; font-size: 12px; margin-bottom: 18px; }
  .qr { background: #fff; display: inline-block; padding: 16px; border-radius: 14px; }
  .qr svg { display: block; }
  .url { font-family: "SF Mono", Menlo, monospace; font-size: 12px; word-break: break-all; margin-top: 18px;
    background: rgba(255,255,255,0.06); padding: 10px 12px; border-radius: 8px; user-select: all; display: inline-block; }
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
  <div class="stop">Run &ldquo;Koder: Disable Remote Access&rdquo; from the command palette to stop and invalidate this link.</div>
</body></html>`;
}

function showRemoteAccessPanel(info, workspaceName) {
  const panel = vscode.window.createWebviewPanel(
    "koderRemoteAccess",
    "Koder Remote Access",
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
    this.log = vscode.window.createOutputChannel("Koder Agent");
    this.transcript = [];
    this.chatId = `chat-${Date.now()}`;
    this.chatTitle = null;
    this.mode = "review";
    this.currentModel = null; // best-effort, for feedback-log context only
    this.remote = null; // RemoteServer instance, only set while "Koder: Enable Remote Access" is on
    this.turnInProgress = false; // set for the duration of a session/prompt turn — see sendPrompt(); the one guard
    // shared by the desktop composer and the phone's POST /control/send so the two can't race each other into two
    // concurrent session/prompt calls (docs/research/10-remote-control.md Phase B, race-handling item).

    // ---------- prompt-checkpoints + undo (docs/research/11) ----------
    // path (workspace-relative, same shape `koder/checkpoint` notifications
    // use) -> { promptId, sha, toolCallId } for the MOST RECENT prompt that
    // touched it — latest-wins, per doc 11 §3.3/§4.1. This is what the
    // editor-title undo button's `koder.fileHasCheckpoint` context key and
    // "undo this file" action read from; the chat panel's per-turn card gets
    // its own file lists straight off the "checkpoint" transcript events
    // (grouped by promptId), not from this map.
    this.fileCheckpoints = new Map();
  }

  /** Snapshot handed to a freshly (re)connecting phone — see remote-server.js's GET /state. */
  remoteSnapshot() {
    return {
      workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? "Koder",
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
      this.transcript.push(msg);
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
      this.post({ type: "system", text: "Koder Agent Runtime not found. Set koder.agent.command in settings." });
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
        if (method === "koder/plan_saved") this.onPlanSaved(params.path);
        if (method === "koder/plan_ready") this.onPlanReady(params.path);
        if (method === "koder/usage") this.post({ type: "usage", ...params });
        if (method === "koder/checkpoint") this.onCheckpoint(params);
        if (method === "koder/checkpoint_compacted") {
          this.post({ type: "system", text: "Older undo history was compacted to bound disk usage — very old turns may no longer be undoable." });
        }
      },
      onRequest: async (method, params) => {
        if (method === "session/request_permission") return this.onPermissionRequest(params);
        throw new Error(`unhandled ${method}`);
      },
    });
    await this.acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const models = await this.acp.request("koder/models", {});
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
   * `koder/checkpoint` notification (doc 11 §3.2) — fired once per
   * successful mutating tool call. Feeds BOTH UI surfaces from the same
   * data: the chat panel gets the raw event (grouped/rendered by promptId in
   * panel.js); `fileCheckpoints` tracks, per path, only the LATEST prompt
   * that touched it (doc 11 §4.1 — the editor button always means "undo
   * what the most recent prompt did to this file").
   */
  onCheckpoint(params) {
    this.post({ type: "checkpoint", promptId: params.promptId, toolCallId: params.toolCallId, toolName: params.toolName, sha: params.sha, files: params.files });
    for (const f of params.files ?? []) {
      this.fileCheckpoints.set(f, { promptId: params.promptId, sha: params.sha, toolCallId: params.toolCallId });
    }
    this.refreshFileHasCheckpointContext();
  }

  /** Rebuild `fileCheckpoints` from a loaded/replayed transcript's "checkpoint" events, latest-wins per path. */
  rebuildFileCheckpoints() {
    this.fileCheckpoints.clear();
    for (const e of this.transcript) {
      if (e.type !== "checkpoint") continue;
      for (const f of e.files ?? []) {
        this.fileCheckpoints.set(f, { promptId: e.promptId, sha: e.sha, toolCallId: e.toolCallId });
      }
    }
    this.refreshFileHasCheckpointContext();
  }

  /** Recompute the `koder.fileHasCheckpoint` `when`-clause context key for whatever editor is currently active. */
  refreshFileHasCheckpointContext() {
    const editor = vscode.window.activeTextEditor;
    const has = Boolean(editor && this.fileCheckpoints.has(toWorkspaceRelative(editor.document.uri.fsPath)));
    vscode.commands.executeCommand("setContext", "koder.fileHasCheckpoint", has);
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

  async onPlanSaved(planPath) {
    this.post({ type: "system", text: `Plan saved: ${path.relative(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", planPath)}` });
    try {
      const doc = await vscode.workspace.openTextDocument(planPath);
      await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
    } catch {}
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
      let res = await this.acp.request("koder/undo_file", { sessionId: this.sessionId, path: relPath });
      if (!res.ok && res.conflict) {
        const pick = await vscode.window.showWarningMessage(
          "This file has been edited since the agent last changed it. Undo will overwrite that edit.",
          { modal: true },
          "Overwrite and Undo",
        );
        if (pick !== "Overwrite and Undo") return null;
        res = await this.acp.request("koder/undo_file", { sessionId: this.sessionId, path: relPath, force: true });
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
          await this.acp.request("koder/set_model", { sessionId: this.sessionId, model: m.model });
        }
        break;
      case "setMode": {
        if (m.mode === "royal") {
          const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
          if (!hasRoyalConsent(cwd)) {
            const confirmLabel = "I understand — enable Royal mode";
            const choice = await vscode.window.showWarningMessage(
              "Royal mode gives the agent full, unrestricted access to this machine: no safety floor, no permission prompts — force-push, deleting files anywhere, running any command all run exactly as issued. Every action is still logged and checkpointed in the background (never blocked) so you have a record and an undo path if something goes wrong, but nothing stops it in the moment.",
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
        vscode.commands.executeCommand("koder.openFeedbackLog");
        break;
      case "undoPrompt": {
        // Chat-panel surface (doc 11 §7): "Undo all N files" under a turn's
        // Files-changed card. Never a tool the model can call — dispatched
        // only from this user-initiated webview message.
        if (!this.acp || !this.sessionId) break;
        try {
          const res = await this.acp.request("koder/undo_prompt", {
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
          this.post({ type: "system", text: `Reverted ${res.reverted?.length ?? 0} file(s) from that turn.` });
        } catch (err) {
          this.post({ type: "system", text: `undo failed: ${err.message}` });
        }
        break;
      }
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
          const result = await this.acp.request("koder/validate", { provider: savedProvider });
          if (result.ok) {
            this.post({ type: "system", text: `✓ ${savedProvider} key valid — ${result.models?.length ?? 0} models available` });
            this.post({ type: "providerModels", provider: savedProvider, models: result.models ?? [] });
          } else {
            this.post({ type: "system", text: `✗ ${savedProvider}: ${result.error}. Check the key and save again.` });
          }
        }
        if (this.acp) {
          const models = await this.acp.request("koder/models", {});
          this.post({ type: "ready", models });
        }
        break;
      }
      case "validateProvider": {
        if (!this.acp) await this.ensureAgent();
        if (!this.acp) break;
        const result = await this.acp.request("koder/validate", { provider: m.provider });
        this.post({ type: "providerStatus", provider: m.provider, ...result });
        break;
      }
      case "openSettingsFile":
        vscode.commands.executeCommand("koder.openProviderSettings");
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
        // cheap local read of ~/.koder/providers.json (no process spawn),
        // and defer the real runtime connection + live model list to the
        // first actual "send" (which already calls ensureAgent()) or to
        // opening the settings sheet.
        const state = readProviderState();
        const providers = PROVIDER_IDS.filter((id) => state.set[id]);
        this.currentModel ??= state.defaultModel;
        this.post({ type: "ready", models: { defaultModel: state.defaultModel, providers } });
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
  <div id="topbar">
    <div id="modes" role="tablist">
      <button data-mode="review" class="mode active" title="Read-only: research and produce a plan">Review</button>
      <button data-mode="approve" class="mode" title="Edits ask for approval">Approve</button>
      <button data-mode="auto" class="mode" title="Agent acts without asking">Auto</button>
      <button data-mode="royal" class="mode" title="Full autonomy, full machine access — no floor, no restrictions. Logged and checkpointed, not blocked.">Royal</button>
    </div>
    <div class="spacer"></div>
    <button id="historyBtn" class="ghost" title="Chat history" aria-label="Chat history">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>
    </button>
  </div>
  <div id="messages"></div>
  <div id="composer">
    <div id="planBar" hidden></div>
    <div id="permissionBar" hidden></div>
    <div id="attachRow" hidden></div>
    <div class="input-wrap">
      <div id="mentionPopup" class="mention-popup" hidden></div>
      <textarea id="input" rows="3" placeholder="Describe a task. Type @ to reference a file. Review mode plans first; Approve executes with your OK."></textarea>
    </div>
    <div id="toolbar">
      <select id="model" title="Model"></select>
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

  // Koder ships its own agent — make sure the leftover built-in chat surfaces
  // stay off even where extension configurationDefaults don't reach (packaged
  // builds' setup views). One-time, respects later manual changes.
  if (!context.globalState.get("koder.chatDisabled.v1")) {
    const cfg = vscode.workspace.getConfiguration();
    try {
      await cfg.update("chat.disableAIFeatures", true, vscode.ConfigurationTarget.Global);
      await cfg.update("chat.commandCenter.enabled", false, vscode.ConfigurationTarget.Global);
    } catch {}
    context.globalState.update("koder.chatDisabled.v1", true);
  }

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
  statusItem.text = "✦ Koder";
  statusItem.tooltip = "Open Koder Agent (⌘L)";
  statusItem.command = "koder.openAgent";
  statusItem.show();

  // agent-first IDE: the agent panel is part of the default layout — open it
  // on every startup unless the user turned that off
  if (vscode.workspace.getConfiguration("koder").get("agent.openOnStartup", true)) {
    setTimeout(() => vscode.commands.executeCommand("koder.chatView.focus"), 900);
  }

  // ---------- Remote Access status bar toggle (off by default) ----------
  const remoteStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999);
  const updateRemoteStatus = () => {
    if (provider.remote?.isRunning) {
      remoteStatusItem.text = `$(radio-tower) Remote: ${provider.remote.port}`;
      remoteStatusItem.tooltip = `Koder Remote Access is ON (view + control) — ${provider.remote.info().url}\nClick to show the QR code again.`;
      remoteStatusItem.command = "koder.showRemoteAccessQr";
    } else {
      remoteStatusItem.text = "$(radio-tower) Remote: off";
      remoteStatusItem.tooltip = "Koder Remote Access — view and control this chat from your phone over WiFi (off by default)";
      remoteStatusItem.command = "koder.enableRemoteAccess";
    }
  };
  updateRemoteStatus();
  remoteStatusItem.show();

  let remoteQrPanel = null;

  async function startRemoteAccess() {
    if (provider.remote?.isRunning) {
      remoteQrPanel?.dispose();
      remoteQrPanel = showRemoteAccessPanel(provider.remote.info(), vscode.workspace.workspaceFolders?.[0]?.name ?? "Koder");
      return;
    }
    // This warning was strengthened for Phase B (docs/research/10 §2.4/§3):
    // a paired phone can now approve/deny permission prompts and send new
    // prompts, not just watch — full blast radius of the desktop panel
    // itself, minus BYOK key management. It is re-shown once even to users
    // who already acked the older view-only wording (distinct globalState
    // key), because the risk it describes materially changed.
    if (!context.globalState.get("koder.remoteAccess.controlWarningAcked")) {
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
      await context.globalState.update("koder.remoteAccess.controlWarningAcked", true);
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
      remoteQrPanel = showRemoteAccessPanel(info, vscode.workspace.workspaceFolders?.[0]?.name ?? "Koder");
      remoteQrPanel.onDidDispose(() => { remoteQrPanel = null; });
      vscode.window.showInformationMessage(`Koder Remote Access is on: ${info.url}`);
    } catch (err) {
      provider.remote = null;
      vscode.window.showErrorMessage(`Could not start Koder Remote Access: ${err.message}`);
    }
  }

  function stopRemoteAccess() {
    if (!provider.remote) {
      vscode.window.showInformationMessage("Koder Remote Access is already off.");
      return;
    }
    provider.remote.stop();
    provider.remote = null;
    updateRemoteStatus();
    remoteQrPanel?.dispose();
    remoteQrPanel = null;
    vscode.window.showInformationMessage("Koder Remote Access is off.");
  }

  context.subscriptions.push(
    statusItem,
    remoteStatusItem,
    { dispose: () => provider.remote?.stop() },
    vscode.commands.registerCommand("koder.enableRemoteAccess", startRemoteAccess),
    vscode.commands.registerCommand("koder.showRemoteAccessQr", startRemoteAccess),
    vscode.commands.registerCommand("koder.disableRemoteAccess", stopRemoteAccess),
    vscode.window.registerWebviewViewProvider("koder.chatView", provider, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.commands.registerCommand("koder.openAgent", () =>
      vscode.commands.executeCommand("koder.chatView.focus"),
    ),
    vscode.commands.registerCommand("koder.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("koder.configureProviders", async () => {
      await vscode.commands.executeCommand("koder.chatView.focus");
      provider.post({ type: "showSettings", providers: readProviderState() });
    }),
    vscode.commands.registerCommand("koder.openProviderSettings", async () => {
      const dir = path.join(os.homedir(), ".koder");
      const file = path.join(dir, "providers.json");
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, PROVIDERS_TEMPLATE);
      const doc = await vscode.workspace.openTextDocument(file);
      vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand("koder.addSelectionToChat", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const attachment = provider.attachmentFromEditor(editor);
      await vscode.commands.executeCommand("koder.chatView.focus");
      provider.view?.webview.postMessage({ type: "addAttachment", attachment });
    }),
    vscode.commands.registerCommand("koder.openFeedbackLog", async () => {
      // Opens this month's local feedback JSONL — the "give you the log
      // file" step from a one-click command, no file-hunting required.
      const file = feedbackFile();
      if (!fs.existsSync(file)) fs.writeFileSync(file, "");
      const doc = await vscode.workspace.openTextDocument(file);
      vscode.window.showTextDocument(doc);
    }),
    // ---------- editor-title undo (doc 11 §6) ----------
    vscode.commands.registerCommand("koder.undoFileChanges", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const relPath = toWorkspaceRelative(editor.document.uri.fsPath);
      const res = await provider.undoFileWithConfirm(relPath);
      if (!res) return; // cancelled, or nothing to undo
      if (!res.ok) {
        provider.post({ type: "system", text: `Could not undo ${relPath}.` });
        return;
      }
      // receipt shows in chat too, same pattern doc 11 §6 sketches
      provider.post({ type: "system", text: `Reverted ${relPath}.` });
    }),
    vscode.window.onDidChangeActiveTextEditor(() => provider.refreshFileHasCheckpointContext()),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
