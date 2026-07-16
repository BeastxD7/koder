# LakshX Graph — design notes

This extension now ships **two** graph views in one webview panel:

1. **Call graph** (pre-existing) — function call hierarchy seeded from the
   cursor, driven by VS Code's own `vscode.prepareCallHierarchy` /
   `provideIncoming|OutgoingCalls` LSP surface. Layered left→right tree.
2. **Dependency graph** (new) — a workspace-wide, interactive map of file,
   module and package **import** dependencies. Force-directed.

A segmented toggle in the toolbar switches between them; each mode owns its
own legend, controls and render path. The two share only zoom/pan and the
canvas — call-mode state (`nodesById`/`edges`/`parentOf`) is never touched by
dep-mode (its own `depNodes`/`depEdges`), so the existing call graph keeps
working unchanged.

## 1. Dependency extraction

VS Code has no built-in import-graph API, so we scan the workspace ourselves.
All parsing lives in `lib/depgraph.js`, which is **vscode-free** and unit-tested
directly with `node --test` (`test/depgraph.test.js`, 25 tests).

- **Languages (v1):**
  - JS/TS/JSX/TSX (`.js .jsx .mjs .cjs .ts .tsx .mts .cts`):
    `import … from "x"`, bare `import "x"`, `export … from "x"`,
    `export * from "x"`, dynamic `import("x")`, `require("x")`.
  - Python (`.py .pyi`): `import a`, `import a.b.c as d`, `import a, b`,
    `from x import y`, and relative `from . / .mod / ..pkg import y`.
- **Regex/line-based, not AST** — deliberate tradeoff: robust, dependency-free,
  fast over thousands of files, and easy to extend per language. Cost: import-
  like text inside comments/strings can false-positive. We mitigate the common
  case by stripping `/* … */` block comments (JS) and `#`/`//` line comments
  before matching, and by skipping template-literal `import(\`…${x}\`)` cleanly
  rather than crashing. A full multi-language parser is out of scope for v1.
- **Resolution** (`resolveImport`):
  - JS relative specifiers resolve against a real file set with an extension
    try-order (`.ts .tsx .d.ts .js .jsx .mjs .cjs .json`) and `index.*` folder
    resolution. TS is tried before JS so source wins over compiled output.
  - Python relative imports resolve by dot-level against the importing file's
    package dir, incl. `__init__.py` packages.
  - Bare/package imports become **external** nodes, grouped by clean package
    name (`react-dom/client` → `react-dom`, `@scope/pkg/sub` → `@scope/pkg`).
- **Bounded static scan** (extension.js): `vscode.workspace.findFiles` with an
  include glob + an exclude glob (`node_modules,.git,dist,build,out,.next,
  .venv,venv,__pycache__,coverage,vendor`), capped at **2000 files** and
  **512 KB/file**. No code is ever executed.

## 2. Graph model & metrics

- **Nodes**: `internal` (a workspace file) and `external` (a package).
- **Edges**: directed "imports" (`from` → `to`), carrying the import `kind`.
- **Metrics**: per-node **fan-in** / **fan-out**; **orphan** files (no edges
  either way); **circular dependencies** via **Tarjan's SCC** (iterative, so it
  survives large graphs) — every strongly-connected component with >1 node (or a
  self-loop) is a cycle cluster. Externals are sinks and never cyclic.
- **Render cap**: payload capped at ~600 nodes — all cyclic nodes kept, then
  highest-degree internals, then attached externals. `stats` always reflects the
  **full** graph so the numbers stay honest even when the view is truncated.

## 3. UI / UX

Primary layout for the dependency graph is **force-directed**
(Fruchterman-Reingold: O(n²) repulsion + link attraction + mild gravity), on the
existing vanilla-canvas stack (no libs, no CDN). It runs a **fixed** number of
pre-settle iterations then freezes, so the layout is **deterministic** (stable
screenshots, no perpetual jitter). Above 400 nodes it falls back to a
deterministic golden-angle spiral instead of the O(n²) sim.

Features: zoom/pan (shared with call-mode), **click-to-focus** (lights a node +
its direct neighbors, dims the rest; second click on a focused file opens it),
**hover tooltip** (path, type, fan-in/out, cycle flag), **search/filter** box
(Enter jumps to first match), **legend**, **cycle highlighting** (red nodes +
red edges), **hide externals** and **collapse externals** (fold all packages
into one aggregate node — the "grouped/collapsed" external treatment), and a
live **stats bar**. Theme: dark, same VS Code CSS-variable palette as the
sibling webviews; CSP stays `default-src 'none'` with scoped script/style/font
(canvas needs no `img-src`).

## 4. Entry points

- Command **`lakshx.showDependencyGraph`** ("LakshX: Show Dependency Graph"),
  in the command palette, alongside the existing `lakshx.showCallGraph`.
- A second **status bar item** `$(type-hierarchy) Dep Graph` at priority **996**
  (right beside Call Graph's 997, same right-aligned cluster), registered in the
  same `activate()` path under `onStartupFinished`. Unlike Call Graph it needs
  no cursor, so it's always actionable.
- In-panel **toggle** between "Dependencies" and "Call graph". Each view is
  populated by its own command/scan; switching to an empty view shows a hint +
  "Scan workspace" button rather than guessing at the cursor.

## Verification & honesty

- `node --check` passes on `extension.js`, `media/graph.js`, `lib/depgraph.js`.
- `node --test` — 25 passing tests for extraction, resolution, `buildGraph`
  metrics, and cycle detection (2-cycle, 3-cycle, DAG, self-loop, 300-node ring).
- Renderer + all dep interactions verified in `test/harness.html` via a headless
  Chrome pass (force layout, cycle highlight, search, click-to-focus, hover
  tooltip, collapse-externals), plus a call-graph regression render. No console
  or CSP errors observed.
- **Not verified live**: the `vscode.workspace.findFiles` scan path runs only
  inside a real extension host, which isn't available here. That wiring is
  code-reviewed and inspection-only; the extraction/model it feeds is fully
  tested in isolation.
