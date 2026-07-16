// LakshX Structural Search — JetBrains-SSR-style find & replace by code SHAPE
// for JS/TS, with a mandatory preview-before-apply step.
//
// All matching/substitution logic lives in lib/pattern.js and is fully
// vscode-free / unit-tested (node --test test/*.test.js) — see that file's
// header for the "token-level structural match, not full AST" tradeoff this
// extension is built on, and README.md for the pattern syntax + known
// limitations. This file is the ONLY place that touches vscode: bounded
// workspace scanning, the webview panel, and the actual multi-file apply via
// vscode.workspace.applyEdit — mirroring product/lakshx-graph/extension.js's
// split between a pure lib and a thin vscode-facing shell.
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const pattern = require("./lib/pattern.js");
const rules = require("./lib/rules.js");

// ---- workspace-scan bounds (a bounded STATIC scan; no code is ever executed,
// same caps/rationale as lakshx-graph's dependency scan) -------------------
const SCAN_MAX_FILES = 2000; // hard cap on files opened
const SCAN_MAX_BYTES = 512 * 1024; // per-file size cap; larger files are skipped
// JS/TS only in v1 — the most tractable target given no bundled AST parser
// (see README "Why this scope").
const SCAN_INCLUDE = "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}";
const SCAN_EXCLUDE = "**/{node_modules,.git,dist,build,out,.next,.venv,venv,__pycache__,coverage,vendor}/**";
// Cap how many matches we ship to the webview so a very broad pattern (e.g. a
// bare `$X`) can't try to render tens of thousands of rows. `truncated` is
// always reported honestly alongside the (possibly partial) results.
const MAX_MATCHES = 500;

let currentPanel = null;
// id -> { uri, startOffset, endOffset, text, captures } — the source of truth
// for "apply", kept server-side so the webview only ever round-trips ids
// (never raw offsets it could get out of sync with a since-edited file).
let matchIndex = new Map();

function relPathOf(uri) {
  return vscode.workspace.asRelativePath(uri, false).split(path.sep).join("/");
}

/**
 * Bounded static file collection shared by every scan surface in this
 * extension (structural search/replace AND the SAST-lite rule scan below) —
 * the same caps/rationale/exclude-glob as lakshx-graph's dependency scan.
 * Returns both the {path,text} list (for pattern.js / rules.js, which are
 * vscode-free and take that shape) and a path->Uri map so callers can turn a
 * match's `path` back into a real vscode.Uri for diagnostics/edits.
 */
async function collectWorkspaceFiles(progress) {
  const uris = await vscode.workspace.findFiles(SCAN_INCLUDE, SCAN_EXCLUDE, SCAN_MAX_FILES);
  const files = [];
  const uriByPath = new Map();
  for (const uri of uris) {
    let bytes;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > SCAN_MAX_BYTES) continue;
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      continue; // unreadable / vanished — skip, best-effort like depgraph.js
    }
    const rel = relPathOf(uri);
    uriByPath.set(rel, uri);
    files.push({ path: rel, text: Buffer.from(bytes).toString("utf8") });
    if (progress && files.length % 200 === 0) progress.report({ message: `scanned ${files.length} files…` });
  }
  return { files, uriByPath };
}

/** Scan the workspace and run the compiled pattern against every JS/TS file. */
async function scanWorkspace(compiledPattern, progress) {
  const { files, uriByPath } = await collectWorkspaceFiles(progress);
  const { matches, truncated } = pattern.searchFiles(files, compiledPattern, { maxMatches: MAX_MATCHES });
  matchIndex = new Map();
  const payload = [];
  for (const m of matches) {
    const id = `${m.path}#${m.startOffset}-${m.endOffset}`;
    matchIndex.set(id, {
      uri: uriByPath.get(m.path),
      startOffset: m.startOffset,
      endOffset: m.endOffset,
      text: m.text,
      captures: m.captures,
    });
    const captureTexts = {};
    for (const [name, cap] of Object.entries(m.captures)) captureTexts[name] = cap.text;
    payload.push({
      id,
      path: m.path,
      startLine: m.startLine,
      startChar: m.startChar,
      endLine: m.endLine,
      endChar: m.endChar,
      text: m.text,
      captures: captureTexts,
    });
  }
  return { matches: payload, truncated, filesScanned: files.length };
}

