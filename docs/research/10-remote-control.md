# Research + Design: Remote Control — LAN Mobile View into Agent Progress (July 2026)

Design for a "watch (and later, nudge) the Koder agent from your phone" feature: a small HTTP(S) server the extension host starts on demand, serving a mobile-optimized page over the same WiFi/LAN, mirroring the same event vocabulary the desktop panel already renders. Grounded in the current code: `product/koder-chat/extension.js` (`AgentViewProvider`), `product/koder-chat/media/panel.js`, `agent/src/server.ts`. No implementation in this doc — design only.

---

## 0. Where we are today (code audit)

| Fact | Where |
|---|---|
| `AgentViewProvider` owns the ACP child process, `this.transcript` (array of replayable events), and `post(msg)` — the single choke point every UI-bound event passes through. | `extension.js:173-199` |
| `REPLAYABLE` set defines exactly which event types are persisted/replayed: `user, chunk, thought, tool, toolUpdate, system, modeChanged, turnEnd`. This is already the "state snapshot" vocabulary — a phone client needs nothing richer for view-only. | `extension.js:165` |
| `post()` pushes to `this.transcript` (if replayable), debounce-persists to `~/.koder/chats/<chatId>.json` via `persistSoon()` (400ms), and forwards to the webview via `this.view?.webview.postMessage(msg)`. | `extension.js:193-199` |
| `post()` is *not* the sole path to the webview — four call sites bypass it via direct `this.view?.webview.postMessage(...)`, and a mirror tapping only `post()` misses all of them: (1) `onPlanReady`'s `{type:"planReady", path}` payload; (2) `newChat()`'s `{type:"clear"}` when the user starts a fresh chat; (3) `loadChat`'s `{type:"replay", events}` + `{type:"modeChanged"}` when the user opens a saved chat; (4) `replayRequest`'s `{type:"replay", events}` on webview rebuild. (1) needs explicit forwarding; (2)–(4) matter because **without them the phone desyncs** — if the desktop user starts a new chat or switches to a different saved chat, a mirror that only sees `post()` keeps streaming the old chat's events onto the phone with no idea the desktop moved on. The mirror must also hook `newChat()` and `loadChat()` directly (broadcast a `clear`/fresh-snapshot to connected phones) — see Phase A file sketch, §5. | `extension.js:342-351` (planReady), `538-549` (newChat/clear), `433-453` (loadChat/replay), `454-459` (replayRequest/replay) |
| `onSessionUpdate(u)` is where ACP `session/update` notifications (from the agent runtime, over stdio) turn into UI events — `agent_message_chunk`→`chunk`, `agent_thought_chunk`→`thought`, `tool_call`→`tool`, `tool_call_update`→`toolUpdate`, `current_mode_update`→`modeChanged`. All flow through `post()`. | `extension.js:321-340` |
| Permission requests: `onPermissionRequest(params)` posts `{type:"permission", id, title, options}` and parks a resolver in `this.permissionWaiters.set(id, resolve)`; resolution happens when the webview later sends `{type:"permissionChoice", id, optionId}`, handled at `onWebviewMessage` case `"permissionChoice"`. This is the exact mechanism a remote "approve" action would reuse. | `extension.js:376-389, 410-417` |
| Sending a prompt: webview sends `{type:"send", text}`; handler calls `ensureAgent()`, `post({type:"user"})`, `post({type:"turnStart"})`, then `session/prompt`, then `post({type:"turnEnd", stopReason})`. Reusable verbatim for a remote "send message" action. | `extension.js:391-409` |
| The extension already vendors a second zero-dependency single-file module, `media/markdown.js` (320 lines), loaded conditionally (`hasMd` check) and cache-busted by file mtime (`stamp()`). This is the established pattern for "one more small vendored capability, no npm dependency." | `extension.js:554-562`; `media/markdown.js` (320 lines) |
| `panel.js` is 464 lines, zero framework, delegated event listeners, a `switch` over `message.type` — the mobile page should be built the same way, at roughly a third the size (view-only, no settings/history/composer chrome). | `media/panel.js:359-461` |
| `activate()` registers the webview view provider, a status bar item, and commands (`koder.openAgent`, `koder.newChat`, `koder.configureProviders`, `koder.openProviderSettings`) — the natural place to register a new `koder.remoteControl.start` / `.stop` command and a status bar toggle. | `extension.js:619-668` |
| Each VS Code window runs its own extension host, so each window's `AgentViewProvider` is a separate object with its own `this.acp`/`this.transcript` — there is no cross-window registry today. Relevant to the multi-window question (§2.6). | `extension.js:173-184` (per-instance state) |
| ACP itself (`agent/src/server.ts`) has no concept of a network client — it only ever talks ndjson-over-stdio to the one process that spawned it (the extension). A remote server must live in the extension host, not the agent runtime, unless the runtime is made multi-client (see §2.1). | `agent/src/server.ts:1-6, 219-224` |
| `docs/research/04-ux-patterns-performance.md` §3 already names "distinct notification classes for agent finished / blocked / needs decision" for desktop multi-agent UIs — directly reusable for mobile push framing, but the doc has no multi-*device* (only multi-agent) angle. §2.5 below extends it. | `docs/research/04-ux-patterns-performance.md:50` |
| `docs/research/08-memory-context-engineering.md` §2.1 establishes that session/chat state is already durable in `~/.koder/chats/<chatId>.json` (render transcript) and (per that doc's Phase A4) will be durable server-side in `~/.koder/sessions/<sessionId>.json` (real agent memory). Remote Control's "progress" is a live tap on the same transcript, not a new data model. | `docs/research/08-memory-context-engineering.md:106-149` |

---

## 1. External prior art

### 1.1 LAN dev-server + QR pairing (Vite, Expo/Metro)

Vite's `--host` binds the dev server to `0.0.0.0`/LAN and prints the LAN URL in the terminal; the ecosystem's answer to "typing an IP on a phone is friction" is a family of small plugins (`vite-plugin-qrcode`, `vite-qr`) that print a scannable QR **encoding that same URL** directly in the terminal on server start — no auth, because a Vite dev server serving your own app's HTML is considered low-stakes to expose on a trusted LAN. Expo Go / Metro bundler is the closer analogue for "controlling a native surface from a phone": `npx expo start` prints a QR code encoding the dev server's LAN URL (IP + port); Expo Go scans it and connects over the LAN by default, with an explicit **Tunnel mode** fallback (public relay URL) for cross-network sharing or restrictive WiFi. Two transferable ideas: (a) **QR-encode the connection URL, not just show text** — eliminates fat-finger IP entry, the #1 friction point named in every one of these tools' docs; (b) **LAN is the default, tunnel is the explicit opt-in fallback**, never the reverse.

### 1.2 The "0.0.0.0 Day" class of vulnerability — why LAN-bound ≠ safe-by-default

Oligo Security's 2024 disclosure ("0.0.0.0 Day," CVE-2023-43654/ShellTorch and related) showed that a **public website**, loaded in a browser on a machine that also has a local dev server bound to `0.0.0.0`, can reach that local server by POSTing to `0.0.0.0` itself — bypassing CORS and Chrome's Private Network Access checks (patched from Chromium 128, fully blocked by 133; Firefox 130; Windows was never affected because the OS blocks `0.0.0.0` at the socket layer). Separately, `CVE-2026-45670` (Nuxt) is a live 2026 example of a **dev server exposing build output over LAN with no auth** — precisely the shape of bug this feature must not reintroduce. Takeaway for Koder: binding to a LAN interface is already a step up in attack surface from `127.0.0.1`-only, and it must never be silently on. It needs (a) an explicit user opt-in per session, (b) a token, and (c) `Host`-header validation server-side (reject any request whose `Host` isn't exactly `<lan-ip>:<port>`) so a browser tab elsewhere on the same machine (or a `0.0.0.0`/DNS-rebinding trick) can't quietly hit it.

### 1.3 OpenClaw's gateway pairing — closest prior art, worth copying near-verbatim

OpenClaw (an agent-gateway project with iOS/Android companion apps) solves almost exactly this problem: a paired admin generates a **QR code that base64-encodes a JSON payload** containing (a) the gateway's WebSocket URL, (b) an ordered list of LAN/Tailnet routes to try, and (c) a **single-use bootstrap token that expires after 10 minutes**. The mobile app probes routes in order and keeps the first reachable one. Access scope is **determined by transport security**: a `wss://` (TLS) or loopback pairing grants full operator scopes (`admin`, `approvals`, `read`, `write`); a plaintext `ws://` LAN pairing is **silently downgraded** to a limited scope that omits `admin` — the insecure transport can't grant the powerful capability regardless of what the token nominally allows. Plaintext setup codes are additionally restricted to loopback/private-LAN/`.local`/emulator hosts only — a plaintext code pointed at a public IP is rejected outright. This maps directly onto Koder's phased scope: **Phase A (view) needs no scope at all; Phase B (control) should adopt OpenClaw's rule that plaintext-LAN tokens never carry write/approve scope**, forcing a TLS or Tailscale upgrade before remote approval is allowed.

### 1.4 Discovery: mDNS/Bonjour vs manual IP vs QR

mDNS/Bonjour (used by Home Assistant, Plex, Homebridge, AirPlay) enables zero-config discovery but is strictly link-local — it does not cross VLANs, and many "smart" home/guest networks now put IoT and guest devices on isolated VLANs specifically to stop this kind of broadcast, which breaks discovery exactly on the networks where isolation is most likely (see §1.5/§2.5). It also **leaks device metadata** (hostnames, service types) to everyone on the segment, a property Koder doesn't want by default (announcing "Shashank's Koder — repo: acme-payments" over mDNS is a mild information leak on a coffee-shop WiFi). QR-encoding the exact `http://<lan-ip>:<port>/?token=…` URL sidesteps both problems: no broadcast, no metadata leak beyond what's already visible to someone physically looking at the IDE screen, and it degrades gracefully to "type this URL" for a phone that can't scan (e.g., no camera access granted to the browser). **Recommendation: QR-of-URL, no mDNS**, consistent with Vite/Expo's approach and avoiding the VLAN/leak issues mDNS introduces.

### 1.5 Notification UX for background agents — what a LAN web page can and cannot deliver

`docs/research/04-ux-patterns-performance.md` already establishes "distinct notification classes for agent finished/blocked/needs-decision" as desktop best practice. Current industry framing for *multi-agent* monitoring (2026 tools like cmux, Pushary-style Claude Code notifiers) converges on a **layered status model**: ambient status (persistent unobtrusive badge) → progress status (glanceable panel, pull) → attention status (interrupting notification, needs input) → summary status (completion report) — explicitly designed so most activity is "glance if you care" and only the attention layer interrupts. The stated failure mode to avoid: turning the monitor into "a place you check" (another tab that joins Slack/email in the pile of things half-monitored) instead of "a thing that checks you."

**Honest constraint for this feature**: a plain HTTP(S) page served by a local dev server **cannot deliver true push to a backgrounded or locked phone**. Web Push requires a secure context (HTTPS with a browser-trusted cert, not self-signed) and a registered push service (FCM/APNs relay) reachable over the public internet — neither is available to a same-LAN, self-signed, no-cloud server, and the page itself is suspended/killed by mobile OSes once backgrounded (no persistent connection). So the only two honest options in scope for a LAN-only design are ambient (pull-to-view, live while the page is open/foregrounded) and summary (visible immediately on reopening the page). **Interrupting the user on a locked phone is out of scope for v1 and v2** — it would require either a native app with a registered push provider, or routing status through a cloud relay (Tailscale doesn't solve this either — it's just a network path, not a push service). Document this as a known limitation rather than a silent gap.

### 1.6 Self-signed TLS is real friction on mobile — informs the security model

Community reports (Home Assistant's own companion-app users, iOS/Android accessory developers) confirm self-signed certificates are actively **rejected by default** by mobile browsers and OS-level TLS stacks; working around it requires per-app Network Security Config changes (Android) or manual cert installation + trust (iOS) — both hostile to a "scan a QR and go" flow. This rules out "TLS-over-LAN with self-signed cert" as a *default* v1 mechanism: it would turn a 10-second pairing flow into a multi-step certificate-trust ritual most users would abandon. Plaintext HTTP + a random bearer token over a trusted home/office WiFi is the pragmatic default (same trust boundary Vite/Expo/OpenClaw's `ws://` mode accept); TLS is reserved for the Tailscale/tunnel escape hatch where the tunneling tool (Tailscale Serve, e.g.) already supplies a real certificate for free.

---

## 2. Design questions, answered concretely

### 2.0 Native app vs. mobile-optimized web page

**Recommendation: a mobile web page served by the LAN server, not a native app. This is not a close call for v1.** The one capability a native app buys over a web page is registered push-to-a-locked-device (via APNs/FCM) — and §1.5 already establishes that a same-LAN, no-cloud, self-signed-averse design **cannot supply the backend half of that** (no public relay, no trusted-CA HTTPS) regardless of which client renders the UI. A native app talking to this exact same local SSE/REST server would still only be able to show live updates while foregrounded — identical capability to the web page, because the constraint is server-side, not client-side. Against that zero capability gain, a native app costs: two separate codebases/build pipelines (iOS + Android) with app-store review cycles for a feature that's supposed to ship fast and iterate; App Store/Play Store distribution friction for what is, for v1, a "scan a QR, see a read-only feed" utility; and it breaks the "any phone on the network, no install" promise that QR-pairing dev tools (§1.1) all rely on for zero-friction adoption. A mobile web page also directly reuses the codebase's existing zero-framework, hand-rolled-HTML/CSS/JS discipline (`panel.js`, `markdown.js`) rather than introducing a second UI stack (Swift/Kotlin or React Native) into a project that currently has none. Revisit only if/when true push (via a native app + registered push provider, or a cloud relay) becomes an explicit goal — a decision this doc deliberately defers (§1.5) rather than smuggles in.

### 2.1 Where does the server run

**Inside the extension host process (the same Node process that already runs `AgentViewProvider`).** Justification:

- It already has full network access (it's plain Node inside VS Code's extension host) and already owns the one piece of state that matters: `this.transcript` and the live event stream from `post()` (`extension.js:193-199`).
- The agent runtime (`agent/src/server.ts`) is single-client-per-process ACP-over-stdio (`connect(acp.ndJsonStream(stdout, stdin))`, `server.ts:219-224`) — it has no notion of a second consumer, and teaching it to fan out to N network clients (with independent auth, backpressure, reconnect) is a much bigger, protocol-level change for no benefit: the extension already re-broadcasts everything the runtime says to the one webview it owns. Tapping *there* is strictly less work and matches the existing architecture (agent runtime = protocol-neutral back end; extension = UI-facing orchestration, already home to BYOK settings, chat persistence, etc.).
- A wholly separate process (Phase C idea, see §2.6) only earns its keep once there are multiple windows to aggregate; for v1 a single window's server living in that window's extension host is simplest and keeps the security boundary obvious (kill the window, the server dies too — no orphan listener).

### 2.2 Transport: Server-Sent Events + REST/JSON POST, not WebSocket

**Recommendation: SSE (`GET /events?token=…`, `Content-Type: text/event-stream`) for the live stream, plus a plain `GET /state?token=…` JSON snapshot on connect, plus `POST /action?token=…` for phone→desktop actions once Phase B ships.** Reject WebSocket for v1. Reasoning:

- The dominant direction is server→phone (chunk/thought/tool/permission/modeChanged events). SSE is a one-directional broadcast primitive that fits that shape exactly, and both ends are **already available with zero new dependencies**: Node's built-in `http` module writes SSE frames directly (`res.writeHead(200, {"Content-Type": "text/event-stream"}); res.write("data: " + JSON.stringify(msg) + "\n\n")`); the browser's built-in `EventSource` consumes them, with **automatic reconnection and last-event-id resume built into the platform** — no reconnect logic to write.
- WebSocket has no such free lunch: Node ships a **built-in WebSocket client** (global `WebSocket`, since Node 21/22) but **no built-in server-side upgrade/handshake** — serving WS requires either the `ws` npm package or ~150 hand-vendored lines of RFC 6455 framing. Since the traffic pattern doesn't need bidirectional low-latency streaming (phone→desktop actions in Phase B are low-frequency: one permission choice, one prompt send, one mode switch at a time), paying that cost buys nothing SSE+POST doesn't already deliver.
- `EventSource`'s `id:` field plus automatic `Last-Event-ID` header on reconnect maps directly onto `this.transcript`'s array index — reconnection after a phone sleeps/loses signal is "resend everything after index N," which is exactly what the existing replay mechanism (`extension.js:249, panel.js applyEvent`) already does for the desktop webview. No new replay logic to design.
- Escape hatch, explicitly not v1: if a future phase needs true bidirectional low-latency (e.g., live cursor/typing indicators), add the `ws` package then — SSE+POST is not a dead end, it's the correct-for-the-actual-traffic-shape choice today.

### 2.3 Pairing/auth flow

**Off by default; explicit opt-in only.** Justification is §1.2 (0.0.0.0-day class) plus the general principle that a feature which opens a LAN-reachable, unauthenticated-until-paired listener must never be a silent side effect of installing/updating the extension.

**IDE side — starting it:**

1. User runs `Koder: Enable Remote Control` from the command palette, or clicks a new status-bar toggle (next to the existing `✦ Koder` item, `extension.js:634-638`).
2. Extension picks a free TCP port starting at `47820` (arbitrary high, memorable-ish port; increments on `EADDRINUSE` — see §2.6), starts the `http` server bound to the machine's LAN-facing interface(s) (`os.networkInterfaces()`, filtering to non-internal IPv4), and generates a random 128-bit token (`crypto.randomBytes(16).toString("hex")`).
3. The panel (or a small modal/webview panel) renders a QR code encoding `http://<lan-ip>:<port>/?token=<token>` — using a vendored single-file QR encoder (see §6), the same pattern already used for `markdown.js`.
4. Below the QR: the plain URL as selectable text (manual-entry fallback, per §1.1/§1.4), the workspace folder name (so a user with multiple windows open knows which QR is which, §2.6), and a "Stop Remote Control" button.
5. Token is scoped to **this session of the server only** — stopping and restarting Remote Control (or the extension host) invalidates it and issues a new one. No persistence of the token to disk.

**Phone side:**

1. Open the phone's camera or a QR scanner, scan the code → opens the URL in the default mobile browser.
2. The mobile page's first request is `GET /state?token=…`; the server validates the token (constant-time compare) against its in-memory current token, validates the `Host` header against the LAN IP:port it's serving on (rejects mismatches — the concrete mitigation for the 0.0.0.0-day/DNS-rebinding class, §1.2), and either 200s with a JSON snapshot (`{workspace, mode, transcript}` — the REPLAYABLE subset of `this.transcript`) or 401s.
3. On success, the page opens `new EventSource("/events?token=…")` for the live stream and renders the snapshot immediately (no blank-screen wait for the first event).
4. Token is remembered in the phone browser's `sessionStorage` (not `localStorage` — cleared when the browser tab/app is fully closed, forcing re-scan next session; deliberate, keeps a lost/stolen phone's exposure window short) so backgrounding-and-returning doesn't require rescanning.

**Rotation/expiry**: token is invalidated when (a) the user clicks "Stop Remote Control," (b) the extension host restarts (VS Code reload/close), or (c) a manual "Rotate token" action in the panel (invalidates all currently-connected phones, forcing rescan — useful if a QR was shown on a screen-share). No fixed TTL in v1 (a session-lifetime token matches the trust model: "on my LAN for this working session," not "for the next N minutes" like OpenClaw's single-use bootstrap — Koder's is a persistent-view token, not a one-shot bootstrap, so a shorter TTL would just cause needless re-scans without a corresponding security win for a *view-only* v1).

### 2.4 Scope: v1 (view-only) vs v2 (also-control)

**v1 = strictly view-only. Recommended and should ship first.**

| | v1 (view-only) | v2 stretch (remote control) |
|---|---|---|
| Phone can... | Watch chunk/thought/tool/toolUpdate/modeChanged/turnStart/turnEnd/permission-pending-state/system messages, read-only | ...also: answer a pending permission prompt, send a new chat message, switch mode (review/approve/auto) |
| New server surface | `GET /state`, `GET /events` (SSE) — no state mutation possible via the network at all | `POST /action` — reuses `permissionWaiters` resolution (`extension.js:384-389`) and the `onWebviewMessage({type:"send"/"setMode"})` handlers (`extension.js:391-429`) verbatim |
| Worst case if token leaks | Someone on the LAN (or who screenshots the QR) can **watch** your agent's chat, file paths touched, and tool titles until you rotate/stop. No ability to act. | Someone with the token can **approve a destructive tool call**, **send arbitrary prompts to an agent with your provider keys and repo access**, or **flip auto mode on** — full blast radius of what the desktop panel itself can do, minus BYOK key management. |
| Justification | Matches OpenClaw's own default (plaintext transport → scope-limited, no admin) and matches "off by default, explicit opt-in" — view-only keeps the opt-in decision low-stakes enough that defaulting the feature to *available* (even if disabled) is safe. | Only justified once the pairing story includes OpenClaw's transport-gated scoping (§1.3): plaintext-LAN tokens should never unlock control, only a `wss://`/Tailscale-upgraded pairing should. Ship this behind an explicit second opt-in ("Allow remote actions") layered on top of view access, not bundled by default. |

Recommendation: build and ship v1 alone first; gate v2 behind (a) a second, separate toggle in settings, off by default even when view-only Remote Control is on, and (b) the OpenClaw-style rule that a plaintext-`http://` pairing can never carry the control scope — control requires the Tailscale/tunnel path (Phase C+) or is simply not offered on a bare LAN pairing at all until that path exists.

### 2.5 Captive-portal / guest-WiFi / AP-isolation failure mode

Client (AP) isolation — common on guest networks, many mesh routers' "Guest" SSID by default, and increasingly on IoT-isolated VLANs — deliberately blocks device-to-device traffic on the same SSID even though both devices show "connected" and have IPs. This is **silent**: no error, the QR scan just hangs or the phone's request times out. Recommended fallback UX:

- **IDE side**: if no phone connects within ~20s of the QR being shown (server sees zero incoming connections), show an inline hint under the QR: *"No connection yet. If this is a guest/hotel WiFi, phone and laptop may be isolated from each other — try a personal hotspot, or see Tailscale setup (coming soon)."* Don't guess harder than that; the IDE can't distinguish "isolated network" from "phone hasn't scanned yet" from its side.
- **Phone side**: if the initial `GET /state` request times out client-side (the browser will just spin — there's no server response to differentiate the failure), there isn't a page to show *this* message on since the connection never succeeded; the honest answer here is that the *pre*-scan guidance (the inline hint above, shown in the IDE before the phone even tries) is the only lever available — a captive-portal/isolated network fails closed and invisibly, and the fix is operator action (switch network), not better client code.
- **Longer-term mitigation (Phase C+, not v1)**: offer Tailscale (or an equivalent WireGuard-based mesh) as the "works anywhere, including isolated guest WiFi" path, exactly as Expo's Tunnel mode and OpenClaw's Tailscale Serve route are the escape hatch from "LAN only." Out of scope to build in v1 — document the seam (pairing payload already has room for "ordered routes to try," per OpenClaw's pattern in §1.3) so it's a additive Phase C change, not a rearchitecture.

### 2.6 Multiple windows/workspaces

Each VS Code window is a separate extension host process with its own `AgentViewProvider` instance (`extension.js:173`, per-instance `this.transcript`/`this.acp`) — there is no shared state across windows today, and introducing one is out of scope for v1. **v1 = one server, one port, per window**, each independently toggled from that window's command palette/status bar:

- Port selection: start at a fixed base (`47820`), probe with `net.createServer().listen()`, increment by 1 on `EADDRINUSE` up to a small bound (e.g. +20), so opening Remote Control in window 2 while window 1's is running doesn't collide.
- Each QR encodes its own window's port and includes the workspace folder's basename in the pairing payload and in the mobile page's header, so a user with three windows open and three QR codes on screen can tell them apart (and so a phone that paired with window 1 doesn't confusingly show window 2's chat if the user later scans a different QR into the same browser tab — each pairing is a distinct URL+token, so this is naturally handled by having each be a genuinely different page load).
- **Phase C aggregator** (not v1): a single well-known local port (or a lightweight discovery file `~/.koder/remote/windows.json` the extension host writes/removes on start/stop) that a phone-facing "index" page reads to show *all* currently-open windows' Remote Control sessions as a list, tapping into one to view it — avoids needing to scan a fresh QR per window once one window has ever been paired. Worth building once users report having 2+ windows open with Remote Control on simultaneously; premature for v1.
- Because the server taps `AgentViewProvider` (the provider object), not the webview, and the webview is torn down/rebuilt on visibility changes (`retainContextWhenHidden: false`, `extension.js:649`) while the provider and its `this.acp`/`this.transcript` persist for the life of the window — **the phone keeps watching even if the user closes the desktop chat panel**, which is exactly the "check on it without needing the IDE focused" use case this feature exists for.

---

## 3. Security model and limits (honest accounting)

**What this protects against:**
- Casual/accidental exposure: off by default, explicit two-click opt-in, visible status-bar indicator while active, one-click stop.
- Passive network sniffing on the sensitive parts on a *shared but encrypted* WiFi (WPA2/3): the token still travels in cleartext HTTP (see below), but WPA2/3 encrypts the radio hop per-client, so a bystander on the same encrypted WiFi without the token still can't read your token off the air. (This protection **does not exist on open/unencrypted WiFi.**)
- The specific 0.0.0.0-day/DNS-rebinding pattern (§1.2): explicit **`Host` header** validation on every request (reject unless `Host` exactly matches `<lan-ip>:<port>` the server is actually listening on) rejects requests that didn't originate from a browser tab that actually navigated to the LAN URL. `Host` is the right check to lean on — it is always sent by both `fetch`/XHR and `EventSource`; `Origin` is frequently absent on a same-origin `EventSource` GET, so it should be treated as a bonus signal when present, never as the primary gate.
- Stale exposure: token invalidated on stop/restart/rotate; no disk persistence of the token; `sessionStorage` (not `localStorage`) on the phone so a fully-closed browser forgets it.

**What this does NOT protect against — state this plainly to the user, e.g. in the toggle's tooltip/first-run notice:**
- **A compromised device already on the same LAN.** Anyone/anything on the network that can capture the QR code (screen-share, shoulder-surf, a malicious app with camera/clipboard access) or intercept the token (e.g., a rogue device doing ARP spoofing on an open network) gets the same access a legitimate phone would. This is a *trusted local network* feature, not a zero-trust one — same boundary Vite/Expo/OpenClaw's plaintext mode all accept.
- **The token travels in the URL query string** because `EventSource` cannot set custom headers — this means it's cleartext on the wire (mitigated only by WiFi-layer encryption, not by anything this server does) and it will land in browser history / could be logged by a proxy if one happens to sit on the path (unlikely on a home LAN, more plausible on a corporate one — worth a line of caution for office-network users specifically).
- **Open/public WiFi is explicitly out of scope for v1** — the "no encryption of any kind on this server" model is only acceptable on WPA2/3-secured personal/office networks. The IDE should say so in the enable flow, not just imply it.
- **A captured QR after the fact**: since the token is session-lifetime (§2.3), anyone who captures it (photo of the screen, screen recording) has standing access until the user manually rotates or stops — there's no auto-expiry safety net in v1. (Tradeoff accepted per §2.3's reasoning; flag as a place to revisit if usage data shows QR codes get shared/screenshotted more than expected.)
- **Self-signed TLS is deliberately not attempted** (§1.6) — so there is no confidentiality/integrity guarantee beyond "your WiFi's encryption," and no protection against an on-path attacker who's already inside the WPA2/3 network (e.g., another compromised device on the same LAN, which brings us back to the first bullet).

---

## 4. Minimal mobile-web UI sketch

Not a mobile IDE — a single scrolling read-only feed plus a tiny status header, deliberately smaller than `panel.js`'s 464 lines. Screens:

1. **Connect screen** (before/if `/state` fails): "Connecting to `<workspace-name>`…" with a spinner; on failure, the guidance text from §2.5.
2. **Live feed screen** (the whole app, effectively one view):
   - **Header**: workspace folder name, current mode badge (review/approve/auto — read-only reflection of `modeChanged` events, no tap-to-change in v1), a small connection-state dot (green = SSE open, amber = reconnecting, red = lost — `EventSource.onerror`/`readyState`).
   - **Feed**: renders the same event vocabulary as `applyEvent()` in `panel.js:249-267` minus settings/history/composer-only bits — `user` (right-aligned bubble), `chunk`/streamed agent text (plain markdown-lite render, reuse the non-`window.koderMarkdown` fallback path already in `panel.js:28-32` rather than porting the full 320-line `markdown.js` — v1 doesn't need code-copy buttons or syntax highlighting on a phone screen), `tool`/`toolUpdate` (single-line rows: dot + title + status, same as desktop), `system` (muted line), `modeChanged` (small inline notice).
   - **Permission banner** (v1: display-only): when a `permission` event arrives, show the pending prompt's title and the option names as **disabled/greyed pills with a "waiting for you in the IDE" caption** — visible so the phone user knows the agent is blocked and why, without being able to act (that's the v2 unlock: same pills become tappable, POSTing to `/action`).
   - No composer, no settings, no history list, no model picker in v1 — those are either not applicable (view-only) or stay IDE-only (BYOK key entry should never be typeable on a phone over plain HTTP).
3. **Disconnected/stopped screen**: shown if the SSE connection closes and reconnection attempts (browser-automatic, per §2.2) exhaust or the server responds 401 (token rotated/invalidated) — "Remote Control was turned off in the IDE, or this link expired. Scan a new QR code to reconnect."

Visual language: reuse `panel.css`'s CSS custom properties (`--bg`, `--fg`, `--accent`, `--hairline`, `--radius`, `--mono`, `--ease` — `panel.css:1-11`) so the phone page feels like the same product, but with mobile-first layout (single column, larger tap targets, safe-area insets for notches) rather than importing the file wholesale — the desktop panel's layout (topbar with mode tabs, composer, settings sheet) doesn't apply.

---

## 5. Phased implementation plan

### Phase A — view-only LAN server + QR pairing + basic mobile page

New files (all inside `product/koder-chat/`):

| File | Contents (sketch, not code) |
|---|---|
| `remote/server.js` (new, CJS, ~150-200 lines) | `class RemoteServer { start(provider) / stop() }`. On `start`: picks port (§2.6), generates token, creates `http.createServer(...)`, routes `GET /` → serves `remote/mobile.html` (inlined JS/CSS, no separate static files — same single-file discipline as `extension.js`'s own `html()` method), `GET /state` → JSON snapshot of `provider.transcript` + `provider.mode` + workspace name, `GET /events` → SSE stream, validates token + `Host` header on every route. Holds a `Set` of open SSE `res` objects to broadcast to. |
| `remote/qr.js` (new, vendored single-file QR encoder, ~300-400 lines) | A trimmed, license-compatible (MIT) QR encoder (e.g. adapted from Kazuhiko Arase's public-domain `qrcode-generator`), exposing one function that takes a string and returns a matrix renderable to `<canvas>`/SVG — same "hand-picked vendored file" pattern as `media/markdown.js`. |
| `remote/mobile.html` + inline `<script>`/`<style>` (new) | The mobile page from §4 — served as a string from `server.js`, not a separate webview-served file (no `vscode.Uri`/webview CSP machinery needed since this is a plain HTTP response, not a VS Code webview). |
| `extension.js` (edit) | In `AgentViewProvider`: add `this.remote = null`; in `post(msg)`, after the existing transcript/persist logic, add `this.remote?.broadcast(msg)` (`extension.js:193-199`) — the single tap point. Separately forward `planReady` (`extension.js:346`) since it bypasses `post()`. Add commands `koder.remoteControl.start`/`.stop` in `activate()` (`extension.js:646-666`) and a status-bar toggle beside the existing `✦ Koder` item (`extension.js:634-638`). On stop or `deactivate()`, ensure `this.remote?.stop()` runs so the port is released. |

### Phase B — remote permission approval (+ optionally send/mode-switch)

- `POST /action` on `remote/server.js`, gated by a **second** opt-in flag (§2.4) and — per the OpenClaw-derived rule (§1.3) — only enabled at all when the connection isn't a bare plaintext-LAN pairing, or explicitly accepted as a known-risk toggle if Tailscale/TLS isn't available yet.
- `{type:"permissionChoice", id, optionId}` action → calls the exact same `this.permissionWaiters.get(id)` / `w(optionId)` path the webview's `permissionChoice` case already uses (`extension.js:410-417`) — no new agent-facing logic, just a second caller of the same resolver map.
- `{type:"send", text}` / `{type:"setMode", mode}` actions → route into `onWebviewMessage` (`extension.js:391-429`) the same way the webview's `postMessage` does today; the remote server becomes, from `AgentViewProvider`'s point of view, just another caller of `onWebviewMessage`.
- Mobile page: permission pills become tappable (§4); no composer text box added in Phase B unless there's demand — "approve/deny" covers the "needs a decision, I'm away from my desk" case, which is the actual described use case, without opening up free-text prompt injection from a phone as a v1-of-control feature.

### Phase C — multi-workspace/multi-window support

- Aggregator index (§2.6): `~/.koder/remote/windows.json`, written/removed by each `AgentViewProvider`'s `RemoteServer.start()/stop()` (`{windowId, workspaceName, port, startedAt}`), read by a lightweight always-on aggregator page/process that lists all currently-active windows for one QR-scan-once experience.
- Tailscale/tunnel route (§2.5, §1.3): extend the pairing payload with an ordered list of routes (LAN URL first, Tailscale Serve HTTPS URL second if detected), mobile page probes in order — directly modeled on OpenClaw's route-probing behavior (§1.3).
- Only build once Phase A/B are shipped and real usage shows 2+ simultaneous windows with Remote Control enabled is common enough to matter.

---

## 6. Package/dependency choices

Consistent with this codebase's stated philosophy (`extension.js:1`: "Plain CJS, zero dependencies"; `panel.js:1`: "No frameworks — small, fast, ours"):

| Need | Choice | Why not the alternative |
|---|---|---|
| HTTP + SSE server | Node built-in `http` module | Zero new deps; SSE needs nothing beyond `res.write` with the right headers — no framework (Express etc.) buys anything here given the tiny route count (`/`, `/state`, `/events`, `/action`). |
| Live transport | SSE (`EventSource` client-side, built into every mobile browser) | See §2.2 — WebSocket would require the `ws` package (no built-in Node WS *server*) for a traffic shape that doesn't need it. |
| QR generation | One small vendored single-file encoder (`remote/qr.js`, ~300-400 lines, MIT/public-domain algorithm) | Matches the existing `media/markdown.js` precedent exactly — a hand-picked, reviewed, zero-transitive-deps vendored file beats an npm dependency (and its supply chain) for a component this small and stable (QR encoding hasn't changed in 20 years). Rejected: any `qrcode`-style npm package — pulls in a package + its own deps for ~300 lines of stable math we can vendor once. |
| Token generation | Node built-in `crypto.randomBytes` | Already used implicitly elsewhere in the Node standard toolchain; no dependency. |
| Mobile page markup rendering | Plain string templates + minimal DOM, same style as `panel.js` | No framework; the mobile page is smaller in scope than the desktop panel, so the "zero deps" bar is even easier to clear here. |

**Net new dependency count: zero.** The only genuinely new code mass is the vendored QR encoder (one file, reviewed once) and the `RemoteServer` class (one file, plain `http`) — both consistent with how `markdown.js` was added previously.

---

## 7. Open questions / risks for the follow-up implementation task

- Exact vendored QR library choice and license text to include (pick and pin a specific well-known public-domain/MIT implementation rather than writing one from scratch).
- Whether `Host`-header validation needs to special-case Safari/iOS quirks around `EventSource` and query-string auth (worth a quick spike before Phase A is considered done, not before this design is approved).
- Whether the "20s no-connection hint" (§2.5) needs to be configurable/removable for users who like to show the QR ahead of actually picking up their phone.
- Whether Phase B's plaintext-LAN-never-gets-control rule (§1.3, §2.4) should be a hard block or a user-acknowledged override — leaning hard block for v1 of Phase B, revisit if it's reported as too restrictive.

---

## Sources

- Oligo Security, "0.0.0.0 Day: Exploiting Localhost APIs From the Browser" — oligo.security/blog/0-0-0-0-day-exploiting-localhost-apis-from-the-browser
- CVE-2026-45670 (Nuxt dev-server LAN exposure) — via Netlify security changelog, netlify.com/changelog/2026-05-19-nuxt-security-vulnerabilities
- Vite `--host` + QR plugins — vite.dev/config/preview-options; viteqr.js.org; github.com/svitejs/vite-plugin-qrcode; github.com/vitejs/vite/issues/17925
- Expo Go / Metro bundler LAN + Tunnel mode — docs.expo.dev/more/expo-cli, docs.expo.dev/guides/customizing-metro
- OpenClaw gateway pairing (QR bootstrap token, transport-scoped access, LAN/Tailscale route probing) — docs.openclaw.ai/channels/pairing, docs.openclaw.ai/gateway/tailscale
- Tailscale device pairing via QR — tailscale.com/kb/1336/device-add-qr-code
- mDNS/Bonjour local discovery, VLAN limitations, Home Assistant zeroconf — home-assistant.io/integrations/zeroconf, developers.home-assistant.io/docs/network_discovery
- Wireless client (AP) isolation on guest networks — documentation.meraki.com/Wireless (Wireless Client Isolation)
- Self-signed TLS rejected by mobile apps/OS trust stores — community.home-assistant.io thread on self-signed cert trust; developer.android.com/privacy-and-security/security-ssl
- Layered agent-status notification model (ambient/progress/attention/summary) and "dashboard failure mode" framing — aiuxdesign.guide/patterns/agent-status-monitoring; amux.io/guides/best-ai-agent-multiplexers-2026
- Internal: `docs/research/04-ux-patterns-performance.md` §3 (notification classes), `docs/research/08-memory-context-engineering.md` §2.1 (session persistence model)
