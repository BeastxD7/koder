// LakshX Call Graph panel — a native, interactive call-hierarchy viewer.
//
// This does NOT unlock any new capability beyond VS Code's own built-in call
// hierarchy: it drives the exact same LSP surface language servers already
// implement for "Peek Call Hierarchy" (vscode.prepareCallHierarchy /
// vscode.provideIncomingCalls / vscode.provideOutgoingCalls). What it adds is
// a webview UI that matches the rest of the IDE and lets you click a node to
// expand it or jump straight to that code — see docs/research for why this
// is a native sibling extension instead of a third-party marketplace one.
//
// Explicitly out of scope for v1: whole-codebase/file-level import graphs.
// This is strictly seed-from-cursor, function-level, depth-capped.
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

// A node's "identity" is derived from its declaration site, since
// CallHierarchyItem objects don't carry a stable id of their own. Same
// symbol reached via two different call paths collapses to one graph node
// (dedup), which also gives us cheap cycle protection for recursive calls.
function nodeId(item) {
  const r = item.selectionRange || item.range;
  return `${item.uri.toString()}::${item.name}::${r.start.line}:${r.start.character}::${r.end.line}:${r.end.character}`;
}

function serializeItem(item, id) {
  return {
    id,
    name: item.name,
    detail: item.detail || "",
    kind: item.kind, // numeric vscode.SymbolKind — mapped to a label/color in media/graph.js
    file: path.basename(item.uri.fsPath || item.uri.path || ""),
    uri: item.uri.toString(),
  };
}

// Cap on how many calls we surface per node per direction on an
// automatic/expand fetch, before showing a "N more" affordance instead of
// silently rendering everything — the hairball-avoidance guardrail from the
// research plan. A user can still ask to see the rest via loadMore.
const PER_NODE_LIMIT = 8;
// How many hop-1 neighbors we auto-expand one further hop into (depth cap of
// ~2 hops by default). Anything beyond that requires an explicit click.
const AUTO_EXPAND_HOP2_LIMIT = 8;

class CallGraphSession {
  constructor(panel) {
    this.panel = panel;
    this.items = new Map(); // id -> live CallHierarchyItem (must stay the exact object instance the provider returned)
    this.expanded = new Map(); // id -> { incoming: bool, outgoing: bool }
  }

  remember(item) {
    const id = nodeId(item);
    if (!this.items.has(id)) {
      this.items.set(id, item);
      this.expanded.set(id, { incoming: false, outgoing: false });
    }
    return id;
  }

  /** Fetch one direction's calls for a node, capped, returning {nodes, edges, truncated}. */
  async fetchDirection(id, direction, { all = false } = {}) {
    const item = this.items.get(id);
    if (!item) return { nodes: [], edges: [], truncated: 0 };
    const command = direction === "incoming" ? "vscode.provideIncomingCalls" : "vscode.provideOutgoingCalls";
    let calls;
    try {
      calls = (await vscode.commands.executeCommand(command, item)) || [];
    } catch (err) {
      vscode.window.showWarningMessage(`LakshX Call Graph: couldn't fetch ${direction} calls (${err.message || err}).`);
      calls = [];
    }
    const limit = all ? calls.length : PER_NODE_LIMIT;
    const truncated = Math.max(0, calls.length - limit);
    const nodes = [];
    const edges = [];
    for (const call of calls.slice(0, limit)) {
      const neighbor = direction === "incoming" ? call.from : call.to;
      const neighborId = this.remember(neighbor);
      nodes.push(serializeItem(neighbor, neighborId));
      edges.push({ from: id, to: neighborId, direction });
    }
    const st = this.expanded.get(id);
    if (st) st[direction] = true;
    return { nodes, edges, truncated };
  }