async function runSearch(patternSource, replacementTemplate) {
  if (!currentPanel) return;
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    currentPanel.webview.postMessage({ type: "error", message: "Open a folder/workspace to search." });
    return;
  }
  let compiled;
  try {
    compiled = pattern.compilePattern(patternSource);
    if (compiled.tokens.length === 0) {
      currentPanel.webview.postMessage({ type: "error", message: "Pattern is empty." });
      return;
    }
  } catch (err) {
    currentPanel.webview.postMessage({ type: "error", message: `Couldn't parse pattern: ${err.message || err}` });
    return;
  }
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "LakshX Structural Search: scanning workspace" },
      (progress) => scanWorkspace(compiled, progress),
    );
    // Compute a replacement preview per match now (server-side) so the
    // webview never has to re-implement placeholder substitution.
    const withPreview = result.matches.map((m) => {
      const idxEntry = matchIndex.get(m.id);
      const preview = replacementTemplate ? pattern.substitute(replacementTemplate, idxEntry.captures) : null;
      return { ...m, preview };
    });
    currentPanel.webview.postMessage({
      type: "results",
      matches: withPreview,
      truncated: result.truncated,
      filesScanned: result.filesScanned,
      placeholderNames: compiled.names,
    });
  } catch (err) {
    currentPanel.webview.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
  }
}

