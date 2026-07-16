"use strict";
/**
 * LakshX FM — background-music station catalogue and pure helpers.
 *
 * This module is deliberately side-effect-free (no vscode, no fs, no
 * network) so it can be unit-tested with `node --test`. The extension host
 * (extension.js) owns all I/O: reading media/tracks/, creating the webview,
 * postMessage, and persisting config/globalState.
 *
 * Playback contract (implemented in media/player.js): every station has an
 * HTTPS stream `url` fed to a single <audio> element inside a WebviewPanel.
 * Only https:// is usable — http:// is blocked as mixed content in the
 * Chromium-based webview.
 *
 * LICENSING — READ BEFORE ADDING STATIONS:
 *  - Radio Paradise (below) is shipped live: its public AAC streams are
 *    reachable over HTTPS and it is a listener-supported station. Attribution
 *    (station name + link) is shown in the player UI.
 *  - SomaFM is intentionally NOT shipped as a built-in station. SomaFM's
 *    Terms of Service prohibit embedding its streams in a commercial product
 *    without written permission. The commented block below documents the
 *    channel URLs ONLY as a reference for a user who wants to add one via
 *    "Add custom stream…", or for LakshX to enable after obtaining written
 *    permission. Do not uncomment these to ship them by default.
 */

/**
 * Built-in, ship-ready stations. `kind`:
 *   "stream"  — an internet radio stream at `url` (HTTPS).
 *   "bundled" — plays local CC0/CC-BY files from media/tracks/ (see README).
 *               `url` is null; the extension resolves per-file webview URIs at
 *               runtime and hides/disables the entry when the folder is empty.
 */
const STATIONS = [
  {
    id: "rp-main",
    name: "Radio Paradise — Main Mix",
    kind: "stream",
    url: "https://stream.radioparadise.com/aac-128",
    homepage: "https://radioparadise.com",
    note: "Eclectic, hand-picked rock/world/electronica. Listener-supported.",
  },
  {
    id: "rp-mellow",
    name: "Radio Paradise — Mellow Mix",
    kind: "stream",
    url: "https://stream.radioparadise.com/mellow-aac-128",
    homepage: "https://radioparadise.com",
    note: "Quieter, low-key selections from Radio Paradise — good for focus.",
  },
  {
    id: "lakshx-focus",
    name: "LakshX Focus (local tracks)",
    kind: "bundled",
    url: null,
    homepage: null,
    note: "Plays CC0/CC-BY tracks you drop into media/tracks/. Disabled until you add files — see README.",
  },
  // ---------------------------------------------------------------------------
  // SomaFM — NOT SHIPPED. SomaFM's ToS forbids embedding its streams in a
  // commercial product without WRITTEN PERMISSION. These are kept here purely
  // as reference so a user can paste one into "Add custom stream…", or so
  // LakshX can enable them AFTER securing permission. Do NOT move these into
  // the array above to enable by default.
  //
  // Caveat if you ever do add a SomaFM custom URL: SomaFM fronts each channel
  // behind failover hosts ice1.somafm.com … ice6.somafm.com; the plain
  // https://ice.somafm.com/<channel> alias is the one to prefer, and a single
  // ice1-6 host may be down while others are up. Use the HTTPS URL only.
  //
  //   Groove Salad  https://ice.somafm.com/groovesalad-128-aac
  //   Drone Zone    https://ice.somafm.com/dronezone-128-aac
  //   Deep Space    https://ice.somafm.com/deepspaceone-128-aac
  // ---------------------------------------------------------------------------
];

/** Config keys (single source of truth for the enabled/station/volume trio). */
const CONFIG_SECTION = "lakshx.commentary";
const CONFIG_KEYS = Object.freeze({
  enabled: "music.enabled", // boolean, default false — OFF/opt-in, separate axis from commentary mute
  station: "music.station", // string — a built-in station id OR a custom https:// URL
  volume: "music.volume", // number 0..100, default 60
  duckDuringCommentary: "music.duckDuringCommentary", // boolean, default true
});

/** globalState key for the user's remembered custom stream URLs (list data — not a config scalar). */
const GLOBALSTATE_KEYS = Object.freeze({
  customStreams: "lakshx.commentary.music.customStreams", // string[] of https URLs the user added
});

const DEFAULTS = Object.freeze({
  enabled: false,
  station: "rp-main",
  volume: 60,
  duckDuringCommentary: true,
  duckVolumeFactor: 0.15, // drop to ~15% of target while commentary speaks
});

/** True only for a syntactically valid https:// URL — http:// (mixed content in the webview) and everything else is rejected. */
function isValidCustomUrl(raw) {
  if (typeof raw !== "string") return false;
  const s = raw.trim();
  if (s.length === 0) return false;
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return u.protocol === "https:";
}

/** Build a station object for a user-supplied custom https URL. Returns null if the URL isn't a valid https URL. */
function makeCustomStation(url) {
  if (!isValidCustomUrl(url)) return null;
  const trimmed = url.trim();
  let host = trimmed;
  try {
    host = new URL(trimmed).host;
  } catch {
    /* isValidCustomUrl already guaranteed it parses; defensive only */
  }
  return {
    id: trimmed, // the URL itself is the id for custom streams
    name: `Custom stream — ${host}`,
    kind: "custom",
    url: trimmed,
    homepage: null,
    note: "User-added custom stream.",
    custom: true,
  };
}

/**
 * Resolve a station id to a station object.
 *  - A built-in id ("rp-main", …) returns that station.
 *  - A valid https:// URL (whether or not it's in `customStreams`) returns a
 *    synthesized custom station, so a persisted custom-URL `station` value
 *    always resolves.
 *  - Anything else returns null (caller falls back to DEFAULTS.station).
 * Pure: `customStreams` is passed in, never read from disk here.
 */
function resolveStation(id, { customStreams = [] } = {}) {
  if (typeof id !== "string" || id.length === 0) return null;
  const builtin = STATIONS.find((s) => s.id === id);
  if (builtin) return builtin;
  if (isValidCustomUrl(id)) return makeCustomStation(id);
  // tolerate a remembered custom stream referenced by a non-URL id (none today, but future-proof)
  if (Array.isArray(customStreams) && customStreams.includes(id) && isValidCustomUrl(id)) {
    return makeCustomStation(id);
  }
  return null;
}

/** Only "stream" and "custom" stations are directly playable via a URL. "bundled" needs the extension to resolve file URIs. */
function isPlayableUrlStation(station) {
  return !!station && (station.kind === "stream" || station.kind === "custom") && isValidCustomUrl(station.url);
}

/** Is this the local-files placeholder station? */
function isBundledStation(station) {
  return !!station && station.kind === "bundled";
}

/**
 * Compose the ordered list the QuickPick shows: built-in stations (the
 * "bundled" LakshX Focus entry is included only when `focusAvailable`, i.e.
 * media/tracks/ has files), then any remembered custom streams. Pure.
 */
function listPickableStations({ customStreams = [], focusAvailable = false } = {}) {
  const out = [];
  for (const s of STATIONS) {
    if (isBundledStation(s) && !focusAvailable) continue;
    out.push(s);
  }
  for (const url of Array.isArray(customStreams) ? customStreams : []) {
    const cs = makeCustomStation(url);
    if (cs) out.push(cs);
  }
  return out;
}

module.exports = {
  STATIONS,
  CONFIG_SECTION,
  CONFIG_KEYS,
  GLOBALSTATE_KEYS,
  DEFAULTS,
  isValidCustomUrl,
  makeCustomStation,
  resolveStation,
  isPlayableUrlStation,
  isBundledStation,
  listPickableStations,
};
