// LakshX Welcome — a real, custom-branded first-launch and getting-started
// surface, replacing the stock VS Code walkthroughs (hidden by
// patches/welcome-hide-builtin-vscode-walkthroughs.patch, which made them
// invisible but put nothing in their place).
//
// Deliberately NOT built on the `walkthroughs` extension-point (the
// GettingStarted editor pane): that system is a fixed VS-Code-shaped chrome
// (categories grid, step list, embedded editor panes) built for Microsoft's
// own content model. A webview panel — the same pattern already proven by
// product/lakshx-db and product/lakshx-graph — gives full control over the
// look with no stock chrome to fight, and can be triggered on first
// activation the same way those panels are triggered by a command.
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { shouldShowWelcome, STORAGE_KEY } = require("./lib/shouldShowWelcome.js");

// Small, explicit allowlist of commands the webview is allowed to trigger via
// postMessage. Never execute an arbitrary command id sent from the webview —
// even though this webview's own content is ours (not remote/untrusted), the
// same discipline lakshx-graph's openPath/lakshx-db's panel handlers use
// (resolve through known-safe operations, not raw pass-through) is cheap
// insurance and keeps the webview message contract self-documenting.
const ALLOWED_COMMANDS = new Set([
  "lakshx.openAgent", // product/lakshx-chat — opens the agent chat panel
  "workbench.action.selectTheme", // built-in theme picker
  "workbench.action.files.openFolder", // built-in "Open Folder" dialog
  "lakshx.db.showPanel", // product/lakshx-db — DB visualization panel
  "lakshx.showDependencyGraph", // product/lakshx-graph — workspace dependency graph
]);

let currentPanel = null;

function panelHtml(context, webview) {
  const stamp = (f) => {
    try {
      return Math.round(fs.statSync(path.join(context.extensionPath, "media", f)).mtimeMs);
    } catch {
      return Date.now();
    }
  };
  const css = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "welcome.css")) + "?v=" + stamp("welcome.css");
  const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "welcome.js")) + "?v=" + stamp("welcome.js");
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${css}">
<title>Welcome to LakshX</title>
</head><body>
<div id="app">
  <header id="hero">
    <div id="wordmark"><span id="mark">Laksh</span><span id="mark-x">X</span></div>
    <p id="tagline">A VS Code fork with its own agent built in — not a Copilot re-skin.</p>
  </header>

  <section id="pitch">
    <h2>What makes this different</h2>
    <p>
      LakshX runs its own hand-written agent — a system-prompt-and-tool-calling loop, no
      LangChain/AutoGPT framework — as a separate process talking to the editor over a real,
      open protocol (ACP). Bring your own API key for Anthropic, OpenAI, OpenRouter, DeepSeek,
      Groq, xAI, Gemini, or a local Ollama model. Everything below actually ships in this build.
    </p>
  </section>

  <section id="features">
    <h2>The real feature set</h2>
    <div id="feature-grid" class="grid"></div>
  </section>

  <section id="quickstart">
    <h2>Quick start</h2>
    <div id="quickstart-actions" class="grid"></div>
  </section>

  <footer id="foot">
    <span id="foot-note">Reopen this anytime: Command Palette &rarr; "LakshX: Show Welcome"</span>
  </footer>
</div>
<script src="${js}"></script>
</body></html>`;
}

function ensurePanel(context) {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active, false);
    return currentPanel;
  }
  currentPanel = vscode.window.createWebviewPanel(
    "lakshxWelcome",
    "Welcome to LakshX",
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    },
  );
  currentPanel.onDidDispose(() => {
    currentPanel = null;
  });
  currentPanel.webview.html = panelHtml(context, currentPanel.webview);
  currentPanel.webview.onDidReceiveMessage((m) => onWebviewMessage(m));
  return currentPanel;
}

function onWebviewMessage(m) {
  if (!m || m.type !== "runCommand") return;
  if (!ALLOWED_COMMANDS.has(m.command)) return;
  vscode.commands.executeCommand(m.command);
}

function showWelcome(context) {
  ensurePanel(context);
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand("lakshx.showWelcome", () => showWelcome(context)));

  // First-activation-of-a-fresh-profile check: globalState is per-profile and
  // persists across restarts, so this fires exactly once per profile, not
  // once per window/session. shouldShowWelcome() is the pure decision
  // function (lib/shouldShowWelcome.js) — kept separate from this
  // globalState read/write so it's unit-testable without a real extension
  // host (see test/shouldShowWelcome.test.js).
  const alreadyShown = context.globalState.get(STORAGE_KEY);
  if (shouldShowWelcome(alreadyShown)) {
    context.globalState.update(STORAGE_KEY, true);
    showWelcome(context);
  }
}

function deactivate() {}

module.exports = { activate, deactivate, ALLOWED_COMMANDS };
