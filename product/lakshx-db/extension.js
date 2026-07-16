// LakshX Database panel — schema + relationship visualization for a live
// database connection (MongoDB, PostgreSQL, MySQL, or SQLite), rendered as
// a Mermaid `erDiagram` in a webview (same createWebviewPanel pattern as
// product/lakshx-chat's showRemoteAccessPanel).
//
// All engine specifics live behind the driver interface in lib/engines.js /
// lib/drivers/*. The one distinction that matters everywhere: the SQL
// engines (Postgres/MySQL/SQLite) have an AUTHORITATIVE schema — their
// foreign keys come from information_schema/pg_catalog/PRAGMA and render as
// solid FK edges — while MongoDB has no schema and no enforced foreign
// keys, so its panel shows a shape INFERRED from a bounded sample of live
// documents with every relationship a dashed, amber "suggestion". See
// lib/mermaid.js and media/db.js for where that distinction is actually
// enforced (visually and in the copy), not just asserted in this comment.
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { listEngines, getDriver } = require("./lib/engines.js");
const { redactText } = require("./lib/redact.js");
const { createRunReadOnlyQuery } = require("./lib/query-api.js");
const { DEFAULT_TIMEOUT_MS } = require("./lib/query-guard.js");

// Per-connection "Allow AI queries" opt-in (design §6), default OFF. Stored in
// globalState (it's a boolean policy flag, not a secret), keyed per engine so
// enabling it for one engine never enables it for another.
const aiQueriesKey = (engineId) => `lakshx.db.${engineId}.allowAiQueries`;
function isAiQueriesAllowed(context, engineId) {
  return context.globalState.get(aiQueriesKey(engineId), false) === true;
}
function setAiQueriesAllowed(context, engineId, value) {
  return context.globalState.update(aiQueriesKey(engineId), value === true);
}

const log = vscode.window.createOutputChannel("LakshX Database");

/** Every string that reaches the output channel or a user-facing error goes
 * through this first — redaction is applied at the write site, not trusted
 * to have already happened upstream. */
function logLine(text) {
  log.appendLine(redactText(String(text)));
}

/** Engine-appropriate connection input: a masked input box for URI engines
 * (mongo/postgres/mysql), a file-open dialog for file engines (sqlite).
 * Returns the connection string / file path, or undefined if cancelled. */
async function promptForConnection(driver) {
  if (driver.connectionKind === "file") {
    const picked = await vscode.window.showOpenDialog({
      title: driver.prompt.title,
      canSelectMany: false,
      canSelectFolders: false,
      openLabel: "Open Read-Only",
      filters: driver.prompt.fileFilters,
    });
    return picked?.[0]?.fsPath;
  }
  return vscode.window.showInputBox({
    title: driver.prompt.title,
    prompt: driver.prompt.example,
    placeHolder: driver.prompt.placeHolder,
    password: true, // masked input — never echoed to the UI or history
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || !driver.prompt.schemeRe.test(value.trim())) {
        return driver.prompt.schemeError;
      }
      return null;
    },
  });
}

/** The chooser UI a driver's resolveDatabase calls when several databases
 * are visible on one connection (mongo, mysql-without-a-db-in-the-uri). */
async function quickPickDatabase(candidates) {
  return vscode.window.showQuickPick(candidates, {
    title: "LakshX Database: choose a database",
    placeHolder: "Multiple databases are visible on this connection",
  });
}

class DbSession {
  constructor(context, engineId) {
    this.context = context;
    this.engineId = engineId;
    this.driver = getDriver(engineId);
    this.panel = null;
    this.handle = null;
    this.dbName = null;
  }

  async ensureHandle() {
    if (this.handle) return this.handle;
    let conn = await this.context.secrets.get(this.driver.secretKey);
    if (!conn) {
      conn = await promptForConnection(this.driver);
      if (!conn) throw new Error("cancelled");
      const err = await this.driver.testConnection(conn);
      if (err) throw new Error(`Couldn't connect: ${err}`);
      await this.context.secrets.store(this.driver.secretKey, conn);
      vscode.window.showInformationMessage(`LakshX Database: ${this.driver.label} connection saved to VS Code's secret storage.`);
    }
    try {
      this.handle = await this.driver.connect(conn);
    } catch (err) {
      this.handle = null;
      throw new Error(`Couldn't connect: ${redactText(String(err?.message ?? err))}`);
    }
    return this.handle;
  }

