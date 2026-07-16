// LakshX Search — semantic/embedding codebase search, complementing (not
// replacing) grep/literal search. Fully standalone: no dependency on or
// routing through agent/src or lakshx-chat — this file makes its own direct
// HTTPS calls to an embeddings endpoint (lib/embeddings.js) using the same
// ~/.lakshx/providers.json BYOK config every other LakshX surface reads
// (lib/config.js has its own small copy of the preset table so this module
// never imports from agent/src/config.ts).
//
// This is the only vscode-touching file in the extension: workspace file
// walking, the save-triggered incremental re-sync, and the query
// QuickPick/InputBox UI all live here. Everything decision-worthy (change
// detection, chunking, ranking/merging, provider-capability resolution) is
// pure and lives in lib/*.js, directly `node --test`-able without an
// extension host — see test/*.test.js.
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const cfgLib = require("./lib/config.js");
const { snippetOf } = require("./lib/chunker.js");
const { rankChunks, mergeAdjacentHits } = require("./lib/similarity.js");
const { embedBatch, embedAll } = require("./lib/embeddings.js");
const store = require("./lib/store.js");
const idx = require("./lib/indexer.js");

const output = vscode.window.createOutputChannel("LakshX Search");

// Guards a single in-flight rebuild/query per workspace folder so a user
// mashing the command (or a save landing mid-rebuild) can't race two writers
// against the same sqlite file.
const busyKeys = new Set();

function dbPathFor(folder) {
  return path.join(folder.uri.fsPath, ".lakshx", "search-index.db");
}

function relPathOf(folder, fsPath) {
  return path.relative(folder.uri.fsPath, fsPath).split(path.sep).join("/");
}

function settings() {
  const cfg = vscode.workspace.getConfiguration("lakshx.search");
  return {
    provider: cfg.get("provider", "") || undefined,
    model: cfg.get("model", "") || undefined,
    chunkLines: cfg.get("chunkLines", 60),
    overlapLines: cfg.get("chunkOverlapLines", 10),
    batchSize: cfg.get("batchSize", 32),
    topN: cfg.get("topN", 15),
    maxFiles: cfg.get("maxFiles", idx.SCAN_MAX_FILES),
    maxFileBytes: cfg.get("maxFileBytes", idx.SCAN_MAX_BYTES),
  };
}

function loadProvidersFileCfg() {
  return cfgLib.readProvidersFile();
}

/** Picks the single workspace folder to operate on. Multi-root workspaces are out of scope for v1 — each folder would need its own index/provider choice, so we ask the user to pick one rather than silently guessing. */
async function pickWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage("LakshX Search: open a folder/workspace first.");
    return undefined;
  }
  if (folders.length === 1) return folders[0];
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, folder: f })),
    { title: "LakshX Search: choose a workspace folder to index/search" },
  );
  return pick?.folder;
}

/** Shared "no usable provider" guidance surface — one place so the query path and the rebuild path show the exact same wording for the exact same reasons. */
function showProviderGuidance(resolved) {
  vscode.window.showErrorMessage(`LakshX Search: ${resolved.message}`);
}

// ---------------------------------------------------------------------------
// Rebuild Index (full scan)
// ---------------------------------------------------------------------------

async function walkWorkspaceFiles(folder, opts) {
  const uris = await vscode.workspace.findFiles(idx.SCAN_INCLUDE, idx.SCAN_EXCLUDE, opts.maxFiles);
  const files = [];
  for (const uri of uris) {
    const relPath = relPathOf(folder, uri.fsPath);
    if (idx.isExcludedPath(relPath)) continue; // belt-and-suspenders vs. findFiles' glob exclude
    let stat;
    try {
      stat = fs.statSync(uri.fsPath);
    } catch {
      continue; // deleted between findFiles and here — skip, not fatal
    }
    if (!stat.isFile() || stat.size > opts.maxFileBytes) continue;
    let buf;
    try {
      buf = fs.readFileSync(uri.fsPath);
    } catch {
      continue;
    }
    if (idx.looksBinary(buf)) continue;
    files.push({ filePath: relPath, text: buf.toString("utf8") });
  }
  return files;
}

