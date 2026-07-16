"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { buildSpeakPlan, findLinuxTts, speak } = require("../lib/tts.js");

test("buildSpeakPlan on macOS uses 'say' with text as a single literal argv element (no shell involved)", () => {
  const plan = buildSpeakPlan("hello world; rm -rf /", "darwin");
  assert.equal(plan.command, "say");
  assert.deepEqual(plan.args, ["hello world; rm -rf /"]);
  assert.equal(plan.stdin, undefined);
});

test("buildSpeakPlan on Windows never embeds the text in the command line — it goes over stdin", () => {
  const text = "hello 'quoted' \"world\" `backtick`";
  const plan = buildSpeakPlan(text, "win32");
  assert.equal(plan.command, "powershell.exe");
  for (const arg of plan.args) {
    assert.ok(!arg.includes(text), "text must not appear embedded in any Windows argv element");
  }
  assert.equal(plan.stdin, text);
});

test("buildSpeakPlan on Linux prefers espeak, falls back to spd-say, and returns null if neither is present", () => {
  assert.equal(buildSpeakPlan("hi", "linux", "espeak").command, "espeak");
  assert.equal(buildSpeakPlan("hi", "linux", "spd-say").command, "spd-say");
  assert.equal(buildSpeakPlan("hi", "linux", null), null);
});

test("buildSpeakPlan rejects empty/non-string text instead of building a bogus command", () => {
  assert.equal(buildSpeakPlan("", "darwin"), null);
  assert.equal(buildSpeakPlan(undefined, "darwin"), null);
});

test("findLinuxTts checks candidate absolute paths (resolveShell()-style), not just PATH lookup", () => {
  const fakeExists = (p) => p === "/usr/bin/spd-say";
  assert.equal(findLinuxTts(fakeExists), "spd-say");
  assert.equal(findLinuxTts(() => false), null);
});

test("speak() never throws, even for a platform/binary that plainly doesn't exist", () => {
  // Force the "no known TTS" branch deterministically regardless of the host OS
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "sunos" });
  try {
    assert.doesNotThrow(() => {
      const launched = speak("test line", { onUnavailable: () => {} });
      assert.equal(launched, false);
    });
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});

test("speak() calls onUnavailable exactly once when no TTS is available", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "sunos" });
  let calls = 0;
  try {
    speak("test line", { onUnavailable: () => calls++ });
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  assert.equal(calls, 1);
});

test("speak() fires onDone (once) even when no TTS is available, so a ducking caller never stays stuck", () => {
  // The synchronous no-plan path must still resolve onDone so background music
  // can un-duck. Guarantee it fires, and only once.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "sunos" });
  let done = 0;
  try {
    const launched = speak("test line", { onUnavailable: () => {}, onDone: () => done++ });
    assert.equal(launched, false);
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
  assert.equal(done, 1);
});

test("speak() stays backward-compatible: callers passing no onDone are unaffected and it still returns synchronously", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "sunos" });
  try {
    assert.doesNotThrow(() => {
      const launched = speak("hi");
      assert.equal(typeof launched, "boolean");
    });
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
  }
});
