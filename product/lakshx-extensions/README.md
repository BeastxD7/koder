# LakshX Extensions — "Recommended & Verified" panel

## The problem this fixes

LakshX's `extensionsGallery.serviceUrl` points at `https://open-vsx.org`, not
the Microsoft Marketplace (see `product/product.overrides.json` and
`docs/architecture.md`). That is correct and necessary for a VS Code fork —
the Microsoft Marketplace's terms of use restrict it to Microsoft's own
products.

But it creates a specific, real risk: **if a fork's UI recommends an
extension id that was only ever published to the Microsoft Marketplace and
never to Open VSX, an attacker can register that exact same
`publisher.name` on Open VSX with malicious code.** A user of this fork,
nudged by a recommendation surface, ends up installing the attacker's
package — not the extension they thought they were getting. This is a
documented, named risk class for VS Code forks (see
`docs/research/15-ide-feature-roadmap.md`, item #10).

This extension is the fix: a small, native panel that only ever recommends
extensions LakshX has **actually checked** against the registry its own
gallery points at.

## What's in here

- `lib/curated.js` — pure data: a hand-maintained array of vetted
  extensions (`{id, displayName, description, category, verifiedOn,
  reason}`) plus a schema-validation helper (`validateCuratedList`). No
  network I/O.
- `lib/verify.js` — the actual trust mechanism: queries the real
  `https://open-vsx.org/api/{namespace}/{name}` endpoint (Node's built-in
  `https`, no dependencies) and turns the response into `found: true / false
  / null` (confirmed-present / confirmed-absent / couldn't-check).
- `extension.js` — wires the two together: a status bar item and command
  palette entry open a webview panel that lists the curated extensions by
  category, each with a live Open VSX trust badge and an Install button.
- `media/panel.css`, `media/panel.js` — the webview's presentation and
  message-passing (dependency-free, matches the CSP used by
  `lakshx-graph`/`lakshx-db`'s panels).
- `test/curated.test.js`, `test/verify.test.js` — `node --test` suites,
  including live network tests against the real Open VSX API (see below).

## Curation process

The list in `lib/curated.js` was seeded from two sources:

1. **LakshX's own existing recommendations.** `product/product.overrides.json`
   was read (read-only — not modified by this change) and its current
   `extensionRecommendations` block copied in as-is:
   - `cweijan.vscode-mysql-client2` (MySQL/Postgres/SQLite/Redis client)
   - `LuoZhihao.call-graph` (function call-hierarchy visualizer)
2. **A handful of obviously-safe, well-known additions** relevant to a
   general-purpose IDE fork: Prettier, ESLint, EditorConfig, Code Spell
   Checker, Error Lens, GitLens, the Red Hat YAML extension, and Auto Rename
   Tag. These were picked for being extremely long-established, high
   install-count, non-controversial tools — not invented or guessed.

Every one of these was then **live-verified** (not just hand-labeled) — see
the results table below.

Each entry carries a `reason` field explaining why it's trusted, and a
`verifiedOn` field with four legal values: `"Open VSX"`, `"VS Code
Marketplace"`, `"both"`, or `"unverified"`. `"unverified"` exists in the
schema so a *future* maintainer can stage a new candidate in the list
without falsely implying it's been checked — `validateCuratedList` accepts
it as schema-valid, but `test/curated.test.js` has a tripwire test
(`"...has no entries silently left as 'unverified'"`) that fails the suite
if anything shipped in this state, so a candidate can't quietly ship
unchecked. As of this change, **every shipped entry was actually checked**
(see below) — none were left as `"unverified"`.

## Open VSX verification results (live, run 2026-07-17)

Every curated entry was queried against the real `open-vsx.org` API from
this sandbox (network was reachable — confirmed with a direct `curl`, HTTP
200). Results, in the order they appear in `lib/curated.js`:

| id | Result | Detail |
|---|---|---|
| `cweijan.vscode-mysql-client2` | **PASS** | 200 OK, 1,272,572 downloads on Open VSX |
| `LuoZhihao.call-graph` | **PASS** | 200 OK, 3,233 downloads on Open VSX |
| `esbenp.prettier-vscode` | **PASS** | 200 OK, 8,251,814 downloads on Open VSX |
| `dbaeumer.vscode-eslint` | **PASS** | 200 OK, 4,773,392 downloads on Open VSX |
| `EditorConfig.EditorConfig` | **PASS** | 200 OK, 1,977,382 downloads on Open VSX |
| `streetsidesoftware.code-spell-checker` | **PASS** | 200 OK, 1,470,060 downloads on Open VSX |
| `usernamehw.errorlens` | **PASS** | 200 OK, 932,262 downloads on Open VSX |
| `eamodio.gitlens` | **PASS** | 200 OK, 14,040,310 downloads on Open VSX |
| `redhat.vscode-yaml` | **PASS** | 200 OK, 6,586,235 downloads on Open VSX |
| `formulahendry.auto-rename-tag` | **PASS** | 200 OK, 526,882 downloads on Open VSX |

**All 10 shipped entries live-verified as PASS.** Nothing was flagged
"unverified" in the final shipped list — every candidate that was
considered got a real network check before being included, per this task's
own instruction not to assert Open VSX availability without checking.

A genuine **FAIL** case was also produced (used only as a test fixture, not
shipped in the curated list): `ms-vscode.cpptools` (Microsoft's C/C++
extension) returned **HTTP 404** from `open-vsx.org/api/ms-vscode/cpptools`
— it is not published there. This is a real, live example of exactly the
squatting-risk scenario this panel exists to prevent: that id exists (and
is popular) on the Microsoft Marketplace, so a fork that recommended it
blindly would be pointing users at a namespace that's wide open on Open
VSX. `test/verify.test.js` asserts this id resolves to `found: false` as a
standing regression check that `lib/verify.js` correctly distinguishes
"confirmed absent" from "couldn't check."

If this had been run somewhere with no network access, the correct behavior
(and what `runVerification`/`checkAll` implement) is to report `found: null`
("could not reach Open VSX: ...") per entry — never to silently treat an
unreachable registry as a pass. `test/verify.test.js`'s two live-network
tests detect this at test time and call `t.skip(...)` with an explicit
message rather than failing or faking a result, if `open-vsx.org` turns out
to be unreachable in whatever environment runs the suite next.

## The panel UI

- **Command:** `lakshx.extensions.showCurated` ("LakshX: Show Recommended &
  Verified Extensions"), registered in the command palette.
- **Discoverability hook:** a status bar item (`$(shield) Extensions`,
  right-aligned, priority 997 — next to lakshx-db's and lakshx-graph's own
  status bar entries) that opens the panel.
- **Panel:** a `vscode.window.createWebviewPanel` (same CSP/pattern as
  `lakshx-db` and `lakshx-graph`'s panels) listing curated extensions
  grouped by category. Each row shows the display name, id, a live trust
  badge (`✓ Verified on Open VSX`, `✗ Not on Open VSX`, or `⚠ Not yet
  checked` / `⚠ Couldn't check`), the curation `reason`, and an **Install**
  button wired to
  `vscode.commands.executeCommand('workbench.extensions.installExtension', id)`.
  The Install button is disabled for any entry whose live check comes back
  `fail`. A **Re-check Open VSX** toolbar button re-runs the live query and
  updates badges without reopening the panel. Verification also runs once
  in the background on activation and again whenever the panel is opened,
  with the last result cached in `context.globalState` so the panel has
  something to show immediately even before a fresh check completes.

### `viewsWelcome` into the built-in Extensions view — investigated, does NOT work

The task asked whether `contributes.viewsWelcome` could add a note to VS
Code's built-in Extensions view pointing at this panel. This was checked
against the actual upstream source rather than assumed:

- `viewsWelcome` content only renders when a view's `shouldShowWelcome()`
  returns `true` (`upstream/src/vs/workbench/browser/parts/views/viewPane.ts`).
- The base `ViewPane` class hardcodes `shouldShowWelcome() { return false; }`.
- The built-in Extensions view (`ExtensionsListView` and its subclasses —
  `DefaultPopularExtensionsView`, `ServerInstalledExtensionsView`,
  `EnabledExtensionsView`, `DisabledExtensionsView` — in
  `upstream/src/vs/workbench/contrib/extensions/browser/extensionsViews.ts`)
  extends `ViewPane` directly and **does not override** `shouldShowWelcome()`.
- Separately, `upstream/src/vs/workbench/contrib/welcomeViews/common/viewsWelcomeExtensionPoint.ts`'s
  `ViewIdentifierMap` (the well-known welcome-eligible view ids: `explorer`,
  `debug`, `scm`, `testing`) doesn't include any extensions-view id either.

**Conclusion: a `viewsWelcome` contribution targeting any of the built-in
Extensions views would silently never render**, no matter what `when`
clause is used — the view class itself never reports "I have no meaningful
content to show." Shipping a non-functional contribution point would be
misleading, so it was deliberately left out; the status bar item above is
the discoverability hook that actually works. If Microsoft's own
`ExtensionsListView` is ever changed to opt into welcome content, this would
be worth revisiting.

## Explicitly NOT done here (deliberate fast-follow)

- **`product/product.overrides.json`'s `extensionRecommendations` cleanup**
  is out of scope for this change by explicit instruction — another agent
  is actively editing that file right now (building the custom welcome
  screen). Once that work lands, a follow-up should reconcile
  `extensionRecommendations` against this panel's curated+verified list
  (e.g., drop anything from `extensionRecommendations` that doesn't also
  appear here as a live-verified pass, or vice versa — add anything
  recommended there that isn't yet curated here). This extension's
  `lib/curated.js` intentionally already contains both of
  `extensionRecommendations`'s current entries so that reconciliation has
  something concrete to diff against.
- **No code-quality/security audit of the extensions themselves.** "Verified"
  here means "confirmed to exist under this id on Open VSX" — it is a
  supply-chain/namespace check, not a code review of the extension's
  contents. The panel's blurb text says this explicitly to avoid overclaiming.
- **No automatic sync/cron re-verification.** The check runs on activation
  and on-demand (panel open / Re-check button); there's no scheduled job
  re-validating the list over time. A future iteration could add a periodic
  re-check (e.g., surface a warning if a previously-passing id starts
  returning 404, which would itself be a signal worth investigating).

## Central registration

Directory name for `scripts/apply-ui.mjs`'s extension list (not edited by
this change, per the task's file-lane restriction):

```
lakshx-extensions
```

This extension has no native/runtime `dependencies` in `package.json` (no
`node_modules` install step needed at build time, unlike `lakshx-db`'s
`mongodb` or `lakshx-chat`'s `playwright-core`), so it likely only needs the
same registration as `lakshx-ui`/`lakshx-graph` (copy into
`upstream/extensions/lakshx-extensions`) — not the extra `build/npm/dirs.ts`
entry that `lakshx-db`/`lakshx-chat` needed for their real npm dependencies.

## Running the tests

```sh
cd product/lakshx-extensions
node --test test/*.test.js
```

26 tests, all passing as of this change, including two live-network tests
that hit the real Open VSX API (they call `t.skip(...)` with an explicit
message instead of failing if the sandbox running them has no network
access — see `test/verify.test.js`).
