// LakshX Database panel — schema + relationship visualization for a live
// MongoDB connection, rendered as a Mermaid `erDiagram` in a webview (same
// createWebviewPanel pattern as product/koder-chat's showRemoteAccessPanel).
//
// MongoDB is a deliberate special case among the engines this panel family
// targets (Postgres/MySQL/SQLite are FK-enforced and get an authoritative
// schema straight from information_schema/PRAGMA equivalents): Mongo has no
// schema and no enforced foreign keys, so everything shown here is INFERRED
// from a bounded sample of live documents, and every relationship is a
// heuristic suggestion, never a fact. See lib/schema.js, lib/relationships.js,
// lib/mermaid.js for where that distinction is actually enforced (visually
// and in the copy), not just asserted in this comment.
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const { inferCollectionSchema } = require("./lib/schema.js");
const { detectRelationships } = require("./lib/relationships.js");
const { buildErDiagram } = require("./lib/mermaid.js");
const { redactConnectionString, redactText } = require("./lib/redact.js");

const SECRET_KEY = "lakshx.db.mongo.connectionString";
const SAMPLE_SIZE = 100; // bounded sample per collection — see lib/schema.js header
const COLLECTION_LIMIT = 40; // guardrail against a huge database fanning out into hundreds of $sample round-trips
const SYSTEM_DB_NAMES = new Set(["admin", "local", "config"]);

const log = vscode.window.createOutputChannel("LakshX Database");

/** Every string that reaches the output channel or a user-facing error goes
 * through this first — redaction is applied at the write site, not trusted
 * to have already happened upstream. */
function logLine(text) {
  log.appendLine(redactText(String(text)));
}

async function promptForConnectionString(prefillRedactedHint) {
  return vscode.window.showInputBox({
    title: "LakshX Database: MongoDB Connection String",
    prompt: prefillRedactedHint
      ? `Enter a new MongoDB connection string (previous: ${prefillRedactedHint})`
      : "mongodb://user:password@host:27017/mydb or a mongodb+srv:// Atlas URI",
    placeHolder: "mongodb://localhost:27017/mydb",
    password: true, // masked input — never echoed to the UI or history
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || !/^mongodb(\+srv)?:\/\//i.test(value.trim())) {
        return "Must start with mongodb:// or mongodb+srv://";
      }
      return null;
    },
  });
}

/** Connects, verifies with a ping, and disconnects — used to validate a
 * freshly entered connection string before it's persisted to SecretStorage.
 * Returns null on success, or a redacted error message on failure. */
async function testConnection(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    await client.db().admin().ping();
    return null;
  } catch (err) {
    return redactText(String(err?.message ?? err));
  } finally {
    await client.close().catch(() => {});
  }
}

async function pickDatabase(client) {
  let candidates = null;
  try {
    const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
    candidates = databases.map((d) => d.name).filter((n) => !SYSTEM_DB_NAMES.has(n));
  } catch (err) {
    // Common for a least-privilege user without the clusterMonitor role —
    // fall back to whatever database the connection string itself names.
    logLine(`listDatabases unavailable (${err?.message ?? err}); falling back to the connection string's default database.`);
  }

  const defaultDb = client.db(); // driver-resolved default (from the URI path), if any
  if (!candidates || candidates.length === 0) {
    if (!defaultDb.databaseName || defaultDb.databaseName === "test") {
      throw new Error(
        "Couldn't determine which database to open: this user can't list databases, and the connection string doesn't name one. Add /yourDbName to the connection string.",
      );
    }
    return defaultDb.databaseName;
  }
  if (candidates.length === 1) return candidates[0];
  if (defaultDb.databaseName && candidates.includes(defaultDb.databaseName)) return defaultDb.databaseName;

  const picked = await vscode.window.showQuickPick(candidates, {
    title: "LakshX Database: choose a database",
    placeHolder: "Multiple databases are visible on this connection",
  });
  if (!picked) throw new Error("No database selected.");
  return picked;
}

/** Connects, samples every collection in `dbName` (bounded, see SAMPLE_SIZE/
 * COLLECTION_LIMIT), infers a schema shape for each, and detects suggested
 * relationships across the set. Returns the payload the webview renders. */
