// LakshX Music — a standalone, in-IDE music player for vibe coders. It streams
// free, embed-permitted internet radio (or your own local CC0/CC-BY tracks)
// inside a small VS Code webview panel, driven from a status-bar entry point
// and a station QuickPick. Zero LLM calls, zero telemetry — just music.
//
// See lib/music.js for the pure station catalogue + helpers; media/player.*
// for the webview player. This file is glue: the music controller (webview
// lifecycle, postMessage handshake, CSP), the status bar item, commands, and
// config reactions.
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const music = require("./lib/music.js");

// ---------- LakshX Music: background-music WebviewPanel + status bar ----------
// The player is OFF by default (opt-in). Configuration is the single source of
// truth for the enabled/station/volume trio; only the list of user-added
// custom stream URLs lives in globalState.
function makeMusicController(context, log) {
  const SECTION = music.CONFIG_SECTION;
  const K = music.CONFIG_KEYS;
  const D = music.DEFAULTS;
  const GK = music.GLOBALSTATE_KEYS;

  let panel = null;
  let ready = false; // webview posted {ready} — safe to postMessage without the load-race dropping it
  let pending = []; // messages queued until `ready`
  let playing = false; // last known audio state, from the webview's {state} messages
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
    try { panel.webview.postMessage(msg); } catch (err) { log.appendLine(`LakshX Music: postMessage failed: ${err.message || err}`); }
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
    post({ type: "setStation", url, name: st ? st.name : "LakshX Music", homepage: st ? st.homepage : null });
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
    post({ type: "setStation", url, name: st ? st.name : "LakshX Music", homepage: st ? st.homepage : null });
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
      "lakshxMusic",
      "LakshX Music",
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
      refreshStatus();
    });
    return panel;
  }

  function shortName(st) {
    if (!st) return "LakshX Music";
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
      statusItem.text = "$(play) LakshX Music";
      statusItem.tooltip = "LakshX Music is off — click to pick a station and play";
    } else if (playing) {
      statusItem.text = `$(unmute) ${shortName(st)}`;
      statusItem.tooltip = `LakshX Music: playing ${st ? st.name : ""} — click for stations / pause`;
    } else {
      statusItem.text = `$(play) ${shortName(st)}`;
      statusItem.tooltip = `LakshX Music: ready (${st ? st.name : ""}) — click to play or pick a station`;
    }
    statusItem.command = "lakshx.music.pickStation";
  }

  function createStatusItem() {
    // Priority 996 — in the same right-aligned cluster as the other LakshX
    // status items (lakshx-graph's Call Graph at 997, lakshx-db's DB at 998,
    // Remote at 999, LakshX chat at 1000). This is the player's single primary
    // entry point.
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 996);
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
      title: "LakshX Music: add a custom stream",
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
    if (getEnabled()) items.push({ label: "$(stop) Turn off LakshX Music", _action: "off" });

    const st = currentStation();
    const picked = await vscode.window.showQuickPick(items, {
      title: "LakshX Music",
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

  function onConfigChange(e) {
    if (e.affectsConfiguration(`${SECTION}.${K.enabled}`)) applyEnabledState(false);
    if (e.affectsConfiguration(`${SECTION}.${K.station}`)) {
      if (panel) pushStation();
      refreshStatus();
    }
    if (e.affectsConfiguration(`${SECTION}.${K.volume}`)) {
      if (panel) post({ type: "volume", value: getVolume() });
    }
  }

  return { createStatusItem, refreshStatus, toggle, pickStation, onConfigChange };
}

function activate(context) {
  const log = vscode.window.createOutputChannel("LakshX Music");
  context.subscriptions.push(log);

  const musicController = makeMusicController(context, log);

  // ---------- LakshX Music: status bar (996), commands, config reactions ----------
  const musicStatusItem = musicController.createStatusItem();
  context.subscriptions.push(
    musicStatusItem,
    vscode.commands.registerCommand("lakshx.music.toggle", () => musicController.toggle()),
    vscode.commands.registerCommand("lakshx.music.pickStation", () => musicController.pickStation()),
    vscode.workspace.onDidChangeConfiguration((e) => musicController.onConfigChange(e)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
