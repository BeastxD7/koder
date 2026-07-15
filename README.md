# LakshX

The world's best IDE for agentic development — measured by the **shipping quality of the software its users produce**.

See [PLAN.md](PLAN.md) for the full implementation plan and `docs/research/` for the sourced research behind every decision.

## Repo layout (thin-fork discipline)

We do **not** vendor the VS Code source. Like VSCodium, the upstream `microsoft/vscode` (code-oss, MIT) tree is fetched at build time into `upstream/` (gitignored) at a pinned tag, then our overlay is applied. Everything LakshX-specific lives in this repo:

```
product/          # product.json overrides: branding, Open VSX endpoints
patches/          # minimal fork-level patches against upstream (keep TINY)
scripts/          # fetch / prepare / build / run pipeline
agent/            # LakshX Agent Runtime — editor-independent, speaks ACP
docs/             # plan research, perf budgets
upstream/         # (gitignored) pinned code-oss checkout
```

## Getting started

```sh
./scripts/fetch-vscode.sh    # shallow-clone upstream at the pinned tag
./scripts/prepare.sh         # apply LakshX overlay (product.json, patches)
./scripts/dev.sh             # install deps, compile, launch dev build
```

Agent runtime spike:

```sh
cd agent && npm install && npm run spike   # ACP client → Claude Code
```

## The rules that keep the fork thin

1. Everything that can be an extension IS an extension.
2. Fork-level patches only for what extensions cannot do (review multi-buffer, inline diff decorations, agent chrome).
3. Upstream lag SLO: ≤ 2 months behind the pinned tag.
4. The agent runtime never links against the editor — ACP over stdio only.
