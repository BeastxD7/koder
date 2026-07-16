# LakshX Search

Semantic/embedding-based codebase search — "ask the codebase" conceptual
queries against a local vector index. See
`docs/research/15-ide-feature-roadmap.md`, item #7.

**This complements grep/literal search. It does not replace it.** For an
exact string, symbol name, or regex, use ripgrep/`grep`/VS Code's built-in
Find in Files — those are exact, instant, and need no index or API call.
Use LakshX Search when you don't know the exact string to look for: "where
do we validate the destructive-command floor", "what handles re-auth on a
401", "how are checkpoints named" — conceptual questions grep can't answer
because the words in your head aren't necessarily the words in the code.

This extension is **fully standalone**: it does not import from or route
through `agent/src` or `product/lakshx-chat`. It reads the same
`~/.lakshx/providers.json` BYOK file everything else does, but keeps its own
small copy of the provider preset table (`lib/config.js`) and makes its own
direct HTTPS calls to an embeddings endpoint (`lib/embeddings.js`, plain
`fetch`, no SDK).

## Commands

- **LakshX Search: Rebuild Index** — full workspace scan. Shows an
  estimated chunk count and API request count and asks you to confirm
  before spending any embeddings-API budget.
- **LakshX Search: Ask the Codebase** — type a natural-language query, get
  ranked results, click one to jump to that file/line range.

## Which providers can do embeddings

Anthropic's API is chat/Messages-only — it never exposes an embeddings
endpoint. Embeddings need an OpenAI-compatible provider. Checked against
each provider's own docs while building this:

| Provider | Embeddings? |
|---|---|
| `openai` | confirmed (`/v1/embeddings`, e.g. `text-embedding-3-small`) |
| `openrouter` | confirmed (`/api/v1/embeddings`, proxies many embedding models) |
| `mistral` | confirmed (`mistral-embed`) |
| `gemini` | confirmed (via the OpenAI-compat shim, `gemini-embedding-001`) |
| `ollama` | confirmed, IF you've pulled a local embedding model (e.g. `nomic-embed-text`) |
| `groq`, `deepseek`, `xai`, `cerebras` | unconfirmed — their client SDKs expose an `embeddings()` method (OpenAI-client-derived boilerplate) but there's no confirmation they actually host embedding models today |
| `anthropic` | never — chat/Messages API only |

If only Anthropic is configured, "Rebuild Index" and "Ask the Codebase"
both show: *"The only provider(s) configured (anthropic) don't do
embeddings... embeddings need an OpenAI-compatible provider configured"* —
not a cryptic HTTP error. If nothing at all is configured, or the index
doesn't exist yet, you get the same kind of plain-language guidance instead
of a stack trace. `lib/config.js`'s `resolveEmbeddingsProvider()` is the one
place all of this logic lives, unit-tested in `test/config.test.js`.

Auto-selection, when you haven't set `lakshx.search.provider`, prefers
confirmed providers in this order: openai, mistral, gemini, openrouter,
ollama. `ollama` is deliberately **not** auto-assumed available the way
`agent/src/config.ts` treats it for chat (that file defaults ollama's key
in unconditionally, since trying a local no-auth server as a chat default
is harmless) — for embeddings that default would mean an Anthropic-only
user silently gets routed to a probably-not-running `localhost:11434`
instead of the clear guidance message above. `ollama` only counts as
configured here if you have an explicit `"ollama": {...}` entry in
`providers.json` (even an empty object opts in) or set `OLLAMA_API_KEY`.

## Indexing: chunking strategy

Fixed-size overlapping **line windows** (default 60 lines, 10 lines of
overlap between consecutive chunks), not function/class-boundary
detection. This is a documented choice, not an oversight:

- `product/lakshx-graph/lib/depgraph.js` already shows how much
  per-language nuance even a lightweight *import-statement* regex needs
  (comment stripping, multi-line specifiers, several import syntaxes) for
  just two languages. Function/class-boundary chunking needs the same kind
  of per-language grammar (`function`/`def`/`class`, brace-matching vs.
  Python indentation vs. Ruby `end`...) to avoid garbage chunks on syntax
  it doesn't recognize — and this extension has no per-file language gate,
  it indexes whatever text files are in the workspace, in any language.
- Fixed-size line windows work identically for any text file regardless of
  language or markup.
- Line numbers are the natural unit for "startLine/endLine" and for
  click-to-jump, which is the whole point of the query UI.
- The overlap means a function/class that straddles a chunk boundary still
  appears whole in at least one neighboring chunk — the practical benefit
  boundary-detection would have bought, without the per-language fragility.

Whitespace-only chunks (common at file tails) are dropped before they'd
otherwise waste an embeddings-API call slot.

## Storage

`.lakshx/search-index.db` in the workspace root, using Node's built-in
`node:sqlite` (`DatabaseSync`) — the same zero-native-dependency approach
as `product/lakshx-db/lib/drivers/sqlite.js`: no `better-sqlite3`/no native
module (would break cross-platform packaging), verified against this
fork's shipped runtime (Electron 42.5.0 / Node 24.17.0).

