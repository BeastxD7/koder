# LakshX Command Bar

A JetBrains "Search Everywhere"-style universal entry point: one search box
that merges workspace file search, workspace symbol search, and
command-palette actions into a single ranked, sectioned list. Extends the
Command Center precedent already enabled by `lakshx-ui` — see
`docs/research/15-ide-feature-roadmap.md`, item #5, for the original pitch.

## v1 scope

**Pure search/palette merge only.** Natural-language dispatch to the LakshX
agent ("ask it to fix X", routed into `lakshx-chat`) is **explicitly deferred
to a v2**, once `lakshx-chat`'s current work lands. This extension does not
call, import, or reference `lakshx-chat` in any way.

## How to open it

- **Keybinding**: `Ctrl+K G` (Windows/Linux) / `Cmd+K G` (macOS).
- **Status bar**: a persistent `$(search) Command Bar` item, right-aligned,
  priority 995 (visible from startup — see "Activation" below).
- **Command palette**: `LakshX: Open Command Bar`.

### Why `Ctrl/Cmd+K G` and not `Ctrl/Cmd+K Ctrl/Cmd+K`

The task brief suggested `Cmd/Ctrl+K Cmd/Ctrl+K` as an example chord. Before
picking it, this repo's actual VS Code fork source
(`upstream/src/vs/**`, `upstream/extensions/**`) was grepped for existing
registrations, since that's authoritative for this fork (not upstream
VS Code's public docs, which can drift from a customized build):

- `Ctrl/Cmd+K Ctrl/Cmd+K` **is already bound**, twice:
  - `editor.action.defineKeybinding` in
    `upstream/src/vs/workbench/contrib/preferences/browser/preferences.contribution.ts`
    (gated to the keybindings.json editor resource).
  - `editor.action.selectFromAnchorToCursor` in
    `upstream/src/vs/editor/contrib/anchorSelect/browser/anchorSelect.ts`
    (gated to `SelectionAnchorSet`, i.e. only after `Ctrl+K Ctrl+B`).
  Both are `when`-clause gated, so a collision would be rare in practice —
  but it's a real, registered collision, not a clean chord, so a different
  one was chosen instead.
- The `Ctrl+K` prefix is otherwise **heavily used** in this fork: a grep of
  every `KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, ...)` registration in
  `upstream/src/vs` plus every `"ctrl+k …"` keybinding contributed by the
  built-in `git` and `markdown-language-features` extensions turned up
  second-key letters `A,B,C,D,E,F,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y,Z`
  already spoken for in some combination of plain/`Ctrl`-held second press
  (`V`, specifically, is `Markdown: Open Preview to the Side`).
- `G` was the one letter that did not turn up in that grep, in either form
  (`Ctrl+K G` or `Ctrl+K Ctrl+G`), in core or in the built-in extensions.
  `Ctrl+K G` was chosen (mnemonic: **K**, then **G**o-to-anything), and does
  not collide with VS Code's own `Ctrl/Cmd+P` (Quick Open) or
  `Ctrl/Cmd+Shift+P` (Command Palette) defaults either.

This is an empirical check against this specific fork's source, not a claim
about upstream VS Code in general — if `product.overrides.json` or a future
upstream merge ever rebinds `Ctrl+K G`, this would need re-checking (it
currently declares no keybinding overrides at all).

## What's merged, and how

| Source | API used | Status |
|---|---|---|
| **Files** | `vscode.workspace.findFiles(glob, exclude, 50, token)` | Clean. Query is escaped and wrapped as a bounded substring glob (`**/*<query>*`); results are then fuzzy-scored again locally so ranking isn't just "whatever findFiles returned first." Same exclude list as `lakshx-graph`'s dependency scan (`node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.venv`, `venv`, `__pycache__`, `coverage`, `vendor`). |
| **Symbols** | `vscode.commands.executeCommand("vscode.executeWorkspaceSymbolProvider", query)` | Clean. This is a real, documented, usable public API. Only returns results when the active language(s) register a workspace symbol provider; an empty result is treated as "no provider," not an error. |
| **Commands** | `vscode.commands.getCommands(true)` (ids) + `vscode.extensions.all[].packageJSON.contributes.commands` (id → title map) | **Partial — see gap below.** |
| **Settings** | — | **Not implemented — see gap below.** |

