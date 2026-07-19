// LakshX Graph panel — a native workspace-dependency viewer.
//
// Renders a file/package import graph (with cycle detection) via a webview
// that matches the rest of the IDE, plus a dependency-ordered Guided Tour
// over the same scan, a per-file "explain" lookup, and inline OSV.dev
// dependency-vulnerability hints. See docs/research for background.
//
// (This extension previously also shipped a "Call Graph" mode — a
// function-level call-hierarchy viewer seeded from the cursor, built on
// vscode.prepareCallHierarchy/provideIncomingCalls/provideOutgoingCalls. It
// was removed: in real usage it never rendered anything beyond the empty
// state, so rather than debug it further it was cut entirely. If a call
// hierarchy view is wanted again, VS Code's own built-in "Peek Call
// Hierarchy" already covers the same LSP surface.)
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const depgraph = require("./lib/depgraph.js");
const vuln = require("./lib/vuln-check.js");
const tourLib = require("./lib/tour.js");

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

let currentPanel = null;
// Maps a workspace-relative POSIX path (a dep-graph node id) back to its Uri so
// the webview's "open this file" click can resolve it. Rebuilt on every scan.
let depPathToUri = new Map();
// The FULL (uncapped) graph from the most recent scan — the Guided Tour and
// "Explain this file" both need the real, complete metrics, not the
// RENDER_NODE_CAP-truncated view shipped to the canvas. Reused across
// showGuidedTour/explainActiveFile so a second feature doesn't force a
// redundant re-scan of the workspace.
let lastScanGraph = null;

// ---------------------------------------------------------------------------
// Dependency graph: workspace scan
// ---------------------------------------------------------------------------

/** POSIX-normalized workspace-relative path for a Uri (forward slashes). */
function relPathOf(uri) {
  return vscode.workspace.asRelativePath(uri, false).split(path.sep).join("/");
}

/**
 * Gather workspace source files (bounded scan: SCAN_MAX_FILES / SCAN_MAX_BYTES,
 * same include/exclude globs as the dependency graph). This is the ONE place
 * that touches the filesystem for a workspace-wide scan; shared by the
 * dependency graph (below) and the vulnerability full-workspace scan so the
 * bounds and file-reading logic aren't duplicated. Best-effort: unreadable
 * files are skipped, not fatal.
 */
async function gatherWorkspaceFiles(progress) {
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
  return files;
}

/**
 * Scan the workspace and build a dependency graph. All parsing/model logic
 * lives in lib/depgraph.js. Returns the webview payload
 * ({nodes, edges, cycles, stats}) already capped to RENDER_NODE_CAP.
 */
