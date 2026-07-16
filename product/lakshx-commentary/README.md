# LakshX Commentary

A cheeky cricket-commentary-style companion that reacts to what you (and the
agent) do in the IDE — spoken aloud via free OS-native text-to-speech. No LLM
calls by default.

This extension has two independent features:

1. **Commentary** — the spoken one-liners (Tier 1 canned lines, optional Tier 2
   AI quips). Master switch: `lakshx.commentary.enabled`.
2. **LakshX FM** — opt-in background music that plays in a small webview player.
   Completely separate from commentary mute.

---

## LakshX FM — background music

LakshX FM streams internet radio (or your own local tracks) inside a VS Code
webview panel that uses an HTML5 `<audio>` element. Because the webview is
Chromium, playback behaves identically on macOS, Windows, and Linux, and the
panel keeps playing while its tab is hidden (`retainContextWhenHidden`).

**It is OFF by default.** Music is a separate axis from commentary mute — muting
commentary does not stop the music, and vice-versa.

### Turning it on / controlling it

- Click the **`$(play) LakshX FM`** item in the status bar (priority 995, just
  left of the Commentary item). This opens the station QuickPick.
- Commands (Command Palette):
  - **LakshX FM: Toggle Background Music (Play/Pause)** — `lakshx.commentary.music.toggle`
  - **LakshX FM: Pick Station / Add Custom Stream** — `lakshx.commentary.music.pickStation`

> **First play must be a real click inside the player panel.** Chromium's
> autoplay policy blocks programmatic playback until the user has clicked once.
> When you first enable LakshX FM the player panel opens with a big **▶ Play**
> button — click it once. After that, the status-bar item can pause/resume it.

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `lakshx.commentary.music.enabled` | `false` | Master on/off for the music feature (opt-in). |
| `lakshx.commentary.music.station` | `rp-main` | Built-in station id, or a custom `https://` URL. |
| `lakshx.commentary.music.volume` | `60` | Volume 0–100 (also the panel's slider). |
| `lakshx.commentary.music.duckDuringCommentary` | `true` | Briefly lower the music to ~15% while a commentary line is spoken, then restore. |

### Built-in stations

| Station | Stream | Notes |
| --- | --- | --- |
| **Radio Paradise — Main Mix** | `https://stream.radioparadise.com/aac-128` | Eclectic, listener-supported. |
| **Radio Paradise — Mellow Mix** | `https://stream.radioparadise.com/mellow-aac-128` | Quieter, good for focus. |

Only **HTTPS** streams work — `http://` URLs are blocked as mixed content inside
the webview.

### Adding a custom stream

Pick **➕ Add custom stream…** from the station QuickPick, paste an `https://`
stream URL, and it is validated (must be https) and remembered. Your custom
streams appear in the QuickPick from then on. The player's Content-Security-Policy
`media-src` is expanded at runtime to allow the origins of your custom streams.

### SomaFM — not included (ToS)

SomaFM channels are **deliberately not shipped** as built-in stations. SomaFM's
Terms of Service prohibit embedding its streams in a commercial product without
**written permission**. If you personally want to listen to a SomaFM channel you
can add it yourself via **Add custom stream…** using its HTTPS URL, e.g.
`https://ice.somafm.com/groovesalad-128-aac`. Note that SomaFM fronts each
channel behind failover hosts `ice1.somafm.com … ice6.somafm.com`; prefer the
plain `https://ice.somafm.com/<channel>` alias, and be aware an individual
ice1–6 host may be down while others are up.

For LakshX to ship SomaFM by default, written permission from SomaFM would be
required first. The channel URLs are documented (commented out, not enabled) in
`lib/music.js`.

### "LakshX Focus" — bundle your own CC0 / CC-BY tracks

There is a scaffolded **LakshX Focus** station that plays local audio files from
`media/tracks/` (served to the webview via `webview.asWebviewUri`). **No audio is
bundled with this extension.** The station is hidden from the picker while
`media/tracks/` is empty.

To enable it, drop royalty-free audio files into `product/lakshx-commentary/media/tracks/`:

- **CC0 / public-domain** tracks require no attribution. Good sources include CC0
  music libraries.
- **CC-BY** tracks (e.g. incompetech.com by Kevin MacLeod) are allowed **but you
  must provide attribution** — add the required credit line (title, author,
  license, source URL) alongside the files, and surface it in the player UI/README
  before distributing.

Supported extensions: `.mp3`, `.ogg`, `.m4a`, `.aac`, `.wav`, `.flac`, `.opus`,
`.webm`. Do **not** commit copyrighted audio you do not have the right to
redistribute.

---

## Development / testing

- Unit tests: `npm run test:unit` (pure-function tests, including `lib/music.js`).
- Visual player harness (no VS Code host needed): serve the extension root over
  http and open `test/harness.html` — it reproduces the player DOM with a
  permissive dev CSP and a mock `acquireVsCodeApi()`, and loads the **real**
  `media/player.js`. See the comment at the top of that file.
