// Unit tests for voice.js — voice mode (push-to-talk STT in the composer,
// docs/research/14-voice-mode.md). Same extraction pattern as
// commands.js/diagnostics.js/crash-context.js: everything here is pure
// logic (path resolution, prompt/option building, PCM math, the
// caret-splice algorithm, and the transcribeAudio orchestration flow via
// dependency injection) so it's directly unit-testable with plain
// `node --test`, no vscode host and no Extension Host needed.
//
// NOT covered here (and NOT verifiable in this environment — see the
// project's build report): ensureModel()'s real network download, and
// transcribe()'s real call into the smart-whisper native addon. Both
// require things this sandbox doesn't have (a live model download, a built
// native addon) and are excluded from this file's require() list entirely
// other than by reference in comments — no test pretends to exercise them.
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  modelsDir,
  modelPath,
  isModelDownloaded,
  buildTranscribeOptions,
  concatFloat32,
  expectedSampleRate,
  pcmDurationSeconds,
  insertAtCaret,
  joinSegments,
  handleTranscribeAudio,
  MODEL_FILENAME,
  INITIAL_PROMPT,
} = require("../voice.js");

// ---------- model path resolution ----------

test("modelsDir/modelPath resolve under <home>/.lakshx/models, same convention as providers.json etc.", () => {
  const home = "/fake/home";
  assert.equal(modelsDir(home), path.join("/fake/home", ".lakshx", "models"));
  assert.equal(modelPath(home), path.join("/fake/home", ".lakshx", "models", MODEL_FILENAME));
});

test("modelsDir/modelPath default to the real os.homedir() when no override is given", () => {
  assert.equal(modelsDir(), path.join(os.homedir(), ".lakshx", "models"));
});

test("isModelDownloaded is false when the model file doesn't exist", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lakshx-voice-test-"));
  assert.equal(isModelDownloaded(home), false);
});

test("isModelDownloaded is true once the model file is present", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lakshx-voice-test-"));
  fs.mkdirSync(modelsDir(home), { recursive: true });
  fs.writeFileSync(modelPath(home), "not a real model, just a marker file");
  assert.equal(isModelDownloaded(home), true);
});

test("isModelDownloaded is false (not a throw) for an unreadable/garbage home path", () => {
  assert.equal(isModelDownloaded("\0invalid"), false);
});

// ---------- transcribe options ----------

test("buildTranscribeOptions defaults to English with the seeded code/tech initial_prompt", () => {
  const opts = buildTranscribeOptions();
  assert.equal(opts.language, "en");
  assert.equal(opts.initial_prompt, INITIAL_PROMPT);
});

test("buildTranscribeOptions lets both fields be overridden", () => {
  const opts = buildTranscribeOptions({ language: "auto", initialPrompt: "custom prompt" });
  assert.deepEqual(opts, { language: "auto", initial_prompt: "custom prompt" });
});

// ---------- PCM math ----------

test("expectedSampleRate is 16kHz, matching the capture pipeline's AudioContext rate", () => {
  assert.equal(expectedSampleRate(), 16000);
});

test("concatFloat32 joins chunks in order into one contiguous buffer", () => {
  const merged = concatFloat32([Float32Array.of(1, 2), Float32Array.of(3), Float32Array.of(4, 5, 6)]);
  assert.deepEqual(Array.from(merged), [1, 2, 3, 4, 5, 6]);
});

test("concatFloat32 of an empty chunk list is an empty Float32Array", () => {
  const merged = concatFloat32([]);
  assert.equal(merged.length, 0);
  assert.ok(merged instanceof Float32Array);
});

test("concatFloat32 tolerates empty chunks mixed with real ones", () => {
  const merged = concatFloat32([Float32Array.of(), Float32Array.of(1), Float32Array.of()]);
  assert.deepEqual(Array.from(merged), [1]);
});

test("pcmDurationSeconds divides sample count by sample rate", () => {
  assert.equal(pcmDurationSeconds(new Float32Array(16000)), 1);
  assert.equal(pcmDurationSeconds(new Float32Array(8000)), 0.5);
  assert.equal(pcmDurationSeconds(new Float32Array(4000), 8000), 0.5);
});

// ---------- insertAtCaret (caret-splice, mirrored in media/panel.js) ----------

test("insertAtCaret inserts at the caret with no existing selection", () => {
  // Caret sits right after "fix" (a non-whitespace char), so a separating
  // space is added before the inserted text; the trailing " the bug" then
  // contributes its own leading space, giving a (harmless, cosmetic) double
  // space — a known shape of this simple algorithm, asserted here as-is.
  const { value, caret } = insertAtCaret("fix the bug", 3, 3, "quickly ");
  assert.equal(value, "fix quickly  the bug");
  assert.equal(caret, "fix quickly ".length);
});

