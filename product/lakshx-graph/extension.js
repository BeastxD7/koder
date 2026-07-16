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
const depgraph = require("./lib/depgraph.js");

// ---- dependency-scan bounds (a bounded STATIC scan; no code is executed) ----
const SCAN_MAX_FILES = 2000; // hard cap on files opened
const SCAN_MAX_BYTES = 512 * 1024; // per-file size cap; larger files are skipped
const SCAN_INCLUDE = "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,py,pyi}";
// findFiles honors files.exclude/search.exclude (which respect .gitignore-ish
// defaults); we add the usual build/vendor dirs explicitly so a repo without
// those settings still gets a clean graph.
const SCAN_EXCLUDE = "**/{node_modules,.git,dist,build,out,.next,.venv,venv,__pycache__,coverage,vendor}/**";
// Cap how many nodes we ship to the webview so a huge monorepo doesn't render
// as an unreadable hairball. We keep all cyclic + highest-degree internal nodes.
const RENDER_NODE_CAP = 600;

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
// Maps a workspace-relative POSIX path (a dep-graph node id) back to its Uri so
// the webview's "open this file" click can resolve it. Rebuilt on every scan.
let depPathToUri = new Map();

// ---------------------------------------------------------------------------
// Dependency graph: workspace scan
// ---------------------------------------------------------------------------

/** POSIX-normalized workspace-relative path for a Uri (forward slashes). */
function relPathOf(uri) {
  return vscode.workspace.asRelativePath(uri, false).split(path.sep).join("/");
}

/**
 * Scan the workspace and build a dependency graph. This is the ONE place that
 * touches the filesystem; all parsing/model logic lives in lib/depgraph.js.
 * Returns the webview payload ({nodes, edges, cycles, stats}) already capped to
 * RENDER_NODE_CAP. Best-effort: unreadable files are skipped, not fatal.
 */
async function scanDependencyGraph(progress) {
  const uris = await vscode.workspace.findFiles(SCAN_INCLUDE, SCAN_EXCLUDE, SCAN_MAX_FILES);
  const files = [];
  depPathToUri = new Map();
  for (const uri of uris) {
    let bytes;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > SCAN_MAX_BYTES) continue;
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      continue; // unreadable / vanished — skip
    }
    const rel = relPathOf(uri);
    depPathToUri.set(rel, uri);
    files.push({ path: rel, text: Buffer.from(bytes).toString("utf8") });
    if (progress && files.length % 200 === 0) progress.report({ message: `scanned ${files.length} files…` });
  }

  const graph = depgraph.buildGraph(files);
  return capGraphForRender(graph);
}

/**
 * Keep the render payload bounded: retain every cyclic node, then fill up to
 * RENDER_NODE_CAP with the highest-degree internal nodes, then any externals
 * they connect to. Edges are filtered to the kept node set. `stats` always
 * reflects the FULL graph so the numbers stay honest even when the view is
 * truncated.
 */
function capGraphForRender(graph) {
  const { nodes, edges, cycles, stats } = graph;
  if (nodes.length <= RENDER_NODE_CAP) {
    return { nodes, edges, cycles, stats, truncatedNodes: 0 };
  }
  const degree = new Map();
  for (const n of nodes) degree.set(n.id, n.fanIn + n.fanOut);
  const keep = new Set();
  for (const n of nodes) if (n.inCycle) keep.add(n.id);
  const internals = nodes
    .filter((n) => n.type === "internal" && !keep.has(n.id))
    .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0));
  for (const n of internals) {
    if (keep.size >= RENDER_NODE_CAP) break;
    keep.add(n.id);
  }
  // include externals directly attached to kept internals (up to a little slack)
  for (const e of edges) {
    if (keep.size >= RENDER_NODE_CAP + 120) break;
    const from = nodes.find((n) => n.id === e.from);
    const to = nodes.find((n) => n.id === e.to);
    if (keep.has(e.from) && to && to.type === "external") keep.add(e.to);
    if (keep.has(e.to) && from && from.type === "external") keep.add(e.from);
  }
  const keptNodes = nodes.filter((n) => keep.has(n.id));
  const keptEdges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  const keptCycles = cycles.filter((c) => c.every((id) => keep.has(id)));
  return {
    nodes: keptNodes,
    edges: keptEdges,
    cycles: keptCycles,
    stats,
    truncatedNodes: nodes.length - keptNodes.length,
  };
}