async function scanDependencyGraph(progress) {
  const files = await gatherWorkspaceFiles(progress);
  const graph = depgraph.buildGraph(files);
  lastScanGraph = graph;
  // Guided Tour ordering is computed on the FULL graph (not the render-capped
  // view below) so its tiers/metrics stay honest even when a huge monorepo's
  // canvas render gets truncated — see capGraphForRender's own comment for the
  // same tradeoff on the dependency-graph render path.
  const tour = tourLib.buildTour(graph);
  return { ...capGraphForRender(graph), tour };
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

/**
 * Guided Tour — a sequential, dependency-ordered walkthrough built on the
 * SAME scan/data as the dependency graph (lib/tour.js just reorders/tiers
 * what's already there). If we already have a scan cached (lastScanGraph),
 * ship it to the webview immediately rather than round-tripping a fresh
 * "scanDependencies" request — this is also what makes "Explain this file"
 * -> "Show in Guided Tour" feel instant on a panel that's already been used.
 * @param {object} [opts]
 * @param {string} [opts.jumpToPath] workspace-relative path to land the tour on
 */
async function showGuidedTour(context, opts = {}) {
  ensurePanel(context);
  currentPanel.title = "LakshX Guided Tour";
  if (lastScanGraph) {
    // Flip the webview into tour mode FIRST, then ship the (already-cached)
    // scan — mirrors the "switchToTour then scan" ordering of the cold path
    // below, so loadDependencyGraph's mode-preservation logic (media/graph.js)
    // behaves identically regardless of which path got us here.
    currentPanel.webview.postMessage({ type: "setMode", mode: "tour" });
    const tour = tourLib.buildTour(lastScanGraph);
    currentPanel.webview.postMessage({ type: "depInit", ...capGraphForRender(lastScanGraph), tour });
  } else {
    // no scan yet — same lazy-scan pattern as showDependencyGraph; the
    // webview requests one itself once it sees switchToTour with no data.
    currentPanel.webview.postMessage({ type: "switchToTour" });
  }
  if (opts.jumpToPath) {
    // Queued regardless of whether depInit above was synchronous or is still
    // pending a scan round-trip — the webview buffers this until tour data
    // actually lands (see media/graph.js's pendingTourJumpPath).
    currentPanel.webview.postMessage({ type: "tourJumpToPath", path: opts.jumpToPath });
  }
}

/**
 * "Explain this file" — `lakshx.graph.explainFile`. Looks up the ACTIVE
 * editor's file in the dependency graph (scanning the workspace first if
 * nothing's cached yet) and surfaces its real fan-in/fan-out, tier, and
 * cycle membership via lib/tour.js's explainNode(). Entirely self-contained
 * within lakshx-graph — no cross-extension dependency on lakshx-chat, and
 * every number shown comes straight from the static import scan, nothing
 * invented. The optional "Show in Guided Tour" action reuses the Guided Tour
 * panel to give it visual context alongside the rest of the codebase walk.
 */
async function explainActiveFile(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage("LakshX: open a file first to explain its place in the dependency graph.");
    return;
  }
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showInformationMessage("LakshX: open a folder/workspace to explain a file's place in the dependency graph.");
    return;
  }
  const relPath = relPathOf(editor.document.uri);
  if (!depgraph.languageOf(relPath)) {
    vscode.window.showInformationMessage(`LakshX: ${path.basename(relPath)} isn't a scanned language (JS/TS/Python) — nothing to explain.`);
    return;
  }

  let graph = lastScanGraph;
  if (!graph) {
    try {
      graph = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: "LakshX: scanning dependencies" },
        async (progress) => {
          const files = await gatherWorkspaceFiles(progress);
          const g = depgraph.buildGraph(files);
          lastScanGraph = g;
          return g;
        },
      );
    } catch (err) {
      vscode.window.showWarningMessage(`LakshX: couldn't scan the workspace (${err && err.message ? err.message : err}).`);
      return;
    }
  }

  const info = tourLib.explainNode(graph, relPath);
  if (!info) {
    vscode.window.showInformationMessage(`LakshX: ${relPath} has no recorded internal imports or importers in this workspace scan.`);
    return;
  }

  const cycleNote = info.inCycle ? ` Part of a ${info.cycleMembers.length}-file circular dependency.` : "";
  const summary = `${relPath} — ${info.blurb}${cycleNote}`;
  const choice = await vscode.window.showInformationMessage(summary, "Show in Guided Tour");
  if (choice === "Show in Guided Tour") {
    await showGuidedTour(context, { jumpToPath: relPath });
  }
}

