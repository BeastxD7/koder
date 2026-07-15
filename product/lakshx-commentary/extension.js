// LakshX Commentary — a cheeky cricket-commentary-style companion that
// reacts to what you (and the agent) do in the IDE, spoken aloud via free
// OS-native text-to-speech. Zero LLM calls by default (Tier 1); an optional,
// hard-rate-limited Tier 2 can ask the already-configured provider for a
// one-off custom quip on genuinely rare moments — off unless the user opts
// in. See lib/lines.js, lib/agent-signal.js, lib/tts.js, lib/tier2.js for
// the pieces; this file is glue: vscode event wiring + delivery + settings.
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CATEGORIES, pickLine } = require("./lib/lines.js");
const { isToolFailure, findTurnSlice, classifyTurn, decideTurnCategory } = require("./lib/agent-signal.js");
const { speak } = require("./lib/tts.js");
const tier2 = require("./lib/tier2.js");

// ---------- tunables ----------
const CHATS_DIR = path.join(os.homedir(), ".lakshx", "chats");
const CHATS_POLL_MS = 5000; // cheap (readdir + stat), not an API call — see docs/tuning note in agent-signal.js's header
const IDLE_THRESHOLD_MS = 40 * 60 * 1000; // 40 min quiet, then activity -> "welcome back"
const LATE_NIGHT_HOURS = [1, 2, 3, 4]; // 1am-4am local
const LATE_NIGHT_COOLDOWN_MS = 3 * 60 * 60 * 1000; // don't re-fire on every save past 1am
const BUILD_FAIL_STREAK = 2; // consecutive non-zero exits in one terminal before we react
const UNDO_BURST_WINDOW_MS = 15_000;
const UNDO_BURST_THRESHOLD = 5;
const TIER2_CATEGORIES = new Set(["bigWin", "slickChange", "agentTrouble"]); // only "special" moments are worth a real API call

function cfg() {
  return vscode.workspace.getConfiguration("lakshx.commentary");
}

// ---------- delivery: mute / voice / rate-cap, then a Tier-2 attempt, then the canned line ----------
function makeDeliver(context, log) {
  const runtime = {
    lineHistory: new Map(), // category -> recently-shown indices, for lines.js's no-immediate-repeat rule
    lastShownTs: 0,
    ttsNoticeShown: false,
  };

  async function maybeTier2(category, meta) {
    if (!TIER2_CATEGORIES.has(category)) return null;
    const c = cfg();
    if (!c.get("tier2.enabled", false)) return null;
    const dailyLimit = Math.max(0, c.get("tier2.dailyLimit", 1));
    if (dailyLimit === 0) return null;
    const today = new Date().toISOString().slice(0, 10);
    const usage = context.globalState.get("lakshx.commentary.tier2.usage", { date: today, count: 0 });
    const count = usage.date === today ? usage.count : 0;
    if (count >= dailyLimit) return null;
    try {
      const quip = await tier2.generateQuip(category, meta, { timeoutMs: 8000 });
      // only the daily budget for a SUCCESSFUL call is spent — a failed
      // attempt (bad key, timeout, provider down) must not eat into it
      await context.globalState.update("lakshx.commentary.tier2.usage", { date: today, count: count + 1 });
      return quip;
    } catch (err) {
      log.appendLine(`Tier 2 quip generation skipped (falling back to Tier 1): ${err.message || err}`);
      return null;
    }
  }

  return function deliver(category, meta = {}, { bypassRateCap = false } = {}) {
    const c = cfg();
    if (!c.get("enabled", true)) return;
    const now = Date.now();
    const minGapMs = Math.max(0, c.get("minIntervalMinutes", 4)) * 60 * 1000;
    if (!bypassRateCap && now - runtime.lastShownTs < minGapMs) return; // dropped, never queued — a burst of triggers still yields at most one line
    runtime.lastShownTs = now;

    maybeTier2(category, meta)
      .catch(() => null)
      .then((tier2Text) => {
        const text = tier2Text ?? pickLine(category, { historyState: runtime.lineHistory, meta });
        if (!text) return;
        vscode.window.showInformationMessage(`🏏 ${text}`);
        if (c.get("voice", true)) {
          speak(text, {
            onUnavailable: () => {
              if (runtime.ttsNoticeShown) return;
              runtime.ttsNoticeShown = true;
              vscode.window.showInformationMessage(
                "LakshX Commentary: no text-to-speech engine found on this system — showing text only from now on.",
              );
            },
          });
        }
      });
  };
}

