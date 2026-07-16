// LakshX Tab — Cursor/Zed-style "next-edit prediction". After an edit, this
// predicts the developer's NEXT likely edit (not just the next few tokens)
// and shows it as ghost text via VS Code's own inline-completion UI —
// accept with Tab, dismiss with Esc, exactly like the built-in suggestion
// widget already does. We don't reimplement any of that accept/dismiss UX;
// we just implement `InlineCompletionItemProvider` and let VS Code drive it.
//
// FULLY STANDALONE: this extension makes its own direct HTTPS calls (see
// lib/predict.js) to whatever provider is configured in the SAME
// `~/.lakshx/providers.json` the main LakshX agent reads (lib/providers.js).
// It does not import, spawn, or route through agent/src or lakshx-chat in
// any way — see README.md for the full rationale.
"use strict";

const vscode = require("vscode");
const providers = require("./lib/providers.js");
const history = require("./lib/history.js");
const predict = require("./lib/predict.js");

const CONFIG_SECTION = "lakshxTab";
const NOTICE_SHOWN_KEY = "lakshxTab.noProviderNoticeShown";

// ---- per-document rolling edit history (bounded; see lib/history.js) ------
/** @type {Map<string, Array<object>>} document URI string -> bounded edit buffer */
const editHistories = new Map();

function getConfig() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: cfg.get("enabled", true),
    debounceMs: cfg.get("debounceMs", 350),
    requestTimeoutMs: cfg.get("requestTimeoutMs", 2500),
  };
}

/** Resolve rounds of vscode's own IndentationRule-free content change into
 * the plain {line, removedChars, insertedText} shape lib/history.js wants. */
function toHistoryChange(change) {
  return {
    line: change.range.start.line,
    removedChars: change.rangeLength,
    insertedText: change.text,
  };
}

function recordDocumentChange(doc, change) {
  const key = doc.uri.toString();
  const prev = editHistories.get(key) || [];
  editHistories.set(key, history.pushEdit(prev, toHistoryChange(change)));
}

/** A small `setTimeout` that resolves early (rejecting) if `token` is
 * cancelled first — this IS the debounce: VS Code cancels a provider
 * invocation's token as soon as a newer one supersedes it (next keystroke,
 * cursor move, etc), so a stale in-flight prediction never lands. This is
 * the same pattern editor-integration extensions commonly use to debounce
 * `provideInlineCompletionItems` without any manual timer bookkeeping. */
function debounceOrThrow(ms, token) {
  return new Promise((resolve, reject) => {
    let sub;
    const timer = setTimeout(() => {
      if (sub) sub.dispose();
      resolve();
    }, ms);
    sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      sub.dispose();
      reject(new vscode.CancellationError());
    });
  });
}

/** One-time "configure a provider first" notice — shown at most once per
 * install (persisted in globalState), never repeated per keystroke/file. */
async function showNoProviderNoticeOnce(context) {
  if (context.globalState.get(NOTICE_SHOWN_KEY)) return;
  await context.globalState.update(NOTICE_SHOWN_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    "LakshX Tab needs a configured model provider before it can predict edits. " +
      "Add one to ~/.lakshx/providers.json (same file the LakshX agent uses).",
    "Open providers.json",
  );
  if (choice === "Open providers.json") {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(require("node:os").homedir()), ".lakshx", "providers.json");
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } catch {
      vscode.window.showWarningMessage("~/.lakshx/providers.json doesn't exist yet — create it to configure a provider.");
    }
  }
}

class TabPredictionProvider {
  constructor(context, statusItem) {
    this.context = context;
    this.statusItem = statusItem;
  }

  async provideInlineCompletionItems(document, position, _context, token) {
    const cfg = getConfig();
    if (!cfg.enabled) return null;

    // Cheap, synchronous gate BEFORE any debounce/network: no provider
    // configured -> show the one-time notice and bail, every time, with no
    // repeated errors and no wasted timer.
    const fileCfg = providers.loadProvidersFileFromDisk();
    const active = providers.resolveActiveModel(fileCfg, process.env);
    if (!active) {
      showNoProviderNoticeOnce(this.context);
      return null;
    }

    // Debounce: wait out a short idle period; if the token gets cancelled
    // (developer kept typing / moved on) we bail before ever calling the
    // model. This is what keeps this from firing a request per keystroke.
    try {
      await debounceOrThrow(cfg.debounceMs, token);
    } catch {
      return null;
    }
    if (token.isCancellationRequested) return null;

    const prefix = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
    const lastLine = document.lineCount - 1;
    const docEnd = document.lineAt(lastLine).range.end;
    const suffix = document.getText(new vscode.Range(position, docEnd));

    const buffer = editHistories.get(document.uri.toString()) || [];
    const historyText = history.summarizeEdits(buffer);

    const { system, user } = predict.buildPrompt({
      prefix,
      suffix,
      historyText,
      languageId: document.languageId,
    });

    const abortController = new AbortController();
    const sub = token.onCancellationRequested(() => abortController.abort());
    let text;
    try {
      text = await predict.callProvider({
        kind: active.kind,
        baseUrl: active.baseUrl,
        apiKey: active.apiKey,
        headers: active.headers,
        model: active.model,
        system,
        user,
        timeoutMs: cfg.requestTimeoutMs,
        signal: abortController.signal,
      });
    } finally {
      sub.dispose();
    }

    if (!text || token.isCancellationRequested) return null;

    const item = new vscode.InlineCompletionItem(text, new vscode.Range(position, position));
    return [item];
  }
}

function updateStatusItem(statusItem) {
  const { enabled } = getConfig();
  statusItem.text = enabled ? "$(sparkle) Tab" : "$(circle-slash) Tab";
  statusItem.tooltip = enabled
    ? "LakshX Tab: next-edit prediction is ON (click to turn off)"
    : "LakshX Tab: next-edit prediction is OFF (click to turn on)";
}

async function toggleEnabled() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const current = cfg.get("enabled", true);
  await cfg.update("enabled", !current, vscode.ConfigurationTarget.Global);
}

function activate(context) {
  // Status bar entry point + on/off toggle. Priority 995 — same right-
  // aligned cluster as the other LakshX product status items (chat 1000,
  // remote 999, db 998, call graph 997, dep graph/commentary 996); see
  // lakshx-graph/extension.js's activate() for the same numbering note.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 995);
  statusItem.command = "lakshx.tab.toggle";
  updateStatusItem(statusItem);
  statusItem.show();

  const provider = new TabPredictionProvider(context, statusItem);

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand("lakshx.tab.toggle", async () => {
      await toggleEnabled();
      updateStatusItem(statusItem);
    }),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: "**" }, provider),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      for (const change of e.contentChanges) {
        recordDocumentChange(e.document, change);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      editHistories.delete(doc.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) updateStatusItem(statusItem);
    }),
  );
}

function deactivate() {
  editHistories.clear();
}

module.exports = { activate, deactivate };