test("insertAtCaret: caret mid-word inserts with a leading space when preceding char is non-whitespace", () => {
  const { value, caret } = insertAtCaret("fixbug", 3, 3, "the");
  assert.equal(value, "fix thebug");
  assert.equal(caret, "fix the".length);
});

test("insertAtCaret: no leading space added when already preceded by whitespace", () => {
  const { value, caret } = insertAtCaret("fix ", 4, 4, "the bug");
  assert.equal(value, "fix the bug");
  assert.equal(caret, "fix the bug".length);
});

test("insertAtCaret: at position 0 of an empty composer, no leading space", () => {
  const { value, caret } = insertAtCaret("", 0, 0, "hello world");
  assert.equal(value, "hello world");
  assert.equal(caret, "hello world".length);
});

test("insertAtCaret: a non-collapsed selection is replaced by the inserted text", () => {
  const { value, caret } = insertAtCaret("fix the old bug", 8, 11, "new");
  assert.equal(value, "fix the new bug");
  assert.equal(caret, "fix the new".length);
});

test("insertAtCaret: empty insertText just removes the selection and leaves the caret there", () => {
  const { value, caret } = insertAtCaret("fix the old bug", 8, 11, "");
  assert.equal(value, "fix the  bug");
  assert.equal(caret, 8);
});

test("insertAtCaret: inserting in the middle preserves the tail", () => {
  const { value, caret } = insertAtCaret("start end", 5, 5, "middle");
  assert.equal(value, "start middle end");
  assert.equal(caret, "start middle".length);
});

// ---------- joinSegments (defensive result-shape handling) ----------

test("joinSegments joins an array of {text} segments with no separator", () => {
  assert.equal(joinSegments([{ text: "hello " }, { text: "world" }]), "hello world");
});

test("joinSegments trims the joined result", () => {
  assert.equal(joinSegments([{ text: "  hello world  " }]), "hello world");
});

test("joinSegments passes through a plain string result, trimmed", () => {
  assert.equal(joinSegments("  already a string  "), "already a string");
});

test("joinSegments tolerates segments that are themselves plain strings", () => {
  assert.equal(joinSegments(["hello ", "world"]), "hello world");
});

test("joinSegments returns empty string for an unrecognized shape", () => {
  assert.equal(joinSegments(null), "");
  assert.equal(joinSegments(undefined), "");
  assert.equal(joinSegments(42), "");
});

test("joinSegments returns empty string for an empty segment array", () => {
  assert.equal(joinSegments([]), "");
});

// ---------- handleTranscribeAudio (orchestration, dependency-injected) ----------
//
// Mocks every dependency (isModelDownloaded/ensureModel/runTranscribe/post)
// the way remote-server.test.js mocks onControl — asserting on the exact
// sequence of post() calls this drives, since that sequence is exactly what
// extension.js's real vscode-bound `post` (webview.postMessage) will relay
// to panel.js.

function postRecorder() {
  const calls = [];
  return { calls, post: (msg) => calls.push(msg) };
}

test("handleTranscribeAudio: empty pcm short-circuits with a system message and still ends with transcribeAudioDone", async () => {
  const { calls, post } = postRecorder();
  let ensureModelCalled = false;
  let runTranscribeCalled = false;
  await handleTranscribeAudio({
    pcm: new Float32Array(0),
    isModelDownloaded: () => true,
    ensureModel: async () => { ensureModelCalled = true; },
    runTranscribe: async () => { runTranscribeCalled = true; return "should not run"; },
    post,
  });
  assert.equal(ensureModelCalled, false);
  assert.equal(runTranscribeCalled, false);
  assert.deepEqual(calls, [
    { type: "system", text: "No audio captured — try holding the mic button a little longer." },
    { type: "transcribeAudioDone" },
  ]);
});

test("handleTranscribeAudio: null/undefined pcm is treated the same as empty", async () => {
  const { calls, post } = postRecorder();
  await handleTranscribeAudio({
    pcm: null,
    isModelDownloaded: () => true,
    ensureModel: async () => {},
    runTranscribe: async () => "x",
    post,
  });
  assert.equal(calls[0].type, "system");
  assert.equal(calls.at(-1).type, "transcribeAudioDone");
});