// ---------- idle-then-active ----------
function makeActivityTracker(deliver) {
  let lastActivityTs = Date.now(); // seeded at activation so the very first save doesn't read as "welcome back"
  return function noteActivity() {
    const now = Date.now();
    if (now - lastActivityTs >= IDLE_THRESHOLD_MS) deliver("welcomeBack", {});
    lastActivityTs = now;
  };
}

// ---------- late-night ----------
function makeLateNightCheck(deliver) {
  let lastFiredTs = 0;
  return function checkLateNight() {
    const now = new Date();
    if (!LATE_NIGHT_HOURS.includes(now.getHours())) return;
    if (Date.now() - lastFiredTs < LATE_NIGHT_COOLDOWN_MS) return;
    lastFiredTs = Date.now();
    deliver("lateNight", {});
  };
}

// ---------- rapid undo/redo ----------
function makeUndoRedoTracker(deliver) {
  let hits = [];
  return function noteUndoRedo() {
    const now = Date.now();
    hits.push(now);
    hits = hits.filter((t) => now - t <= UNDO_BURST_WINDOW_MS);
    if (hits.length >= UNDO_BURST_THRESHOLD) {
      hits = []; // reset so the NEXT burst has to build up fresh, not re-fire every keystroke
      deliver("frustrationBurst", {});
    }
  };
}

// ---------- terminal build/test failure streaks ----------
function makeTerminalTracker(deliver, noteActivity) {
  const streaks = new WeakMap(); // Terminal -> consecutive-non-zero-exit count
  return {
    onStart(terminal) {
      noteActivity();
    },
    onEnd(terminal, exitCode) {
      noteActivity();
      if (typeof exitCode !== "number") return; // ambiguous per API docs (ctrl+c, sub-shell, etc.) — not a signal we trust
      const prev = streaks.get(terminal) ?? 0;
      if (exitCode !== 0) {
        const next = prev + 1;
        streaks.set(terminal, next);
        if (next >= BUILD_FAIL_STREAK) deliver("buildFail", { count: next });
      } else {
        if (prev >= BUILD_FAIL_STREAK) deliver("bigWin", {});
        streaks.set(terminal, 0);
      }
    },
  };
}

