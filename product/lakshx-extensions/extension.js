// LakshX Extensions — the "Recommended & Verified" panel.
//
// WHY THIS EXISTS: LakshX's extensionsGallery points at open-vsx.org, not
// the Microsoft Marketplace (see product/product.overrides.json's
// extensionsGallery.serviceUrl and docs/architecture.md). Recommending an
// extension id that was only ever published to the Microsoft Marketplace is
// a real supply-chain risk for a fork wired to Open VSX: an attacker can
// register that exact same `publisher.name` on Open VSX with malicious code,
// and this fork's own recommendation UI would nudge users straight into
// installing it. See docs/research/15-ide-feature-roadmap.md item #10.
//
// This extension does two things:
//   1. Ships a small, hand-curated, hand-reasoned list (lib/curated.js) of
//      extensions LakshX is willing to vouch for.
//   2. Actually queries the live Open VSX registry (lib/verify.js) to
//      confirm each one resolves there — the list is not "verified" just
//      because someone typed verifiedOn: "both" into a data file.
//
// Explicitly NOT done here (deliberate fast-follow, see README.md): this
// extension does not touch product/product.overrides.json's
// extensionRecommendations. That file is being actively edited by another
// in-flight change (the custom welcome screen); reconciling its
// recommendations against this panel's curated+verified list is future work.
"use strict";

const vscode = require("vscode");
const curated = require("./lib/curated.js");
const verify = require("./lib/verify.js");

const VERIFY_CACHE_KEY = "lakshx.extensions.lastVerifyResults";

let currentPanel = null;
/** @type {Map<string, object>} id -> latest verify.checkExtension() result for this session */
let verifyResultsById = new Map();
let verifyInFlight = null;

function log(context, message) {
  if (!context.__lakshxExtensionsLog) {
    context.__lakshxExtensionsLog = vscode.window.createOutputChannel("LakshX Extensions");
  }
  context.__lakshxExtensionsLog.appendLine(message);
}

/** Kick off (or reuse an in-flight) live verification of the whole curated list. */
async function runVerification(context) {
  if (verifyInFlight) return verifyInFlight;
  verifyInFlight = (async () => {
    log(context, `Checking ${curated.CURATED_EXTENSIONS.length} curated extensions against ${verify.OPEN_VSX_HOST}…`);
    const results = await verify.checkAll(curated.CURATED_EXTENSIONS);
    verifyResultsById = new Map(results.map((r) => [r.id, r]));
    const stamp = { at: Date.now(), results };
    await context.globalState.update(VERIFY_CACHE_KEY, stamp);
    const passed = results.filter((r) => r.found === true).length;
    const failed = results.filter((r) => r.found === false).length;
    const errored = results.filter((r) => r.found === null).length;
    log(context, `Open VSX check complete: ${passed} resolved, ${failed} confirmed absent, ${errored} could not be checked.`);
    return results;
  })();
  try {
    return await verifyInFlight;
  } finally {
    verifyInFlight = null;
  }
}

/** Load the last cached verify results (from a previous session) before any fresh check completes. */
function loadCachedVerification(context) {
  const stamp = context.globalState.get(VERIFY_CACHE_KEY);
  if (stamp && Array.isArray(stamp.results)) {
    verifyResultsById = new Map(stamp.results.map((r) => [r.id, r]));
    return stamp.at;
  }
  return null;
}

/** Combine curated data + latest verify result into what the webview renders. */
function buildPanelModel() {
  const groups = curated.groupByCategory(curated.CURATED_EXTENSIONS);
  const categories = [];
  for (const [category, entries] of groups) {
    categories.push({
      category,
      extensions: entries.map((entry) => {
        const live = verifyResultsById.get(entry.id);
        let trust;
        if (!live) trust = { status: "unchecked", label: "Not yet checked this session" };
        else if (live.found === true) trust = { status: "pass", label: `Verified on Open VSX${live.version ? ` (v${live.version})` : ""}` };
        else if (live.found === false) trust = { status: "fail", label: "NOT found on Open VSX — do not install" };
        else trust = { status: "unknown", label: `Could not check: ${live.reason || "unknown error"}` };
        return { ...entry, trust };
      }),
    });
  }
  return categories;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function panelHtml(context, webview) {
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "panel.css"));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "panel.js"));
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource}; img-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${cssUri}">
</head><body>
<div id="app">
  <div id="toolbar">
    <span id="title">Recommended &amp; Verified Extensions</span>
    <div class="spacer"></div>
    <button id="recheck" class="ghost" title="Re-query Open VSX for every entry below">Re-check Open VSX</button>
  </div>
  <p id="blurb">
    Every extension below was hand-picked by LakshX maintainers, then checked against
    <a href="https://open-vsx.org" target="_blank" rel="noopener">Open VSX</a> — the registry this IDE's
    Extensions view actually installs from. A green badge means we just confirmed the id resolves there;
    it does NOT mean we've audited the extension's code.
  </p>
  <div id="list"></div>
</div>
<script src="${jsUri}"></script>
</body></html>`;
}

function postModel(context) {
  if (!currentPanel) return;
  currentPanel.webview.postMessage({ type: "model", categories: buildPanelModel() });
}

async function showCuratedPanel(context) {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Beside, true);
    postModel(context);
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    "lakshxExtensionsCurated",
    "LakshX: Recommended & Verified",
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
  currentPanel.webview.onDidReceiveMessage(async (message) => {
    if (message.type === "install") {
      try {
        await vscode.commands.executeCommand("workbench.extensions.installExtension", message.id);
        vscode.window.showInformationMessage(`LakshX Extensions: installing ${message.id}…`);
      } catch (err) {
        vscode.window.showErrorMessage(`LakshX Extensions: could not install ${message.id}: ${err.message || err}`);
      }
    } else if (message.type === "recheck") {
      await runVerification(context);
      postModel(context);
    } else if (message.type === "ready") {
      postModel(context);
    }
  });

  // Show whatever we know immediately (cache or "unchecked"), then kick off
  // a fresh live check in the background and push updated badges when done.
  postModel(context);
  runVerification(context).then(() => postModel(context));
}

function activate(context) {
  loadCachedVerification(context);

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 997);
  statusItem.text = "$(shield) Extensions";
  statusItem.tooltip = "Open LakshX's Recommended & Verified extensions panel (checked against Open VSX)";
  statusItem.command = "lakshx.extensions.showCurated";
  statusItem.show();

  context.subscriptions.push(
    vscode.commands.registerCommand("lakshx.extensions.showCurated", () => showCuratedPanel(context)),
    statusItem,
  );

  // Kick off a background verification early (best-effort; a fresh check
  // also runs whenever the panel is opened, so this just warms the cache).
  runVerification(context).catch((err) => log(context, `Background Open VSX check failed: ${err.message || err}`));
}

function deactivate() {}

module.exports = { activate, deactivate };