test("handleTranscribeAudio: model already downloaded skips the download messages entirely", async () => {
  const { calls, post } = postRecorder();
  const text = await new Promise((resolve) => {
    handleTranscribeAudio({
      pcm: new Float32Array([0.1, 0.2]),
      isModelDownloaded: () => true,
      ensureModel: async () => { throw new Error("must not be called"); },
      runTranscribe: async (pcm) => { resolve(pcm); return "hello world"; },
      post,
    });
  });
  assert.equal(text.length, 2);
  assert.deepEqual(calls, [
    { type: "transcribedText", text: "hello world" },
    { type: "transcribeAudioDone" },
  ]);
});

test("handleTranscribeAudio: model not downloaded posts a download-started message, runs ensureModel, then a ready message, then transcribes", async () => {
  const { calls, post } = postRecorder();
  let ensureModelCalled = false;
  await handleTranscribeAudio({
    pcm: new Float32Array([0.1]),
    isModelDownloaded: () => false,
    ensureModel: async ({ onProgress }) => {
      ensureModelCalled = true;
      onProgress({ receivedMb: 71, totalMb: 142 }); // 50% — should surface
      onProgress({ receivedMb: 72, totalMb: 142 }); // +0.7% — throttled out
    },
    runTranscribe: async () => "done",
    post,
  });
  assert.equal(ensureModelCalled, true);
  const texts = calls.map((c) => c.text ?? c.type);
  assert.equal(texts[0], "Downloading speech-to-text model (base.en, ~142MB)... this happens once.");
  assert.ok(texts[1].includes("50%"), `expected a 50% progress message, got: ${texts[1]}`);
  assert.equal(texts.filter((t) => typeof t === "string" && t.includes("%")).length, 1, "the +0.7% progress update should have been throttled out");
  assert.equal(texts[2], "Speech-to-text model ready.");
  assert.deepEqual(calls.at(-2), { type: "transcribedText", text: "done" });
  assert.deepEqual(calls.at(-1), { type: "transcribeAudioDone" });
});

test("handleTranscribeAudio: empty transcription result posts a 'no speech' message, not transcribedText", async () => {
  const { calls, post } = postRecorder();
  await handleTranscribeAudio({
    pcm: new Float32Array([0.1]),
    isModelDownloaded: () => true,
    ensureModel: async () => {},
    runTranscribe: async () => "",
    post,
  });
  assert.deepEqual(calls, [
    { type: "system", text: "Didn't catch any speech in that recording — try again." },
    { type: "transcribeAudioDone" },
  ]);
});

test("handleTranscribeAudio: a thrown error from runTranscribe becomes a system message, never an unhandled rejection", async () => {
  const { calls, post } = postRecorder();
  await assert.doesNotReject(
    handleTranscribeAudio({
      pcm: new Float32Array([0.1]),
      isModelDownloaded: () => true,
      ensureModel: async () => {},
      runTranscribe: async () => { throw new Error("native addon exploded"); },
      post,
    })
  );
  assert.deepEqual(calls, [
    { type: "system", text: "Voice transcription failed: native addon exploded" },
    { type: "transcribeAudioDone" },
  ]);
});

test("handleTranscribeAudio: a thrown error from ensureModel (e.g. network failure) also becomes a clean system message", async () => {
  const { calls, post } = postRecorder();
  await assert.doesNotReject(
    handleTranscribeAudio({
      pcm: new Float32Array([0.1]),
      isModelDownloaded: () => false,
      ensureModel: async () => { throw new Error("ENOTFOUND huggingface.co"); },
      runTranscribe: async () => { throw new Error("must not be reached"); },
      post,
    })
  );
  const last = calls.at(-1);
  assert.deepEqual(last, { type: "transcribeAudioDone" });
  assert.ok(calls.some((c) => c.type === "system" && c.text.includes("ENOTFOUND")));
});

test("handleTranscribeAudio always ends with exactly one transcribeAudioDone, regardless of outcome", async () => {
  for (const scenario of [
    { pcm: new Float32Array(0) },
    { pcm: new Float32Array([1]), downloaded: true, result: "hi" },
    { pcm: new Float32Array([1]), downloaded: true, result: "" },
    { pcm: new Float32Array([1]), downloaded: true, throws: true },
  ]) {
    const { calls, post } = postRecorder();
    await handleTranscribeAudio({
      pcm: scenario.pcm,
      isModelDownloaded: () => !!scenario.downloaded,
      ensureModel: async () => {},
      runTranscribe: async () => {
        if (scenario.throws) throw new Error("boom");
        return scenario.result ?? "";
      },
      post,
    });
    const doneCount = calls.filter((c) => c.type === "transcribeAudioDone").length;
    assert.equal(doneCount, 1, `expected exactly one transcribeAudioDone, got ${doneCount} for scenario ${JSON.stringify(scenario)}`);
    assert.equal(calls.at(-1).type, "transcribeAudioDone", "transcribeAudioDone must be the LAST message");
  }
});
