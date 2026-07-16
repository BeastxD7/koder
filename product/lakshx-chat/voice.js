// Voice mode (push-to-talk STT in the chat composer) — docs/research/14-voice-mode.md.
// Wraps the `smart-whisper` native addon (whisper.cpp bindings): model
// download-on-first-use, prompt-building, and the transcribe call itself.
//
// Split the same way commands.js/diagnostics.js/crash-context.js are split
// from extension.js: everything that's pure logic (path resolution, prompt
// text, PCM buffer math, the transcribeAudio orchestration flow) lives here
// with zero `vscode` dependency, so it's directly unit-testable with plain
// `node --test` (see test/voice.test.js) instead of only exercisable inside
// a running extension host. The two functions that actually touch the
// network (`ensureModel`) and the native addon (`transcribe`) are ALSO here,
// but are not (and cannot be, in this environment) unit-tested themselves —
// see the header of test/voice.test.js for exactly what is and isn't
// covered.
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// ---------- model identity ----------
//
// v1 scope is fixed to base.en (docs/research/14-voice-mode.md's "v1 scope"
// section) — no config surface for model size yet.
const MODEL_NAME = "base.en";
const MODEL_FILENAME = "ggml-base.en.bin";
// Standard whisper.cpp ggml model host (the same one whisper.cpp's own
// models/download-ggml-model.sh pulls from). Only ever read by ensureModel()
// below, which this environment never actually runs (no network download
// was attempted as part of this build — see the report).
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILENAME}`;
// Approximate size (MiB) for the first-use download progress message —
// matches the design doc's "~142 MB" figure. Not read from the server;
// purely a human-readable estimate shown before the real Content-Length is
// known (or if the server never sends one).
const MODEL_APPROX_MB = 142;

/**
 * ~/.lakshx/models — same home-relative convention every other LakshX cache
 * dir uses (providers.json, chats/, feedback/, commands/ — all under
 * `~/.lakshx`, never workspace-relative, per extension.js). Takes an
 * injectable `homedir` (defaults to `os.homedir()`) purely so tests don't
 * need to touch the real home directory.
 */
function modelsDir(homedir = os.homedir()) {
  return path.join(homedir, ".lakshx", "models");
}

function modelPath(homedir = os.homedir()) {
  return path.join(modelsDir(homedir), MODEL_FILENAME);
}

/** True if the base.en model file is already present on disk. */
function isModelDownloaded(homedir = os.homedir()) {
  try {
    return fs.statSync(modelPath(homedir)).isFile();
  } catch {
    return false;
  }
}

// ---------- transcription options ----------
//
// Seeded with code/tech terms to bias recognition — docs/research/14's
// stated advantage of a local model over OS STT engines: an `initial_prompt`
// the OS engines have no equivalent hook for.
const INITIAL_PROMPT =
  "The following is a transcript of a software developer dictating code, " +
  "file paths, and technical instructions. Common terms: function, " +
  "variable, array, npm, git, commit, branch, pull request, TypeScript, " +
  "JavaScript, Python, React, async, await, API, JSON, endpoint, refactor, " +
  "debug, repo, repository, terminal, console, boolean, null, undefined.";

/**
 * Builds the options object passed to `whisper.transcribe(pcm, options)`.
 * Pure — no I/O, no vscode. Exists mainly so both the real call site and
 * tests share one source of truth for the option shape the design doc
 * specifies (`{language:"en", initial_prompt}`).
 */
function buildTranscribeOptions({ language = "en", initialPrompt = INITIAL_PROMPT } = {}) {
  return { language, initial_prompt: initialPrompt };
}

// ---------- PCM helpers ----------

const SAMPLE_RATE = 16000; // Float32 PCM at 16 kHz mono, per the design doc's capture path.

function expectedSampleRate() {
  return SAMPLE_RATE;
}

/**
 * Concatenates an array of Float32Array chunks (as pushed by panel.js's
 * ScriptProcessorNode callback while the mic button is held) into one
 * contiguous Float32Array — the shape `whisper.transcribe` expects. Pure
 * math, no I/O.
 */
function concatFloat32(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Clip duration in seconds for a given Float32 PCM buffer at `sampleRate`. */
function pcmDurationSeconds(float32Array, sampleRate = SAMPLE_RATE) {
  return float32Array.length / sampleRate;
}

// ---------- caret-splice (insert-don't-send) ----------
//
// Mirrors pickMention's caret-splice pattern in media/panel.js (the @-mention
// picker): compute a new composer value + caret position from the current
// value/selection and inserted text. Kept here as the single tested source
// of truth for the algorithm.
//
// panel.js runs inside the sandboxed webview (CSP `default-src 'none'`, no
// module loader), so it CANNOT `require("./voice.js")` — it re-implements
// this exact same algorithm inline (see insertTranscribedText in
// media/panel.js). Keep the two in lockstep if this changes; this copy is
// the one test/voice.test.js exercises.
/**
 * @param {string} value current composer textarea value
 * @param {number} selectionStart
 * @param {number} selectionEnd
 * @param {string} insertText transcribed text to insert
 * @returns {{ value: string, caret: number }}
 */
function insertAtCaret(value, selectionStart, selectionEnd, insertText) {
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  if (!insertText) {
    return { value: before + after, caret: before.length };
  }
  // If there's already non-whitespace immediately before the caret, add a
  // separating space so a transcript doesn't weld onto existing text (e.g.
  // "fix thebug" instead of "fix the bug") when the user dictates a
  // continuation without repositioning the caret first.
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const inserted = needsLeadingSpace ? " " + insertText : insertText;
  const newValue = before + inserted + after;
  return { value: newValue, caret: (before + inserted).length };
}

// ---------- model download (real network I/O — not unit-tested here) ----------

/**
 * Downloads the base.en ggml model to `modelPath()` if not already present,
 * reporting progress via `onProgress({ receivedMb, totalMb })`. Streams to a
 * `.part` temp file and renames on completion so a cancelled/failed download
 * never leaves a corrupt file at the real path for isModelDownloaded() to
 * wrongly trust.
 *
 * NOT exercised by any automated test in this build: it requires a live
 * network fetch of a ~142MB file, which this disk- and network-constrained
 * verification pass deliberately did not attempt. Treat as unverified.
 */
const MAX_REDIRECTS = 5;

async function ensureModel({ onProgress, homedir = os.homedir() } = {}) {
  if (isModelDownloaded(homedir)) return modelPath(homedir);

  const dir = modelsDir(homedir);
  fs.mkdirSync(dir, { recursive: true });
  const dest = modelPath(homedir);
  const partial = dest + ".part";

  await new Promise((resolve, reject) => {
    // MODEL_URL (huggingface.co/.../resolve/main/...) always 302s to a CDN
    // host, so the redirect branch below is the REAL path taken on every
    // download, not a rare edge case. The write stream is only opened once
    // we have a genuine 200 response — opening it eagerly and writing a
    // redirected response into an already-closed stream (an earlier draft
    // of this function did exactly that) would throw on the very first
    // chunk and leave `renameSync` promoting an empty `.part` file.
    const follow = (url, redirectsLeft) => {
      https
        .get(url, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume(); // discard this response's body before following
            if (redirectsLeft <= 0) {
              reject(new Error("too many redirects downloading the speech-to-text model"));
              return;
            }
            follow(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`model download failed: HTTP ${res.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(partial);
          const total = Number(res.headers["content-length"]) || MODEL_APPROX_MB * 1024 * 1024;
          let received = 0;
          res.on("data", (chunk) => {
            received += chunk.length;
            if (onProgress) {
              onProgress({ receivedMb: Math.round(received / 1024 / 1024), totalMb: Math.round(total / 1024 / 1024) });
            }
          });
          res.pipe(file);
          file.on("finish", () => file.close(() => resolve()));
          res.on("error", reject);
          file.on("error", reject);
        })
        .on("error", reject);
    };
    follow(MODEL_URL, MAX_REDIRECTS);
  });

  fs.renameSync(partial, dest);
  return dest;
}