async function rebuildIndex() {
  const folder = await pickWorkspaceFolder();
  if (!folder) return;
  if (busyKeys.has(folder.uri.fsPath)) {
    vscode.window.showWarningMessage("LakshX Search: an index/search operation is already running for this folder.");
    return;
  }

  const opts = settings();
  const fileCfg = loadProvidersFileCfg();
  const resolved = cfgLib.resolveEmbeddingsProvider(fileCfg, process.env, { preferredProviderId: opts.provider, preferredModel: opts.model });
  if (!resolved.ok) {
    showProviderGuidance(resolved);
    return;
  }
  if (resolved.warning) vscode.window.showWarningMessage(`LakshX Search: ${resolved.warning}`);

  busyKeys.add(folder.uri.fsPath);
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "LakshX Search: scanning workspace", cancellable: true }, async (progress, token) => {
      const files = await walkWorkspaceFiles(folder, opts);
      if (token.isCancellationRequested) return;

      const dbPath = dbPathFor(folder);
      const db = store.openStore(dbPath);
      try {
        const storedHashes = store.getAllFileHashes(db);
        const plan = idx.planFullIndex(files, storedHashes, { chunkLines: opts.chunkLines, overlapLines: opts.overlapLines });

        if (plan.toUpdate.length === 0 && plan.toDelete.length === 0) {
          vscode.window.showInformationMessage(`LakshX Search: index already up to date (${plan.unchanged} unchanged file(s), ${store.countChunks(db)} chunks).`);
          return;
        }

        const chunkCount = idx.estimateChunkCount(plan.toUpdate);
        const batchCount = idx.estimateBatchCount(chunkCount, opts.batchSize);
        // COST GUARDRAIL: confirm before spending any embeddings-API budget.
        // Embeddings calls cost real money on most providers — a large repo
        // full-index should never silently fire hundreds of requests.
        const confirmMsg =
          `This will (re-)embed ${plan.toUpdate.length} file(s) as ~${chunkCount} chunk(s), ` +
          `~${batchCount} API request(s) to "${resolved.providerId}"${plan.toDelete.length ? `, and prune ${plan.toDelete.length} deleted file(s)` : ""}. Continue?`;
        const choice = await vscode.window.showWarningMessage(confirmMsg, { modal: true }, "Continue");
        if (choice !== "Continue" || token.isCancellationRequested) return;

        // Record which provider/model/chunking this index is being built
        // with BEFORE the embed loop starts, not after it finishes. If the
        // loop is cancelled partway through (or throws — a network blip on
        // file 12 of 200), the rows committed so far are still real,
        // queryable data — leaving them meta-less would make a later query
        // fall through resolveEmbeddingsProvider's auto-selection instead of
        // reusing the provider/model those partial rows were actually
        // embedded with, silently producing meaningless cosine scores. A
        // partial index with correct meta is useful; a partial index with
        // no meta is a landmine.
        store.setMeta(db, "providerId", resolved.providerId);
        store.setMeta(db, "model", resolved.model);
        store.setMeta(db, "chunkLines", String(opts.chunkLines));
        store.setMeta(db, "overlapLines", String(opts.overlapLines));

        for (const del of plan.toDelete) store.deleteFile(db, del);

        let done = 0;
        for (const file of plan.toUpdate) {
          if (token.isCancellationRequested) break;
          progress.report({ message: `${file.filePath} (${++done}/${plan.toUpdate.length})` });
          if (file.chunks.length === 0) {
            store.deleteFile(db, file.filePath); // now-empty/whitespace-only file — nothing to search, don't leave stale chunks
            continue;
          }
          const embeddings = await embedAll(
            { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: resolved.model },
            file.chunks.map((c) => c.text),
            { batchSize: opts.batchSize },
          );
          store.upsertFile(
            db,
            file.filePath,
            file.hash,
            file.chunks.map((c, i) => ({ ...c, embedding: embeddings[i] })),
          );
        }

        if (!token.isCancellationRequested) {
          store.setMeta(db, "lastFullIndexAt", String(Date.now())); // marks a FULLY completed rebuild, distinct from the provider/model/chunking meta set above (which applies even to a partial/cancelled run)
          vscode.window.showInformationMessage(`LakshX Search: indexed ${plan.toUpdate.length} file(s), ${store.countChunks(db)} chunks total.`);
        } else {
          vscode.window.showWarningMessage("LakshX Search: rebuild cancelled — partial progress was saved (already-embedded files won't be re-embedded next run).");
        }
      } finally {
        store.closeStore(db);
      }
    });
  } catch (err) {
    output.appendLine(`[rebuildIndex] ${err?.stack ?? err}`);
    vscode.window.showErrorMessage(`LakshX Search: rebuild failed — ${err?.message ?? err}`);
  } finally {
    busyKeys.delete(folder.uri.fsPath);
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

async function runQuery() {
  const folder = await pickWorkspaceFolder();
  if (!folder) return;

  const dbPath = dbPathFor(folder);
  if (!fs.existsSync(dbPath)) {
    vscode.window.showInformationMessage('LakshX Search: no index yet for this folder. Run "LakshX Search: Rebuild Index" first.');
    return;
  }

  const query = await vscode.window.showInputBox({
    title: "LakshX Search — ask the codebase",
    prompt: "Natural-language / conceptual query (for exact strings, use regular grep/Find in Files instead — see the README).",
    placeHolder: "e.g. \"where do we validate the destructive-command floor\"",
  });
  if (!query) return;

  const db = store.openStore(dbPath);
  try {
    const totalChunks = store.countChunks(db);
    if (totalChunks === 0) {
      vscode.window.showInformationMessage('LakshX Search: the index is empty. Run "LakshX Search: Rebuild Index" first.');
      return;
    }

    const storedProviderId = store.getMeta(db, "providerId");
    const storedModel = store.getMeta(db, "model");
    const fileCfg = loadProvidersFileCfg();
    // Reuse the INDEX'S recorded provider/model, not the current default —
    // a query vector from a different embedding model is meaningless (and
    // often a different dimensionality entirely) against stored chunks.
    const resolved = cfgLib.resolveEmbeddingsProvider(fileCfg, process.env, { preferredProviderId: storedProviderId, preferredModel: storedModel });
    if (!resolved.ok) {
      showProviderGuidance(resolved);
      return;
    }

    let queryEmbedding;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "LakshX Search: searching…" }, async () => {
      const [emb] = await embedBatch({ baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: resolved.model }, [query]);
      queryEmbedding = emb;
    });

    const rows = store.getAllChunkRows(db);
    const skippedForDimMismatch = rows.some((r) => r.embedding.length !== queryEmbedding.length);
    const ranked = rankChunks(queryEmbedding, rows, { topN: settings().topN });
    const merged = mergeAdjacentHits(ranked);

    if (skippedForDimMismatch) {
      vscode.window.showWarningMessage("LakshX Search: some stored chunks have a different embedding dimensionality than the current query (likely from a since-changed model) and were excluded from ranking. Consider running Rebuild Index.");
    }
    if (merged.length === 0) {
      vscode.window.showInformationMessage("LakshX Search: no results.");
      return;
    }

    const items = merged.map((hit) => ({
      label: `$(file) ${hit.filePath}:${hit.startLine}-${hit.endLine}`,
      description: hit.score.toFixed(3),
      detail: snippetOf(hit.chunkText),
      hit,
    }));
    const picked = await vscode.window.showQuickPick(items, { title: `LakshX Search results for "${query}"`, matchOnDetail: true });
    if (!picked) return;

    const fileUri = vscode.Uri.file(path.join(folder.uri.fsPath, picked.hit.filePath));
    const doc = await vscode.workspace.openTextDocument(fileUri);
    const editor = await vscode.window.showTextDocument(doc);
    const startLine = Math.max(0, picked.hit.startLine - 1);
    const endLine = Math.max(startLine, picked.hit.endLine - 1);
    const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(Math.min(endLine, doc.lineCount - 1)).text.length);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch (err) {
    output.appendLine(`[runQuery] ${err?.stack ?? err}`);
    vscode.window.showErrorMessage(`LakshX Search: query failed — ${err?.message ?? err}`);
  } finally {
    store.closeStore(db);
  }
}