async function openMatch(id) {
  const entry = matchIndex.get(id);
  if (!entry || !entry.uri) return;
  const doc = await vscode.workspace.openTextDocument(entry.uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
  const startPos = doc.positionAt(entry.startOffset);
  const endPos = doc.positionAt(entry.endOffset);
  const range = new vscode.Range(startPos, endPos);
  editor.selection = new vscode.Selection(range.start, range.end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

/**
 * Apply a batch of selected matches via a single WorkspaceEdit, gated on an
 * explicit confirmation dialog (in addition to the webview's own "Apply"
 * click — belt-and-suspenders, never a silent write). Re-verifies each
 * match's original text against the file's CURRENT contents right before
 * building the edit, so a file edited since the scan doesn't get corrupted by
 * a stale offset — mismatches are skipped and reported, not force-applied.
 */
async function applySelected(ids, replacementTemplate) {
  if (!currentPanel) return;
  const selected = ids.map((id) => ({ id, entry: matchIndex.get(id) })).filter((x) => x.entry);
  if (selected.length === 0) {
    currentPanel.webview.postMessage({ type: "applyResult", applied: 0, skipped: 0, skippedReasons: [] });
    return;
  }

  const fileCount = new Set(selected.map((s) => s.entry.uri.toString())).size;
  const confirm = await vscode.window.showWarningMessage(
    `Apply ${selected.length} structural-search replacement${selected.length === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"}? This edits files on disk (undoable via VS Code's normal Undo).`,
    { modal: true },
    "Apply",
  );
  if (confirm !== "Apply") {
    currentPanel.webview.postMessage({ type: "applyResult", cancelled: true, applied: 0, skipped: 0, skippedReasons: [] });
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  let applied = 0;
  const skippedReasons = [];
  // Group by file and re-read each file's CURRENT text once.
  const byUri = new Map();
  for (const { id, entry } of selected) {
    if (!byUri.has(entry.uri.toString())) byUri.set(entry.uri.toString(), { uri: entry.uri, items: [] });
    byUri.get(entry.uri.toString()).items.push({ id, entry });
  }
  for (const { uri, items } of byUri.values()) {
    let doc;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      for (const { id } of items) skippedReasons.push({ id, reason: `couldn't open file: ${err.message || err}` });
      continue;
    }
    const currentText = doc.getText();
    for (const { id, entry } of items) {
      const currentSlice = currentText.slice(entry.startOffset, entry.endOffset);
      if (currentSlice !== entry.text) {
        skippedReasons.push({ id, reason: "file changed since scan — re-run search before applying" });
        continue;
      }
      const replacementText = pattern.substitute(replacementTemplate, entry.captures);
      const startPos = doc.positionAt(entry.startOffset);
      const endPos = doc.positionAt(entry.endOffset);
      edit.replace(uri, new vscode.Range(startPos, endPos), replacementText);
      applied++;
    }
  }

  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    currentPanel.webview.postMessage({ type: "applyResult", applied: 0, skipped: selected.length, skippedReasons: [{ id: null, reason: "workspace.applyEdit failed" }] });
    return;
  }
  currentPanel.webview.postMessage({ type: "applyResult", applied, skipped: skippedReasons.length, skippedReasons });
  vscode.window.showInformationMessage(
    `LakshX Structural Search: applied ${applied} replacement${applied === 1 ? "" : "s"}` +
      (skippedReasons.length ? `, skipped ${skippedReasons.length} (stale — re-run search).` : "."),
  );
}

async function onWebviewMessage(context, m) {
  if (!currentPanel) return;
  try {
    switch (m.type) {
      case "search":
        await runSearch(m.pattern, m.replacement);
        break;
      case "openMatch":
        await openMatch(m.id);
        break;
      case "apply":
        await applySelected(m.ids, m.replacement);
        break;
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
  const css = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "search.css")) + "?v=" + stamp("search.css");
  const js = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "search.js")) + "?v=" + stamp("search.js");
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; font-src ${webview.cspSource};">
<link rel="stylesheet" href="${css}">
</head><body>
<div id="app">
  <div id="toolbar">
    <div id="fields">
      <label>Pattern <input id="pattern" type="text" spellcheck="false" placeholder="e.g.  $FN($$ARGS)   or   $OBJ.$METHOD($$ARGS)" /></label>
      <label>Replace with <input id="replacement" type="text" spellcheck="false" placeholder="e.g.  await $FN($ARGS)" /></label>
    </div>
    <div id="actions">
      <button id="searchBtn">Search</button>
      <button id="selectAllBtn" class="ghost">Select all</button>
      <button id="selectNoneBtn" class="ghost">Select none</button>
      <button id="applyBtn" disabled>Apply selected (<span id="selCount">0</span>)</button>
    </div>
  </div>
  <div id="hint">
    Token-level structural search &mdash; matches code <em>shape</em>, not literal text.
    <code>$NAME</code> = one expression/argument. <code>$$NAME</code> = zero-or-more
    comma-separated arguments (any count). Same name used twice must capture the
    same text both times. See README.md for the full syntax and known limitations.
  </div>
  <div id="status"></div>
  <div id="results"></div>
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
    "lakshxStructuralSearch",
    "LakshX Structural Search",
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    },
  );
  currentPanel.onDidDispose(() => {
    currentPanel = null;
    matchIndex = new Map();
  });
  currentPanel.webview.html = panelHtml(context, currentPanel.webview);
  currentPanel.webview.onDidReceiveMessage((m) => onWebviewMessage(context, m));
  return currentPanel;
}

function showPanel(context) {
  ensurePanel(context);
}

