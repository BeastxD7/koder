import type { Metadata } from "next";
import DocArticle from "../_components/DocArticle";
import DocHeader, { AccessRow } from "../_components/DocHeader";
import Callout from "../_components/Callout";

export const metadata: Metadata = {
  title: "Voice Mode",
  description: "Offline push-to-talk dictation into the composer, with a configurable toggle hotkey.",
};

export default function VoicePage() {
  return (
    <DocArticle>
      <DocHeader eyebrow="Voice" title="Voice Mode">
        Dictate straight into the composer instead of typing. Hold the mic button to talk, or bind a toggle
        hotkey and use it hands-free — transcription runs entirely on your machine.
      </DocHeader>

      <AccessRow
        items={[
          { label: "Where", value: "mic icon in the composer" },
          { label: "Hold", value: "press and hold" },
          { label: "Or", value: "toggle hotkey (set in Settings)" },
        ]}
      />

      <h2>Hold to talk</h2>
      <p>
        Press and hold the mic button next to <strong>Send</strong>, speak, then release. LakshX transcribes
        what you said and inserts it at the caret in the composer — it never sends automatically, so
        you always get to review or edit the text first.
      </p>

      <h2>Push-to-talk hotkey</h2>
      <p>
        Prefer not to hold your mouse down? Open the AI Providers panel and set a{" "}
        <strong>Push-to-talk hotkey</strong> under the voice section. Unlike the mic button, the hotkey is a{" "}
        <strong>toggle</strong>: press it once to start recording, press it again to stop — a bare
        key-release is too unreliable to catch consistently, so a toggle sidesteps that. It only fires while
        the LakshX panel itself has focus, not from an editor tab.
      </p>
      <ul>
        <li>Any function key (<code>F1</code>–<code>F24</code>) works on its own.</li>
        <li>
          Anything else needs a modifier — <code>Ctrl</code>, <code>Alt</code>, or <code>Cmd</code>/
          <code>Win</code> — so the binding can never collide with normal typing.
        </li>
      </ul>

      <h2>Fully local, first-use download</h2>
      <p>
        Transcription runs on your machine via a bundled Whisper model (<code>base.en</code>) — no
        cloud speech API, no account, no per-use cost. The first time you use it, LakshX downloads the model
        (about 142MB) into <code>~/.lakshx/models</code> and caches it there; every recording after that is
        transcribed offline. Recognition is seeded with a prompt biased toward code and developer vocabulary,
        so identifiers, library names, and commands come through more cleanly than a general-purpose
        dictation engine.
      </p>

      <Callout variant="note" title="If the mic button says it can&rsquo;t get access">
        Microphone capture needs the underlying Electron shell patched to allow it — LakshX ships that
        patch, but on a build where it hasn&rsquo;t taken (or where your OS denies mic permission), the mic
        button fails gracefully with a clear message instead of silently doing nothing. Check your OS privacy
        settings first; if it&rsquo;s still blocked after that, it&rsquo;s the former.
      </Callout>

      <Callout variant="tip" title="Voice can be turned off">
        The mic button is on by default. If you&rsquo;d rather not see it, set{" "}
        <code>lakshx.voice.enabled</code> to <code>false</code> in your VS Code settings.
      </Callout>
    </DocArticle>
  );
}