// ---------------------------------------------------------------------------
// Incremental re-sync on save
// ---------------------------------------------------------------------------

async function onSave(doc) {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return;
  if (doc.uri.scheme !== "file") return;

  const dbPath = dbPathFor(folder);
  // No index yet: do NOT auto-embed on save. Auto-embedding before the user
  // has ever confirmed a full index would silently start burning API budget
  // — exactly what the cost guardrail exists to prevent. Rebuild Index is
  // the only path that creates the index file in the first place.
  if (!fs.existsSync(dbPath)) return;

  const relPath = relPathOf(folder, doc.uri.fsPath);
  if (idx.isExcludedPath(relPath)) return;

  const opts = settings();
  let stat;
  try {
    stat = fs.statSync(doc.uri.fsPath);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size > opts.maxFileBytes) return;

  const key = dbPath + "::" + relPath;
  if (busyKeys.has(key)) return; // a previous save's re-embed for this exact file is still in flight
  busyKeys.add(key);

  const db = store.openStore(dbPath);
  try {
    const text = doc.getText();
    const buf = Buffer.from(text, "utf8");
    if (idx.looksBinary(buf)) return;

    const storedHash = store.getFileHash(db, relPath);
    const plan = idx.planFileUpdate(relPath, text, storedHash, { chunkLines: opts.chunkLines, overlapLines: opts.overlapLines });
    if (!plan) return; // content hash unchanged — nothing to do

    const storedProviderId = store.getMeta(db, "providerId");
    const storedModel = store.getMeta(db, "model");
    const fileCfg = loadProvidersFileCfg();
    const resolved = cfgLib.resolveEmbeddingsProvider(fileCfg, process.env, { preferredProviderId: storedProviderId, preferredModel: storedModel });
    if (!resolved.ok) {
      output.appendLine(`[onSave] skipped re-embedding ${relPath}: ${resolved.message}`);
      return; // logged, not popped up — a save happens constantly, a popup per save would be obnoxious
    }

    if (plan.chunks.length === 0) {
      store.deleteFile(db, relPath);
      return;
    }
    const embeddings = await embedAll(
      { baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, model: resolved.model },
      plan.chunks.map((c) => c.text),
      { batchSize: opts.batchSize },
    );
    store.upsertFile(db, relPath, plan.hash, plan.chunks.map((c, i) => ({ ...c, embedding: embeddings[i] })));
    output.appendLine(`[onSave] re-embedded ${relPath} (${plan.chunks.length} chunk(s))`);
  } catch (err) {
    output.appendLine(`[onSave] ${relPath}: ${err?.stack ?? err}`);
  } finally {
    store.closeStore(db);
    busyKeys.delete(key);
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("lakshx.search.query", runQuery),
    vscode.commands.registerCommand("lakshx.search.rebuildIndex", rebuildIndex),
    vscode.workspace.onDidSaveTextDocument(onSave),
    output,
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
