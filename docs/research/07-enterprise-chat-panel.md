# Research: Enterprise Chat Panel Backlog (July 2026)

Grounded in our actual code (extension.js / panel.js / server.ts / loop.ts) + Cursor/Copilot/Cline/Windsurf parity. Items marked ✅ shipped in panel v2.

## P0 (parity floor)
1. ✅ Chat store + restore-on-show + history panel (extension-owned transcript → ~/.koder/chats/*.json)
2. Auto-generated titles — `koder/title` runtime request w/ cheapest model of session provider; fallback first-40-chars (fallback ✅)
3. ✅(partial) Markdown blocks + highlighter + copy button. TODO: committed-prefix streaming (render only last open block per tick, freeze completed blocks — kills long-message re-render cost)
4. File-path links → openFile w/ line (regex over rendered text; delegated click → showTextDocument). Diff cards for edit tools: render old/new from rawInput; "Open diff" via TextDocumentContentProvider + vscode.diff
5. @-file mentions (findFiles autocomplete popup), context chips, cmd+shift+L add-selection, workspace+branch indicator
6. Turn controls: regenerate / edit-last / retry-with-model — needs `koder/rewind {turns}` in server.ts (splice session.history)
7. Permission policy: allow_always option per tool kind; durable ~/.koder/policy.json per workspace; audit JSONL receipts (~/.koder/audit/YYYY-MM.jsonl) — cheapest true enterprise differentiator. ✅ mode ladder UI
8. A11y: aria-live status node (turn boundaries only, not per-token), role=alertdialog + focus mgmt on permission bar, :focus-visible, Esc = stop

## P1
9. Shadow-git checkpoints (Cline pattern): git init in globalStorage w/ core.worktree=workspace; commit before each mutating tool; Compare via vscode.diff, Restore files / files+conversation; skip >50k-file repos
10. Usage/cost/context meter: loop.ts already gets usage — emit `koder/usage`; pricing.json table; footer meter `38% ctx · 12k↑ 3k↓ · $0.04`; warn at 80%
11. History search/pin/trash (soft-delete to .trash/)
12. Image attachments: paste/drop → base64 chips; widen server.ts prompt filter beyond text; vision providers only
13. Long transcripts: `content-visibility:auto` on .msg/.tool first; collapse-older placeholder past 300 nodes; multi-window: atomic tmp+rename writes + sessionOwner pid; workspace switch → respawn agent w/ new cwd

## P2
- ACP `loadSession:true` + session/load replay (Zed/JetBrains clients get history)
- Rules/memories: ~/.koder/rules.md + workspace .koder/rules.md injected into system prompt
- Side chats/forking; @problems (getDiagnostics — easy, promote); @terminal via shell integration API
- Auto-summarize history at 90% context; org-managed policy file (mode floor, provider allowlist)

Key code hook points: extension.js onSessionUpdate (was dropping thought/mode/tool-content updates — fixed), server.ts session/set_mode + permission options, loop.ts session.history array (rewind/replay splice point).

Sources: docs.cline.bot/core-workflows/checkpoints · deepwiki.com/cline (checkpoints internals) · cursor.com/changelog · docs.github.com/copilot features · docs.windsurf.com cascade/memories · agentclientprotocol.com/protocol/session-setup
