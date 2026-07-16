# Voice mode (STT) in the chat composer — design + the gate

Push-to-talk dictation into the composer, all three OSes, free/offline.

## Recommendation: uniform local Whisper (not per-OS native STT)

"Use each OS's default STT" fails — **Linux has no built-in STT** (macOS has
SFSpeechRecognizer, Windows has Windows.Media.SpeechRecognition, Linux has
nothing), so that path forces Whisper on Linux anyway and gives 3 code paths
of inconsistent quality. Instead use ONE stack everywhere:

- **whisper.cpp via the `smart-whisper` native addon** (MIT, prebuilt for
  Win/Mac/Linux — no per-user compile), in the extension host.
- **base.en** model (~142 MB; tiny.en ~75 MB if footprint matters), downloaded
  on first voice use and cached under `.lakshx/` (keeps the installer lean).
- `initial_prompt` seeded with code/tech terms to bias recognition — a real
  advantage over the OS engines.
- Offline, free, no signup, no per-use cost. Audio never leaves the machine —
  lead with that as a privacy selling point.

Note for the owner: the official `ms-vscode.vscode-speech` extension is nice
but only dictates into the editor/Copilot chat with no API to feed our
composer, so it can't be reused.

## The gate — why this isn't a blind build

**getUserMedia is BLOCKED in stock VS Code webviews** (microsoft/vscode
#250568). LakshX is a fork, so it CAN unblock it, but that requires patching
`upstream/` at 3 points and REBUILDING Electron:

1. `upstream/src/vs/code/electron-main/app.ts` (~L196-222): add `'media'` to
   `allowedPermissionsInWebview` (currently only in `...InCore`). SECURITY:
   scope it to the LakshX chat webview via `details.requestingUrl`, don't
   grant mic to all webviews blanket.
2. `upstream/.../webview/browser/webviewElement.ts:427`: add microphone to the
   outer iframe `allow` list.
3. `upstream/.../webview/browser/pre/index.html:1038`: add microphone to the
   inner (nested) iframe `allow` list — this inner frame runs panel.js.

**Cross-origin subtlety that will silently fail:** the inner frame is a
different origin (`vscode-webview://`), so bare `allow="microphone"` (defaults
to same-origin) likely won't delegate — need **`microphone *`** at BOTH iframe
levels. Get this wrong and you still get "microphone is not allowed in this
document" and wrongly conclude the whole approach failed.

**Therefore: do a ~1-hour spike FIRST** — apply the 3 patches with
`microphone *`, rebuild, call `getUserMedia({audio:true})` from the composer
webview, confirm a live MediaStream. Only build the STT pipeline after the
spike passes. This is why voice is NOT being auto-built unattended: it can't
be verified without a full Electron rebuild (heavy; disk has been tight) and
the permission-propagation behavior is genuinely uncertain until tested.

## Capture path (after the spike passes)

Capture in the webview, NOT MediaRecorder (which yields WebM/Opus): use
`new AudioContext({ sampleRate: 16000 })` + a `ScriptProcessorNode` (dodges
the CSP AudioWorklet-module-load issue under `default-src 'none'`) to
accumulate **Float32 PCM at 16 kHz mono**, postMessage the buffer to the
extension, feed straight into `smart-whisper.transcribe(pcm, {language:"en",
initial_prompt})`. No WAV, no ffmpeg, no per-OS recorder binary.

Fallback if the fork owner won't patch Electron: native capture in the host —
but mac/Windows have no built-in CLI recorder (bundle ffmpeg/PortAudio), only
Linux has `arecord`. Much worse; the 3-patch webview path is strongly preferred.

## Wiring (turnkey touch points)

- New patch file in `patches/` with the 3 hunks above (apply-verify via
  scripts/prepare.sh; runtime behavior needs the rebuild + spike).
- `product/lakshx-chat/media/panel.js`: mic button next to `#send` (mirror
  attachBtn ~L886); push-to-talk (hold=record, release=transcribe); recording
  pulse; on release postMessage `{type:"transcribeAudio", pcm}`.
- `product/lakshx-chat/extension.js`: `case "transcribeAudio"` in
  onWebviewMessage (~L1114) — ensure model downloaded (progress via a system
  message), run smart-whisper (try/catch, never crash the host — mirror
  lakshx-commentary/lib/tts.js graceful-fallback discipline), post
  `{type:"transcribedText", text}`.
- panel.js inbound `case "transcribedText"`: insert at caret (reuse pickMention
  caret-splice), do NOT auto-send — let the user review/edit.
- macOS: fork Info.plist needs `NSMicrophoneUsageDescription`.

## v1 scope

English-only base.en (or tiny.en), push-to-talk only (no wake word/VAD),
download-model-on-first-use, insert-don't-send, whole-clip transcription (no
streaming partials).

## Status

Design locked. Implementation is GATED on: (1) the mic-permission spike +
Electron rebuild, (2) the serial lakshx-chat lane (behind db_query wiring and
Stage 2), (3) owner sign-off on adding the smart-whisper native dependency +
model download. Not auto-built — flagged for the owner.