Each source is capped to 8 results (`PER_SOURCE_CAP`), debounced 120ms after
the last keystroke, and a generation counter drops any source's results that
resolve after a newer keystroke has already superseded them (so a slow old
query can never render over a fresh one). File search additionally gets a
real `vscode.CancellationTokenSource` cancelled on every new keystroke.

Selecting a result:
- **File** → opens it (`vscode.window.showTextDocument`, preview mode).
- **Symbol** → opens its file and moves the cursor/selection to the exact
  line/column from `SymbolInformation.location.range`.
- **Command** → `vscode.commands.executeCommand(id)`.

### Known gap #1: command titles are not fully reachable

`vscode.commands.getCommands(true)` returns command **IDs** only (e.g.
`workbench.action.files.save`), not the human-readable titles the built-in
Command Palette shows (`File: Save`). There is no public API that returns a
title for every registered command — the palette's title strings come from
`MenuRegistry` / `registerAction2` metadata that is internal to
vscode-core, not part of the extension API.

What this extension does instead: it builds an id → title map from every
installed extension's `contributes.commands` in its `package.json`
(`vscode.extensions.all[].packageJSON`). That covers most commands a user
would actually search for by name — `git`, `markdown-language-features`,
`npm`, `debug`, and every third-party extension all contribute commands this
way. It does **not** cover core workbench commands registered purely in
TypeScript with no `package.json` entry. For those, the result still shows
up (id-matched), but its label falls back to the raw command id and its
description reads `(no contributed title — showing raw command id)` so the
gap is visible rather than papered over. This also means the palette's own
`when`-clause visibility filtering (hiding commands that aren't currently
applicable) is **not** replicated — every non-internal command id is a
candidate here, applicable or not.

### Known gap #2: settings search is not implemented

VS Code does not expose a public API to search or enumerate the Settings
schema (descriptions, categories, current values) the way the built-in
Settings editor does — there's no `vscode.executeSettingsSearch` or
equivalent. Rather than fake this with a small hand-maintained list of
"common settings" and imply broader coverage than it has, this v1 ships
**no settings source at all**. This is a deliberate, documented gap, not an
oversight.

## Files

- `extension.js` — vscode wiring: quick pick session, the three source
  functions, action dispatch, status bar item, activation.
- `lib/omnibox.js` — pure logic, no `vscode` dependency: fuzzy scoring,
  glob-escaping, per-section ranking + section-header assembly, a
  generation-based staleness guard, and a dependency-injectable debounce.
- `test/omnibox.test.js` — `node --test` unit tests over `lib/omnibox.js`
  (22 tests; fake timers, no real `setTimeout` sleeps).
- `package.json` — `onStartupFinished` activation (so the status bar item
  is actually reachable on a fresh window — see commit `745c1a4`, which
  fixed exactly this bug for `lakshx-db`/`lakshx-graph`), the
  `lakshx.commandbar.open` command, and its keybinding.

## Verification performed

- `node --check extension.js` and `node --check lib/omnibox.js` — both pass.
- `package.json` parses as valid JSON.
- `node --test test/*.test.js` — 22/22 pass, covering fuzzy scoring
  (substring bonus, start-of-string bonus, case-insensitivity, word-boundary
  bonus, no-match rejection), glob-escaping, per-source ranking/capping,
  section-header assembly (including omitting empty sections), the
  generation/staleness guard, and debounce collapsing/cancel behavior
  against a fake, injectable clock.

**Not verified**: the live `createQuickPick()` UX itself (typing, seeing
results render/re-rank as you type, selecting an item, the keybinding
actually firing) — that needs a running Extension Host / an actual VS Code
window, which this task's environment doesn't have. What's checked here is
static (syntax, JSON validity) and the pure ranking/merging/debounce logic
in isolation. Manual smoke-testing in a real Extension Host is the
recommended next step before shipping.

## Central registration

Directory name for `scripts/apply-ui.mjs`'s extension list:
**`lakshx-commandbar`** (no real npm dependencies, so no `dirs.ts` patch
should be needed — see how plain `lakshx-graph`/`lakshx-commentary` are
registered vs. how `lakshx-db`/`lakshx-chat`, which do have real
dependencies, needed the extra `dirs.ts` entry).
