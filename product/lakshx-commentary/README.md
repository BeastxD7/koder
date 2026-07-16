# LakshX Music

A standalone, in-IDE **music player for vibe coders**. LakshX Music streams
free, embed-permitted internet radio — or your own local CC0/CC-BY tracks —
inside a small VS Code webview panel. No LLM calls, no telemetry, no accounts:
just press play and build.

> **Directory-rename note (future):** this extension lives in
> `product/lakshx-commentary/` and keeps the id `lakshx-commentary` for
> packaging stability. The user-facing product is now **LakshX Music**. A future
> rename of the directory (and the `name` field) to `lakshx-music` is advisable,
> but it touches out-of-lane build tooling (`scripts/apply-ui.mjs` lists the dir
> by name) so it was intentionally left for a dedicated change.

---

## How it works

The player runs an HTML5 `<audio>` element inside a Chromium webview panel, so
playback behaves identically on macOS, Windows, and Linux. The panel keeps
playing while its tab is hidden (`retainContextWhenHidden`). It is **OFF by
default** — opt in when you want music.

### Turning it on / controlling it

- Click the **`$(play) LakshX Music`** item in the status bar (right cluster,
  priority 996). This opens the station QuickPick — play/pause, pick a station,
  add a custom stream, or turn the player off.
- Commands (Command Palette):
  - **LakshX Music: Toggle Playback (Play/Pause)** — `lakshx.music.toggle`
  - **LakshX Music: Pick Station / Add Custom Stream** — `lakshx.music.pickStation`

> **First play must be a real click inside the player panel.** Chromium's
> autoplay policy blocks programmatic playback until the user has clicked once.
> When you first enable LakshX Music the player panel opens with a big **▶ Play**
> button — click it once. After that, the status-bar item can pause/resume it.

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `lakshx.music.enabled` | `false` | Master on/off for the player (opt-in). |
| `lakshx.music.station` | `rp-main` | Built-in station id, or a custom `https://` URL. |
| `lakshx.music.volume` | `60` | Volume 0–100 (also the panel's slider). |

---

## Built-in stations

All built-in radio stations are **Radio Paradise** channels. Radio Paradise is a
listener-supported, 100% commercial-free station that **publishes these exact
stream URLs for third-party players** (its stream-links page is titled *"RP's
Stream URLs for WiFi Radios & other players"*), so embedding them in a player
like this one is expressly what the URLs are for. The player shows the station
name and a link back to radioparadise.com as attribution.

Every stream URL below was verified to resolve over **HTTPS** returning
`audio/aac` (live audio), on the `{channel}-128` path format from RP's own
stream-links page:

| Station | Stream | Vibe |
| --- | --- | --- |
| **Radio Paradise — Main Mix** | `https://stream.radioparadise.com/aac-128` | Eclectic rock/world/electronica. |
| **Radio Paradise — Mellow Mix** | `https://stream.radioparadise.com/mellow-128` | Quieter, low-key — good for focus. |
| **Radio Paradise — Rock Mix** | `https://stream.radioparadise.com/rock-128` | Guitar-forward energy for heads-down building. |
| **Radio Paradise — Global Mix** | `https://stream.radioparadise.com/global-128` | World/downtempo, warm and atmospheric. |
| **Radio Paradise — Beyond (ambient)** | `https://stream.radioparadise.com/beyond-128` | Ambient/instrumental — deep, distraction-free focus. |

Only **HTTPS** streams work — `http://` URLs are blocked as mixed content inside
the webview.

---

## Adding a custom stream

Pick **➕ Add custom stream…** from the station QuickPick, paste an `https://`
stream URL, and it is validated (must be https) and remembered. Your custom
streams appear in the QuickPick from then on. The player's Content-Security-Policy
`media-src` is expanded at runtime to allow the origins of your custom streams
(plus `webview.cspSource` for local files) — HTTPS only.

### SomaFM and other stations — custom-URL only (ToS)

Some great free stations **cannot be shipped as built-ins** because their Terms
of Service forbid embedding in a product without written permission. **SomaFM**
is the canonical example — deliberately not a built-in. If you personally want to
listen you can add it yourself via **Add custom stream…** using its HTTPS URL,
e.g. `https://ice.somafm.com/groovesalad-128-aac`. (SomaFM fronts each channel
behind failover hosts `ice1.somafm.com … ice6.somafm.com`; prefer the plain
`https://ice.somafm.com/<channel>` alias, and note an individual host may be down
while others are up.) These URLs are documented (commented out, not enabled) in
`lib/music.js` — do not move them into the shipped station list without written
permission first.

The rule for adding any new **built-in** station: it must pass **both** (1) the
exact URL resolves as HTTPS audio, and (2) the station's ToS explicitly permits
third-party embedding. Free is not the same as embeddable.

---

## "LakshX Focus" — bundle your own CC0 / CC-BY tracks

There is a scaffolded **LakshX Focus** station that plays local audio files from
`media/tracks/` (served to the webview via `webview.asWebviewUri`). **No audio is
bundled with this extension.** The station is hidden from the picker while
`media/tracks/` is empty, and appears automatically once you add files.

To enable it, drop royalty-free audio files into
`product/lakshx-commentary/media/tracks/`:

- **CC0 / public-domain** tracks require no attribution.
- **CC-BY** tracks (e.g. incompetech.com by Kevin MacLeod) are allowed **but you
  must provide attribution** — add the required credit line (title, author,
  license, source URL) alongside the files, and surface it before distributing.

Supported extensions: `.mp3`, `.ogg`, `.m4a`, `.aac`, `.wav`, `.flac`, `.opus`,
`.webm`. Do **not** commit copyrighted audio you do not have the right to
redistribute.

---

## Development / testing

- Unit tests: `npm run test:unit` (pure-function tests of `lib/music.js` —
  station catalogue, URL validation, custom-stream handling).
- Visual player harness (no VS Code host needed): serve the extension root over
  http and open `test/harness.html` — it reproduces the player DOM with a
  permissive dev CSP and a mock `acquireVsCodeApi()`, and loads the **real**
  `media/player.js`. See the comment at the top of that file.