async function onWebviewMessage(context, m) {
  if (!currentPanel) return;
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
      <button id="modeDep" role="tab" class="active">Dependencies</button>
      <button id="modeTour" role="tab">Guided Tour</button>
    </div>
    <div class="spacer"></div>
    <button id="zoomOut" class="ghost" title="Zoom out">&#8722;</button>
    <button id="zoomReset" class="ghost" title="Reset view">Reset</button>
    <button id="zoomIn" class="ghost" title="Zoom in">&#43;</button>
  </div>
  <div id="depLegend">
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
  <div id="stats"></div>
  <canvas id="canvas"></canvas>
  <div id="empty" hidden></div>
  <div id="depHint" hidden>
    Build an interactive map of your workspace's file &amp; package dependencies — imports, fan-in/out, and circular dependencies.
    <br><button id="depScanBtn">Scan workspace</button>
  </div>
  <div id="tourPanel" hidden>
    <div id="tourHeader">
      <span id="tourTier"></span>
      <span id="tourCounter"></span>
    </div>
    <div id="tourTitle"></div>
    <div id="tourBlurb"></div>
    <div id="tourNav">
      <button id="tourPrev" class="ghost">&larr; Prev</button>
      <button id="tourJump" class="ghost">Jump to file</button>
      <button id="tourNext" class="ghost">Next &rarr;</button>
    </div>
  </div>
  <div id="tooltip" hidden></div>
</div>
<script src="${js}"></script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Inline dependency-vulnerability hints (OSV.dev) — roadmap doc 15, item #1.
//
// All request-building / response-parsing / caching logic lives in the
// vscode-free lib/vuln-check.js (unit-tested with mocked HTTP in
// test/vuln-check.test.js). This section is the ONLY place that touches
// vscode's editor/document/diagnostic/decoration APIs and the real network
// `fetch`. Two surfaces are wired:
//   1. Gutter icon + hover on import/require lines in the active editor
//      (TextEditorDecorationType, per-line hoverMessage — no separate hover
//      provider needed).
//   2. A DiagnosticCollection for package.json dependencies/devDependencies
//      so vulnerable deps show up in the standard Problems panel too.
// Re-scans are debounced per document and the whole thing fails silently
// (logged to an output channel) on any API/network error — it must never
// crash the editor.
// ---------------------------------------------------------------------------

const VULN_DEBOUNCE_MS = 1500; // don't hit the API on every keystroke
const VULN_CACHE_KEY = "lakshx.vulnCache";
const VULN_CONCURRENCY = 5; // cap on simultaneous OSV detail lookups

let vulnOutputChannel = null;
let vulnDiagnostics = null;
let vulnDecorationType = null;
let vulnCache = null; // vuln.TTLCache, backed by globalState
let extContext = null;
const vulnScanTimers = new Map(); // doc uri string -> debounce timeout

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function severityToDiagnosticSeverity(sev) {
  switch (sev) {
    case "CRITICAL":
    case "HIGH":
      return vscode.DiagnosticSeverity.Error;
    case "MODERATE":
    case "MEDIUM":
      return vscode.DiagnosticSeverity.Warning;
    case "LOW":
      return vscode.DiagnosticSeverity.Information;
    default:
      return vscode.DiagnosticSeverity.Warning;
  }
}

function vulnHoverMarkdown(pkgName, version, entry, imprecise) {
  const md = new vscode.MarkdownString("", true);
  md.isTrusted = false;
  const n = entry.vulns.length;
  md.appendMarkdown(`**LakshX — ${pkgName}${version ? "@" + version : ""}**: ${n} known ${n === 1 ? "vulnerability" : "vulnerabilities"}\n\n`);
  for (const v of entry.vulns.slice(0, 5)) {
    md.appendMarkdown(`- **${v.severity}** [${v.id}](${v.url}) — ${v.summary}\n`);
  }
  if (n > 5) md.appendMarkdown(`- …and ${n - 5} more\n`);
  if (imprecise) {
    md.appendMarkdown(`\n_Installed version not resolved — showing all known advisories for \`${pkgName}\`, some may already be fixed in your installed version._`);
  }
  return md;
}

function initVulnCache() {
  let stored;
  try {
    stored = extContext.globalState.get(VULN_CACHE_KEY);
  } catch {
    stored = undefined;
  }
  vulnCache = vuln.TTLCache.fromJSON(stored, { ttlMs: vuln.DEFAULT_TTL_MS });
}

function persistVulnCache() {
  try {
    extContext.globalState.update(VULN_CACHE_KEY, vulnCache.toJSON());
  } catch (err) {
    vulnOutputChannel.appendLine(`Failed to persist vulnerability cache: ${err && err.message ? err.message : err}`);
  }
}

/** POSIX-relative path for a document (mirrors relPathOf(uri) for editors). */
function relPathForDoc(doc) {
  try {
    return vscode.workspace.asRelativePath(doc.uri, false).split(path.sep).join("/");
  } catch {
    return doc.fileName || "";
  }
}

/**
 * Best-effort installed version lookup: read node_modules/<pkg>/package.json
 * under each workspace folder. This is the ACCURATE source (a caret range
 * like "^4.17.15" may have resolved to a patched 4.17.21 — trusting the range
 * literal would false-positive). Returns undefined if not installed/found,
 * in which case callers fall back to a name-only OSV query and label the
 * result as imprecise.
 */
async function resolveInstalledVersion(pkgName) {
  const folders = vscode.workspace.workspaceFolders || [];
  for (const folder of folders) {
    try {
      const segs = pkgName.split("/");
      const pkgJsonUri = vscode.Uri.joinPath(folder.uri, "node_modules", ...segs, "package.json");
      const bytes = await vscode.workspace.fs.readFile(pkgJsonUri);
      const json = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (json && typeof json.version === "string") return json.version;
    } catch {
      // not installed under this folder, or unreadable/malformed — try the
      // next workspace folder (multi-root) rather than failing the whole scan
    }
  }
  return undefined;
}

/**
 * Extract the external package specs a document imports, reusing
 * lib/depgraph.js (extractImports + resolveImport) rather than re-parsing.
 * An empty fileSet means every relative import "fails" internal resolution
 * (deliberate — we only want the package/bare imports here); unresolved
 * relative imports come back as external with a dotted/relative raw name,
 * which we filter out since they aren't real packages.
 * @returns {Array<{spec:string, pkgName:string}>}
 */
function collectImportPackageSpecs(doc) {
  const relPath = relPathForDoc(doc);
  const lang = depgraph.languageOf(relPath);
  if (!lang) return [];
  const imports = depgraph.extractImports(doc.getText(), lang);
  const emptyFileSet = new Set();
  const out = [];
  const seen = new Set();
  for (const imp of imports) {
    const res = depgraph.resolveImport(relPath, imp, emptyFileSet, lang);
    if (res.type !== "external") continue;
    if (res.name.startsWith(".")) continue; // unresolved relative import, not a package
    const key = res.name + "|" + imp.spec;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ spec: imp.spec, pkgName: res.name });
  }
  return out;
}

