// LakshX Command Bar — a JetBrains "Search Everywhere"-style universal entry
// point: one search box merging workspace file search, workspace symbol
// search, and command-palette actions into a single ranked, sectioned list.
//
// v1 SCOPE: pure search/palette merge only. Natural-language dispatch to the
// LakshX agent ("ask it to fix X") is explicitly deferred to a v2, once
// lakshx-chat's current work lands — see README.md.
//
// All ranking/merging/debounce/staleness logic lives in lib/omnibox.js as
// plain functions with no `vscode` dependency, so it's unit-testable with
// `node --test` (see test/omnibox.test.js). This file is the thin vscode
// wiring on top: gathering candidates from the three sources, driving a
// `vscode.window.createQuickPick()`, and performing the selected action.
"use strict";

const vscode = require("vscode");
const path = require("path");
const {
  matchQuery,
  buildFileGlob,
  buildQuickPickItems,
  createGeneration,
  createDebounced,
} = require("./lib/omnibox.js");

const PER_SOURCE_CAP = 8;
const FILE_SEARCH_MAX_RESULTS = 50; // over-fetch, then fuzzy-rank down to PER_SOURCE_CAP
const FILE_EXCLUDE = "**/{node_modules,.git,dist,build,out,.next,.venv,venv,__pycache__,coverage,vendor}/**";
const DEBOUNCE_MS = 120;

// ---------------------------------------------------------------------------
// Command title lookup — see README's "Known gaps" for the full story.
// ---------------------------------------------------------------------------
// `vscode.commands.getCommands(true)` only returns command IDs (e.g.
// "workbench.action.files.save"), not the human-readable titles the built-in
// Command Palette shows ("File: Save"). There is no public API that returns
// title strings for EVERY registered command — the palette's own title
// metadata comes from MenuRegistry/registerAction2 calls internal to
// vscode-core, not the extension API surface.
//
// What IS reachable: every extension's package.json `contributes.commands`
// entries carry {command, title, category} for commands THAT extension
// contributes, via `vscode.extensions.all[].packageJSON`. Since most
// user-facing commands (git, markdown, npm, debug, and all third-party
// extensions) are contributed this way, this covers a large majority of
// commands someone would actually search for by name. It does NOT cover core
// workbench commands registered purely in TypeScript with no package.json
// entry — for those we fall back to displaying the raw command id (clearly
// distinguishable in the description column) rather than pretending we have
// a title for it.
function buildCommandTitleIndex() {
  const index = new Map(); // id -> { title, category }
  for (const ext of vscode.extensions.all) {
    const contributed = ext.packageJSON && ext.packageJSON.contributes && ext.packageJSON.contributes.commands;
    if (!Array.isArray(contributed)) continue;
    for (const c of contributed) {
      if (!c || !c.command) continue;
      const title = typeof c.title === "string" ? c.title : c.title && c.title.value;
      if (!title) continue;
      const category = typeof c.category === "string" ? c.category : c.category && c.category.value;
      index.set(c.command, { title, category });
    }
  }
  return index;
}