async function runDependencyScan() {
  if (!currentPanel) return;
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    currentPanel.webview.postMessage({ type: "error", message: "Open a folder/workspace to scan its dependency graph." });
    return;
  }
  try {
    const payload = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "LakshX: scanning dependencies" },
      (progress) => scanDependencyGraph(progress),
    );
    currentPanel.webview.postMessage({ type: "depInit", ...payload });
  } catch (err) {
    currentPanel.webview.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
  }
}

/** Open a workspace file by its dep-graph relative-path id. */
async function openDepPath(relPath) {
  const uri = depPathToUri.get(relPath);
  if (!uri) return;
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
}

/** Ensure the shared graph panel exists; create it (with handlers) if not. */
function ensurePanel(context) {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside, true);
    return currentPanel;
  }
  currentPanel = vscode.window.createWebviewPanel(
    "lakshxCallGraph",
    "LakshX Graph",
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
  return currentPanel;
}

async function showDependencyGraph(context) {
  ensurePanel(context);
  currentPanel.title = "LakshX Dependency Graph";
  // ask the webview to switch to dep mode; it will request a scan if it has no
  // data yet (keeps the scan lazy and driven from one place).
  currentPanel.webview.postMessage({ type: "switchToDep" });
}

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

  ensurePanel(context);
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
  if (!currentPanel) return;
  // Dependency-graph messages don't need a call-hierarchy session — handle them
  // first so the dep view works even if Call Graph was never opened.
  try {
    if (m.type === "scanDependencies") {
      await runDependencyScan();
      return;
    }
    if (m.type === "openPath") {
      await openDepPath(m.path);
      return;
    }
  } catch (err) {
    currentPanel.webview.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
    return;
  }

  if (!currentSession) return;
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
    <div id="modeToggle" role="tablist">
      <button id="modeDep" role="tab">Dependencies</button>
      <button id="modeCall" role="tab" class="active">Call graph</button>
    </div>
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
  <div id="depLegend" hidden>
    <span class="chip internal"><span class="dot"></span>File</span>
    <span class="chip external"><span class="dot"></span>External package</span>
    <span class="chip cycle"><span class="dot"></span>Circular dependency</span>
  </div>
  <div id="depControls" hidden>
    <input id="depSearch" type="text" placeholder="Search files / packages…" spellcheck="false" />
    <label class="check"><input id="depHideExt" type="checkbox" />Hide externals</label>
    <label class="check"><input id="depCollapseExt" type="checkbox" />Collapse externals</label>
    <button id="depRescan" class="ghost" title="Re-scan the workspace">Re-scan</button>
  </div>
  <div id="stats" hidden></div>
  <canvas id="canvas"></canvas>
  <div id="empty" hidden>No call hierarchy available at the cursor. Place it on a function or method name and try again.</div>
  <div id="depHint" hidden>
    Build an interactive map of your workspace's file &amp; package dependencies — imports, fan-in/out, and circular dependencies.
    <br><button id="depScanBtn">Scan workspace</button>
  </div>
  <div id="tooltip" hidden></div>
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

  // Dependency-graph entry point — a second always-visible affordance right
  // beside the Call Graph one, priority 996 (same right-aligned cluster; see
  // the numbering note above). Unlike Call Graph this needs no cursor, so it's
  // always actionable.
  const depStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 996);
  depStatusItem.text = "$(type-hierarchy) Dep Graph";
  depStatusItem.tooltip = "LakshX: Show Dependency Graph (file & package import map of the workspace)";
  depStatusItem.command = "lakshx.showDependencyGraph";
  depStatusItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("lakshx.showCallGraph", () => showCallGraph(context)),
    vscode.commands.registerCommand("lakshx.showDependencyGraph", () => showDependencyGraph(context)),
    statusItem,
    depStatusItem,
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