**This is not a vector database with an ANN index** — no `sqlite-vss`/
`vec0` extension, no approximate search structure. It's plain SQLite tables
plus a full JS scan computing cosine similarity per query (`lib/similarity.js`,
pure dot-product/cosine, no native math library). That's the intentional
scale target: a single repo's chunk count (thousands, not millions) is fine
for an O(n) scan; this explicitly does not aim to scale past that.

Schema: a `files` table (`file_path`, `content_hash`, `chunk_count`,
`updated_at`) for change detection, a `chunks` table (`file_path`,
`start_line`, `end_line`, `chunk_text`, `embedding`) with the embedding
stored as a raw float32 **BLOB** (not JSON text — ~4 bytes/dimension
instead of ~15-20 decimal-text chars/dimension, meaningful at thousands of
rows × 1536 dims), and a `meta` table recording which `providerId`/`model`
the index was built with.

**`.lakshx/search-index.db` should be gitignored** — it's a local,
regeneratable, potentially large binary artifact, not source. This
extension does not touch the repo's root `.gitignore` (outside its file
lane); add `.lakshx/search-index.db` yourself, the same way `.lakshx/plans/`
is already ignored for the agent's scratch plan drafts.

## Incremental re-sync

`vscode.workspace.onDidSaveTextDocument` re-embeds **only the saved file's
new chunks**, not a full repo re-index:

1. Compute the saved file's content hash (sha1, change-detection only — not
   a security hash).
2. If it matches what's stored, do nothing (this is the common case: a
   save that didn't really change tracked content, or an editor re-save).
3. If it changed, re-chunk just that file, embed just those chunks, and
   replace that file's rows in the `chunks` table.

**Guardrail: this only runs if an index already exists.** A workspace
where you've never run "Rebuild Index" gets zero auto-embedding on save —
otherwise the very first save after installing this extension would start
silently spending API budget before you ever confirmed anything, which is
exactly what the cost guardrail below exists to prevent. Saved files are
also run through the same exclude-directory/binary/size-cap checks as a
full index (`lib/indexer.js`'s `isExcludedPath`/`looksBinary`), so saving a
file inside `node_modules` or a huge generated blob that slipped into the
workspace is a no-op, not an accidental embed.

The full-scan "Rebuild Index" command remains available any time — after
pulling a branch with many changed files, after switching embedding
providers/models, or just to prune files that were deleted since the last
index (`planFullIndex`'s `toDelete` list).

## Query

Natural-language input box → embed the query with **the same
provider/model the index was built with** (recorded in the `meta` table,
not whatever the current default happens to be — a query vector from a
different embedding model is meaningless, and often a different
dimensionality entirely, against the stored chunks) → rank all stored
chunks by cosine similarity → merge overlapping/adjacent hits from the same
file into one result (the chunker's overlap deliberately duplicates a few
lines between neighbors, so a strong hit would otherwise show up 2-3 times
back to back) → show the top N (`lakshx.search.topN`, default 15) as a
QuickPick with file:line-range, a similarity score, and a snippet. Picking
one opens the file and reveals that line range.

If the provider the index was built with is no longer configured, you get
a "rebuild the index" prompt — never a silent fallback to a different
provider/model that would just produce meaningless scores.

## Cost guardrail

Embeddings API calls cost money on most providers. "Rebuild Index" always
shows, and requires confirming, an estimate **before** any API call:
*"This will (re-)embed N file(s) as ~C chunk(s), ~B API request(s) to
"providerId"..."* — computed from the actual chunk plan
(`lib/indexer.js`'s `estimateChunkCount`/`estimateBatchCount`), not a rough
guess. A rebuild also skips files whose content hash hasn't changed since
the last index, so re-running it after a small change only re-embeds what
actually changed, keeping both the dollar cost and the confirmation number
honest on repeat runs.

Per-file incremental re-embeds on save are NOT re-confirmed individually
(that would mean a modal dialog on every save) — this is intentional: a
single file's chunk count is small and bounded by the same
`maxFileBytes` cap as a full index, and the guardrail's real job (stopping
an unbounded whole-repo spend) is fully covered by requiring the initial
"Rebuild Index" confirmation before incremental sync can even begin.

## Configuration

`lakshx.search.provider` / `.model` (override auto-selection),
`.chunkLines` / `.chunkOverlapLines` (default 60/10), `.batchSize` (chunks
per embeddings request, default 32), `.topN` (results shown, default 15),
`.maxFiles` / `.maxFileBytes` (scan bounds, default 2000 files / 512KB).

## Known limitations (v1, by design)

- Single-workspace-folder at a time (multi-root asks you to pick one — each
  folder would need its own index and possibly its own provider choice).
- All chunk embeddings are loaded into memory per query (`getAllChunkRows`)
  — fine at single-repo scale, not built to scale past it.
- Deleted-file pruning only happens on a full "Rebuild Index" run, not on
  file-delete events (out of the incremental-sync scope this pass covers).
- Chunking is language-agnostic fixed-size windows, not AST-aware — see
  "Chunking strategy" above for why that's a deliberate v1 tradeoff.