// ---------------------------------------------------------------------------
// SAST-lite rule scan (roadmap doc 16 "Security angle") — same bounded
// workspace file collection as the search/replace panel above
// (collectWorkspaceFiles), fed into the curated shape-matching rules in
// lib/rules.js, surfaced through the standard Problems panel via a
// vscode.languages.createDiagnosticCollection — the exact wiring style
// product/lakshx-graph/extension.js already uses for its OSV vulnerability
// diagnostics (new vscode.Diagnostic(range, message, severity),
// diag.source = "LakshX", diag.code = <rule id>, collection.set(uri, diags)),
// not a new diagnostics style invented for this extension.
//
// HONESTY (same framing as lib/rules.js and README.md): this is shape-
// matching over a static snapshot of the workspace, not taint/dataflow
// analysis, and every rule documents its own "what this WON'T catch" —
// see lib/rules.js. No code is ever executed by this scan.
// ---------------------------------------------------------------------------

let sastDiagnostics = null;
let sastOutputChannel = null;

function sastSeverityToDiagnosticSeverity(sev) {
  return sev === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
}

/** Run every curated SAST-lite rule across the bounded workspace scan and
 * populate the Problems panel. Returns the total hit count. */
async function scanWorkspaceForVulnerabilities(progress) {
  const { files, uriByPath } = await collectWorkspaceFiles(progress);
  const hits = rules.scanFiles(files);

  // Group by file so each file gets exactly one diagnostics.set() call.
  const byPath = new Map();
  for (const hit of hits) {
    if (!byPath.has(hit.path)) byPath.set(hit.path, []);
    byPath.get(hit.path).push(hit);
  }

  sastDiagnostics.clear();
  for (const [relPath, fileHits] of byPath) {
    const uri = uriByPath.get(relPath);
    if (!uri) continue; // shouldn't happen — every hit came from a file we just read
    const diags = fileHits.map((hit) => {
      const range = new vscode.Range(hit.startLine, hit.startChar, hit.endLine, hit.endChar);
      const diag = new vscode.Diagnostic(range, `LakshX SAST-lite: ${hit.title}`, sastSeverityToDiagnosticSeverity(hit.severity));
      diag.source = "LakshX";
      diag.code = hit.ruleId;
      return diag;
    });
    sastDiagnostics.set(uri, diags);
  }
  return hits.length;
}

async function runSastScanCommand() {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showWarningMessage("LakshX: open a folder/workspace to run the SAST-lite scan.");
    return;
  }
  try {
    const total = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "LakshX SAST-lite: scanning workspace", cancellable: false },
      (progress) => scanWorkspaceForVulnerabilities(progress),
    );
    vscode.window.showInformationMessage(
      total === 0
        ? "LakshX SAST-lite: no hits from the curated rule pack — see Problems panel is unchanged. Shape-matching only, not proof of safety (see README)."
        : `LakshX SAST-lite: ${total} hit${total === 1 ? "" : "s"} across the curated rule pack — see Problems panel. Shape-matching, not taint analysis — review each hit; see README/rules.js for what each rule won't catch.`,
    );
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    sastOutputChannel.appendLine(`SAST-lite scan failed: ${msg}`);
    vscode.window.showErrorMessage(`LakshX SAST-lite scan failed: ${msg}`);
  }
}

function activate(context) {
  // Status bar entry point, same right-aligned cluster/numbering convention
  // as the other native LakshX panels (see lakshx-graph/extension.js's
  // activate() comment for the full priority list: chat=1000, remote=999,
  // db=998, call graph=997, dep graph=996). Structural search takes 995.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 995);
  statusItem.text = "$(regex) Structural Search";
  statusItem.tooltip = "LakshX: Structural Search & Replace (find/replace by code shape, not literal text)";
  statusItem.command = "lakshx.structuralSearch.show";
  statusItem.show();

  sastOutputChannel = vscode.window.createOutputChannel("LakshX SAST-lite");
  sastDiagnostics = vscode.languages.createDiagnosticCollection("lakshxSast");

  context.subscriptions.push(
    vscode.commands.registerCommand("lakshx.structuralSearch.show", () => showPanel(context)),
    vscode.commands.registerCommand("lakshx.structuralSearch.scanWorkspace", () => runSastScanCommand()),
    statusItem,
    sastDiagnostics,
    sastOutputChannel,
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
