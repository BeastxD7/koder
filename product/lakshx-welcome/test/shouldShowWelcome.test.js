// Unit tests for the pure "should the welcome panel auto-show?" decision
// function. This is the one piece of extension.js's first-activation logic
// that's testable without a real extension host — see extension.js's
// activate() for how context.globalState feeds into it, and the final
// report's VERIFY section for why the live activation trigger itself is
// inspection-only, not exercised end-to-end here.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { shouldShowWelcome, STORAGE_KEY } = require("../lib/shouldShowWelcome.js");

test("shows on a fresh profile (globalState.get returns undefined)", () => {
  assert.equal(shouldShowWelcome(undefined), true);
});

test("does not show once the flag was persisted as true", () => {
  assert.equal(shouldShowWelcome(true), false);
});

test("shows again if the stored flag is anything other than strict true", () => {
  // Defensive: a stale/corrupt/future-schema value should fail toward
  // showing the welcome experience rather than silently suppressing it
  // forever.
  assert.equal(shouldShowWelcome(false), true);
  assert.equal(shouldShowWelcome(null), true);
  assert.equal(shouldShowWelcome(0), true);
  assert.equal(shouldShowWelcome("true"), true);
});

test("exposes the storage key extension.js reads/writes", () => {
  assert.equal(STORAGE_KEY, "lakshx.welcome.shown");
});
