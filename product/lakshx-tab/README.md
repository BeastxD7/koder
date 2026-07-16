# LakshX Tab

Cursor/Zed-style **next-edit prediction**. After you make an edit, LakshX Tab
predicts the *next likely edit* — not just the next few tokens — and shows
it as ghost text at your cursor. Accept it with `Tab`, dismiss it with `Esc`,
exactly like VS Code's built-in inline-suggestion widget already works,
because that widget *is* what's rendering it: this extension is a thin
`InlineCompletionItemProvider`, nothing more.

See `docs/research/15-ide-feature-roadmap.md`, item #4, for the original
pitch: "wire an existing low-latency model behind VS Code's stock
inline-completion API; the hard R&D (the model) is already solved
elsewhere." This extension is that wiring.

## How it works

1. **You edit.** `onDidChangeTextDocument` records a bounded, in-memory
   summary of your last few edits per open document (line, chars removed,
   text inserted — each snippet capped at 160 characters, at most 5 edits
   kept, oldest dropped first). This never touches disk and is cleared the
   moment a document closes.
2. **You pause.** VS Code calls `provideInlineCompletionItems` as you type
   or move the cursor. Rather than firing a model call on every keystroke,
   the provider waits out a short idle window (`lakshxTab.debounceMs`,
   default 350ms) using the cancellation token VS Code passes in — if you
   keep typing, that token gets cancelled and the pending request is
   dropped before it ever reaches the network. This is the entire debounce
   mechanism: no separate timer bookkeeping, no queue.
3. **One small, fast model call.** If you're still paused, LakshX Tab sends
   ONE non-agentic completion request: a short prefix before the cursor
   (last 800 characters), a short suffix after it (next 400 characters), a
   compact text summary of your recent edits (capped at 500 characters
   total), and the file's language ID. No tools, no multi-turn
   conversation, no chain-of-thought — just "predict the next edit, reply
   with the raw text or the literal word NONE." Max response budget is 80
   tokens.
4. **A hard timeout, and silent failure.** The request is aborted at
   `lakshxTab.requestTimeoutMs` (default 2500ms). On timeout, network
   error, non-2xx response, or a `NONE`/empty reply, the provider simply
   returns no items — no error toast, no retry storm, no blocking the
   editor. Ghost text either appears fast or doesn't appear at all.
5. **Tab to accept.** VS Code's own inline-completion UI handles
   accept/reject/partial-accept — LakshX Tab never re-implements or
   intercepts that UX.

## Same provider config as the LakshX agent — no separate setup

LakshX Tab reads `~/.lakshx/providers.json` directly — **the exact same
file** the main LakshX agent (`agent/src/config.ts`) reads. If you've
already configured a provider (Anthropic, OpenAI, OpenRouter, DeepSeek,
Groq, xAI, Gemini, Ollama, or a custom `kind`/`baseUrl`/`apiKey` entry)
for the agent, LakshX Tab works immediately with zero extra
configuration. It resolves whichever model `defaultModel` points at and
calls that provider's chat/completions endpoint directly over HTTPS.

This extension is **fully standalone**: it does not import, spawn, or
route through `agent/src` or `product/lakshx-chat` in any way. It has its
own copy of the small provider-preset table (`lib/providers.js`) so it
keeps working even if the agent runtime isn't installed, is mid-refactor,
or simply isn't running. The tradeoff of this duplication (vs. importing
agent/src) is intentional — see the file header in `lib/providers.js`.

If no usable provider is configured, LakshX Tab shows a **one-time**
notification ("configure a provider first," with a shortcut to open
`providers.json`) instead of silently erroring on every keystroke or
nagging repeatedly.

## Latency tradeoffs

- Debounce (350ms default) + model round trip is the total added delay
  before ghost text can appear. In one real, manual round trip against a
  configured OpenRouter free-tier model during development (see
  "Verification" below), the model call itself took ~1.9s — noticeably
  close to the 2.5s default timeout on a free/rate-limited model. Faster
  dedicated low-latency models (Codestral, Mercury Coder, a paid
  fast-inference tier) will feel snappier; this extension makes no
  assumption about which model is configured, so this is a real,
  user-visible tradeoff of BYOK rather than a bug.
