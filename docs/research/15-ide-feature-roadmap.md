# IDE feature roadmap (beyond the agent layer)

Broad research pass on what makes a modern coding IDE good, deliberately
scoped AWAY from agentic-loop features (covered in doc 12) — the actual
editor/IDE experience itself. Additive to what's shipped: LakshX Dark theme
+ modern editor defaults (lakshx-ui), the ACP chat panel with checkpoints/
undo/browser-tool/remote-control (lakshx-chat), a dual call-graph +
import-dependency graph with cycle detection (lakshx-graph), multi-engine
DB schema+data+query (lakshx-db), and an IDE music player (lakshx-commentary,
renamed). None of that touches: tab-completion, terminal UX, test-runner UX,
merge-conflict UX, semantic search, structural search, or extension curation
— that's the open space this covers.

## Top 10 (ranked wow × feasibility for this stack)

1. **Inline dependency-vulnerability hints** (low-med) — reuses the existing
   `lib/depgraph.js` import graph; add one free OSV.dev lookup + a decoration
   layer. Catches hijacked-package attacks at the point of use.
2. **Default-on inline test results + coverage gutter** (low for the 80% win)
   — wire VS Code's own native Testing API on by default for Jest/Vitest/
   pytest, matching lakshx-ui's "flip the good defaults on" precedent. Full
   Wallaby-style live-as-you-type eval is high-complexity, separate scope.
3. **Terminal command blocks** (low-med) — group command+output into
   collapsible units with exit code/rerun, using VS Code's existing
   shell-integration marks (not a Warp-style renderer rewrite).
4. **Tab / next-edit prediction** (medium) — wire an existing low-latency
   model (Zeta/Codestral/Mercury Coder) behind VS Code's stock
   inline-completion API; the hard R&D (the model) is already solved
   elsewhere.
5. **Universal command bar** (medium) — merge file/symbol search + command
   palette + natural-language dispatch to lakshx-chat, extending the
   Command Center already enabled by lakshx-ui.
6. **AI-assisted merge conflict resolution** (medium) — agent proposes
   resolutions into VS Code's native 3-way merge editor, gated by the
   existing checkpoint/rewind system as the safety net (never auto-applied).
7. **Semantic/embedding codebase search** (medium-high) — complements grep,
   not a replacement; biggest win past ~1,000 files where literal search
   degrades.
8. **"Explain this crash" using repo history** (low-med) — hook the
   debug-adapter-protocol exception event to the existing ACP agent; no new
   execution/replay engine needed.
9. **Structural search & replace** (medium-high) — JetBrains-SSR-style
   syntax-aware find/replace by code shape; complements the agent (which is
   nondeterministic/slow for bulk mechanical changes), doesn't duplicate it.
10. **Curated/vetted extension panel** (low) — fork-specific supply-chain
    fix: stop recommending Marketplace extensions that don't exist on Open
    VSX (a named, real squatting risk for VS Code forks as of Jan 2026).

## Explicitly cut, not ranked

- **Zed-style GPU-rendered UI** — architectural; can't be added without
  abandoning the Electron/DOM fork model entirely.
- **From-scratch multiplayer co-editing** — Microsoft's own Live Share
  extension is bundleable near-zero-cost; building OT/CRDT from scratch
  would be reinventing an already-solved, already-available piece.

## Status

Research only — nothing implemented yet. Menu for the product owner to pick
from, not a committed plan.