// ---------- transcribe (native addon — not unit-tested here) ----------

/**
 * Runs whisper.cpp (via smart-whisper) over a Float32 PCM buffer and returns
 * the joined transcript text. Lazily requires "smart-whisper" so this module
 * can be loaded (and its pure helpers tested) in environments where the
 * native addon isn't installed/built.
 *
 * NOT exercised by any automated test in this build: it requires the
 * smart-whisper native addon to be compiled (this environment could not
 * safely run `npm install` for it — see the report) and a downloaded model.
 * Treat as unverified; the exact shape of `task.result` (array of segments
 * vs plain string) is defended against below but not confirmed against a
 * real run.
 */
async function transcribe(pcmFloat32Array, opts = {}, { homedir = os.homedir() } = {}) {
  // eslint-disable-next-line global-require
  const { Whisper } = require("smart-whisper");
  const whisper = new Whisper(modelPath(homedir), { gpu: false });
  try {
    const task = await whisper.transcribe(pcmFloat32Array, buildTranscribeOptions(opts));
    const result = await task.result;
    return joinSegments(result);
  } finally {
    await whisper.free();
  }
}

/** Defensive join: result may be an array of {text} segments or a plain string. */
function joinSegments(result) {
  if (typeof result === "string") return result.trim();
  if (Array.isArray(result)) {
    return result
      .map((seg) => (typeof seg === "string" ? seg : seg?.text ?? ""))
      .join("")
      .trim();
  }
  return "";
}

