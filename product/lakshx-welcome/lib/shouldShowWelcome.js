// Pure decision function for "should the welcome panel auto-open on this
// activation?" — deliberately has zero dependency on the `vscode` module so
// it's directly unit-testable with plain `node --test` (see
// test/shouldShowWelcome.test.js), the same rationale product/lakshx-chat's
// commands.js and diagnostics.js use for their own pure-logic extraction.
//
// extension.js is the only caller that touches the real
// `context.globalState` API; it passes in whatever
// `context.globalState.get(STORAGE_KEY)` returned (usually `undefined` on a
// fresh profile, or `true` once we've shown it) and nothing else.
"use strict";

const STORAGE_KEY = "lakshx.welcome.shown";

/**
 * @param {unknown} storedFlag - whatever globalState.get(STORAGE_KEY) returned.
 * @returns {boolean} true iff the welcome panel should auto-show this activation.
 */
function shouldShowWelcome(storedFlag) {
  // Only a strict `true` counts as "already shown". Anything else (undefined
  // on a fresh profile, null, a stale non-boolean value from some future
  // schema change) is treated as "not shown yet" so we fail toward showing
  // the welcome experience rather than silently hiding it forever.
  return storedFlag !== true;
}

module.exports = { shouldShowWelcome, STORAGE_KEY };
