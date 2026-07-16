"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
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
} = require("../lib/music.js");

test("Radio Paradise stations ship live over HTTPS with the verified URLs", () => {
  const main = STATIONS.find((s) => s.id === "rp-main");
  const mellow = STATIONS.find((s) => s.id === "rp-mellow");
  assert.equal(main.url, "https://stream.radioparadise.com/aac-128");
  assert.equal(mellow.url, "https://stream.radioparadise.com/mellow-128");
  for (const s of [main, mellow]) {
    assert.equal(s.kind, "stream");
    assert.ok(s.url.startsWith("https://"), "must be https (http is mixed-content-blocked in the webview)");
  }
});

test("all shipped stream stations are HTTPS Radio Paradise channels (verified embed-OK) and unique", () => {
  const streams = STATIONS.filter((s) => s.kind === "stream");
  assert.ok(streams.length >= 4, "at least the four Radio Paradise channels ship");
  const seen = new Set();
  for (const s of streams) {
    assert.ok(s.url.startsWith("https://stream.radioparadise.com/"), `${s.id} must be a Radio Paradise HTTPS stream`);
    assert.ok(typeof s.name === "string" && s.name.length > 0, `${s.id} needs a display name`);
    assert.equal(s.homepage, "https://radioparadise.com", `${s.id} must credit Radio Paradise`);
    assert.ok(!seen.has(s.url), `duplicate stream URL: ${s.url}`);
    seen.add(s.url);
  }
});

test("the added Radio Paradise Rock, Global and Beyond channels are present with their exact verified URLs", () => {
  const rock = STATIONS.find((s) => s.id === "rp-rock");
  const global = STATIONS.find((s) => s.id === "rp-global");
  const beyond = STATIONS.find((s) => s.id === "rp-beyond");
  assert.ok(rock, "rp-rock station should exist");
  assert.ok(global, "rp-global station should exist");
  assert.ok(beyond, "rp-beyond station should exist");
  assert.equal(rock.url, "https://stream.radioparadise.com/rock-128");
  assert.equal(global.url, "https://stream.radioparadise.com/global-128");
  assert.equal(beyond.url, "https://stream.radioparadise.com/beyond-128");
});

test("SomaFM is NOT shipped as a built-in station (ToS: no embedding without written permission)", () => {
  for (const s of STATIONS) {
    const blob = JSON.stringify(s).toLowerCase();
    assert.ok(!blob.includes("somafm"), `SomaFM must not appear in a shipped station entry: ${s.id}`);
  }
});

test("LakshX Focus bundled placeholder is present but has no url (resolved at runtime, disabled when empty)", () => {
  const focus = STATIONS.find((s) => s.id === "lakshx-focus");
  assert.ok(focus, "LakshX Focus entry should exist");
  assert.equal(focus.kind, "bundled");
  assert.equal(focus.url, null);
  assert.equal(isBundledStation(focus), true);
});

test("isValidCustomUrl accepts https, rejects http and junk", () => {
  assert.equal(isValidCustomUrl("https://example.com/stream"), true);
  assert.equal(isValidCustomUrl("https://ice.somafm.com/groovesalad-128-aac"), true);
  // rejects http (mixed content), other schemes, and non-URLs
  assert.equal(isValidCustomUrl("http://example.com/stream"), false);
  assert.equal(isValidCustomUrl("ftp://example.com/x"), false);
  assert.equal(isValidCustomUrl("file:///etc/passwd"), false);
  assert.equal(isValidCustomUrl("not a url"), false);
  assert.equal(isValidCustomUrl(""), false);
  assert.equal(isValidCustomUrl("   "), false);
  assert.equal(isValidCustomUrl(null), false);
  assert.equal(isValidCustomUrl(undefined), false);
  assert.equal(isValidCustomUrl(42), false);
});

test("isValidCustomUrl trims surrounding whitespace before validating", () => {
  assert.equal(isValidCustomUrl("  https://example.com/s  "), true);
});