- Raise `lakshxTab.debounceMs` or lower `lakshxTab.requestTimeoutMs` if a
  configured model feels laggy; both are per-user settings, not code
  changes.
- There is no caching, no speculative pre-fetch, and no streaming partial
  ghost text in v1 — each accepted keystroke context gets one fresh,
  small request.

## Privacy bounds — exactly what leaves your machine

Every prediction request sends, and ONLY sends:

| Field | Bound |
|---|---|
| Text before the cursor | last 800 characters of the current document |
| Text after the cursor | next 400 characters of the current document |
| Recent-edit summary | last 5 edits in the *current* document, each insert snippet capped at 160 characters, total summary capped at 500 characters |
| Language ID | e.g. `"javascript"` |

Never sent: the rest of the file, any *other* open document, workspace
folder names/paths, file names, git state, or telemetry of any kind. The
request goes directly from your machine to whichever provider's base URL
is configured in `providers.json` — the same trust boundary you already
accepted by configuring that provider for the main agent. No LakshX
server sits in between.

## On/off toggle

- Status bar item (`$(sparkle) Tab` / `$(circle-slash) Tab`) — click to
  toggle.
- Command palette: **LakshX Tab: Toggle Next-Edit Prediction**.
- Setting: `lakshxTab.enabled` (boolean, default `true`).
- Additional settings: `lakshxTab.debounceMs` (default `350`),
  `lakshxTab.requestTimeoutMs` (default `2500`).

## Verification

- `node --check` passes on every `.js` file in this extension.
- `npm run test:unit` (`node --test test/*.test.js`) — 47 tests, all
  passing, covering: `providers.json` parsing and provider/model
  resolution against every preset in `docs/architecture.md`'s table
  (including custom providers, malformed specs, env-var fallback vs.
  file-provided key precedence); the bounded rolling edit-history buffer
  (truncation, cap enforcement, immutability); prompt construction
  (prefix/suffix truncation direction, recent-edits inclusion,
  language-id defaulting); per-wire-format request-body shape
  (Anthropic vs. OpenAI-compatible); response parsing for both wire
  formats; and `callProvider`'s HTTPS call with `fetch` mocked — success,
  non-2xx, thrown network error, and timeout-abort, all resolving to
  `null` rather than throwing.
- **One real HTTPS round trip was made** during development, using the
  provider already configured in this machine's `~/.lakshx/providers.json`
  (OpenRouter, model `tencent/hy3:free` — a free-tier model, so this cost
  nothing). Prompt: a two-function JS snippet where `subtract`'s body was
  cut off after `return a - `, matching the `add` function's pattern
  immediately above it. The model correctly predicted the missing
  `b;`, in ~1.9 seconds. This confirms the full request/response path
  (prompt building → wire-format request → real network call → response
  parsing → prediction extraction) works end-to-end against a live
  provider, not just against mocks.

## Known limitations / deviations from an ideal implementation

- Ghost text is always a **pure insertion** at the cursor position in
  this v1 (`new vscode.InlineCompletionItem(text, new vscode.Range(position,
  position))`). True "next EDIT" systems (Zeta/Cursor's tab model) can also
  predict edits slightly *away* from the cursor (e.g., a matching rename a
  few lines down) by returning a replace-range. The prompt already asks the
  model to reason about edit patterns, not just token continuation, but the
  VS Code-facing side only wires up same-position insertion for now — a
  natural v2 extension point, not implemented here to keep the surface
  small and the accept/dismiss UX unambiguous.
- No telemetry, no persistence of edit history across a document close/
  reopen or window reload — by design, per the privacy bounds above.
- Registered against `{ pattern: "**" }` (effectively "all files"), not a
  curated per-language allowlist — VS Code's own inline-completion trigger
  conditions (cursor in editable text, not mid-multi-cursor-conflict, etc.)
  already gate when this is even invoked.
