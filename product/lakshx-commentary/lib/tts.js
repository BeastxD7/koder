"use strict";
/**
 * OS-native, free, no-API-key text-to-speech. Cross-platform shell
 * resolution follows the exact precedent in agent/src/tools.ts's
 * resolveShell() (~line 18): check a short list of candidate absolute paths
 * with existsSync rather than assuming a binary is on PATH or crashing if
 * it's missing.
 *
 * Safety: text is NEVER concatenated into a shell string. `spawn(cmd, args)`
 * with an argv array and no `shell: true` passes the text as one literal
 * argument (macOS `say`, Linux `espeak`/`spd-say`) — there is no shell in
 * between to interpret quotes/semicolons/backticks in it. On Windows, text
 * is not embedded in the command string at all; it's piped over stdin to a
 * small fixed PowerShell script that reads it back, so there is nothing
 * platform-specific to escape.
 *
 * Must never crash the extension: every failure mode (binary missing,
 * spawn error, non-zero exit) is caught and reported via `onUnavailable`,
 * never thrown.
 */
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

const LINUX_TTS_CANDIDATES = [
  { name: "espeak", paths: ["/usr/bin/espeak", "/usr/bin/espeak-ng", "/usr/local/bin/espeak", "/bin/espeak"] },
  { name: "spd-say", paths: ["/usr/bin/spd-say", "/usr/local/bin/spd-say", "/bin/spd-say"] },
];

/** Which Linux TTS binary (if any) is present, checked by absolute path — same style as resolveShell(). Pure/side-effect-free beyond reading the filesystem. */
function findLinuxTts(existsFn = existsSync) {
  for (const candidate of LINUX_TTS_CANDIDATES) {
    if (candidate.paths.some((p) => existsFn(p))) return candidate.name;
  }
  return null;
}

const WIN_SPEECH_SCRIPT =
  "Add-Type -AssemblyName System.Speech; " +
  "$t = [Console]::In.ReadToEnd(); " +
  "if ($t) { (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($t) }";

/**
 * Pure: decide WHAT would be run to speak `text` on `platform`, without
 * actually running anything. Returns null if no known TTS is available.
 * `linuxTts` is injectable so tests can force each branch without touching
 * the real filesystem.
 */
function buildSpeakPlan(text, platform = process.platform, linuxTts = undefined) {
  if (typeof text !== "string" || text.length === 0) return null;
  if (platform === "darwin") return { command: "say", args: [text], stdin: undefined };
  if (platform === "win32") {
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", WIN_SPEECH_SCRIPT], stdin: text };
  }
  const linux = linuxTts !== undefined ? linuxTts : findLinuxTts();
  if (linux === "espeak") return { command: "espeak", args: [text], stdin: undefined };
  if (linux === "spd-say") return { command: "spd-say", args: [text], stdin: undefined };
  return null; // no known TTS binary on this Linux box — caller falls back to text-only
}

/**
 * Actually speak `text` aloud. Never throws. Returns true if a TTS process
 * was launched (not a guarantee it produced audio — e.g. a mis-signed
 * macOS `say` sandbox restriction could still silently no-op), false if no
 * TTS was available or the spawn itself failed synchronously.
 * `onUnavailable` is called at most once per invocation, for callers that
 * want to show a one-time "voice not available, falling back to text" notice.
 *
 * `onDone` (optional, backward-compatible) is called at most once when the
 * spawned TTS process finishes — on its `close` event (spoke, then exited) OR
 * on an async `error` event (e.g. post-spawn ENOENT). It exists so callers
 * that duck other audio while speaking can un-duck the instant speech ends.
 * Callers that pass no `onDone` are completely unaffected: `speak()` still
 * returns synchronously (true if a process launched, false otherwise), and
 * no behavior changes for them. If the child never fires either event,
 * `onDone` is not called — callers needing a hard guarantee should keep their
 * own timeout fallback (extension.js does).
 */
function speak(text, { onUnavailable, onDone } = {}) {
  // Fire onDone at most once, whichever path resolves first (no plan,
  // synchronous spawn failure, async error, or normal close).
  let doneFired = false;
  const fireDone = () => {
    if (doneFired) return;
    doneFired = true;
    try { onDone?.(); } catch { /* never let a caller's callback crash us */ }
  };
  let plan;
  try {
    plan = buildSpeakPlan(text);
  } catch {
    plan = null;
  }
  if (!plan) {
    try { onUnavailable?.(); } catch { /* never let a caller's callback crash us */ }
    fireDone(); // speech won't happen — resolve immediately so a ducking caller un-ducks
    return false;
  }
  try {
    const child = spawn(plan.command, plan.args, {
      stdio: plan.stdin !== undefined ? ["pipe", "ignore", "ignore"] : "ignore",
    });
    // Load-bearing: an unhandled 'error' event on a ChildProcess crashes the
    // whole Node process. A missing binary (ENOENT) surfaces here async,
    // AFTER spawn() returns without throwing — this listener is what turns
    // that into a graceful fallback instead of taking down the extension host.
    child.on("error", () => {
      try { onUnavailable?.(); } catch { /* ignore */ }
      fireDone(); // an ENOENT here means speech never happens — don't leave a ducked caller stuck
    });
    child.on("close", () => {
      fireDone(); // normal completion: process spoke (or no-op'd) and exited
    });
    if (plan.stdin !== undefined && child.stdin) {
      child.stdin.write(plan.stdin);
      child.stdin.end();
    }
    return true;
  } catch {
    try { onUnavailable?.(); } catch { /* ignore */ }
    fireDone();
    return false;
  }
}

module.exports = { buildSpeakPlan, speak, findLinuxTts, WIN_SPEECH_SCRIPT, LINUX_TTS_CANDIDATES };