// ---------- transcribeAudio orchestration (pure given injected deps) ----------

/**
 * The full "transcribeAudio" webview-message handling flow, as pure
 * orchestration over injected dependencies — same reason remote-server.js
 * takes an `onControl` callback instead of reaching for vscode directly.
 * extension.js's `case "transcribeAudio"` handler is a thin wrapper that
 * supplies the real vscode-bound `post`, plus this module's own
 * `isModelDownloaded`/`ensureModel`/`transcribe`.
 *
 * Never throws: every failure path posts a `system` message instead,
 * mirroring the graceful-fallback discipline the design doc asks for
 * (never crash the host).
 *
 * Always posts exactly one terminal `{ type: "transcribeAudioDone" }` at the
 * very end (success OR failure), via `finally`. This is the ONE unambiguous
 * signal panel.js needs to leave its "Transcribing…" disabled state — plain
 * `system` messages alone aren't enough, since the model-download progress
 * path posts several non-terminal `system` messages along the way and
 * panel.js has no other way to tell "still going" from "done".
 *
 * @param {object} deps
 * @param {Float32Array} deps.pcm
 * @param {() => boolean} deps.isModelDownloaded
 * @param {(opts: {onProgress: (p:{receivedMb:number,totalMb:number})=>void}) => Promise<string>} deps.ensureModel
 * @param {(pcm: Float32Array) => Promise<string>} deps.runTranscribe
 * @param {(msg: object) => void} deps.post
 */
async function handleTranscribeAudio({ pcm, isModelDownloaded: isDownloaded, ensureModel: doEnsureModel, runTranscribe, post }) {
  try {
    if (!pcm || pcm.length === 0) {
      post({ type: "system", text: "No audio captured — try holding the mic button a little longer." });
      return;
    }
    if (!isDownloaded()) {
      post({ type: "system", text: `Downloading speech-to-text model (${MODEL_NAME}, ~${MODEL_APPROX_MB}MB)... this happens once.` });
      let lastPct = -1;
      await doEnsureModel({
        onProgress: ({ receivedMb, totalMb }) => {
          const pct = totalMb ? Math.round((receivedMb / totalMb) * 100) : 0;
          // Throttle to every 10% so this doesn't spam the transcript.
          if (pct >= lastPct + 10) {
            lastPct = pct;
            post({ type: "system", text: `Downloading speech-to-text model... ${pct}% (${receivedMb}MB/${totalMb}MB)` });
          }
        },
      });
      post({ type: "system", text: "Speech-to-text model ready." });
    }
    const text = await runTranscribe(pcm);
    if (!text) {
      post({ type: "system", text: "Didn't catch any speech in that recording — try again." });
      return;
    }
    post({ type: "transcribedText", text });
  } catch (err) {
    post({ type: "system", text: `Voice transcription failed: ${err?.message ?? err}` });
  } finally {
    post({ type: "transcribeAudioDone" });
  }
}

module.exports = {
  MODEL_NAME,
  MODEL_FILENAME,
  MODEL_URL,
  MODEL_APPROX_MB,
  INITIAL_PROMPT,
  modelsDir,
  modelPath,
  isModelDownloaded,
  buildTranscribeOptions,
  concatFloat32,
  expectedSampleRate,
  pcmDurationSeconds,
  insertAtCaret,
  joinSegments,
  ensureModel,
  transcribe,
  handleTranscribeAudio,
};
