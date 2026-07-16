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
const music = require("./lib/music.js");

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
// `musicController` (optional) lets a spoken line duck LakshX FM while it
// plays; passing nothing keeps delivery exactly as before.
function makeDeliver(context, log, musicController = null) {
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
          // Duck LakshX FM (if playing) for the duration of this line, so the
          // commentary is audible over the music. music.duck() self-gates on
          // enabled/playing/duckDuringCommentary and returns whether it ducked.
          const ducked = musicController ? musicController.duck() : false;
          // Un-duck on the TTS process's completion (tts.speak's new onDone),
          // with a length-based timeout fallback in case the child never fires
          // a close/error event — un-duck is idempotent, so both are safe.
          let unduckTimer = null;
          const finish = () => {
            if (unduckTimer) { clearTimeout(unduckTimer); unduckTimer = null; }
            if (musicController) musicController.unduck();
          };
          speak(text, {
            onUnavailable: () => {
              if (runtime.ttsNoticeShown) return;
              runtime.ttsNoticeShown = true;
              vscode.window.showInformationMessage(
                "LakshX Commentary: no text-to-speech engine found on this system — showing text only from now on.",
              );
            },
            onDone: finish,
          });
          if (ducked) {
            // ~120ms/char, floor 4s — a safety net only; onDone normally wins.
            unduckTimer = setTimeout(finish, Math.max(4000, text.length * 120));
          }
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

// ---------- LakshX FM: background-music WebviewPanel + status bar (priority 995) ----------
// Music is a SEPARATE axis from commentary mute: OFF by default, opt-in.
// Configuration is the single source of truth for the enabled/station/volume
// trio (same convention as commentary's toggleMute → config.update Global);
// only the list of user-added custom stream URLs lives in globalState.
function makeMusicController(context, log) {
  const SECTION = music.CONFIG_SECTION;
  const K = music.CONFIG_KEYS;
  const D = music.DEFAULTS;
  const GK = music.GLOBALSTATE_KEYS;

  let panel = null;
  let ready = false; // webview posted {ready} — safe to postMessage without the load-race dropping it
  let pending = []; // messages queued until `ready`
  let playing = false; // last known audio state, from the webview's {state} messages
  let didDuck = false; // are we currently ducking for a commentary line?
  let allowedOrigins = new Set(); // media-src origins baked into the current webview html

  const c = () => vscode.workspace.getConfiguration(SECTION);
  const getEnabled = () => c().get(K.enabled, D.enabled);
  const getStationId = () => c().get(K.station, D.station);
  const getVolume = () => {
    const v = c().get(K.volume, D.volume);
    return typeof v === "number" ? Math.max(0, Math.min(100, v)) : D.volume;
  };
  const getCustomStreams = () => {
    const list = context.globalState.get(GK.customStreams, []);
    return Array.isArray(list) ? list.filter(music.isValidCustomUrl) : [];
  };
  const setCustomStreams = (list) => context.globalState.update(GK.customStreams, list);

  const currentStation = () =>
    music.resolveStation(getStationId(), { customStreams: getCustomStreams() }) || music.resolveStation(D.station) || music.STATIONS[0];

  // media/tracks/ has at least one audio file → the "LakshX Focus" bundled
  // station becomes offerable. Empty/absent (the shipped state, no CC0 files
  // bundled) → it stays hidden. See README for the drop-in instructions.
  function focusAvailable() {
    try {
      const dir = path.join(context.extensionPath, "media", "tracks");
      return fs.readdirSync(dir).some((f) => /\.(mp3|ogg|m4a|aac|wav|flac|opus|webm)$/i.test(f));
    } catch {
      return false;
    }
  }

  // Resolve a station to a concrete media URL for the <audio> element.
  // Streams/custom → their https url. Bundled → the first local track as a
  // webview URI (null when the folder is empty, which keeps it disabled).
  function resolveStationUrl(station, webview) {
    if (!station) return null;
    if (station.kind === "stream" || station.kind === "custom") return station.url;
    if (station.kind === "bundled") {
      try {
        const dir = path.join(context.extensionPath, "media", "tracks");
        const first = fs.readdirSync(dir).find((f) => /\.(mp3|ogg|m4a|aac|wav|flac|opus|webm)$/i.test(f));
        if (!first) return null;
        return webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "tracks", first)).toString();
      } catch {
        return null;
      }
    }
    return null;
  }

  function nonce() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  function buildHtml(webview) {
    const n = nonce();
    // media-src always allows Radio Paradise + the webview resource origin
    // (for bundled files); every remembered custom stream's origin plus the
    // active station's origin are added so custom https streams actually play
    // instead of being blocked as a CSP violation.
    const origins = new Set(["https://stream.radioparadise.com"]);
    for (const u of getCustomStreams()) {
      try { origins.add(new URL(u).origin); } catch { /* skip unparseable */ }
    }
    const st = currentStation();
    if (st && (st.kind === "stream" || st.kind === "custom") && music.isValidCustomUrl(st.url)) {
      try { origins.add(new URL(st.url).origin); } catch { /* skip */ }
    }
    allowedOrigins = origins;
    const mediaSrc = [...origins].join(" ") + " " + webview.cspSource;
    const csp =
      `default-src 'none'; ` +
      `script-src 'nonce-${n}' ${webview.cspSource}; ` +
      `style-src ${webview.cspSource}; ` +
      `media-src ${mediaSrc};`;
    const tpl = fs.readFileSync(path.join(context.extensionPath, "media", "player.html"), "utf8");
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "player.css")).toString();
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "player.js")).toString();
    // split/join (not replace) so a `$` in any URI is never treated as a
    // replacement pattern; __NONCE__ appears twice (CSP + script tag).
    return tpl
      .split("__CSP__").join(csp)
      .split("__CSS_URI__").join(cssUri)
      .split("__JS_URI__").join(jsUri)
      .split("__NONCE__").join(n);
  }

  function postDirect(msg) {
    try { panel.webview.postMessage(msg); } catch (err) { log.appendLine(`LakshX FM: postMessage failed: ${err.message || err}`); }
  }

  function post(msg) {
    if (!panel) return;
    if (ready) postDirect(msg);
    else pending.push(msg); // flushed on the {ready} handshake
  }

  function pushStationAndVolume() {
    if (!panel) return;
    const st = currentStation();
    const url = resolveStationUrl(st, panel.webview);
    post({ type: "setStation", url, name: st ? st.name : "LakshX FM", homepage: st ? st.homepage : null });
    post({ type: "volume", value: getVolume() });
  }

  function pushStation() {
    if (!panel) return;
    const st = currentStation();
    const url = resolveStationUrl(st, panel.webview);
    // If this station's origin isn't in the html's media-src, the stream would
    // be CSP-blocked — rebuild the html (a reload) so the expanded media-src
    // includes it. The custom URL is already persisted by this point, so
    // buildHtml() picks it up. On {ready}, setStation+volume are re-sent.
    if (url && (st.kind === "stream" || st.kind === "custom")) {
      let origin = null;
      try { origin = new URL(url).origin; } catch { /* ignore */ }
      if (origin && !allowedOrigins.has(origin)) {
        ready = false;
        pending = [];
        panel.webview.html = buildHtml(panel.webview);
        return;
      }
    }
    post({ type: "setStation", url, name: st ? st.name : "LakshX FM", homepage: st ? st.homepage : null });
  }

  function onWebviewMessage(m) {
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "ready":
        ready = true;
        pushStationAndVolume();
        for (const q of pending) postDirect(q);
        pending = [];
        break;
      case "state":
        playing = m.value === "playing";
        refreshStatus();
        break;
      case "volumeChanged":
        if (typeof m.value === "number") {
          // persist the user's slider to config (the single source of truth)
          c().update(K.volume, Math.max(0, Math.min(100, Math.round(m.value))), vscode.ConfigurationTarget.Global);
        }
        break;
      case "needsGesture":
        // a programmatic play() was blocked by the autoplay policy — surface
        // the panel so the user can make the required first click.
        if (panel) panel.reveal(vscode.ViewColumn.Beside, false);
        break;
      default:
        break;
    }
  }

  function ensurePanel(reveal) {
    if (panel) {
      if (reveal) panel.reveal(vscode.ViewColumn.Beside, false);
      return panel;
    }
    ready = false;
    pending = [];
    panel = vscode.window.createWebviewPanel(
      "lakshxFm",
      "LakshX FM",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !reveal },
      {
        enableScripts: true,
        retainContextWhenHidden: true, // keep music playing while the tab is hidden
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );
    panel.webview.html = buildHtml(panel.webview);
    panel.webview.onDidReceiveMessage(onWebviewMessage);
    panel.onDidDispose(() => {
      panel = null;
      ready = false;
      pending = [];
      playing = false;
      didDuck = false;
      refreshStatus();
    });
    return panel;
  }

  function shortName(st) {
    if (!st) return "LakshX FM";
    if (st.kind === "custom") {
      try { return new URL(st.url).host; } catch { return "Custom"; }
    }
    // "Radio Paradise — Main Mix" → "Radio Paradise" for a compact status bar
    return String(st.name).split(" — ")[0];
  }

  let statusItem = null;
  function refreshStatus() {
    if (!statusItem) return;
    const enabled = getEnabled();
    const st = currentStation();
    if (!enabled) {
      statusItem.text = "$(play) LakshX FM";
      statusItem.tooltip = "LakshX FM background music is off — click to pick a station and play";
    } else if (playing) {
      statusItem.text = `$(unmute) ${shortName(st)}`;
      statusItem.tooltip = `LakshX FM: playing ${st ? st.name : ""} — click for stations / pause`;
    } else {
      statusItem.text = `$(play) ${shortName(st)}`;
      statusItem.tooltip = `LakshX FM: ready (${st ? st.name : ""}) — click to play or pick a station`;
    }
    statusItem.command = "lakshx.commentary.music.pickStation";
  }

  function createStatusItem() {
    // Priority 995 — one slot left of Commentary's 996, keeping both LakshX
    // icons together in the same right-aligned cluster.
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 995);
    refreshStatus();
    statusItem.show();
    return statusItem;
  }

  function applyEnabledState(reveal) {
    if (getEnabled()) ensurePanel(reveal);
    else if (panel) panel.dispose(); // disposing the panel stops the audio
    refreshStatus();
  }

  async function ensureEnabledAndPlay() {
    if (!getEnabled()) await c().update(K.enabled, true, vscode.ConfigurationTarget.Global);
    ensurePanel(true);
    // Queued until {ready}; the webview's play() will succeed if the user's
    // first click already granted the gesture, otherwise it posts
    // {needsGesture} and we've already revealed the panel for them to click.
    post({ type: "play" });
    refreshStatus();
  }

  async function selectStation(id) {
    await c().update(K.station, id, vscode.ConfigurationTarget.Global);
    if (getEnabled() && panel) {
      ensurePanel(true);
      pushStation();
    }
    refreshStatus();
  }

  async function addCustomStream() {
    const url = await vscode.window.showInputBox({
      title: "LakshX FM: add a custom stream",
      prompt: "Paste an HTTPS stream URL. http:// is blocked as mixed content in the player.",
      placeHolder: "https://example.com/stream",
      ignoreFocusOut: true,
      validateInput: (v) => (music.isValidCustomUrl(v) ? null : "Enter a valid https:// URL"),
    });
    if (!url) return;
    const clean = url.trim();
    const list = getCustomStreams();
    if (!list.includes(clean)) {
      list.push(clean);
      await setCustomStreams(list);
    }
    await selectStation(clean); // a custom station's id is its URL
    await ensureEnabledAndPlay();
  }

  async function pickStation() {
    const custom = getCustomStreams();
    const focus = focusAvailable();
    const stations = music.listPickableStations({ customStreams: custom, focusAvailable: focus });
    const curId = getStationId();
    const items = [];
    if (getEnabled() && playing) items.push({ label: "$(debug-pause) Pause", _action: "pause" });
    else items.push({ label: "$(play) Play", _action: "play" });
    items.push({ label: "Stations", kind: vscode.QuickPickItemKind.Separator });
    for (const s of stations) {
      items.push({
        label: (s.id === curId ? "$(check) " : "") + s.name,
        description: s.note,
        _action: "station",
        _stationId: s.id,
      });
    }
    // Note when LakshX Focus is hidden because no tracks are bundled yet.
    if (!focus) {
      items.push({ label: "LakshX Focus (local tracks) — add CC0/CC-BY files to media/tracks/ (see README)", kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: "$(add) Add custom stream…", _action: "add" });
    if (getEnabled()) items.push({ label: "$(stop) Turn off LakshX FM", _action: "off" });

    const st = currentStation();
    const picked = await vscode.window.showQuickPick(items, {
      title: "LakshX FM",
      placeHolder: playing ? `Playing: ${st ? st.name : ""}` : "Pick a station or add a stream",
    });
    if (!picked || !picked._action) return;
    switch (picked._action) {
      case "play":
        await ensureEnabledAndPlay();
        break;
      case "pause":
        post({ type: "pause" });
        break;
      case "station":
        await selectStation(picked._stationId);
        await ensureEnabledAndPlay();
        break;
      case "add":
        await addCustomStream();
        break;
      case "off":
        await c().update(K.enabled, false, vscode.ConfigurationTarget.Global);
        applyEnabledState(false);
        break;
      default:
        break;
    }
  }

  // Status-bar/palette "toggle": enable+play when off, pause when playing,
  // resume when paused. (Full off is via the QuickPick's "Turn off" entry.)
  async function toggle() {
    if (!getEnabled()) {
      await ensureEnabledAndPlay();
      return;
    }
    if (panel && playing) post({ type: "pause" });
    else await ensureEnabledAndPlay();
  }

  function duck() {
    if (didDuck) return true;
    if (!getEnabled() || !panel || !playing) return false;
    if (!c().get(K.duckDuringCommentary, D.duckDuringCommentary)) return false;
    post({ type: "duck" });
    didDuck = true;
    return true;
  }

  function unduck() {
    if (!didDuck) return;
    didDuck = false;
    post({ type: "unduck" });
  }

  function onConfigChange(e) {
    if (e.affectsConfiguration(`${SECTION}.${K.enabled}`)) applyEnabledState(false);
    if (e.affectsConfiguration(`${SECTION}.${K.station}`)) {
      if (panel) pushStation();
      refreshStatus();
    }
    if (e.affectsConfiguration(`${SECTION}.${K.volume}`)) {
      if (panel) post({ type: "volume", value: getVolume() });
    }
    if (e.affectsConfiguration(`${SECTION}.${K.duckDuringCommentary}`)) refreshStatus();
  }

  return { createStatusItem, refreshStatus, toggle, pickStation, onConfigChange, duck, unduck };
}

function activate(context) {
  const log = vscode.window.createOutputChannel("LakshX Commentary");
  context.subscriptions.push(log);

  const musicController = makeMusicController(context, log);
  const deliver = makeDeliver(context, log, musicController);
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

  // ---------- LakshX FM: status bar (995), commands, config reactions ----------
  const musicStatusItem = musicController.createStatusItem();
  context.subscriptions.push(
    musicStatusItem,
    vscode.commands.registerCommand("lakshx.commentary.music.toggle", () => musicController.toggle()),
    vscode.commands.registerCommand("lakshx.commentary.music.pickStation", () => musicController.pickStation()),
    vscode.workspace.onDidChangeConfiguration((e) => musicController.onConfigChange(e)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
