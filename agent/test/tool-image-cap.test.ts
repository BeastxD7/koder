/**
 * Unit tests for src/tool-image-cap.ts — the size cap server.ts applies to a
 * tool's `image` attachment (currently only `browser_preview`'s screenshot)
 * before it crosses the ACP wire as `lakshx/tool_image`. Deliberately pulled
 * out of server.ts (which `connect()`s to real stdio at import time, see the
 * bottom of server.ts) so this one piece of logic is directly unit
 * testable without spawning a subprocess.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { capToolImageBase64, MAX_TOOL_IMAGE_BYTES } from "../src/tool-image-cap.js";

/** Base64 string that decodes to exactly `n` raw bytes. */
function base64OfSize(n: number): string {
  return Buffer.alloc(n, 0x41).toString("base64");
}

test("capToolImageBase64: passes through a typical small screenshot unchanged", () => {
  const b64 = base64OfSize(200_000); // ~200KB, a normal viewport screenshot
  assert.equal(capToolImageBase64(b64), b64);
});

test("capToolImageBase64: passes through exactly at the cap", () => {
  const b64 = base64OfSize(MAX_TOOL_IMAGE_BYTES);
  assert.equal(capToolImageBase64(b64), b64);
});

test("capToolImageBase64: drops (returns undefined) once over the cap — never truncates/corrupts", () => {
  const b64 = base64OfSize(MAX_TOOL_IMAGE_BYTES + 1024);
  assert.equal(capToolImageBase64(b64), undefined);
});

test("capToolImageBase64: an empty image is never dropped", () => {
  assert.equal(capToolImageBase64(""), "");
});

test("capToolImageBase64: a custom maxBytes is honored, for narrower tests", () => {
  const b64 = base64OfSize(1000);
  assert.equal(capToolImageBase64(b64, 999), undefined);
  assert.equal(capToolImageBase64(b64, 1000), b64);
});