  async openFile(id) {
    const item = this.items.get(id);
    if (!item) return;
    const doc = await vscode.workspace.openTextDocument(item.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    const range = item.selectionRange || item.range;
    const vsRange = new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
    editor.selection = new vscode.Selection(vsRange.start, vsRange.end);
    editor.revealRange(vsRange, vscode.TextEditorRevealType.InCenter);
  }
}

/** Builds the seed graph (root + auto-expanded hop-1, plus a capped auto hop-2). */
async function buildInitialGraph(session, rootItem) {
  const rootId = session.remember(rootItem);
  const nodes = [serializeItem(rootItem, rootId)];
  const edges = [];

  const [inc, out] = await Promise.all([
    session.fetchDirection(rootId, "incoming"),
    session.fetchDirection(rootId, "outgoing"),
  ]);
  nodes.push(...inc.nodes, ...out.nodes);
  edges.push(...inc.edges, ...out.edges);
  // keyed by node id (not "id:direction" — ids are URIs and already contain
  // colons, so a flat string key would be ambiguous to split back apart)
  const truncated = { [rootId]: { incoming: inc.truncated, outgoing: out.truncated } };

  // Hop 2: keep expanding strictly in the same direction each hop-1 node was
  // discovered in (an incoming-caller's further callers; an outgoing-callee's
  // further callees) — anything else would just re-surface nodes near the
  // root. Capped so a single "Show Call Graph" click can't fan out into
  // dozens of LSP round-trips.
  const hop1 = [...inc.nodes.map((n) => ({ id: n.id, direction: "incoming" })), ...out.nodes.map((n) => ({ id: n.id, direction: "outgoing" }))].slice(
    0,
    AUTO_EXPAND_HOP2_LIMIT,
  );
  for (const { id, direction } of hop1) {
    const res = await session.fetchDirection(id, direction);
    nodes.push(...res.nodes);
    edges.push(...res.edges);
    truncated[id] = { ...truncated[id], [direction]: res.truncated };
  }

  return { rootId, nodes, edges, truncated };
}

function dedupeNodes(nodes) {
  const seen = new Map();
  for (const n of nodes) if (!seen.has(n.id)) seen.set(n.id, n);
  return [...seen.values()];
}

let currentPanel = null;
let currentSession = null;

async function showCallGraph(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("LakshX Call Graph: open a file and place your cursor on a function/method first.");
    return;
  }
  const position = editor.selection.active;
  let items;
  try {
    items = await vscode.commands.executeCommand("vscode.prepareCallHierarchy", editor.document.uri, position);
  } catch (err) {
    vscode.window.showWarningMessage(`LakshX Call Graph: ${err.message || err}`);
    return;
  }
  if (!items || items.length === 0) {
    vscode.window.showInformationMessage("LakshX Call Graph: no call hierarchy available at the cursor. Place it on a function or method name.");
    return;
  }
  const rootItem = items[0];

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    currentPanel = vscode.window.createWebviewPanel(
      "lakshxCallGraph",
      "LakshX Call Graph",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );
    currentPanel.onDidDispose(() => {
      currentPanel = null;
      currentSession = null;
    });
    currentPanel.webview.html = panelHtml(context, currentPanel.webview);
    currentPanel.webview.onDidReceiveMessage((m) => onWebviewMessage(context, m));
  }

  currentSession = new CallGraphSession(currentPanel);
  currentPanel.title = `Call Graph: ${rootItem.name}`;

  try {
    const graph = await buildInitialGraph(currentSession, rootItem);
    currentPanel.webview.postMessage({
      type: "init",
      rootId: graph.rootId,
      nodes: dedupeNodes(graph.nodes),
      edges: graph.edges,
      truncated: graph.truncated,
    });
  } catch (err) {
    currentPanel.webview.postMessage({ type: "error", message: String(err.message || err) });
  }
}

async function onWebviewMessage(context, m) {
  if (!currentSession || !currentPanel) return;
  try {
    switch (m.type) {
      case "expand": {
        const res = await currentSession.fetchDirection(m.id, m.direction);
        currentPanel.webview.postMessage({
          type: "expandResult",
          parentId: m.id,
          direction: m.direction,
          nodes: dedupeNodes(res.nodes),
          edges: res.edges,
          truncated: res.truncated,
        });
        break;
      }
      case "loadMore": {
        const res = await currentSession.fetchDirection(m.id, m.direction, { all: true });
        currentPanel.webview.postMessage({
          type: "expandResult",
          parentId: m.id,
          direction: m.direction,
          nodes: dedupeNodes(res.nodes),
          edges: res.edges,
          truncated: 0,
        });
        break;
      }
      case "openFile":
        await currentSession.openFile(m.id);
        break;
    }
  } catch (err) {
    currentPanel.webview.postMessage({ type: "error", message: String(err.message || err) });
  }
}

function panelHtml(context, webview) {
  const stamp = (f) => {
    try {
      return Math.round(fs.statSync(path.join(context.extensionPath, "media", f)).mtimeMs);
    } catch {
      return Date.now();
    }
  };
  const css = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "graph.css")) + "?v=" + stamp("graph.css");
  const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "graph.js")) + "?v=" + stamp("graph.js");
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${css}">
</head><body>
<div id="app">
  <div id="toolbar">
    <span id="title">Call Graph</span>
    <div class="spacer"></div>
    <button id="zoomOut" class="ghost" title="Zoom out">&#8722;</button>
    <button id="zoomReset" class="ghost" title="Reset view">Reset</button>
    <button id="zoomIn" class="ghost" title="Zoom in">&#43;</button>
  </div>
  <div id="legend">
    <span class="chip incoming"><span class="dot"></span>Incoming (callers)</span>
    <span class="chip outgoing"><span class="dot"></span>Outgoing (callees)</span>
  </div>
  <canvas id="canvas"></canvas>
  <div id="empty" hidden>No call hierarchy available at the cursor. Place it on a function or method name and try again.</div>
</div>
<script src="${js}"></script>
</body></html>`;
}

function activate(context) {
  // Status bar entry point — previously this panel was ONLY reachable via
  // editor/title (and only then when `editorHasCallHierarchyProvider` is
  // true) or the command palette, so it had no persistent, always-visible
  // affordance. Priority 997, right after koder-db's "$(database) DB" (998)
  // in the same right-aligned cluster as koder-chat's "✦ LakshX" (1000) and
  // "$(radio-tower) Remote: ..." (999) — see those files for the same
  // numbering convention.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 997);
  statusItem.text = "$(graph) Call Graph";
  statusItem.tooltip = "LakshX: Show Call Graph (place your cursor on a function/method first)";
  statusItem.command = "lakshx.showCallGraph";
  statusItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("lakshx.showCallGraph", () => showCallGraph(context)),
    statusItem,
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