function isPackageJsonDoc(doc) {
  return path.basename(doc.uri.fsPath || relPathForDoc(doc)) === "package.json";
}

function isVulnScannableDoc(doc) {
  if (doc.uri.scheme !== "file") return false;
  if (isPackageJsonDoc(doc)) return true;
  return depgraph.languageOf(relPathForDoc(doc)) !== null;
}

/** Gutter icon + hover for vulnerable import/require lines in one editor. */
async function scanActiveEditorImports(editor) {
  if (!editor || typeof fetch === "undefined") return;
  const doc = editor.document;
  if (isPackageJsonDoc(doc)) return; // handled by scanPackageJsonDoc (diagnostics, not decorations)
  const specs = collectImportPackageSpecs(doc);
  if (specs.length === 0) {
    editor.setDecorations(vulnDecorationType, []);
    return;
  }

  const uniquePkgs = [...new Set(specs.map((s) => s.pkgName))];
  const versionByPkg = new Map();
  await Promise.all(uniquePkgs.map(async (name) => versionByPkg.set(name, await resolveInstalledVersion(name))));
  const deps = uniquePkgs.map((name) => ({ name, version: versionByPkg.get(name) }));

  let results;
  try {
    results = await vuln.checkVulnerabilities(deps, {
      fetchImpl: fetch,
      cache: vulnCache,
      concurrency: VULN_CONCURRENCY,
      log: (msg) => vulnOutputChannel.appendLine(msg),
    });
  } catch (err) {
    vulnOutputChannel.appendLine(`Import vulnerability scan failed for ${relPathForDoc(doc)}: ${err && err.message ? err.message : err}`);
    return;
  }
  persistVulnCache();

  const decorations = [];
  const lineCount = doc.lineCount;
  for (const { spec, pkgName } of specs) {
    const version = versionByPkg.get(pkgName);
    const entry = results.get(vuln.depKey(pkgName, version));
    if (!entry || entry.vulns.length === 0) continue;
    const quotedForms = [`"${spec}"`, `'${spec}'`, `\`${spec}\``];
    const hover = vulnHoverMarkdown(pkgName, version, entry, !version);
    for (let i = 0; i < lineCount; i++) {
      const lineText = doc.lineAt(i).text;
      if (!quotedForms.some((q) => lineText.includes(q))) continue;
      decorations.push({ range: new vscode.Range(i, 0, i, lineText.length), hoverMessage: hover });
    }
  }
  // Editor may have been closed/switched away while we were awaiting network
  // calls; setDecorations on a disposed editor is a silent no-op in vscode,
  // so no extra guard is needed here.
  editor.setDecorations(vulnDecorationType, decorations);
}