// ---------- own-agent activity: read-only tail of ~/.lakshx/chats/*.json ----------
// Deliberately decoupled from product/lakshx-chat: no shared module, no
// exported extension API, just this extension periodically re-reading a
// file the other extension already writes for its own "resume chat"
// feature. See lib/agent-signal.js's header comment for the full rationale
// and the defensive-parsing contract this relies on.
function makeChatWatcher(deliver, noteActivity, log) {
  const chatMtimes = new Map(); // filename -> mtimeMs last seen
  const processedCount = new Map(); // filename -> number of events already handled
  const failureCounts = new Map(); // filename -> recent tool-failure count (for Tier 2's "how bad was it" context only)

  function processFile(filename, events) {
    const already = processedCount.get(filename);
    if (already === undefined) {
      // first time seeing this chat file: seed only, never replay pre-existing
      // history as "new" triggers on extension (re)start.
      processedCount.set(filename, events.length);
      return;
    }
    if (events.length <= already) {
      processedCount.set(filename, events.length); // e.g. file was truncated/rewritten shorter — resync, no replay
      return;
    }
    processedCount.set(filename, events.length);
    for (let i = already; i < events.length; i++) {
      const e = events[i];
      if (!e || typeof e !== "object") continue;
      noteActivity();
      if (isToolFailure(e)) {
        const n = (failureCounts.get(filename) ?? 0) + 1;
        failureCounts.set(filename, n);
        deliver("agentTrouble", { count: n });
      }
      if (e.type === "turnEnd") {
        failureCounts.set(filename, 0);
        const turn = findTurnSlice(events, i);
        const summary = classifyTurn(turn);
        const category = decideTurnCategory(summary);
        if (category) deliver(category, { fileCount: summary.fileCount, hadFailure: summary.hadFailure });
      }
    }
  }

  function scan() {
    let files;
    try {
      files = fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith(".json"));
    } catch {
      return; // dir doesn't exist yet (no chat ever opened) — nothing to do
    }
    for (const filename of files) {
      const full = path.join(CHATS_DIR, filename);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (chatMtimes.get(filename) === stat.mtimeMs) continue; // unchanged since last scan
      chatMtimes.set(filename, stat.mtimeMs);
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch (err) {
        log.appendLine(`chat watcher: skipping unreadable ${filename}: ${err.message || err}`);
        continue;
      }
      const events = Array.isArray(parsed?.events) ? parsed.events : [];
      try {
        processFile(filename, events);
      } catch (err) {
        // an undocumented-format hiccup here must degrade to silence, never crash the extension
        log.appendLine(`chat watcher: error processing ${filename}, ignoring: ${err.message || err}`);
      }
    }
  }

  return { scan };
}

function activate(context) {
  const log = vscode.window.createOutputChannel("LakshX Commentary");
  context.subscriptions.push(log);

  const deliver = makeDeliver(context, log);
  const noteActivity = makeActivityTracker(deliver);
  const checkLateNight = makeLateNightCheck(deliver);
  const noteUndoRedo = makeUndoRedoTracker(deliver);
  const terminalTracker = makeTerminalTracker(deliver, noteActivity);
  const chatWatcher = makeChatWatcher(deliver, noteActivity, log);

  // seed the chat-transcript baseline immediately so pre-existing history
  // never gets replayed as fresh triggers on activation/reload
  chatWatcher.scan();
  const pollTimer = setInterval(() => chatWatcher.scan(), CHATS_POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      noteActivity();
      checkLateNight();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) {
        noteUndoRedo();
      }
    }),
  );

  if (vscode.window.onDidStartTerminalShellExecution) {
    context.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution((e) => terminalTracker.onStart(e.terminal)),
      vscode.window.onDidEndTerminalShellExecution((e) => terminalTracker.onEnd(e.terminal, e.exitCode)),
    );
  }

  // Priority 996 — right after lakshx-graph's "$(graph) Call Graph" (997),
  // in the same right-aligned cluster as lakshx-chat's "✦ LakshX" (1000),
  // "$(radio-tower) Remote: ..." (999), and lakshx-db's "$(database) DB"
  // (998). Lands this icon immediately beside Remote/DB/Call Graph instead
  // of floating off on its own — same numbering convention those files use.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 996);
  const refreshStatusItem = () => {
    const enabled = cfg().get("enabled", true);
    statusItem.text = enabled ? "$(unmute) Commentary" : "$(mute) Commentary";
    statusItem.tooltip = enabled
      ? "LakshX Commentary is on — click to mute"
      : "LakshX Commentary is muted — click to unmute";
    statusItem.command = "lakshx.commentary.toggleMute";
  };
  refreshStatusItem();
  statusItem.show();
  context.subscriptions.push(
    statusItem,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("lakshx.commentary.enabled")) refreshStatusItem();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("lakshx.commentary.toggleMute", async () => {
      const c = cfg();
      await c.update("enabled", !c.get("enabled", true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand("lakshx.commentary.toggleVoice", async () => {
      const c = cfg();
      const next = !c.get("voice", true);
      await c.update("voice", next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`LakshX Commentary voice is now ${next ? "on" : "off (text only)"}.`);
    }),
    vscode.commands.registerCommand("lakshx.commentary.testLine", () => {
      const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
      deliver(category, { fileCount: 4, count: 2 }, { bypassRateCap: true });
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