async function introspect(client, dbName) {
  const db = client.db(dbName);
  const allCollections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith("system."))
    .sort((a, b) => a.localeCompare(b));

  const collectionNames = allCollections.slice(0, COLLECTION_LIMIT);
  const truncatedCollectionCount = Math.max(0, allCollections.length - collectionNames.length);

  const schemasByCollection = {};
  for (const name of collectionNames) {
    // $sample gives a uniform random sample straight from the server,
    // rather than an insertion-order-biased "first N" scan.
    const sampleDocs = await db.collection(name).aggregate([{ $sample: { size: SAMPLE_SIZE } }]).toArray();
    schemasByCollection[name] = inferCollectionSchema(sampleDocs, { limit: SAMPLE_SIZE });
  }

  const relationships = detectRelationships(schemasByCollection);
  const mermaidSource = buildErDiagram(schemasByCollection, relationships);

  return {
    databaseName: dbName,
    collections: collectionNames.map((name) => ({
      name,
      sampledCount: schemasByCollection[name].sampledCount,
      fieldCount: schemasByCollection[name].fields.length,
    })),
    truncatedCollectionCount,
    relationships,
    mermaidSource,
    sampleSize: SAMPLE_SIZE,
  };
}

class DbSession {
  constructor(context) {
    this.context = context;
    this.panel = null;
    this.client = null;
    this.dbName = null;
  }

  async ensureClient() {
    if (this.client) return this.client;
    let uri = await this.context.secrets.get(SECRET_KEY);
    if (!uri) {
      uri = await promptForConnectionString();
      if (!uri) throw new Error("cancelled");
      const err = await testConnection(uri);
      if (err) throw new Error(`Couldn't connect: ${err}`);
      await this.context.secrets.store(SECRET_KEY, uri);
      vscode.window.showInformationMessage("LakshX Database: connection saved to VS Code's secret storage.");
    }
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    try {
      await this.client.connect();
    } catch (err) {
      this.client = null;
      throw new Error(`Couldn't connect: ${redactText(String(err?.message ?? err))}`);
    }
    return this.client;
  }

  async refresh() {
    this.panel?.webview.postMessage({ type: "loading" });
    try {
      const client = await this.ensureClient();
      if (!this.dbName) this.dbName = await pickDatabase(client);
      const payload = await introspect(client, this.dbName);
      this.panel?.webview.postMessage({ type: "schema", ...payload });
      logLine(`Introspected "${this.dbName}": ${payload.collections.length} collection(s), ${payload.relationships.length} suggested relationship(s).`);
    } catch (err) {
      const message = redactText(String(err?.message ?? err));
      logLine(`Introspection failed: ${message}`);
      this.panel?.webview.postMessage({ type: "error", message });
    }
  }

  async dispose() {
    await this.client?.close().catch(() => {});
    this.client = null;
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
    <span id="title">MongoDB Schema</span>
    <div class="spacer"></div>
    <button id="refresh" class="ghost" title="Re-sample and redraw">Refresh</button>
    <button id="changeConnection" class="ghost" title="Forget this connection and connect elsewhere">Change Connection&hellip;</button>
  </div>
  <div id="banner" hidden></div>
  <div id="loading">Connecting and sampling documents&hellip;</div>
  <div id="error" hidden></div>
  <div id="diagramWrap" hidden>
    <div id="diagram"></div>
  </div>
  <div id="relPanel" hidden>
    <h3>Suggested relationships</h3>
    <p class="hint">MongoDB has no enforced foreign keys. These are pattern-matched guesses over the sampled documents — verify before relying on them.</p>
    <ul id="relList"></ul>
  </div>
</div>
<script src="${mermaidJs}"></script>
<script src="${dbJs}"></script>
</body></html>`;
}

function showPanel(context) {
  if (!session) session = new DbSession(context);

  if (currentPanel) {
    // Reusing an already-loaded webview: it already ran its own initial
    // "refresh" postMessage on first load (see media/db.js), so nothing
    // re-fires that here — just reveal it and let the user hit Refresh if
    // they want a re-sample.
    currentPanel.reveal(vscode.ViewColumn.Beside, true);
    session.panel = currentPanel;
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
      await forgetCredentials(context, { silent: true });
      await session.refresh();
    }
  });
}

async function forgetCredentials(context, { silent = false } = {}) {
  await context.secrets.delete(SECRET_KEY);
  if (session) {
    await session.dispose();
  }
  if (!silent) {
    vscode.window.showInformationMessage("LakshX Database: credentials forgotten. Run “LakshX: Show Database Panel” to connect again.");
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("lakshx.db.showPanel", () => showPanel(context)),
    vscode.commands.registerCommand("lakshx.db.forgetCredentials", () => forgetCredentials(context)),
    log,
  );
}

function deactivate() {
  return session?.dispose();
}

module.exports = { activate, deactivate };