/** Find the line declaring `"name": "..."` inside a package.json document. */
function findDependencyLineNumber(doc, name) {
  const re = new RegExp(`^\\s*"${escapeRegExp(name)}"\\s*:`);
  for (let i = 0; i < doc.lineCount; i++) {
    if (re.test(doc.lineAt(i).text)) return i;
  }
  return 0;
}

/** Problems-panel diagnostics for one package.json's declared dependencies. */
// Returns the number of diagnostics set (0 on error/empty), so callers that
// aggregate a workspace-wide count don't have to re-query
// vscode.languages.getDiagnostics() (which mixes in diagnostics from other
// providers, e.g. JSON-schema validation, and would over-count LakshX's hits).
async function scanPackageJsonDoc(doc) {
  if (typeof fetch === "undefined") return 0;
  let manifest;
  try {
    manifest = JSON.parse(doc.getText());
  } catch {
    vulnDiagnostics.delete(doc.uri); // invalid JSON mid-edit — skip silently
    return 0;
  }
  if (!manifest || typeof manifest !== "object") {
    vulnDiagnostics.delete(doc.uri);
    return 0;
  }

  const declared = [];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const obj = manifest[section];
    if (!obj || typeof obj !== "object") continue;
    for (const [name, range] of Object.entries(obj)) {
      if (typeof range === "string") declared.push({ name, range });
    }
  }
  if (declared.length === 0) {
    vulnDiagnostics.delete(doc.uri);
    return 0;
  }

  const versionInfo = new Map(); // name -> {version, imprecise}
  await Promise.all(
    declared.map(async ({ name, range }) => {
      const installed = await resolveInstalledVersion(name);
      if (installed) {
        versionInfo.set(name, { version: installed, imprecise: false });
        return;
      }
      const cleaned = vuln.cleanVersionSpec(range);
      versionInfo.set(name, { version: cleaned, imprecise: true });
    }),
  );
  const deps = declared.map(({ name }) => ({ name, version: versionInfo.get(name).version }));

  let results;
  try {
    results = await vuln.checkVulnerabilities(deps, {
      fetchImpl: fetch,
      cache: vulnCache,
      concurrency: VULN_CONCURRENCY,
      log: (msg) => vulnOutputChannel.appendLine(msg),
    });
  } catch (err) {
    vulnOutputChannel.appendLine(`package.json vulnerability scan failed for ${relPathForDoc(doc)}: ${err && err.message ? err.message : err}`);
    return 0;
  }
  persistVulnCache();

  const diagnostics = [];
  for (const { name } of declared) {
    const info = versionInfo.get(name);
    const entry = results.get(vuln.depKey(name, info.version));
    if (!entry || entry.vulns.length === 0) continue;
    const line = findDependencyLineNumber(doc, name);
    const range = new vscode.Range(line, 0, line, doc.lineAt(line).text.length);
    const worst = vuln.worstSeverity(entry.vulns);
    const idsPreview = entry.vulns
      .slice(0, 3)
      .map((v) => v.id)
      .join(", ");
    const more = entry.vulns.length > 3 ? ` +${entry.vulns.length - 3} more` : "";
    const impreciseNote = info.imprecise ? " (installed version not resolved; showing all known advisories)" : "";
    const diag = new vscode.Diagnostic(
      range,
      `LakshX: ${name} has ${entry.vulns.length} known ${entry.vulns.length === 1 ? "vulnerability" : "vulnerabilities"} (${worst}): ${idsPreview}${more}${impreciseNote}`,
      severityToDiagnosticSeverity(worst),
    );
    diag.source = "LakshX";
    diag.code = entry.vulns[0].id;
    diagnostics.push(diag);
  }
  vulnDiagnostics.set(doc.uri, diagnostics);
  return diagnostics.length;
}

