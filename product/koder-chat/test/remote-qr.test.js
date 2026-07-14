// Sanity tests for the vendored QR encoder (remote-qr.js). We don't vendor a
// decoder to verify against (that would defeat the "zero new dependencies"
// point) — instead this checks the structural/API contract that
// remote-server.js and extension.js rely on. The encoder's correctness
// against the real QR spec was verified out-of-band during development by
// round-tripping generated codes through a real decoder (jsQR); see the
// commit message for that verification note.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { renderQrSvg } = require("../remote-qr.js");

test("renderQrSvg returns a well-formed, self-contained SVG string", () => {
  const token = "abcdef0123456789abcdef0123456789";
  const svg = renderQrSvg(`http://192.168.1.42:47820/?token=${token}`);
  assert.match(svg, /^<svg version="1\.1" xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.equal(svg.includes("<script"), false); // no active content in an SVG we hand to a webview
  assert.equal(svg.includes(token), false); // the URL is encoded as QR modules (a <path>), not echoed as plain text
});

test("renderQrSvg produces a larger code for a longer payload (more modules needed)", () => {
  const short = renderQrSvg("http://10.0.0.1:47820/?token=aa");
  const long = renderQrSvg(
    "http://10.0.0.1:47820/?token=" + "a".repeat(200), // forces a higher QR version
  );
  const moduleCountOf = (svg) => Number(svg.match(/viewBox="0 0 (\d+) /)[1]);
  assert.ok(moduleCountOf(long) > moduleCountOf(short));
});

test("renderQrSvg is deterministic for the same input", () => {
  const a = renderQrSvg("http://192.168.1.5:47820/?token=deadbeef");
  const b = renderQrSvg("http://192.168.1.5:47820/?token=deadbeef");
  assert.equal(a, b);
});