// vscode.SymbolKind -> codicon suffix, best-effort (cosmetic only).
const SYMBOL_KIND_ICON = {
  [vscode.SymbolKind.File]: "file",
  [vscode.SymbolKind.Module]: "namespace",
  [vscode.SymbolKind.Namespace]: "namespace",
  [vscode.SymbolKind.Package]: "package",
  [vscode.SymbolKind.Class]: "class",
  [vscode.SymbolKind.Method]: "method",
  [vscode.SymbolKind.Property]: "property",
  [vscode.SymbolKind.Field]: "field",
  [vscode.SymbolKind.Constructor]: "misc",
  [vscode.SymbolKind.Enum]: "enum",
  [vscode.SymbolKind.Interface]: "interface",
  [vscode.SymbolKind.Function]: "method",
  [vscode.SymbolKind.Variable]: "variable",
  [vscode.SymbolKind.Constant]: "constant",
  [vscode.SymbolKind.String]: "string",
  [vscode.SymbolKind.Struct]: "structure",
};
function symbolKindIcon(kind) {
  return SYMBOL_KIND_ICON[kind] || "misc";
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** (a) Workspace file search — a real, clean public API. */
async function searchFiles(query, token) {
  const glob = buildFileGlob(query);
  let uris;
  try {
    uris = await vscode.workspace.findFiles(glob, FILE_EXCLUDE, FILE_SEARCH_MAX_RESULTS, token);
  } catch {
    return []; // cancelled or no workspace open -- not fatal
  }
  const items = [];
  for (const uri of uris) {
    const rel = vscode.workspace.asRelativePath(uri, false);
    const base = path.basename(rel);
    const score = matchQuery(query, [base, rel]);
    if (score < 0) continue;
    items.push({
      label: `$(file) ${base}`,
      description: rel,
      score,
      action: { type: "openFile", uri: uri.toString() },
    });
  }
  return items;
}

/** (d) Workspace symbol search — a real, clean public API (when a provider is registered). */
async function searchSymbols(query) {
  let symbols;
  try {
    symbols = await vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", query);
  } catch {
    symbols = [];
  }
  if (!Array.isArray(symbols)) return [];
  const items = [];
  for (const sym of symbols) {
    if (!sym || !sym.location || !sym.location.uri) continue;
    const name = sym.name || "";
    const containerName = sym.containerName || "";
    const score = matchQuery(query, [name, containerName]);
    if (score < 0) continue;
    const rel = vscode.workspace.asRelativePath(sym.location.uri, false);
    const range = sym.location.range;
    items.push({
      label: `$(symbol-${symbolKindIcon(sym.kind)}) ${name}`,
      description: containerName ? `${containerName} — ${rel}` : rel,
      score,
      action: {
        type: "openSymbol",
        uri: sym.location.uri.toString(),
        line: range ? range.start.line : 0,
        character: range ? range.start.character : 0,
      },
    });
  }
  return items;
}

/**
 * (b) Command list, id-matched and (best-effort) title-matched — see the
 * gap documented above buildCommandTitleIndex(). `getCommands(true)` filters
 * out internal (`_`-prefixed) commands.
 */
async function searchCommands(query, titleIndex) {
  let ids;
  try {
    ids = await vscode.commands.getCommands(true);
  } catch {
    return [];
  }
  const items = [];
  for (const id of ids) {
    const meta = titleIndex.get(id);
    const title = meta && meta.title;
    const fields = title ? [title, id] : [id];
    const score = matchQuery(query, fields);
    if (score < 0) continue;
    items.push({
      label: title ? `$(run) ${title}` : `$(run) ${id}`,
      description: title ? id : "(no contributed title — showing raw command id)",
      score,
      action: { type: "runCommand", id },
    });
  }
  return items;
}

// (c) Settings search: deliberately NOT implemented. VS Code does not expose
// a public API to search or list the settings schema + descriptions the way
// the built-in Settings editor does (no `vscode.executeSettingsSearch` or
// equivalent). Faking it with a hand-maintained list of common settings
// would misrepresent coverage, so this is documented as a known gap in
// README.md instead of shipped as a fake fourth section.

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

async function performAction(action) {
  try {
    if (action.type === "runCommand") {
      await vscode.commands.executeCommand(action.id);
    } else if (action.type === "openFile") {
      const uri = vscode.Uri.parse(action.uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    } else if (action.type === "openSymbol") {
      const uri = vscode.Uri.parse(action.uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      const pos = new vscode.Position(action.line, action.character);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  } catch (err) {
    vscode.window.showWarningMessage(`LakshX Command Bar: couldn't complete that action (${err && err.message ? err.message : err}).`);
  }
}

// ---------------------------------------------------------------------------
// Quick pick session
// ---------------------------------------------------------------------------

function openCommandBar() {
  const qp = vscode.window.createQuickPick();
  qp.placeholder = "Search files, symbols, and commands…";
  qp.matchOnDescription = false; // we run our own fuzzy scoring across sources; let it own the filtering
  qp.matchOnDetail = false;

  const titleIndex = buildCommandTitleIndex(); // built once per session; see gap note above
  const generation = createGeneration(); // guards against a slow older query clobbering a newer one
  let fileSearchCts = null;

  async function runSearch(query) {
    const token = generation.next();
    if (fileSearchCts) fileSearchCts.cancel();
    fileSearchCts = new vscode.CancellationTokenSource();
    const myToken = fileSearchCts.token;

    const trimmed = query.trim();
    if (trimmed.length === 0) {
      qp.busy = false;
      qp.items = [];
      return;
    }

    qp.busy = true;
    let files = [];
    let symbols = [];
    let commands = [];
    try {
      [files, symbols, commands] = await Promise.all([
        searchFiles(trimmed, myToken).catch(() => []),
        searchSymbols(trimmed).catch(() => []),
        searchCommands(trimmed, titleIndex).catch(() => []),
      ]);
    } finally {
      qp.busy = false;
    }

    // A newer keystroke may have started (and possibly already finished)
    // while we were awaiting these three sources -- drop stale results
    // instead of racing them onto the screen out of order.
    if (!generation.isCurrent(token)) return;

    const sections = [
      { key: "files", title: "Files", items: files },
      { key: "symbols", title: "Symbols", items: symbols },
      { key: "commands", title: "Commands", items: commands },
    ];
    const flat = buildQuickPickItems(sections, PER_SOURCE_CAP);

    qp.items = flat.map((entry) =>
      entry.kind === "separator"
        ? { label: entry.label, kind: vscode.QuickPickItemKind.Separator }
        : { label: entry.label, description: entry.description, alwaysShow: true, _action: entry.action },
    );
  }

  const debouncedSearch = createDebounced((value) => {
    runSearch(value).catch((err) => {
      vscode.window.showWarningMessage(`LakshX Command Bar: search failed (${err && err.message ? err.message : err}).`);
    });
  }, DEBOUNCE_MS);

  qp.onDidChangeValue((value) => debouncedSearch(value));

  qp.onDidAccept(() => {
    const picked = qp.selectedItems[0];
    qp.hide();
    if (picked && picked._action) {
      performAction(picked._action);
    }
  });

  qp.onDidHide(() => {
    debouncedSearch.cancel();
    if (fileSearchCts) fileSearchCts.cancel();
    qp.dispose();
  });

  qp.show();
}

function activate(context) {
  // Status bar entry point, always visible from startup (onStartupFinished
  // activation) -- see commit 745c1a4 for why this matters: a status bar
  // item only ever created inside activate() is unreachable if activation
  // itself is gated behind the very command that item exists to expose.
  // Priority 995: right after lakshx-graph's Dep Graph (996) in the same
  // right-aligned cluster as lakshx-chat's "✦ LakshX" (1000), "Remote:..."
  // (999), lakshx-db's "$(database) DB" (998), and Call Graph (997).
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 995);
  statusItem.text = "$(search) Command Bar";
  statusItem.tooltip = "LakshX: Open Command Bar (Ctrl/Cmd+K G) — unified file / symbol / command search";
  statusItem.command = "lakshx.commandbar.open";
  statusItem.show();

  context.subscriptions.push(vscode.commands.registerCommand("lakshx.commandbar.open", openCommandBar), statusItem);
}

function deactivate() {}

module.exports = { activate, deactivate };