async function runVulnScanForDoc(doc) {
  try {
    if (isPackageJsonDoc(doc)) {
      await scanPackageJsonDoc(doc);
      return;
    }
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === doc.uri.toString());
    if (editor) await scanActiveEditorImports(editor);
  } catch (err) {
    vulnOutputChannel.appendLine(`Vulnerability scan error for ${relPathForDoc(doc)}: ${err && err.message ? err.message : err}`);
  }
}

/** Debounced re-scan trigger — coalesces bursts of edits/saves per document. */
function scheduleVulnScan(doc) {
  if (!doc || !isVulnScannableDoc(doc)) return;
  const key = doc.uri.toString();
  const existing = vulnScanTimers.get(key);
  if (existing) clearTimeout(existing);
  vulnScanTimers.set(
    key,
    setTimeout(() => {
      vulnScanTimers.delete(key);
      runVulnScanForDoc(doc);
    }, VULN_DEBOUNCE_MS),
  );
}

/** Manual full-workspace vulnerability scan (command + status bar item). */
async function runFullWorkspaceVulnScan() {
  if (typeof fetch === "undefined") {
    vscode.window.showWarningMessage("LakshX: vulnerability scanning needs a fetch-capable runtime, which isn't available here.");
    return;
  }
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showInformationMessage("LakshX: open a folder/workspace to scan for vulnerable dependencies.");
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "LakshX: scanning dependencies for known vulnerabilities (OSV.dev)", cancellable: false },
    async (progress) => {
      // 1) every package.json in the workspace (bounded by SCAN_MAX_FILES) —
      // populates the Problems panel for files that may not even be open.
      let pkgUris = [];
      try {
        pkgUris = await vscode.workspace.findFiles("**/package.json", SCAN_EXCLUDE, SCAN_MAX_FILES);
      } catch (err) {
        vulnOutputChannel.appendLine(`Failed to enumerate package.json files: ${err && err.message ? err.message : err}`);
      }
      progress.report({ message: `checking ${pkgUris.length} package.json file(s)…` });
      let pkgJsonHits = 0;
      for (const uri of pkgUris) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          pkgJsonHits += await scanPackageJsonDoc(doc);
        } catch (err) {
          vulnOutputChannel.appendLine(`Skipped ${uri.fsPath}: ${err && err.message ? err.message : err}`);
        }
      }

      // 2) source-file imports across the workspace — reuses depgraph's
      // existing bounded scan (gatherWorkspaceFiles: SCAN_MAX_FILES /
      // SCAN_MAX_BYTES) and buildGraph's import extraction/resolution rather
      // than re-parsing anything here.
      progress.report({ message: "scanning source file imports…" });
      let vulnerableCount = 0;
      try {
        const files = await gatherWorkspaceFiles(progress);
        const graph = depgraph.buildGraph(files);
        const uniqueNames = [...new Set(graph.nodes.filter((n) => n.type === "external").map((n) => n.path))];
        const versionByPkg = new Map();
        await Promise.all(uniqueNames.map(async (name) => versionByPkg.set(name, await resolveInstalledVersion(name))));
        const deps = uniqueNames.map((name) => ({ name, version: versionByPkg.get(name) }));
        const results = await vuln.checkVulnerabilities(deps, {
          fetchImpl: fetch,
          cache: vulnCache,
          concurrency: VULN_CONCURRENCY,
          log: (msg) => vulnOutputChannel.appendLine(msg),
        });
        persistVulnCache();
        vulnerableCount = [...results.values()].filter((e) => e.vulns.length > 0).length;
      } catch (err) {
        vulnOutputChannel.appendLine(`Full-workspace import vulnerability scan failed: ${err && err.message ? err.message : err}`);
      }

      vscode.window.showInformationMessage(
        vulnerableCount > 0 || pkgJsonHits > 0
          ? `LakshX: found known vulnerabilities in ${vulnerableCount} imported package(s) and ${pkgJsonHits} manifest entr${pkgJsonHits === 1 ? "y" : "ies"}. See the Problems panel; re-open source files for inline hints.`
          : "LakshX: no known vulnerabilities found across scanned dependencies.",
      );

      // Refresh inline decorations for whatever's currently visible.
      for (const editor of vscode.window.visibleTextEditors) {
        await scanActiveEditorImports(editor);
      }
    },
  );
}