  async refresh() {
    this.panel?.webview.postMessage({ type: "loading", engineLabel: this.driver.label });
    try {
      const handle = await this.ensureHandle();
      if (!this.dbName) {
        this.dbName = await this.driver.resolveDatabase(handle, { pick: quickPickDatabase, log: logLine });
      }
      const payload = await this.driver.introspect(handle, this.dbName);
      this.panel?.webview.postMessage({ type: "schema", ...payload });
      logLine(
        `[${this.driver.label}] Introspected "${this.dbName}": ${payload.collections.length} ${payload.authoritative ? "table(s)" : "collection(s)"}, ` +
          `${payload.relationships.length} ${payload.authoritative ? "foreign key(s)" : "suggested relationship(s)"}.`,
      );
    } catch (err) {
      const message = redactText(String(err?.message ?? err));
      logLine(`[${this.driver.label}] Introspection failed: ${message}`);
      this.panel?.webview.postMessage({ type: "error", message });
    }
  }

  async forgetOwnCredentials() {
    await this.context.secrets.delete(this.driver.secretKey);
  }

  async dispose() {
    await this.driver.close(this.handle);
    this.handle = null;
    this.dbName = null;
  }
}

let session = null;
let currentPanel = null;

function panelHtml(context, webview) {
  const stamp = (f) => {
    try {
      return Math.round(fs.statSync(path.join(context.extensionPath, "media", f)).mtimeMs);
    } catch {
      return Date.now();
    }
  };
  const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", f)) + "?v=" + stamp(f);
  const mermaidJs = uri("mermaid.min.js");
  const dbJs = uri("db.js");
  const css = uri("db.css");
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${css}">
</head><body>
<div id="app">
  <div id="toolbar">
    <span id="title">Database Schema</span>
    <div class="spacer"></div>
    <button id="aiQueries" class="ghost" title="Let the AI assistant run read-only queries against this connection">Allow AI queries</button>
    <button id="refresh" class="ghost" title="Re-read the schema and redraw">Refresh</button>
    <button id="changeConnection" class="ghost" title="Forget this connection and connect elsewhere">Change Connection&hellip;</button>
  </div>
  <div id="banner" hidden></div>
  <div id="loading">Connecting and reading the schema&hellip;</div>
  <div id="error" hidden></div>
  <div id="diagramWrap" hidden>
    <div id="diagram"></div>
  </div>
  <div id="relPanel" hidden>
    <h3 id="relTitle">Relationships</h3>
    <p class="hint" id="relHint"></p>
    <ul id="relList"></ul>
  </div>
</div>
<script src="${mermaidJs}"></script>
<script src="${dbJs}"></script>
</body></html>`;
}

async function pickEngine() {
  const picked = await vscode.window.showQuickPick(
    listEngines().map((e) => ({ label: e.label, description: e.description, engineId: e.id })),
    {
      title: "LakshX Database: choose an engine",
      placeHolder: "Which database do you want to visualize?",
    },
  );
  return picked?.engineId;
}

async function showPanel(context) {
  const engineId = await pickEngine();
  if (!engineId) return;

  const engineChanged = session?.engineId !== engineId;
  if (engineChanged) {
    // Switching engines tears down the old session's live connection but
    // NOT its saved secret — each engine keeps its own SecretStorage key,
    // so flipping back later reconnects without re-entering credentials.
    await session?.dispose();
    session = new DbSession(context, engineId);
  }

  if (currentPanel) {
    // Reusing an already-loaded webview: it already ran its own initial
    // "refresh" postMessage on first load (see media/db.js), so nothing
    // re-fires that here for the same engine — just reveal it and let the
    // user hit Refresh if they want a re-read. An engine SWITCH does
    // re-introspect, since the old diagram is now the wrong engine's.
    currentPanel.reveal(vscode.ViewColumn.Beside, true);
    session.panel = currentPanel;
    if (engineChanged) await session.refresh();
    postAiState(context); // engine may have changed — refresh the toolbar's opt-in state
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    "lakshxDatabase",
    "LakshX Database",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    },
  );
  session.panel = currentPanel;
  currentPanel.onDidDispose(() => {
    currentPanel = null;
    if (session) session.panel = null;
  });
  currentPanel.webview.html = panelHtml(context, currentPanel.webview);
  currentPanel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === "refresh") {
      await session.refresh();
    } else if (m.type === "changeConnection") {
      // Only the CURRENT engine's saved connection is forgotten here —
      // "change connection" shouldn't nuke every other engine's secret.
      await session.forgetOwnCredentials();
      await session.dispose();
      await session.refresh();
    } else if (m.type === "getAiQueries") {
      postAiState(context);
    } else if (m.type === "toggleAiQueries") {
      await handleToggleAiQueries(context);
    }
  });
}

/** Posts the current engine's "Allow AI queries" state to the webview so the
 * toolbar button reflects it. */
function postAiState(context) {
  const engineId = session?.engineId;
  currentPanel?.webview.postMessage({
    type: "aiQueries",
    enabled: engineId ? isAiQueriesAllowed(context, engineId) : false,
  });
}

/** Turning the flag ON requires a one-time confirmation that spells out the
 * PII-egress consequence (design §6); turning it OFF is immediate. */
async function handleToggleAiQueries(context) {
  const engineId = session?.engineId;
  if (!engineId) return;
  if (isAiQueriesAllowed(context, engineId)) {
    await setAiQueriesAllowed(context, engineId, false);
  } else {
    const choice = await vscode.window.showWarningMessage(
      "This lets the AI assistant read real rows from this database and send them to your model provider. " +
        "Prefer a non-production connection. Enable?",
      { modal: true },
      "Enable",
    );
    if (choice !== "Enable") {
      postAiState(context);
      return;
    }
    await setAiQueriesAllowed(context, engineId, true);
  }
  postAiState(context);
}

async function forgetCredentials(context) {
  // The command forgets EVERY engine's saved connection — it's the
  // "clean slate" escape hatch, as the confirmation copy says.
  for (const engine of listEngines()) {
    await context.secrets.delete(getDriver(engine.id).secretKey);
  }
  if (session) {
    await session.dispose();
  }
  vscode.window.showInformationMessage(
    "LakshX Database: saved connections for all engines forgotten. Run “LakshX: Show Database Panel” to connect again.",
  );
}

function activate(context) {
  // Status bar entry point — this extension had NO visible UI entry point
  // before (command palette only), which is exactly the discoverability gap
  // a real user hit. Priority 998, right after koder-chat's "✦ LakshX"
  // (1000) and "$(radio-tower) Remote: ..." (999) items, so it lands
  // immediately beside them in the same right-aligned group rather than
  // floating off on its own.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 998);
  statusItem.text = "$(database) DB";
  statusItem.tooltip = "Open LakshX Database Panel (MongoDB, PostgreSQL, MySQL, SQLite)";
  statusItem.command = "lakshx.db.showPanel";
  statusItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("lakshx.db.showPanel", () => showPanel(context)),
    vscode.commands.registerCommand("lakshx.db.forgetCredentials", () => forgetCredentials(context)),
    statusItem,
    log,
  );

  // Exported cross-extension API (design §"Wire path" step 7): lakshx-chat's
  // ACP relay calls this to run the agent's db_query tool. It ALWAYS resolves
  // to { text, isError } and NEVER throws across the boundary. The opt-in gate,
  // secret read, driver dispatch, formatting, and redaction all live behind it.
  const runReadOnlyQuery = createRunReadOnlyQuery({
    getDriver,
    getSecret: (secretKey) => context.secrets.get(secretKey),
    isAiQueriesAllowed: (engineId) => isAiQueriesAllowed(context, engineId),
    redactText,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  return { runReadOnlyQuery };
}

function deactivate() {
  return session?.dispose();
}

module.exports = { activate, deactivate };