test("makeCustomStation builds a custom station from an https URL, null otherwise", () => {
  const cs = makeCustomStation("https://example.com/stream");
  assert.equal(cs.kind, "custom");
  assert.equal(cs.id, "https://example.com/stream");
  assert.equal(cs.url, "https://example.com/stream");
  assert.equal(cs.custom, true);
  assert.ok(cs.name.includes("example.com"));
  assert.equal(makeCustomStation("http://example.com/stream"), null);
  assert.equal(makeCustomStation("garbage"), null);
});

test("resolveStation resolves built-in ids", () => {
  assert.equal(resolveStation("rp-main").url, "https://stream.radioparadise.com/aac-128");
  assert.equal(resolveStation("rp-mellow").id, "rp-mellow");
  assert.equal(resolveStation("lakshx-focus").kind, "bundled");
});

test("resolveStation treats a valid https URL as a custom station, and returns null for unknown non-URL ids", () => {
  const r = resolveStation("https://example.com/stream");
  assert.equal(r.kind, "custom");
  assert.equal(r.url, "https://example.com/stream");
  assert.equal(resolveStation("nope-not-a-station"), null);
  assert.equal(resolveStation("http://example.com/x"), null); // http is not a valid custom url
  assert.equal(resolveStation(""), null);
  assert.equal(resolveStation(undefined), null);
});

test("isPlayableUrlStation is true only for stream/custom with a valid https url", () => {
  assert.equal(isPlayableUrlStation(resolveStation("rp-main")), true);
  assert.equal(isPlayableUrlStation(makeCustomStation("https://example.com/s")), true);
  assert.equal(isPlayableUrlStation(resolveStation("lakshx-focus")), false); // bundled has no url
  assert.equal(isPlayableUrlStation(null), false);
});

test("listPickableStations hides LakshX Focus when no tracks are available, shows it when they are", () => {
  const hidden = listPickableStations({ customStreams: [], focusAvailable: false });
  assert.ok(!hidden.some((s) => s.id === "lakshx-focus"), "Focus hidden when folder empty");
  assert.ok(hidden.some((s) => s.id === "rp-main"));

  const shown = listPickableStations({ customStreams: [], focusAvailable: true });
  assert.ok(shown.some((s) => s.id === "lakshx-focus"), "Focus shown when tracks exist");
});

test("listPickableStations appends valid custom streams and drops invalid ones", () => {
  const list = listPickableStations({
    customStreams: ["https://good.example/s", "http://bad.example/s", "nonsense"],
    focusAvailable: false,
  });
  const customs = list.filter((s) => s.kind === "custom");
  assert.equal(customs.length, 1);
  assert.equal(customs[0].url, "https://good.example/s");
});

test("config/globalState key shapes are stable and correctly namespaced under the standalone lakshx.music id", () => {
  assert.equal(CONFIG_SECTION, "lakshx.music");
  assert.equal(CONFIG_KEYS.enabled, "enabled");
  assert.equal(CONFIG_KEYS.station, "station");
  assert.equal(CONFIG_KEYS.volume, "volume");
  assert.equal(CONFIG_KEYS.duckDuringCommentary, undefined, "ducking is removed with commentary");
  assert.equal(GLOBALSTATE_KEYS.customStreams, "lakshx.music.customStreams");
  // full setting paths (SECTION + key) are what package.json contributes
  assert.equal(`${CONFIG_SECTION}.${CONFIG_KEYS.enabled}`, "lakshx.music.enabled");
  assert.equal(`${CONFIG_SECTION}.${CONFIG_KEYS.station}`, "lakshx.music.station");
  assert.equal(`${CONFIG_SECTION}.${CONFIG_KEYS.volume}`, "lakshx.music.volume");
});

test("defaults enforce the opt-in / OFF-by-default contract", () => {
  assert.equal(DEFAULTS.enabled, false, "music must be OFF by default");
  assert.equal(DEFAULTS.station, "rp-main");
  assert.equal(DEFAULTS.volume, 60);
  assert.equal(DEFAULTS.duckDuringCommentary, undefined, "no ducking config remains");
  assert.equal(DEFAULTS.duckVolumeFactor, undefined, "no ducking config remains");
});