function activate(context) {
  // Dependency-graph entry point — a persistent, always-visible affordance
  // (no cursor/selection needed). Priority 996, right after lakshx-db's
  // "$(database) DB" (998) in the same right-aligned cluster as lakshx-chat's
  // "✦ LakshX" (1000) and "$(radio-tower) Remote: ..." (999) — see those
  // files for the same numbering convention. (997 was formerly this
  // extension's "Call Graph" status item, removed as non-functional; left
  // unused rather than renumbering the rest of the cluster.)
  const depStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 996);
  depStatusItem.text = "$(type-hierarchy) Dep Graph";
  depStatusItem.tooltip = "LakshX: Show Dependency Graph (file & package import map of the workspace)";
  depStatusItem.command = "lakshx.showDependencyGraph";
  depStatusItem.show();

  // Vulnerability-scan entry point — third item in the same right-aligned
  // cluster, priority 995 (right after Dep Graph's 996). Triggers the manual
  // full-workspace OSV scan; inline gutter/hover hints and the package.json
  // Problems-panel diagnostics run automatically/debounced without needing
  // this, but it's the explicit "scan everything now" affordance.
  const vulnStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 995);
  vulnStatusItem.text = "$(shield) Vuln Scan";
  vulnStatusItem.tooltip = "LakshX: Scan workspace dependencies for known vulnerabilities (OSV.dev)";
  vulnStatusItem.command = "lakshx.graph.scanVulnerabilities";
  vulnStatusItem.show();

  // Guided Tour entry point — fourth item in the same right-aligned cluster,
  // priority 994 (right after Vuln Scan's 995). Needs no cursor, so it's
  // always actionable, same as Dep Graph.
  const tourStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 994);
  tourStatusItem.text = "$(list-ordered) Guided Tour";
  tourStatusItem.tooltip = "LakshX: Walk the workspace dependency-ordered — entry points first, shared utilities/persistence last";
  tourStatusItem.command = "lakshx.showGuidedTour";
  tourStatusItem.show();

  // --- Vulnerability-hint wiring -------------------------------------------
  extContext = context;
  vulnOutputChannel = vscode.window.createOutputChannel("LakshX: Vulnerability Scan");
  vulnDiagnostics = vscode.languages.createDiagnosticCollection("lakshxVuln");
  vulnDecorationType = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, "media", "vuln-gutter.svg"),
    gutterIconSize: "contain",
    overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  initVulnCache();

  if (typeof fetch === "undefined") {
    vulnOutputChannel.appendLine("No global `fetch` available in this runtime — vulnerability lookups are disabled.");
  }

  // Scan the currently active editor (and any already-open package.json) once
  // on startup, then let the debounced listeners below keep things fresh.
  if (vscode.window.activeTextEditor) scheduleVulnScan(vscode.window.activeTextEditor.document);
  for (const doc of vscode.workspace.textDocuments) {
    if (isPackageJsonDoc(doc)) scheduleVulnScan(doc);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("lakshx.showDependencyGraph", () => showDependencyGraph(context)),
    vscode.commands.registerCommand("lakshx.showGuidedTour", () => showGuidedTour(context)),
    vscode.commands.registerCommand("lakshx.graph.explainFile", () => explainActiveFile(context)),
    vscode.commands.registerCommand("lakshx.graph.scanVulnerabilities", () => runFullWorkspaceVulnScan()),
    vscode.workspace.onDidOpenTextDocument((doc) => scheduleVulnScan(doc)),
    vscode.workspace.onDidSaveTextDocument((doc) => scheduleVulnScan(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleVulnScan(e.document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) scheduleVulnScan(editor.document);
    }),
    depStatusItem,
    vulnStatusItem,
    tourStatusItem,
    vulnOutputChannel,
    vulnDiagnostics,
    vulnDecorationType,
  );
}

function deactivate() {
  for (const t of vulnScanTimers.values()) clearTimeout(t);
  vulnScanTimers.clear();
  if (vulnCache && extContext) persistVulnCache();
}

module.exports = { activate, deactivate };
