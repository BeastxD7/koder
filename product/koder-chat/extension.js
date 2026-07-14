// Koder Agent panel — ACP client + webview UI. Plain CJS, zero dependencies:
// a minimal ndjson JSON-RPC client speaks ACP to the Koder Agent Runtime.
const vscode = require("vscode");
const cp = require("child_process");
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

// ---------- webview view ----------
// transcript events that get replayed when the webview is rebuilt
const REPLAYABLE = new Set(["user", "chunk", "thought", "tool", "toolUpdate", "system", "modeChanged", "turnEnd"]);

function chatsDir() {
  const dir = path.join(os.homedir(), ".koder", "chats");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
  }

  persistSoon() {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      if (this.transcript.length === 0) return;
      const file = path.join(chatsDir(), `${this.chatId}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({ id: this.chatId, title: this.chatTitle ?? "Untitled chat", updatedAt: Date.now(), mode: this.mode, events: this.transcript }),
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
            return { id: j.id, title: j.title, updatedAt: j.updatedAt };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50);
    } catch { return []; }
  }

  async ensureAgent() {
    if (this.acp && this.sessionId) return true;
    const spec = agentSpawnSpec(this.context);
    if (!spec) {
      this.post({ type: "system", text: "Koder Agent Runtime not found. Set koder.agent.command in settings." });
      return false;
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
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
      },
      onRequest: async (method, params) => {
        if (method === "session/request_permission") return this.onPermissionRequest(params);
        throw new Error(`unhandled ${method}`);
      },
    });
    await this.acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const models = await this.acp.request("koder/models", {});
    const s = await this.acp.request("session/new", { cwd, mcpServers: [] });
    this.sessionId = s.sessionId;
    this.post({ type: "ready", models });
    return true;
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
        this.post({ type: "tool", id: u.toolCallId, title: u.title, kind: u.kind, status: u.status });
        break;
      case "tool_call_update":
        this.post({ type: "toolUpdate", id: u.toolCallId, status: u.status });
        break;
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

  async onWebviewMessage(m) {
    switch (m.type) {
      case "send": {
        if (!(await this.ensureAgent())) return;
        this.post({ type: "user", text: m.text });
        if (!this.chatTitle) this.chatTitle = m.text.slice(0, 48);
        this.post({ type: "turnStart" });
        try {
          const res = await this.acp.request("session/prompt", {
            sessionId: this.sessionId,
            prompt: [{ type: "text", text: m.text }],
          });
          this.post({ type: "turnEnd", stopReason: res.stopReason });
        } catch (err) {
          this.post({ type: "system", text: `error: ${err.message}` });
          this.post({ type: "turnEnd", stopReason: "error" });
        }
        break;
      }
      case "permissionChoice": {
        const w = this.permissionWaiters.get(m.id);
        if (w) {
          this.permissionWaiters.delete(m.id);
          w(m.optionId);
        }
        break;
      }
      case "setModel":
        if (this.acp && this.sessionId) {
          await this.acp.request("koder/set_model", { sessionId: this.sessionId, model: m.model });
        }
        break;
      case "setMode":
        this.mode = m.mode;
        if (this.acp && this.sessionId) {
          await this.acp.request("session/set_mode", { sessionId: this.sessionId, modeId: m.mode });
        }
        this.post({ type: "modeChanged", mode: m.mode, auto: false });
        break;
      case "history":
        this.view?.webview.postMessage({ type: "historyList", chats: this.listChats() });
        break;
      case "loadChat": {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(chatsDir(), `${m.id}.json`), "utf8"));
          this.chatId = j.id;
          this.chatTitle = j.title;
          this.transcript = j.events ?? [];
          this.view?.webview.postMessage({ type: "replay", events: this.transcript });
          this.view?.webview.postMessage({ type: "system", text: "Restored chat (view only — the agent's working memory starts fresh)." });
          if (this.acp) {
            const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
            const s = await this.acp.request("session/new", { cwd, mcpServers: [] });
            this.sessionId = s.sessionId;
          }
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
      case "boot":
        this.ensureAgent();
        break;
    }
  }

  async newChat() {
    this.transcript = [];
    this.chatId = `chat-${Date.now()}`;
    this.chatTitle = null;
    this.mode = "review";
    if (this.acp) {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
      const s = await this.acp.request("session/new", { cwd, mcpServers: [] });
      this.sessionId = s.sessionId;
    }
    this.view?.webview.postMessage({ type: "clear" });
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
    </div>
    <div class="spacer"></div>
    <button id="historyBtn" class="ghost" title="Chat history">&#9776;</button>
  </div>
  <div id="messages"></div>
  <div id="composer">
    <div id="planBar" hidden></div>
    <div id="permissionBar" hidden></div>
    <textarea id="input" rows="3" placeholder="Describe a task. Review mode plans first; Approve executes with your OK."></textarea>
    <div id="toolbar">
      <select id="model" title="Model"></select>
      <div class="spacer"></div>
      <button id="settings" class="ghost" title="Configure providers">&#8942;</button>
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

  context.subscriptions.push(
    statusItem,
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
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
