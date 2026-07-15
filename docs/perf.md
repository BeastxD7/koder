# LakshX performance budgets & baseline

## Budgets (commitments from PLAN.md §4)

| Interaction | Budget |
|---|---|
| Keystroke → glyph | ≤16ms end-to-end (Electron floor) |
| Palette open / tab switch / panel toggle | <50ms |
| Local action feedback (optimistic UI) | <100ms |
| First streamed agent token | <1s |
| Streaming markdown re-parse | 50–100ms debounce, incremental |
| Lists/trees/diffs | virtualized, O(visible rows) |
| Checkpoint restore | <500ms perceived |
| Cold start to editor interactive | <3s (beat VS Code's 2–4s; track every release) |

## Baseline measurement (requires GUI — run manually)

[Typometer](https://pavelfatin.com/typometer/) measures true end-to-end keystroke→pixel
latency via screen capture. Java app; run it against each editor with the same
document, font size, and display (disable ProMotion variable refresh during runs).

Editors to baseline on this machine (Apple Silicon, macOS 26):

1. VS Code 1.128 stock
2. Cursor (latest)
3. Zed (latest) — the native reference point
4. LakshX dev build (`./scripts/dev.sh`)

Record min/avg/max into the table below. Reference published numbers: GVim 1.4ms,
IntelliJ zero-latency 4.3ms, Sublime 12.6ms, Atom 60ms (Fatin); VS Code community
measurements ~15–25ms.

| Editor | min | avg | max | date |
|---|---|---|---|---|
| VS Code 1.128 | | | | |
| Cursor | | | | |
| Zed | | | | |
| LakshX dev | | | | |

Also record per release: cold-start time (quit → window interactive, `time` +
stopwatch), RSS after opening the vscode repo itself (Activity Monitor, sum of
helper processes).

## Phase 1 entry item (carried from Phase 0)

- **Settings-import wizard**: first-run import of VS Code/Cursor settings.json,
  keybindings, extension list (re-resolved against Open VSX), and themes.
  Cursor's version is the single most-copied onboarding move — see
  `docs/research/04-ux-patterns-performance.md` §6.
