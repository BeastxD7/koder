// LakshX agent panel UI. No frameworks — small, fast, ours.
const vscode = acquireVsCodeApi();

// Security audit finding (2026-07-17): a small number of innerHTML template
// strings interpolate values that ultimately trace back to a live provider
// API response (model ids) rather than hardcoded config — escape those
// before interpolation. The CSP already blocks any resulting script
// execution; this closes the narrower "attribute/markup corruption from a
// compromised or spoofed provider endpoint" gap.
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop");
const modelEl = document.getElementById("model");
const permissionBar = document.getElementById("permissionBar");
const modeSelectEl = document.getElementById("modeSelect");
const composerEl = document.getElementById("composer");
const attachRow = document.getElementById("attachRow");
const attachBtn = document.getElementById("attachBtn");
const diagBtn = document.getElementById("diagBtn");
// Only present when lakshx.voice.enabled is true (extension.js's html()
// conditionally renders it) — every use below is guarded.
const micBtn = document.getElementById("micBtn");
const mentionPopup = document.getElementById("mentionPopup");
const checkpointBarEl = document.getElementById("checkpointBar");
const cpbarHead = document.getElementById("cpbarHead");
const cpbarBody = document.getElementById("cpbarBody");
const taskTrayEl = document.getElementById("taskTray");
const trayHead = document.getElementById("trayHead");
const trayBody = document.getElementById("trayBody");

let streamEl = null;
let streamRaw = "";
let thoughtEl = null;
let thoughtRaw = "";
let busy = false;
let codeStore = {};
let codeSeq = 0;
// The permission currently shown in permissionBar, if any — lets a
// "permissionResolved" event (fired when a paired phone answers a prompt
// this panel is also showing, docs/research/10 Phase B) hide the bar ONLY
// if it's still showing that same permission, so a resolve for an older,
// already-superseded prompt can't wrongly hide a freshly-shown newer one.
let currentPermissionId = null;

// ---------- feedback (thumbs / retry) turn tracking ----------
// Tracks the most recently rendered agent message bubble and whether the
// in-progress turn actually produced any text, so the thumbs/retry row can
// be attached once, at the end of a turn, only when there is a real
// response to react to (never for pure tool-only turns).
let lastAgentEl = null;
let turnHasText = false;
// The promptId of the turn currently streaming in. Set from both "user"
// event sites (replay and live) since a user message always opens the turn
// whose promptId every subsequent checkpoint/assistant event shares.
let currentPromptId = null;

// ---------- rendering ----------
function renderRich(raw) {
  if (window.lakshxMarkdown) {
    const { html, codes } = window.lakshxMarkdown.render(raw);
    for (const [k, v] of Object.entries(codes)) codeStore[`s${codeSeq}-${k}`] = v;
    return html.replace(/data-code-id="(\d+)"/g, (m, id) => `data-code-id="s${codeSeq}-${id}"`);
  }
  let s = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/```([\s\S]*?)(```|$)/g, (_, code) => `<pre>${code.replace(/^\w*\n/, "")}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  return s;
}

function showEmpty() {
  messagesEl.innerHTML = `<div class="empty">
    <svg class="mark" width="34" height="34" viewBox="0 0 24 24"><path d="M12 2 L13.8 8.6 L20 5.5 L15.4 10.8 L22 12 L15.4 13.2 L20 18.5 L13.8 15.4 L12 22 L10.2 15.4 L4 18.5 L8.6 13.2 L2 12 L8.6 10.8 L4 5.5 L10.2 8.6 Z" fill="currentColor"/></svg>
    <div class="title">LakshX Agent</div>
    <div class="hint">Review plans first. Approve executes with your OK. Auto runs free.</div>
    <button id="ctaProviders" class="cta">Config Model</button>
    <div class="hint"><kbd>Enter</kbd> send &middot; <kbd>Shift+Enter</kbd> newline</div>
  </div>`;
  document.getElementById("ctaProviders")?.addEventListener("click", () =>
    vscode.postMessage({ type: "openSettings" }),
  );
}
showEmpty();
const clearEmpty = () => messagesEl.querySelector(".empty")?.remove();
const scrollBottom = () => { messagesEl.scrollTop = messagesEl.scrollHeight; };

function addMsg(cls, text) {
  clearEmpty();
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollBottom();
  return el;
}

let renderTimer = null;
function streamText(text) {
  clearEmpty();
  collapseThought();
  if (!streamEl) {
    codeSeq++;
    streamEl = document.createElement("div");
    streamEl.className = "msg agent";
    messagesEl.appendChild(streamEl);
    streamRaw = "";
  }
  streamRaw += text;
  lastAgentEl = streamEl;
  turnHasText = true;
  if (!renderTimer) {
    renderTimer = setTimeout(() => {
      renderTimer = null;
      streamEl.innerHTML = renderRich(streamRaw);
      scrollBottom();
    }, 60);
  }
}

function endStream() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  if (streamEl && streamRaw) streamEl.innerHTML = renderRich(streamRaw);
  streamEl = null;
  streamRaw = "";
  collapseThought();
  scrollBottom();
}

// ---------- thinking stream ----------
function streamThought(text) {
  clearEmpty();
  if (!thoughtEl) {
    thoughtEl = document.createElement("details");
    thoughtEl.className = "thought";
    thoughtEl.open = true;
    thoughtEl.innerHTML = `<summary>Thinking<span class="tdots"><i></i><i></i><i></i></span></summary><div class="tbody"></div>`;
    messagesEl.appendChild(thoughtEl);
    thoughtRaw = "";
  }
  thoughtRaw += text;
  thoughtEl.querySelector(".tbody").textContent = thoughtRaw;
  scrollBottom();
}

function collapseThought() {
  if (thoughtEl) {
    thoughtEl.open = false;
    thoughtEl.querySelector("summary").innerHTML = "Thought process";
    thoughtEl = null;
    thoughtRaw = "";
  }
}

// ---------- tools ----------
const tools = new Map();
function toolCardTemplate() {
  const el = document.createElement("div");
  el.innerHTML = `<div class="tool-head"><span class="dot"></span><span class="title"></span></div><div class="tool-preview" hidden></div>`;
  return el;
}
function addTool(t) {
  endStream();
  // A `toolInputDelta` (below) may already have rendered a placeholder card
  // for this SAME id before the model's turn even finished streaming — this
  // is the real, dispatch-authoritative "tool" event catching up. Reuse it
  // in place (same DOM position, same live-typed preview still visible)
  // rather than appending a second, duplicate card.
  let el = tools.get(t.id);
  if (el) {
    el.className = "tool running";
    el.querySelector(".title").textContent = t.title;
  } else {
    el = toolCardTemplate();
    el.className = "tool running";
    el.querySelector(".title").textContent = t.title;
    messagesEl.appendChild(el);
    tools.set(t.id, el);
  }
  // `resolve_merge_conflict` (agent/src/tools.ts) is the only tool call whose
  // rawInput carries a `filePath` field (write_file/edit_file use `path`) —
  // tag the card so `toolUpdate` below knows to render a hunk-count summary
  // instead of leaving this card with just a title, without needing a new
  // "tool name" field threaded through the ACP tool_call notification.
  if (t.input && typeof t.input.filePath === "string") {
    el.dataset.mergeConflictFile = t.input.filePath;
  }
  scrollBottom();
}

/**
 * `toolInputDelta` (agent/src/loop.ts's `onToolInputDelta`, throttled
 * server-side in server.ts) — live tool-input streaming, fired for a tool
 * call that has NOT been dispatched yet: `write_file`'s `content` growing,
 * `edit_file`'s `new_string` growing. This is what lets the tool card appear
 * and its preview grow WHILE the model is still generating the call, instead
 * of only after the whole thing lands (the gap this feature closes). Never
 * replayed (see extension.js's `onToolInputDelta` doc comment) — a reload
 * just shows the finished `tool`/`toolUpdate` card, same as before this
 * feature existed.
 *
 * Creates the SAME kind of `.tool` card `addTool()` does, keyed by the same
 * `id`, so whichever arrives first (this, almost always) or `addTool()`
 * (if the model's whole turn — including the tool call — streamed faster
 * than one throttle window) reconciles cleanly with the other.
 */
function applyToolInputDelta(m) {
  clearEmpty();
  endStream();
  let el = tools.get(m.id);
  if (!el) {
    el = toolCardTemplate();
    el.className = "tool running pending";
    el.querySelector(".title").textContent = toolInputDeltaTitle(m);
    messagesEl.appendChild(el);
    tools.set(m.id, el);
  } else if (m.path) {
    el.querySelector(".title").textContent = toolInputDeltaTitle(m);
  }
  if (m.value) {
    const preview = el.querySelector(".tool-preview");
    preview.hidden = false;
    preview.textContent = m.value;
    preview.scrollTop = preview.scrollHeight;
  }
  scrollBottom();
}

function toolInputDeltaTitle(m) {
  const label = m.name === "write_file" ? "Write" : m.name === "edit_file" ? "Edit" : m.name;
  return m.path ? `${label} ${m.path}` : label;
}

// ---------- browser_preview screenshot (inline visual verification) ----------
// `toolImage` (durable, lightweight — id/path/mimeType only, REPLAYABLE) and
// `toolImageData` (live-only, the actual base64 pixels — see extension.js's
// `onToolImage` doc comment for why these are split) both target the SAME
// `.tool` card `addTool()`/`applyToolInputDelta()` already created, keyed by
// `id`. Whichever arrives — almost always both, `toolImage` first — renders
// into the same card, right under its `.tool-preview`/title row, exactly
// where a live "typing" preview would have been.
function applyToolImage(m) {
  const el = tools.get(m.id);
  if (!el) return;
  // The real pixels (from "toolImageData", live-only) already rendered —
  // the lightweight marker has nothing further to add. Guards against the
  // marker arriving second (or a replay-then-live edge case) clobbering an
  // already-inlined image with a plain "click to open" chip.
  if (el.querySelector(".tool-image")) return;
  let link = el.querySelector(".tool-image-link");
  if (!link) {
    link = document.createElement("div");
    link.className = "tool-image-link";
    link.setAttribute("role", "button");
    link.tabIndex = 0;
    link.addEventListener("click", () => openToolImage(link.dataset.path));
    link.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); link.click(); }
    });
    el.appendChild(link);
  }
  link.dataset.path = m.path ?? "";
  link.textContent = m.truncated
    ? "Screenshot saved (too large to preview inline) — click to open"
    : "Screenshot saved — click to open";
  scrollBottom();
}

/** Live-only — see extension.js's `onToolImage` doc comment for why this never replays. */
function applyToolImageData(m) {
  const el = tools.get(m.id);
  if (!el || !m.dataBase64) return;
  el.querySelector(".tool-image-link")?.remove(); // the real picture supersedes the "click to open" placeholder
  let img = el.querySelector(".tool-image");
  if (!img) {
    img = document.createElement("img");
    img.className = "tool-image";
    img.alt = "browser_preview screenshot";
    img.title = "Click to open full size";
    img.setAttribute("role", "button");
    img.tabIndex = 0;
    img.addEventListener("click", () => openToolImage(img.dataset.path));
    img.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); img.click(); }
    });
    el.appendChild(img);
  }
  img.dataset.path = m.path ?? "";
  img.src = `data:${m.mimeType};base64,${m.dataBase64}`;
  scrollBottom();
}

function openToolImage(path) {
  if (path) vscode.postMessage({ type: "openToolImage", path });
}

/**
 * `resolve_merge_conflict` (agent/src/tools.ts) card summary — the tool's own
 * return value already IS the exact "Resolved merge conflict in X — N
 * hunks.\n\n<reasoning>" text (or, on refusal, a plain error message), so this
 * just renders `m.output` (already forwarded on every `toolUpdate`, see
 * extension.js's `extractToolOutputText`) into the card's existing
 * `.tool-preview` box — no new parsing needed. Deliberately modest per this
 * feature's scope: the actual "open the native merge/diff view to confirm"
 * affordance is the SAME "Open diff" action the checkpoint ("Files changed")
 * card already offers for this exact file — `resolve_merge_conflict` is a
 * normal checkpointed dangerous tool, so that card appears right after this
 * one with a working, repo-relative-path-correct diff link; this only adds
 * a shortcut into that same flow rather than a second bespoke diff viewer.
 */
function applyMergeConflictSummary(el, m) {
  const filePath = el.dataset.mergeConflictFile;
  if (!filePath) return;
  const preview = el.querySelector(".tool-preview");
  if (m.output) {
    preview.hidden = false;
    preview.textContent = m.output;
  }
  if (m.status === "completed" && currentPromptId && !el.querySelector(".tool-open-diff")) {
    const btn = document.createElement("button");
    btn.className = "tool-open-diff";
    btn.textContent = "Open diff";
    btn.title = "Open VS Code's diff view for this file to confirm the resolution";
    btn.addEventListener("click", () => openCheckpointFile(currentPromptId, filePath));
    el.appendChild(btn);
  }
}

// ---------- prompt checkpoints + "Files changed" undo (docs/research/11 §7) ----------
// Two surfaces, same underlying "checkpoint"/"checkpointReverted" event
// stream, same undo primitives:
//  - `checkpointCards`: one card per promptId, inline in the transcript,
//    accumulated live as `lakshx/checkpoint` events arrive (not batched to
//    turnEnd — a long multi-tool turn shows its file list growing in real
//    time) and identically on replay. Good for "what did THIS turn touch."
//  - `sessionFiles`: a single composer-anchored summary bar aggregating
//    every file changed so far THIS SESSION (latest-touching-promptId per
//    path), collapsed by default. Added because the per-turn card scrolls
//    out of view as the conversation continues — this is reachable without
//    scrolling back, which was the explicit ask. Kept the per-turn card too
//    rather than replacing it: the two answer different questions ("just
//    this turn" vs "everything so far") and share all their rendering/undo
//    logic, so the marginal cost of keeping both is low.
// Neither surface is ever shown with zero files — a card/bar with nothing
// to undo is worse than no card/bar at all.
const checkpointCards = new Map(); // promptId -> { el, files: Set<string> }
const sessionFiles = new Map(); // path -> { promptId } — latest-wins

function applyCheckpoint(m) {
  if (!m.files?.length) return; // never render a zero-file card (loop.ts already guarantees this, guarded again here)
  let card = checkpointCards.get(m.promptId);
  if (!card) {
    const el = document.createElement("div");
    el.className = "checkpoint";
    messagesEl.appendChild(el);
    card = { el, files: new Set() };
    checkpointCards.set(m.promptId, card);
  }
  for (const f of m.files) {
    card.files.add(f);
    sessionFiles.set(f, { promptId: m.promptId });
  }
  renderCheckpointCard(m.promptId, card);
  renderCheckpointBar();
  scrollBottom();
}

/** "an undo just succeeded" — drop the reverted paths from both surfaces, removing/hiding whatever becomes empty. Fed live and on replay (see applyEvent). */
function applyRevert(paths) {
  if (!paths?.length) return;
  for (const [promptId, card] of [...checkpointCards.entries()]) {
    let changed = false;
    for (const p of paths) changed = card.files.delete(p) || changed;
    if (!changed) continue;
    if (card.files.size === 0) {
      card.el.remove();
      checkpointCards.delete(promptId);
    } else {
      renderCheckpointCard(promptId, card);
    }
  }
  let sessionChanged = false;
  for (const p of paths) sessionChanged = sessionFiles.delete(p) || sessionChanged;
  if (sessionChanged) renderCheckpointBar();
}

function openCheckpointFile(promptId, path) {
  vscode.postMessage({ type: "openCheckpointFile", promptId, path });
}

function renderCheckpointCard(promptId, card) {
  const files = [...card.files];
  const n = files.length;
  card.el.innerHTML = `
    <div class="cp-head">Files changed (${n})</div>
    <div class="cp-files">${files.map(() => `<div class="cp-file"><span class="cp-path" role="button" tabindex="0" title="Open diff"></span><button class="cp-file-undo" title="Undo this file">Undo</button></div>`).join("")}</div>
    <button class="cp-undo-all">Undo all ${n} file${n === 1 ? "" : "s"}</button>
    <div class="cp-confirm" hidden></div>`;
  [...card.el.querySelectorAll(".cp-file")].forEach((el, i) => {
    const p = el.querySelector(".cp-path");
    p.textContent = files[i];
    p.addEventListener("click", () => openCheckpointFile(promptId, files[i]));
    el.querySelector(".cp-file-undo").addEventListener("click", () => requestUndoFile(promptId, files[i]));
  });
  card.el.querySelector(".cp-undo-all").addEventListener("click", () => requestUndoPrompt(promptId));
}

/** Shared confirm UI for both a manual-edit conflict (§5) and a cross-prompt overlap warning (§4.3) — same shape, different copy. */
function showUndoConfirm(card, message, onConfirm) {
  const box = card.el.querySelector(".cp-confirm");
  box.hidden = false;
  box.innerHTML = `<div class="cp-confirm-msg"></div><div class="cp-confirm-actions">
    <button class="deny cp-cancel">Cancel</button><button class="allow cp-force">Overwrite and Undo</button></div>`;
  box.querySelector(".cp-confirm-msg").textContent = message;
  box.querySelector(".cp-cancel").addEventListener("click", () => { box.hidden = true; box.innerHTML = ""; });
  box.querySelector(".cp-force").addEventListener("click", () => {
    box.hidden = true;
    box.innerHTML = "";
    onConfirm();
  });
  card.el.scrollIntoView({ block: "nearest" }); // the click that triggered this may have come from the composer bar, off in a different part of the transcript
}

function requestUndoPrompt(promptId, force) {
  vscode.postMessage({ type: "undoPrompt", promptId, force: force === true });
}

function requestUndoFile(promptId, path, force) {
  vscode.postMessage({ type: "undoFile", promptId, path, force: force === true });
}

function handleUndoConflict(m) {
  const card = checkpointCards.get(m.promptId);
  if (!card) return;
  const message = m.path
    ? `${m.path} has been edited since the agent last changed it. Undo will overwrite that edit. Continue?`
    : m.overlap
    ? `A later prompt also changed ${Object.keys(m.overlap).join(", ")} after this one. Undoing will discard those changes too. Continue?`
    : `${m.conflict?.paths?.join(", ") || "One or more files"} have been edited since the agent last changed them. Undo will overwrite that edit. Continue?`;
  showUndoConfirm(card, message, () =>
    m.path ? requestUndoFile(m.promptId, m.path, true) : requestUndoPrompt(m.promptId, true),
  );
}

// ---------- live subagent progress ("dispatch_subtasks" fan-out) ----------
// Same registry-of-DOM-elements-by-id pattern as `checkpointCards` above,
// keyed by `batchId` instead of `promptId` (loop.ts mints one `batchId` per
// dispatch_subtasks call — see agent/src/loop.ts's `dispatchSubtasks`).
// Reuses `.checkpoint`'s card chrome (dark card, small header, expandable
// body) rather than inventing a new visual style, and `.tool`'s
// running/done/failed dot-pulse classes for each task row's status dot —
// same visual vocabulary as the rest of the transcript, not a new one.
//
// Each row keeps its own retained activity history (`row.history`), not just
// "whatever's in the current line" — every `text`/`thinking` chunk is
// ACCUMULATED into a running message (mirroring `streamRaw`'s pattern, the
// bug this fixes: `onSubagentActivity`'s `detail` is a streaming DELTA, same
// granularity as the top-level chat's own `onText`, not the full message —
// overwriting the row's line with each delta produced a flickering
// few-word fragment instead of the growing response) and every
// `tool_start`/`tool_end` becomes its own entry, closing whatever text/
// thinking message was open (a tool call always ends the message that
// preceded it, same as `addTool()` calling `endStream()` in the main
// transcript). Clicking a row expands `row.bodyEl` into a small nested
// transcript built from that history — `.tool`/`.tool.running/done/failed`
// rows reused verbatim for tool entries, so a subtask's tool calls read
// exactly like the parent's own, not a different visual language.
const subagentCards = new Map(); // batchId -> { el, bodyEl, headLabelEl, chevronEl, rows: Map(taskId -> row), total, ended, promptId }

function applySubagentsStart(m) {
  clearEmpty();
  endStream();
  document.getElementById("thinking")?.remove();
  const el = document.createElement("div");
  el.className = "checkpoint subagents";
  el.innerHTML = `
    <div class="sa-head" role="button" tabindex="0">
      <span class="sa-head-label"></span><span class="cpbar-chevron">▾</span>
    </div>
    <div class="sa-body"></div>`;
  const bodyEl = el.querySelector(".sa-body");
  const headLabelEl = el.querySelector(".sa-head-label");
  const chevronEl = el.querySelector(".cpbar-chevron");
  const rows = new Map();
  for (const t of m.tasks ?? []) {
    const row = document.createElement("div");
    row.className = "sa-task";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.innerHTML = `<span class="dot running"></span><div class="sa-task-main">
      <div class="sa-task-head"><div class="sa-task-prompt"></div><span class="sa-task-chevron">▸</span></div>
      <div class="sa-task-detail"></div>
      <div class="sa-task-body" hidden></div>
    </div>`;
    row.querySelector(".sa-task-prompt").textContent = t.prompt;
    row.querySelector(".sa-task-detail").textContent = `Starting (${t.mode})…`;
    bodyEl.appendChild(row);
    const rowState = {
      rowEl: row,
      dotEl: row.querySelector(".dot"),
      detailEl: row.querySelector(".sa-task-detail"),
      bodyEl: row.querySelector(".sa-task-body"),
      chevronEl: row.querySelector(".sa-task-chevron"),
      history: [], // ordered {kind:'text'|'thinking', text} | {kind:'tool', title, status, path?}
      current: null, // the open text/thinking entry, if any (accumulator)
      runningTool: null, // the open tool entry, if any
      expanded: false,
    };
    const setExpanded = (v) => {
      rowState.expanded = v;
      rowState.bodyEl.hidden = !v;
      rowState.chevronEl.textContent = v ? "▾" : "▸";
      if (v) renderSubagentRowBody(rowState, card);
    };
    row.addEventListener("click", (e) => {
      if (e.target.closest(".sa-file-path")) return; // file links handle their own click, don't also toggle
      setExpanded(!rowState.expanded);
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setExpanded(!rowState.expanded);
      }
    });
    rows.set(t.id, rowState);
  }
  const card = { el, bodyEl, headLabelEl, chevronEl, rows, total: (m.tasks ?? []).length, ended: false, promptId: m.promptId };
  headLabelEl.textContent = `Running ${card.total} subtask${card.total === 1 ? "" : "s"}…`;
  // Expanded while running (so progress is visible without a click); the
  // header is always clickable so a curious user can collapse it early too.
  let expanded = true;
  const applyExpanded = () => {
    bodyEl.hidden = !expanded;
    chevronEl.textContent = expanded ? "▾" : "▸";
  };
  applyExpanded();
  el.querySelector(".sa-head").addEventListener("click", () => {
    expanded = !expanded;
    applyExpanded();
  });
  card._setExpanded = (v) => { expanded = v; applyExpanded(); };
  messagesEl.appendChild(el);
  subagentCards.set(m.batchId, card);
  scrollBottom();
}

/** Collapsed-row preview line: the live accumulated text/thinking message, the currently-running tool's title, or (once settled) the last thing that happened. Never a raw delta. */
function renderSubagentRowPreview(row) {
  if (row.runningTool) {
    row.detailEl.textContent = `Running: ${row.runningTool.title}`;
    return;
  }
  if (row.current) {
    row.detailEl.textContent = row.current.text || "…";
    return;
  }
  const last = row.history[row.history.length - 1];
  if (!last) return;
  row.detailEl.textContent =
    last.kind === "tool" ? `${last.status === "failed" ? "Failed" : "Done"}: ${last.title}` : last.text || "";
}

/** Unique, in-order list of file paths this subtask's tool calls touched (write_file/edit_file only — see loop.ts's `runSubtask`). */
function subagentRowFiles(row) {
  const seen = new Set();
  const files = [];
  for (const entry of row.history) {
    if (entry.kind === "tool" && entry.path && !seen.has(entry.path)) {
      seen.add(entry.path);
      files.push(entry.path);
    }
  }
  return files;
}

/** Full nested transcript for an expanded row: chronological text/thinking/tool entries (reusing `.tool`'s exact chrome), plus a "Files touched" list wired into the same click-to-diff path the top-level "Files changed" card uses. */
function renderSubagentRowBody(row, card) {
  row.bodyEl.innerHTML = "";
  for (const entry of row.history) {
    const el = document.createElement("div");
    if (entry.kind === "tool") {
      el.className = `tool ${entry.status}`;
      // `.tool` is a shared class — since `addTool()`/`applyToolInputDelta()`
      // wrap dot+title in `.tool-head` (so a `.tool-preview` can sit below
      // it), every `.tool` card must, or `.tool`'s `flex-direction: column`
      // stacks a flat dot+title vertically instead of inline. This row never
      // gets a live input preview (subagent activity isn't wired to
      // `onToolInputDelta`), but still needs the same wrapper for layout.
      el.innerHTML = `<div class="tool-head"><span class="dot"></span><span class="title"></span></div>`;
      el.querySelector(".title").textContent = entry.title;
    } else {
      el.className = entry.kind === "thinking" ? "sa-entry sa-entry-thinking" : "sa-entry sa-entry-text";
      el.textContent = entry.text;
    }
    row.bodyEl.appendChild(el);
  }
  const files = subagentRowFiles(row);
  if (files.length) {
    const wrap = document.createElement("div");
    wrap.className = "sa-files";
    wrap.innerHTML = `<div class="sa-files-head">Files touched by this subtask (${files.length})</div>`;
    for (const f of files) {
      const p = document.createElement("span");
      p.className = "sa-file-path";
      p.setAttribute("role", "button");
      p.tabIndex = 0;
      p.title = "Open diff";
      p.textContent = f;
      p.addEventListener("click", () => openCheckpointFile(card.promptId, f));
      wrap.appendChild(p);
    }
    row.bodyEl.appendChild(wrap);
  }
}

function applySubagentActivity(m) {
  const card = subagentCards.get(m.batchId);
  if (!card) return;
  const row = card.rows.get(m.taskId);
  if (!row) return;
  if (m.kind === "text" || m.kind === "thinking") {
    // Accumulate into the currently-open message of the same kind — the fix
    // for the flickering-fragment bug: `m.detail` is only a delta, so a
    // fresh entry is opened once (on the first delta, or right after a tool
    // call closed the previous one) and every subsequent delta is appended,
    // never used to replace the line outright.
    if (!row.current || row.current.kind !== m.kind) {
      row.current = { kind: m.kind, text: "" };
      row.history.push(row.current);
    }
    row.current.text += m.detail || "";
  } else if (m.kind === "tool_start") {
    row.current = null; // a tool call always closes whatever message preceded it
    const entry = { kind: "tool", title: m.detail || "", status: "running", path: m.path };
    row.history.push(entry);
    row.runningTool = entry;
  } else if (m.kind === "tool_end") {
    if (row.runningTool) {
      row.runningTool.status = m.isError ? "failed" : "done";
      if (m.path) row.runningTool.path = m.path;
      row.runningTool = null;
    }
  }
  renderSubagentRowPreview(row);
  if (row.expanded) renderSubagentRowBody(row, card);
}

function applySubagentsEnd(m) {
  const card = subagentCards.get(m.batchId);
  if (!card) return;
  card.ended = true;
  let failed = 0;
  for (const r of m.results ?? []) {
    const row = card.rows.get(r.id);
    if (!row) continue;
    row.dotEl.className = `dot ${r.isError ? "failed" : "done"}`;
    // Close out any activity left dangling (e.g. the child threw mid-tool-
    // call, so no `tool_end` ever arrived for the open entry).
    if (row.runningTool) {
      row.runningTool.status = r.isError ? "failed" : "done";
      row.runningTool = null;
    }
    row.current = null;
    if (r.isError) {
      // The error text comes from the caught exception, not from any
      // `onText` delta the child streamed — it wouldn't otherwise appear in
      // the retained history, so it's recorded as its own entry here.
      row.history.push({ kind: "text", text: r.output || "" });
      row.detailEl.textContent = `Failed: ${(r.output || "").slice(0, 200)}`;
    } else {
      renderSubagentRowPreview(row);
    }
    if (row.expanded) renderSubagentRowBody(row, card);
    if (r.isError) failed++;
  }
  card.headLabelEl.textContent =
    failed === 0
      ? `Ran ${card.total} subtask${card.total === 1 ? "" : "s"}`
      : `Ran ${card.total} subtask${card.total === 1 ? "" : "s"} — ${failed} failed`;
  // A finished run collapses by default so it doesn't permanently take up
  // vertical space in the transcript — same "collapse once done" shape the
  // composer-anchored checkpoint bar already uses (`cpbarExpanded`), just
  // applied per-card instead of to one persistent bar. Still togglable via
  // the header click handler wired in `applySubagentsStart`. Individual task
  // rows keep whatever expand/collapse state the user left them in.
  card._setExpanded(false);
  scrollBottom();
}

// ---------- live royal-mode phase/checklist card (Royal Mode 2.0 Stage B) ----------
// A single persistent card (not a Map keyed by id, unlike checkpoints/
// subagents/background tasks — there is at most ONE phase machine live per
// turn), updated in place on every `lakshx/phase_state` notification
// (agent/src/loop.ts's `runRoyalPhaseTurn`). Reuses `.checkpoint`'s card
// chrome and `.dot`'s running/done/failed status-dot language (same visual
// vocabulary the subagent card above and the checkpoint card use) rather
// than inventing a new design — a "pending" dot variant is the one new
// visual state, styled in panel.css next to the existing dot classes.
let phaseCard = null; // {el, headLabelEl, bodyEl, chevronEl, tasksEl, verifyEl, setExpanded}

const PHASE_LABELS = {
  intake: "Intake",
  recon: "Recon",
  plan: "Plan",
  execute: "Execute",
  verify: "Verify",
  fix: "Fix",
  rewind: "Rewind",
  done: "Done",
};

function ensurePhaseCard() {
  if (phaseCard) return phaseCard;
  clearEmpty();
  endStream();
  document.getElementById("thinking")?.remove();
  const el = document.createElement("div");
  el.className = "checkpoint phase-card";
  el.innerHTML = `
    <div class="ph-head" role="button" tabindex="0">
      <span class="ph-head-label"></span><span class="cpbar-chevron">▾</span>
    </div>
    <div class="ph-body">
      <div class="ph-tasks"></div>
      <div class="ph-verify" hidden></div>
    </div>`;
  const bodyEl = el.querySelector(".ph-body");
  const headLabelEl = el.querySelector(".ph-head-label");
  const chevronEl = el.querySelector(".cpbar-chevron");
  const tasksEl = el.querySelector(".ph-tasks");
  const verifyEl = el.querySelector(".ph-verify");
  let expanded = true;
  const applyExpanded = () => {
    bodyEl.hidden = !expanded;
    chevronEl.textContent = expanded ? "▾" : "▸";
  };
  applyExpanded();
  el.querySelector(".ph-head").addEventListener("click", () => {
    expanded = !expanded;
    applyExpanded();
  });
  messagesEl.appendChild(el);
  phaseCard = { el, headLabelEl, bodyEl, chevronEl, tasksEl, verifyEl, setExpanded: (v) => { expanded = v; applyExpanded(); } };
  scrollBottom();
  return phaseCard;
}

/** Per-task status dot: pending (dim, not yet started) / running (in_progress, pulsing) / done / failed — same dot vocabulary as `.tool`/subagent rows. */
function phaseTaskDotClass(status) {
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "in_progress") return "running";
  return "pending";
}

function renderPhaseTasks(card, taskList, currentTaskId) {
  card.tasksEl.innerHTML = "";
  for (const t of taskList ?? []) {
    const row = document.createElement("div");
    row.className = "ph-task";
    row.innerHTML = `<span class="dot ${phaseTaskDotClass(t.status)}"></span><span class="ph-task-title"></span>`;
    row.querySelector(".ph-task-title").textContent = t.title + (t.id === currentTaskId ? " — current" : "");
    card.tasksEl.appendChild(row);
  }
}

function applyPhaseState(m) {
  const card = ensurePhaseCard();
  const label = PHASE_LABELS[m.phase] || m.phase;
  const doneCount = (m.taskList ?? []).filter((t) => t.status === "done").length;
  const taskSuffix = m.taskList?.length ? ` (${doneCount}/${m.taskList.length} tasks)` : "";
  card.headLabelEl.textContent = `Royal mode — ${label}${taskSuffix}`;
  renderPhaseTasks(card, m.taskList, m.currentTaskId);

  if (m.verificationResult) {
    card.verifyEl.hidden = false;
    const v = m.verificationResult;
    const checks = (v.results ?? []).map((r) => `${r.passed ? "✓" : "✗"} ${r.cmd}`).join(", ");
    card.verifyEl.textContent = v.passed
      ? `Verification passed${checks ? ": " + checks : ""}`
      : `Verification failed${checks ? ": " + checks : v.note ? " — " + v.note : ""}`;
    card.verifyEl.classList.toggle("ph-verify-fail", !v.passed);
  } else {
    card.verifyEl.hidden = true;
  }

  // A finished run collapses by default (same "collapse once done" shape the
  // subagent card and composer checkpoint bar already use) — still togglable
  // via the header click handler above.
  if (m.phase === "done") card.setExpanded(false);
}

// ---------- composer-anchored "files changed this session" summary bar ----------
// Collapsed by default ("Files changed this session (N)"); expands to a flat,
// latest-wins-per-path file list with the same per-file Undo + Open-diff
// actions as the per-turn card. "Undo all" here deliberately does N
// sequential per-file undos (not one atomic `undo_prompt`) rather than
// grouping by promptId: a per-file undo's only failure mode is the
// manual-edit conflict, which reuses the per-turn card's existing confirm UI
// (that card is guaranteed to exist whenever a path is listed here, since
// both maps are populated by the exact same checkpoint events) — grouping by
// prompt would additionally risk the cross-prompt "overlap" conflict, which
// has no confirm surface of its own in this bar. Trading a small amount of
// atomicity for not needing a second conflict-UI is the right call here.
let cpbarExpanded = false;

function renderCheckpointBar() {
  const n = sessionFiles.size;
  checkpointBarEl.hidden = n === 0; // never show a "0 files" bar
  if (n === 0) {
    cpbarBody.innerHTML = "";
    return;
  }
  cpbarHead.innerHTML = `<span class="cpbar-label">Files changed this session (${n})</span><span class="cpbar-chevron">${cpbarExpanded ? "▾" : "▸"}</span>`;
  cpbarBody.hidden = !cpbarExpanded;
  if (!cpbarExpanded) {
    cpbarBody.innerHTML = "";
    return;
  }
  const entries = [...sessionFiles.entries()];
  cpbarBody.innerHTML = `
    <div class="cpbar-files">${entries.map(() => `<div class="cpbar-file"><span class="cpbar-path" role="button" tabindex="0" title="Open diff"></span><button class="cpbar-file-undo" title="Undo this file">Undo</button></div>`).join("")}</div>
    <button class="cpbar-undo-all">Undo all ${n} file${n === 1 ? "" : "s"}</button>`;
  [...cpbarBody.querySelectorAll(".cpbar-file")].forEach((el, i) => {
    const [filePath, info] = entries[i];
    const p = el.querySelector(".cpbar-path");
    p.textContent = filePath;
    p.addEventListener("click", () => openCheckpointFile(info.promptId, filePath));
    el.querySelector(".cpbar-file-undo").addEventListener("click", () => requestUndoFile(info.promptId, filePath));
  });
  cpbarBody.querySelector(".cpbar-undo-all").addEventListener("click", () => {
    for (const [filePath, info] of entries) requestUndoFile(info.promptId, filePath);
  });
}

cpbarHead.addEventListener("click", () => {
  cpbarExpanded = !cpbarExpanded;
  renderCheckpointBar();
});

// ---------- running-agents tray (background subtasks — Royal Mode 2.0) ----------
// A persistent, composer-anchored tray — same anchoring precedent as the
// checkpoint bar just above (collapsed-by-default pill, expands to rows) —
// but PERSISTENT PAST turnEnd, unlike the per-turn subagentCards above:
// background tasks are explicitly detached from any one turn, so their rows
// must keep living (and updating) after the turn that launched them ends.
// `bgTasks`: taskId -> { taskId, batchId, prompt, mode, status, startedAt,
// endedAt, lastActivity, result, lost, steerExpanded }. `lost` is set only by
// `applyTasksReconcile` (reload reconcile — see its own doc comment) and
// overrides the status label/dot without touching `status` itself, so a
// later real event for the same taskId (which cannot arrive once the backing
// process is gone, but this keeps the two concerns cleanly separate) would
// still make sense to apply.
const bgTasks = new Map();
let trayExpanded = false;

function trayStatusLabel(t) {
  if (t.lost) return "lost — agent restarted";
  return t.status;
}

function trayDotClass(t) {
  if (t.lost) return "lost";
  return t.status; // running | done | failed | cancelled
}

function renderTray() {
  const tasks = [...bgTasks.values()];
  taskTrayEl.hidden = tasks.length === 0; // never show an empty tray
  if (tasks.length === 0) {
    trayBody.innerHTML = "";
    return;
  }
  const running = tasks.filter((t) => t.status === "running" && !t.lost).length;
  trayHead.innerHTML = `<span class="tray-label"></span><span class="tray-badge"></span><span class="cpbar-chevron">${trayExpanded ? "▾" : "▸"}</span>`;
  trayHead.querySelector(".tray-label").textContent =
    running > 0 ? `${running} agent${running === 1 ? "" : "s"} running` : `${tasks.length} background task${tasks.length === 1 ? "" : "s"}`;
  trayHead.querySelector(".tray-badge").textContent = String(tasks.length);
  trayBody.hidden = !trayExpanded;
  if (!trayExpanded) {
    trayBody.innerHTML = "";
    return;
  }
  trayBody.innerHTML = "";
  for (const t of tasks) trayBody.appendChild(buildTrayRow(t));
}

function buildTrayRow(t) {
  const row = document.createElement("div");
  row.className = "tray-row";
  row.innerHTML = `
    <div class="tray-row-head">
      <span class="dot"></span>
      <span class="tray-row-prompt"></span>
      <span class="tray-row-status"></span>
    </div>
    <div class="tray-row-detail"></div>
    <div class="tray-row-actions" hidden>
      <input class="tray-steer-input" placeholder="Steer this agent…">
      <button class="tray-steer-send ghost" type="button">Send</button>
      <button class="tray-stop ghost" type="button">Stop</button>
    </div>`;
  row.querySelector(".dot").className = `dot ${trayDotClass(t)}`;
  row.querySelector(".tray-row-prompt").textContent = t.prompt;
  row.querySelector(".tray-row-status").textContent = trayStatusLabel(t);
  row.querySelector(".tray-row-detail").textContent = t.lastActivity || "";

  const actions = row.querySelector(".tray-row-actions");
  const canSteer = t.status === "running" && !t.lost;
  actions.hidden = !canSteer;
  if (canSteer) {
    const input = actions.querySelector(".tray-steer-input");
    const send = () => {
      const msg = input.value.trim();
      if (!msg) return;
      vscode.postMessage({ type: "sendToTask", taskId: t.taskId, message: msg });
      input.value = "";
    };
    actions.querySelector(".tray-steer-send").addEventListener("click", send);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        send();
      }
    });
    actions.querySelector(".tray-stop").addEventListener("click", () => vscode.postMessage({ type: "cancelTask", taskId: t.taskId }));
  }
  return row;
}

function applyTaskStart(m) {
  bgTasks.set(m.taskId, {
    taskId: m.taskId,
    batchId: m.batchId,
    promptId: m.promptId,
    prompt: m.prompt,
    mode: m.mode,
    status: "running",
    startedAt: m.startedAt,
    lastActivity: "Starting…",
    lost: false,
  });
  renderTray();
}

function applyTaskActivity(m) {
  const t = bgTasks.get(m.taskId);
  if (!t) return; // e.g. a reload without a matching taskStart replayed (older chat) — nothing to attach this to
  if (m.kind === "tool_start") t.lastActivity = `Running: ${m.detail}`;
  else if (m.kind === "tool_end") t.lastActivity = `${m.isError ? "Failed" : "Done"}: ${m.detail}`;
  else t.lastActivity = m.detail || t.lastActivity;
  renderTray();
}

function applyTaskDone(m) {
  const t = bgTasks.get(m.taskId);
  if (!t) return;
  t.status = m.status;
  t.endedAt = Date.now();
  t.result = m.result;
  const summary = (m.result?.output || "").slice(0, 240);
  t.lastActivity = m.status === "failed" ? `Failed: ${summary}` : m.status === "cancelled" ? "Cancelled" : summary || t.lastActivity;
  renderTray();
}

function applyTaskSteered(m) {
  const t = bgTasks.get(m.taskId);
  if (!t) return;
  t.lastActivity = `Steering: ${m.message}`;
  renderTray();
}

/**
 * Reload reconcile (Royal Mode 2.0 §8): fired after a "replay" round-trip with
 * the live registry's own view of this session's tasks (`lakshx/tasks_list`,
 * extension.js's "replayRequest" handler). Any row the replayed transcript
 * still shows as "running" but this list no longer contains means the
 * in-memory registry doesn't know it anymore — v1 has no persistence across
 * an agent-process restart (see agent/src/tasks.ts's module doc), so that is
 * the ONLY way a replayed-running row and an empty/mismatched live list can
 * disagree. Flips it to "lost — agent restarted" rather than leaving a
 * spinner that will never resolve. A row already settled (done/failed/
 * cancelled) from replay is left exactly as-is — there is nothing to
 * reconcile for a task that already has a real final status.
 */
function applyTasksReconcile(m) {
  const known = new Set((m.tasks ?? []).map((t) => t.taskId));
  for (const t of bgTasks.values()) {
    if (t.status === "running" && !known.has(t.taskId)) t.lost = true;
  }
  renderTray();
}

trayHead.addEventListener("click", () => {
  trayExpanded = !trayExpanded;
  renderTray();
});

// ---------- conversation rewind (Accept / "Rewind to here" under USER bubbles) ----------
// Replaces the old per-agent-response undo icon: the control now lives under
// each user message and means "come back to this message" — rewinding reverts
// EVERY file change made since that message (this prompt and every later one)
// AND truncates the conversation there, both in the visible chat and in the
// agent's real history (extension.js "rewindToPrompt" → lakshx/rewind_to_prompt).
// Accept is the opposite, deliberately weightless affordance: a purely visual,
// NON-BLOCKING "keep this" that just dismisses the row for that message — it
// never pauses or gates a turn (persisted as a "rewindAccepted" transcript
// event so replay respects the dismissal).
const rewindRows = new Map(); // promptId -> { wrap, msgEl }
const userPromptOrder = []; // promptIds in arrival order — index order = conversation order

/** Render a user bubble; wire the rewind row when the event carries a promptId (older persisted chats without one simply get no row — graceful degradation). */
function addUserMsg(m) {
  const msgEl = addMsg("user", m.text);
  if (m.promptId) attachRewindRow(msgEl, m.promptId);
  return msgEl;
}

function attachRewindRow(msgEl, promptId) {
  const wrap = document.createElement("div");
  wrap.className = "rewind";
  wrap.innerHTML = `<div class="rewind-actions">
    <button class="ghost rw-btn rw-rewind" title="Revert all file changes made since this message and remove it and everything after from the conversation">&#8617; Rewind to here</button>
    <button class="ghost rw-btn rw-accept" title="Keep everything — just dismiss this row">&#10003; Accept</button>
  </div>
  <div class="rw-confirm cp-confirm" hidden></div>`;
  msgEl.insertAdjacentElement("afterend", wrap);
  rewindRows.set(promptId, { wrap, msgEl });
  userPromptOrder.push(promptId);
  wrap.querySelector(".rw-accept").addEventListener("click", () => {
    dismissRewindRow(promptId); // optimistic — the extension echoes a "rewindAccepted" event for persistence/replay
    vscode.postMessage({ type: "acceptTurn", promptId });
  });
  wrap.querySelector(".rw-rewind").addEventListener("click", () => startRewindConfirm(promptId));
}

function dismissRewindRow(promptId) {
  rewindRows.get(promptId)?.wrap.classList.add("accepted");
}

/** Union of files touched by this prompt AND every later one — the rewind's real revert set, mirroring the server's own union. */
function rewindFilesFor(promptId) {
  const start = userPromptOrder.indexOf(promptId);
  if (start === -1) return [];
  const ids = new Set(userPromptOrder.slice(start));
  const files = new Set();
  for (const [pid, card] of checkpointCards) {
    if (ids.has(pid)) for (const f of card.files) files.add(f);
  }
  return [...files];
}

/** The user message itself + every rendered chat message after it (tool/checkpoint cards not counted as "messages"). */
function rewindMessageCount(promptId) {
  const row = rewindRows.get(promptId);
  if (!row) return 0;
  let n = 0;
  for (let el = row.msgEl; el; el = el.nextElementSibling) {
    if (el.classList.contains("msg")) n++;
  }
  return n;
}

function startRewindConfirm(promptId) {
  if (busy) {
    toast("Agent is busy — wait for the turn to finish");
    return;
  }
  const row = rewindRows.get(promptId);
  if (!row) return;
  row.wrap.classList.remove("accepted"); // /undo can target an already-accepted message — surface the row for its confirm
  const files = rewindFilesFor(promptId);
  const n = rewindMessageCount(promptId);
  showRewindConfirm(
    promptId,
    `Rewind to this message? ${n} message${n === 1 ? "" : "s"} will be removed from the conversation${files.length ? ` and ${files.length} file${files.length === 1 ? "" : "s"} reverted` : ""}.`,
    files,
    () => requestRewind(promptId),
  );
}

/** Same inline confirm shape showUndoConfirm uses, anchored to the message's own rewind row, with the file list rendered like the checkpoint card's. */
function showRewindConfirm(promptId, message, files, onConfirm) {
  const row = rewindRows.get(promptId);
  if (!row) return;
  const box = row.wrap.querySelector(".rw-confirm");
  box.hidden = false;
  box.innerHTML = `<div class="cp-confirm-msg"></div>${files.length ? `<div class="rw-files"></div>` : ""}<div class="cp-confirm-actions">
    <button class="deny rw-cancel">Cancel</button><button class="allow rw-go">Rewind</button></div>`;
  box.querySelector(".cp-confirm-msg").textContent = message;
  const list = box.querySelector(".rw-files");
  if (list) {
    for (const f of files) {
      const d = document.createElement("div");
      d.className = "rw-file";
      d.textContent = f;
      list.appendChild(d);
    }
  }
  box.querySelector(".rw-cancel").addEventListener("click", () => { box.hidden = true; box.innerHTML = ""; });
  box.querySelector(".rw-go").addEventListener("click", () => {
    box.hidden = true;
    box.innerHTML = "";
    onConfirm();
  });
  row.wrap.scrollIntoView({ block: "nearest" }); // /undo triggers this from the composer, potentially far from the row
}

function requestRewind(promptId, force) {
  vscode.postMessage({ type: "rewindToPrompt", promptId, force: force === true });
}

/** Server refused the rewind because files were edited OUTSIDE the agent since — confirm-then-force, same flow handleUndoConflict uses. */
function handleRewindConflict(m) {
  const files = m.conflicts ?? [];
  showRewindConfirm(
    m.promptId,
    `${files.join(", ") || "One or more files"} ${files.length === 1 ? "has" : "have"} been edited outside the agent since. Rewinding will overwrite ${files.length === 1 ? "that edit" : "those edits"}. Continue?`,
    [],
    () => requestRewind(m.promptId, true),
  );
}

function resetRewindRows() {
  rewindRows.clear();
  userPromptOrder.length = 0;
}

function setBusy(b) {
  busy = b;
  sendBtn.disabled = b;
  stopBtn.hidden = !b;
  document.getElementById("thinking")?.remove();
  if (b) {
    clearEmpty();
    const th = document.createElement("div");
    th.className = "waiting";
    th.id = "thinking";
    th.innerHTML = "<i></i><i></i><i></i>";
    messagesEl.appendChild(th);
    scrollBottom();
  }
}

// ---------- modes ----------
function setModeUI(mode) {
  modeSelectEl.value = mode;
}
modeSelectEl.addEventListener("change", () => {
  vscode.postMessage({ type: "setMode", mode: modeSelectEl.value });
});

// ---------- attachments (chips): drag-drop, @-mention, attach-current-file ----------
// Chips are pure UI state here — the extension does the actual file read +
// prompt-block expansion (this side has no fs access, and keeping the
// displayed/persisted "user" text free of file dumps is deliberate; see
// extension.js sendPrompt).
let attachments = []; // {path, startLine?, endLine?}

function attachmentKey(a) {
  return `${a.path}:${a.startLine ?? ""}-${a.endLine ?? ""}`;
}

function addAttachment(att) {
  if (!att || !att.path) return;
  const key = attachmentKey(att);
  if (attachments.some((a) => attachmentKey(a) === key)) return; // dedupe
  attachments.push(att);
  renderAttachments();
}

function removeAttachment(idx) {
  attachments.splice(idx, 1);
  renderAttachments();
}

function clearAttachments() {
  attachments = [];
  renderAttachments();
}

function renderAttachments() {
  attachRow.innerHTML = "";
  attachRow.hidden = attachments.length === 0;
  attachments.forEach((a, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    const base = a.path.split("/").pop();
    const label = a.startLine ? `${base}:${a.startLine}-${a.endLine}` : base;
    // Security audit finding (2026-07-17): `base` is a workspace filename —
    // untrusted text (a malicious/compromised repo can name a file
    // `foo".onmouseover="...` on Linux/macOS). Build the chip via
    // createElement/setAttribute/textContent, never interpolate it into an
    // innerHTML template — the CSP already blocks script execution from
    // this, but an attribute-breakout is still real DOM corruption to close.
    const labelEl = document.createElement("span");
    labelEl.className = "chip-label";
    labelEl.textContent = label;
    labelEl.title = a.path;
    const removeBtn = document.createElement("button");
    removeBtn.className = "chip-x";
    removeBtn.title = "Remove";
    removeBtn.setAttribute("aria-label", `Remove ${base}`);
    removeBtn.textContent = "✕";
    chip.appendChild(labelEl);
    chip.appendChild(removeBtn);
    removeBtn.addEventListener("click", () => removeAttachment(i));
    attachRow.appendChild(chip);
  });
}

attachBtn.addEventListener("click", () => vscode.postMessage({ type: "attachActiveFile" }));

// ---------- voice mode (push-to-talk STT, docs/research/14-voice-mode.md) ----------
//
// Capture uses `new AudioContext({ sampleRate: 16000 })` + a
// ScriptProcessorNode — NOT AudioWorklet — specifically because AudioWorklet
// requires loading a separate module script, which this webview's CSP
// (`default-src 'none'`) blocks; ScriptProcessorNode runs its callback
// inline with no extra script load. ScriptProcessorNode is deprecated in
// favor of AudioWorklet upstream but is not removed, and this constraint is
// exactly why the design doc calls for it here.
//
// NOTE: none of this has been exercised against a live getUserMedia call in
// this build — no browser/Extension Host was available (see the project's
// build report). It is wired per the design doc but unverified at runtime.

/**
 * Mirrors voice.js's insertAtCaret() (tested there via test/voice.test.js)
 * — duplicated here because this file runs inside the sandboxed webview
 * with no module loader (CSP `default-src 'none'`), so it can't require()
 * voice.js. Keep the two in lockstep if this changes. Module-scope (not
 * nested under the mic-button guard below) so it stays a plain, pure,
 * easily-diffed-against-its-twin function.
 */
function insertTranscribedText(value, selectionStart, selectionEnd, insertText) {
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  if (!insertText) return { value: before + after, caret: before.length };
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const inserted = needsLeadingSpace ? " " + insertText : insertText;
  return { value: before + inserted + after, caret: (before + inserted).length };
}

/** Insert-don't-send: splice transcribed text at the caret, focus, but never auto-submit — the user reviews/edits before sending. */
function insertTranscribedTextIntoComposer(text) {
  const { value, caret } = insertTranscribedText(inputEl.value, inputEl.selectionStart, inputEl.selectionEnd, text);
  inputEl.value = value;
  inputEl.focus();
  inputEl.setSelectionRange(caret, caret);
  // Same auto-grow trigger the rest of the composer relies on for
  // programmatic value changes (mirrors pickMention's caret-set-then-focus
  // pattern above) so the textarea resizes if the transcript is long.
  inputEl.dispatchEvent(new Event("input"));
}

// `transcribing`/`endVoiceTranscribing` are module-scope (not nested under
// the `if (micBtn)` guard) so the "transcribeAudioDone" case in the inbound
// message listener further down can always call endVoiceTranscribing() —
// even on a build where micBtn doesn't exist, this is just a no-op.
let voiceTranscribing = false;
function endVoiceTranscribing() {
  voiceTranscribing = false;
  if (micBtn) {
    micBtn.classList.remove("transcribing");
    micBtn.disabled = false;
  }
}

// Readiness gate — resolved by the host's "ready" boot message before the
// user ever touches the mic button, and re-resolved after "voiceSetupDone".
// The point of tracking this client-side (rather than just trying to record
// and finding out) is that a click while "needs-setup"/"unavailable" must
// run the (possibly slow, network-bound) setup flow INSTEAD of arming
// getUserMedia — never record-then-tell-you-it-was-pointless afterwards.
// See docs/research/14-voice-mode.md.
const MIC_TITLES = {
  idle: "Hold to dictate (push-to-talk)",
  recording: "Recording — release to transcribe",
  transcribing: "Transcribing…",
  "needs-setup": "Click to set up voice input (one-time ~142MB download)",
  "setting-up": "Setting up voice input…",
  unavailable: "Voice input isn't available in this build",
};
let voiceStatus = "needs-setup"; // "needs-setup" | "unavailable" | "ready" — set for real by applyVoiceCapability()
let settingUp = false;

function setMicState(state) {
  // state: "idle" | "recording" | "transcribing" | "needs-setup" | "setting-up" | "unavailable"
  if (!micBtn) return;
  micBtn.classList.remove("recording", "transcribing", "needs-setup", "setting-up", "unavailable");
  if (state !== "idle") micBtn.classList.add(state);
  micBtn.disabled = state === "transcribing" || state === "setting-up";
  const title = MIC_TITLES[state] || MIC_TITLES.idle;
  micBtn.title = title;
  micBtn.setAttribute("aria-label", title);
}

/** Applies the host's boot-time (or post-setup) capability check to the mic button's resting state. */
function applyVoiceCapability(v) {
  if (!micBtn || !v) return;
  voiceStatus = !v.addonAvailable ? "unavailable" : !v.modelDownloaded ? "needs-setup" : "ready";
  setMicState(voiceStatus === "ready" ? "idle" : voiceStatus);
}

function startSetup() {
  if (!micBtn || settingUp) return;
  settingUp = true;
  setMicState("setting-up");
  vscode.postMessage({ type: "setupVoice" });
}

if (micBtn) {
  let mediaStream = null;
  let audioCtx = null;
  let sourceNode = null;
  let scriptNode = null;
  let pcmChunks = [];
  let recording = false;

  function teardownCapture() {
    try { scriptNode && scriptNode.disconnect(); } catch { /* already disconnected */ }
    try { sourceNode && sourceNode.disconnect(); } catch { /* already disconnected */ }
    try { mediaStream && mediaStream.getTracks().forEach((t) => t.stop()); } catch { /* already stopped */ }
    try { audioCtx && audioCtx.close(); } catch { /* already closed */ }
    scriptNode = null;
    sourceNode = null;
    mediaStream = null;
    audioCtx = null;
  }

  async function startRecording() {
    if (recording || voiceTranscribing || settingUp || voiceStatus !== "ready") return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Covers both a user denial and the (currently likely, on an
      // unpatched build) case where getUserMedia is blocked entirely by the
      // webview's permission policy — can't distinguish the two from a
      // rejected promise alone, so the message names both possible causes
      // instead of confidently pointing at OS settings when that might not
      // be it at all.
      addMsg(
        "system",
        "Couldn't access the microphone — either it was denied in your OS privacy settings, " +
          "or this build doesn't have microphone access patched in yet. Check your OS privacy " +
          "settings first; if it's still blocked after that, it's likely the latter.",
      );
      return;
    }
    recording = true;
    pcmChunks = [];
    setMicState("recording");
    audioCtx = new AudioContext({ sampleRate: 16000 });
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = (e) => {
      // Float32Array from getChannelData is a live view into the
      // AudioContext's internal buffer — copy it, or every chunk we've
      // pushed silently changes underneath us on the next callback.
      pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    sourceNode.connect(scriptNode);
    // ScriptProcessorNode only fires onaudioprocess while connected into the
    // graph all the way to a destination.
    scriptNode.connect(audioCtx.destination);
  }

  function stopRecording() {
    if (!recording) return;
    recording = false;
    teardownCapture();

    let total = 0;
    for (const c of pcmChunks) total += c.length;
    if (total === 0) {
      pcmChunks = [];
      setMicState("idle");
      return;
    }
    const merged = new Float32Array(total);
    let offset = 0;
    for (const c of pcmChunks) { merged.set(c, offset); offset += c.length; }
    pcmChunks = [];

    voiceTranscribing = true;
    setMicState("transcribing");
    vscode.postMessage({ type: "transcribeAudio", pcm: merged.buffer });
  }

  function onMicPress() {
    if (voiceStatus !== "ready") { startSetup(); return; }
    startRecording();
  }
  micBtn.addEventListener("mousedown", (e) => { e.preventDefault(); onMicPress(); });
  micBtn.addEventListener("touchstart", (e) => { e.preventDefault(); onMicPress(); });
  micBtn.addEventListener("mouseup", stopRecording);
  micBtn.addEventListener("touchend", stopRecording);
  micBtn.addEventListener("mouseleave", () => { if (recording) stopRecording(); });
  window.addEventListener("blur", () => { if (recording) stopRecording(); });
}

// ---------- diagnostics (full session report -> clipboard) ----------
// extension.js assembles the report (it holds the full transcript, incl.
// fields this webview doesn't keep around, like raw tool input) and copies
// it via vscode.env.clipboard — see the "copyDiagnostics"/"diagnosticsCopied"
// pair below and the case "copyDiagnostics" handler in extension.js.
diagBtn.addEventListener("click", () => {
  if (diagBtn.disabled) return;
  diagBtn.disabled = true;
  vscode.postMessage({ type: "copyDiagnostics" });
});

// drag-and-drop onto the composer. VS Code reliably surfaces explorer/tab
// drags into a webview as `text/uri-list`; OS-level Finder/Explorer drops
// vary by platform and sometimes populate `dataTransfer.files` instead (a
// webview's sandbox often strips real filesystem paths off File objects,
// so uri-list is the general-purpose path — this is a known webview
// sandbox limitation, not a bug here).
["dragenter", "dragover"].forEach((evt) =>
  composerEl.addEventListener(evt, (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    composerEl.classList.add("drag-over");
  }),
);
["dragleave", "drop"].forEach((evt) =>
  composerEl.addEventListener(evt, () => composerEl.classList.remove("drag-over")),
);
composerEl.addEventListener("drop", (e) => {
  e.preventDefault();
  const dt = e.dataTransfer;
  if (!dt) return;
  const uriList = dt.getData("text/uri-list") || dt.getData("text/plain");
  if (uriList) {
    for (const line of uriList.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      vscode.postMessage({ type: "resolveDroppedUri", uri: s });
    }
    return;
  }
  for (const f of dt.files ?? []) {
    if (f.path) vscode.postMessage({ type: "resolveDroppedUri", uri: "file://" + f.path });
  }
});

// ---------- @-mention autocomplete ----------
let mentionActive = false;
let mentionStart = -1; // index of "@" in inputEl.value
let mentionQuery = "";
let mentionItems = [];
let mentionIndex = 0;
let mentionSeq = 0;

function closeMention() {
  mentionActive = false;
  mentionPopup.hidden = true;
  mentionPopup.innerHTML = "";
}

function openMentionAt(atIdx) {
  mentionActive = true;
  mentionStart = atIdx;
  mentionQuery = "";
  requestMentionResults();
}

function requestMentionResults() {
  vscode.postMessage({ type: "searchFiles", q: mentionQuery, seq: ++mentionSeq });
}

function renderMentionResults(files) {
  mentionItems = files;
  mentionIndex = 0;
  if (!files.length) {
    mentionPopup.innerHTML = `<div class="mention-empty">No matching files</div>`;
    mentionPopup.hidden = false;
    return;
  }
  mentionPopup.innerHTML = files.map((_, i) => `<div class="mention-item${i === 0 ? " active" : ""}"></div>`).join("");
  [...mentionPopup.querySelectorAll(".mention-item")].forEach((el, i) => {
    el.textContent = files[i];
    el.addEventListener("mousedown", (e) => { e.preventDefault(); pickMention(i); });
  });
  mentionPopup.hidden = false;
}

function pickMention(i) {
  const f = mentionItems[i];
  if (f === undefined) return;
  const before = inputEl.value.slice(0, mentionStart);
  const after = inputEl.value.slice(mentionStart + 1 + mentionQuery.length);
  const token = `@${f} `;
  inputEl.value = before + token + after;
  const caret = (before + token).length;
  inputEl.focus();
  inputEl.setSelectionRange(caret, caret);
  addAttachment({ path: f });
  closeMention();
}

function updateMentionHighlight() {
  [...mentionPopup.querySelectorAll(".mention-item")].forEach((el, i) => el.classList.toggle("active", i === mentionIndex));
  mentionPopup.querySelector(".mention-item.active")?.scrollIntoView({ block: "nearest" });
}

inputEl.addEventListener("input", () => {
  const caret = inputEl.selectionStart;
  if (!mentionActive) {
    const prevChar = inputEl.value[caret - 2];
    if (inputEl.value[caret - 1] === "@" && (prevChar === undefined || /\s/.test(prevChar))) {
      openMentionAt(caret - 1);
    }
    return;
  }
  const slice = inputEl.value.slice(mentionStart + 1, caret);
  if (caret <= mentionStart || /\s/.test(slice)) { closeMention(); return; }
  mentionQuery = slice;
  requestMentionResults();
});

// Registered on document (capture phase) so it runs BEFORE inputEl's own
// keydown listener below (same-element listeners fire in registration
// order regardless of capture flag — only a capturing ancestor listener
// can pre-empt a target's own listener).
document.addEventListener(
  "keydown",
  (e) => {
    if (e.target !== inputEl || !mentionActive) return;
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); mentionIndex = Math.min(mentionIndex + 1, mentionItems.length - 1); updateMentionHighlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); mentionIndex = Math.max(mentionIndex - 1, 0); updateMentionHighlight(); }
    else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); pickMention(mentionIndex); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMention(); }
  },
  true,
);
document.addEventListener("click", (e) => {
  if (mentionActive && !mentionPopup.contains(e.target) && e.target !== inputEl) closeMention();
});

// ---------- slash commands (Royal Mode 2.0 Stage 1b — docs/research/12) ----------
// Structure deliberately cloned from the @-mention machinery above: same
// popup chrome (.mention-popup / .mention-item CSS), same open/render/pick/
// close state machine, same capture-phase keyboard nav. Differences: it only
// triggers when "/" is the FIRST character of the input (never mid-text),
// the item list is local (built-ins) + extension-provided (custom .md
// commands) instead of a searchFiles round-trip, and picking either executes
// immediately (no-arg built-ins) or completes the token (commands that take
// arguments), with actual execution living in runSlashCommand() on send.
const slashPopup = document.getElementById("slashPopup");
let customCommands = []; // [{name, description, source}] — pushed by extension.js ("commands" message)
let slashActive = false;
let slashQuery = "";
let slashItems = [];
let slashIndex = 0;

// takesArgs: picking from the popup completes "/name " instead of executing,
// so the user can type the argument; run() executes (args may be "").
const BUILTIN_COMMANDS = [
  { name: "plan", description: "Switch to Review mode — research first, produce a plan", takesArgs: false, run: () => switchMode("review") },
  { name: "approve", description: "Switch to Approve mode — edits ask for your OK", takesArgs: false, run: () => switchMode("approve") },
  { name: "auto", description: "Switch to Auto mode — the agent acts without asking", takesArgs: false, run: () => switchMode("auto") },
  { name: "royal", description: "Switch to Royal mode — full autonomy (consent gate applies)", takesArgs: false, run: () => switchMode("royal") },
  { name: "model", description: "/model <name> — switch model; bare /model focuses the picker", takesArgs: true, run: (args) => slashModel(args) },
  { name: "new", description: "Start a new chat", takesArgs: false, run: () => vscode.postMessage({ type: "newChat" }) },
  { name: "undo", description: "Rewind to the last message — revert its file changes and remove it from the conversation", takesArgs: false, run: () => slashUndo() },
  { name: "report", description: "Copy the full diagnostic session report to the clipboard", takesArgs: false, run: () => slashReport() },
  { name: "walkthrough", description: "Narrate the current diff, grounded in dependency + test-coverage data", takesArgs: false, run: () => slashWalkthrough() },
  { name: "help", description: "List all slash commands", takesArgs: false, run: () => renderSlashHelp() },
];

/** Built-ins + customs (built-in names win a clash), for both the popover and /help. */
function allSlashCommands() {
  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));
  const customs = customCommands.filter((c) => !builtinNames.has(c.name.toLowerCase()));
  return [
    ...BUILTIN_COMMANDS.map((c) => ({ ...c, source: "built-in" })),
    ...customs.map((c) => ({ name: c.name, description: c.description || "Custom command", source: c.source, takesArgs: true, custom: true })),
  ];
}

// Transient confirmation pill above the composer (there was no toast
// machinery before this; system chat messages are too heavy for "mode
// switched" acks and the .fb-note pattern is anchored to a button).
let toastTimer = null;
function toast(text) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.querySelector(".input-wrap").appendChild(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/** All four mode commands reuse the mode select's exact message — royal still hits extension.js's consent gate ("setMode" handler), never bypassed. */
function switchMode(mode) {
  vscode.postMessage({ type: "setMode", mode });
  toast(`Switching to ${mode} mode…`);
}

function slashModel(args) {
  if (!args) {
    modelEl.focus();
    toast("Pick a model");
    return;
  }
  const q = args.toLowerCase();
  const opts = [...modelEl.options].map((o) => o.value);
  // exact > "model id without provider prefix" > substring — same forgiving
  // spirit as the mention popup's fuzzy match, without false positives.
  const match =
    opts.find((v) => v.toLowerCase() === q) ||
    opts.find((v) => v.toLowerCase().endsWith(`/${q}`)) ||
    opts.find((v) => v.toLowerCase().includes(q));
  if (!match) {
    toast(`No model matching "${args}"`);
    return;
  }
  modelEl.value = match;
  vscode.postMessage({ type: "setModel", model: match }); // same path the select's own change handler uses
  toast(`Model: ${match}`);
}

function slashUndo() {
  // /undo = rewind to the LAST user message: revert every file change made
  // since it and remove it (and everything after) from the conversation —
  // the exact confirm-first flow of that message's own "Rewind to here"
  // control, just reachable from the composer. userPromptOrder only holds
  // prompts that carried a promptId, so old replayed chats degrade to a
  // toast instead of a broken rewind.
  const last = userPromptOrder[userPromptOrder.length - 1];
  if (!last) {
    toast("Nothing to rewind yet");
    return;
  }
  startRewindConfirm(last);
}

function slashReport() {
  if (diagBtn.disabled) return; // a copy is already in flight
  diagBtn.disabled = true; // "diagnosticsCopied" re-enables it and shows the note, same as a button click
  vscode.postMessage({ type: "copyDiagnostics" });
}

/**
 * /walkthrough (docs/research/16-ide-feature-roadmap-round2.md §"PR
 * walkthrough auto-generator") — unlike the mode-switch/undo/report
 * built-ins above (side-channel actions that must work mid-turn, per the
 * comment on send() below), this one STARTS a real turn: extension.js's
 * "walkthrough" handler shells to git, scans the diff for lightweight
 * dependents/test coverage, composes a rich prompt, and sends it through
 * sendPrompt() exactly like a custom .md command's expanded body does. So
 * it respects `busy` explicitly here, the same way runSlashCommand() does
 * for custom commands — the general busy guard in send() is skipped for
 * ALL built-ins (they run before it), so a turn-starting built-in has to
 * opt back into the check itself.
 */
function slashWalkthrough() {
  if (busy) {
    toast("Agent is busy — wait for the turn to finish");
    return;
  }
  vscode.postMessage({ type: "walkthrough" });
}

/**
 * /help — rendered locally, styled like a system message. DELIBERATELY
 * ephemeral (not persisted, gone after a reload/replay): the webview cannot
 * append to the extension's transcript itself, and a round-trip just to
 * durably store what is on-demand UI chrome (not conversation content) isn't
 * worth it — replay safety is preserved by keeping it out of the transcript
 * entirely rather than by making it replayable.
 */
function renderSlashHelp() {
  clearEmpty();
  const el = document.createElement("div");
  el.className = "msg system slash-help";
  const title = document.createElement("div");
  title.className = "help-title";
  title.textContent = "Slash commands";
  el.appendChild(title);
  for (const c of allSlashCommands()) {
    const row = document.createElement("div");
    row.className = "help-row";
    const name = document.createElement("span");
    name.className = "help-name";
    name.textContent = `/${c.name}`;
    const desc = document.createElement("span");
    desc.className = "help-desc";
    desc.textContent = c.description;
    row.append(name, desc);
    if (c.source !== "built-in") {
      const src = document.createElement("span");
      src.className = "help-src";
      src.textContent = c.source;
      row.appendChild(src);
    }
    el.appendChild(row);
  }
  const foot = document.createElement("div");
  foot.className = "help-foot";
  foot.textContent = "Custom commands: add .md files to .lakshx/commands/ (workspace or home). $ARGUMENTS in the body is replaced by what you type after the name.";
  el.appendChild(foot);
  messagesEl.appendChild(el);
  scrollBottom();
}

function closeSlash() {
  slashActive = false;
  slashPopup.hidden = true;
  slashPopup.innerHTML = "";
}

function openSlash(query) {
  if (!slashActive) {
    slashActive = true;
    vscode.postMessage({ type: "refreshCommands" }); // re-scan .lakshx/commands so the list is never stale
  }
  slashQuery = query;
  renderSlashResults();
}

function renderSlashResults() {
  const q = slashQuery.toLowerCase();
  const all = allSlashCommands();
  // prefix matches first (the expected completion), substring matches after
  const prefix = all.filter((c) => c.name.toLowerCase().startsWith(q));
  const rest = all.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  slashItems = [...prefix, ...rest];
  slashIndex = 0;
  if (!slashItems.length) {
    slashPopup.innerHTML = `<div class="mention-empty">No matching commands</div>`;
    slashPopup.hidden = false;
    return;
  }
  slashPopup.innerHTML = slashItems
    .map((_, i) => `<div class="mention-item slash-item${i === 0 ? " active" : ""}"><span class="slash-name"></span><span class="slash-desc"></span><span class="slash-src"></span></div>`)
    .join("");
  [...slashPopup.querySelectorAll(".slash-item")].forEach((el, i) => {
    const c = slashItems[i];
    el.querySelector(".slash-name").textContent = `/${c.name}`;
    el.querySelector(".slash-desc").textContent = c.description;
    el.querySelector(".slash-src").textContent = c.source === "built-in" ? "" : c.source;
    el.addEventListener("mousedown", (e) => { e.preventDefault(); pickSlash(i); });
  });
  slashPopup.hidden = false;
}

function pickSlash(i) {
  const c = slashItems[i];
  if (c === undefined) return;
  if (!c.takesArgs) {
    // no-arg built-in: picking IS running it (a second Enter to send an
    // already-complete "/plan" would just be friction)
    closeSlash();
    inputEl.value = "";
    c.run("");
    return;
  }
  // argument-taking command: complete the token ("/model " / "/fix-issue ")
  // and let the user type args; Enter then routes through send() below.
  const after = inputEl.value.slice(1 + slashQuery.length);
  const token = `/${c.name} `;
  inputEl.value = token + after;
  inputEl.focus();
  inputEl.setSelectionRange(token.length, token.length);
  closeSlash();
}

function updateSlashHighlight() {
  [...slashPopup.querySelectorAll(".slash-item")].forEach((el, i) => el.classList.toggle("active", i === slashIndex));
  slashPopup.querySelector(".slash-item.active")?.scrollIntoView({ block: "nearest" });
}

/**
 * Execute "/name args" typed into the composer (send() routes here).
 * Returns true if it was handled as a command (input should be cleared),
 * false if send() should treat the text as a normal message.
 */
function runSlashCommand(name, args) {
  const lower = name.toLowerCase();
  const builtin = BUILTIN_COMMANDS.find((c) => c.name === lower);
  if (builtin) {
    builtin.run(args);
    return true;
  }
  const custom = customCommands.find((c) => c.name.toLowerCase() === lower);
  if (custom) {
    if (busy) {
      toast("Agent is busy — wait for the turn to finish");
      return false;
    }
    // extension.js expands the .md template and sends it through the normal
    // sendPrompt path (renders + persists + replays as a plain user turn).
    vscode.postMessage({ type: "runCommand", name: custom.name, args });
    return true;
  }
  return false;
}

inputEl.addEventListener("input", () => {
  const v = inputEl.value;
  const caret = inputEl.selectionStart;
  // only at position 0 of the input, and only while the caret is still
  // inside the first whitespace-free token — "/" mid-text never triggers,
  // and typing a space (starting the args) dismisses the popover.
  if (v[0] !== "/" || caret < 1) { closeSlash(); return; }
  const token = v.slice(1, caret);
  if (/\s/.test(token)) { closeSlash(); return; }
  openSlash(token);
});

// capture-phase, same registration pattern (and reason) as the mention
// popup's keyboard nav above — must pre-empt inputEl's own Enter-to-send.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.target !== inputEl || !slashActive) return;
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); slashIndex = Math.min(slashIndex + 1, slashItems.length - 1); updateSlashHighlight(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); slashIndex = Math.max(slashIndex - 1, 0); updateSlashHighlight(); }
    else if (e.key === "Enter" || e.key === "Tab") {
      if (!slashItems.length) { closeSlash(); return; } // nothing to pick — let Enter fall through to send() (unknown-command toast)
      e.preventDefault(); e.stopPropagation(); pickSlash(slashIndex);
    }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeSlash(); }
  },
  true,
);
document.addEventListener("click", (e) => {
  if (slashActive && !slashPopup.contains(e.target) && e.target !== inputEl) closeSlash();
});

// ---------- send ----------
function send() {
  const text = inputEl.value.trim();
  if (!text && attachments.length === 0) return;
  // Slash-command interception — BEFORE the busy guard, deliberately: the
  // built-ins are side-channel actions (mode switch, /report on a hung
  // session — its whole reason to exist, /undo, /help) that must work while
  // a turn is in flight, exactly like their button/select equivalents do.
  // Custom commands DO respect busy (checked in runSlashCommand) since they
  // start a real turn.
  if (text[0] === "/") {
    const m = text.match(/^\/(\S+)([\s\S]*)$/);
    if (m && runSlashCommand(m[1], m[2].trim())) {
      inputEl.value = "";
      closeSlash();
      return;
    }
    // Unknown "/token": if it LOOKS like a command attempt (bare word), warn
    // instead of sending a typo to the agent; anything else (e.g. a pasted
    // absolute path like /Users/…) falls through as a normal message.
    if (m && /^[A-Za-z][A-Za-z0-9._-]*$/.test(m[1])) {
      toast(`Unknown command: /${m[1]} — type / to see the list`);
      return;
    }
  }
  if (busy) return;
  inputEl.value = "";
  planBar.hidden = true; // typing a custom reply supersedes the plan buttons
  closeMention();
  closeSlash();
  const atts = attachments.slice();
  clearAttachments();
  vscode.postMessage({ type: "send", text, attachments: atts }); // extension echoes back "user" for transcript
}
sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
modelEl.addEventListener("change", () => vscode.postMessage({ type: "setModel", model: modelEl.value }));

// copy buttons + safe links in rendered markdown (delegated)
messagesEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button.copy");
  if (btn) {
    const code = codeStore[btn.dataset.codeId];
    if (code !== undefined) {
      navigator.clipboard.writeText(code);
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1200);
    }
    return;
  }
  const link = e.target.closest("[data-href]");
  if (link) vscode.postMessage({ type: "openLink", href: link.dataset.href });
});

// ---------- plan approval gate ----------
const planBar = document.getElementById("planBar");

function showPlanBar(relPath) {
  planBar.innerHTML = `<div class="plan-title">Plan ready<span class="plan-path"></span></div>
    <div class="plan-actions">
      <button id="planApprove" class="allow">Approve &amp; build</button>
      <button id="planEnhance" class="deny">Enhance</button>
      <button id="planReject" class="deny">Reject</button>
    </div>`;
  planBar.querySelector(".plan-path").textContent = relPath;
  planBar.hidden = false;
  document.getElementById("planApprove").addEventListener("click", () => {
    planBar.hidden = true;
    vscode.postMessage({ type: "planDecision", decision: "approve" });
  });
  document.getElementById("planReject").addEventListener("click", () => {
    planBar.hidden = true;
    vscode.postMessage({ type: "planDecision", decision: "reject" });
  });
  document.getElementById("planEnhance").addEventListener("click", () => {
    planBar.hidden = true;
    vscode.postMessage({ type: "planDecision", decision: "enhance" });
    inputEl.value = "Enhance the plan: ";
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  });
}

// ---------- feedback (thumbs up/down, retry) ----------
// Rendered inline, right below a completed assistant message — not a
// full-screen overlay like settings/history. Everything here posts to the
// extension, which does the actual local, offline JSONL logging; this file
// only builds the UI and the message payloads.
function attachFeedback(msgEl, promptId) {
  const wrap = document.createElement("div");
  wrap.className = "feedback";
  // No undo icon here anymore: per-response undo was replaced by the
  // conversation-rewind control under each USER message bubble (the
  // "Rewind to here" / "Accept" row — see attachRewindRow above), which
  // reverts files AND truncates the conversation. Thumbs + retry stay.
  void promptId; // still passed by maybeAttachFeedback — kept for future per-turn feedback correlation
  wrap.innerHTML = `<div class="feedback-actions">
    <button class="ghost fb-btn" data-act="up" title="Good response" aria-label="Good response">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 22V11M2 13v7a2 2 0 0 0 2 2h14.3a2 2 0 0 0 2-1.7l1.4-9A2 2 0 0 0 19.7 9H14l1-5.5a2 2 0 0 0-3.7-1.3L7 9"/></svg>
    </button>
    <button class="ghost fb-btn" data-act="down" title="Needs work" aria-label="Needs work">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2v11M22 11V4a2 2 0 0 0-2-2H5.7a2 2 0 0 0-2 1.7l-1.4 9A2 2 0 0 0 4.3 15H10l-1 5.5a2 2 0 0 0 3.7 1.3L17 15"/></svg>
    </button>
    <button class="ghost fb-btn" data-act="retry" title="Retry with the same prompt" aria-label="Retry">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6"/></svg>
    </button>
  </div>`;
  msgEl.insertAdjacentElement("afterend", wrap);
  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".fb-btn");
    if (!btn || btn.disabled) return;
    if (btn.dataset.act === "retry") {
      if (busy) return;
      vscode.postMessage({ type: "retryMessage" });
      const note = document.createElement("span");
      note.className = "fb-note";
      note.textContent = "Retrying…";
      btn.insertAdjacentElement("afterend", note);
      setTimeout(() => note.remove(), 2500);
      return;
    }
    for (const b of wrap.querySelectorAll('.fb-btn[data-act="up"], .fb-btn[data-act="down"]')) {
      b.classList.toggle("active", b === btn);
    }
    openFeedbackForm(wrap, btn.dataset.act);
  });
  scrollBottom();
}

function openFeedbackForm(wrap, kind) {
  let form = wrap.querySelector(".feedback-form");
  if (form) {
    if (form.dataset.kind === kind) { form.hidden = !form.hidden; return; }
    form.remove(); // switched from "Good" to "Needs work" (or vice versa) — rebuild for the new kind
    form = null;
  }
  form = document.createElement("div");
  form.className = "feedback-form";
  form.dataset.kind = kind;
  const closeRow = `<div class="feedback-form-top">
       <button class="ghost fb-close" type="button" title="Dismiss" aria-label="Dismiss feedback form">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
       </button>
     </div>`;
  form.innerHTML = closeRow + (kind === "up"
    ? `<input type="text" class="fb-comment" placeholder="Anything you want to add? (optional)">
       <div class="feedback-form-actions"><div class="spacer"></div><button class="fb-submit">Submit</button></div>`
    : `<textarea class="fb-expected" rows="2" placeholder="What did you expect?"></textarea>
       <textarea class="fb-wrong" rows="2" placeholder="What went wrong?"></textarea>
       <div class="feedback-form-actions">
         <button class="ghost fb-viewlog">View log for this response</button>
         <div class="spacer"></div>
         <button class="fb-submit">Submit</button>
       </div>`);
  wrap.appendChild(form);
  form.querySelector(".fb-close").addEventListener("click", () => { form.hidden = true; });
  form.querySelector(".fb-viewlog")?.addEventListener("click", () =>
    vscode.postMessage({ type: "openFeedbackLog" }),
  );
  form.querySelector(".fb-submit").addEventListener("click", () => {
    if (kind === "up") {
      vscode.postMessage({ type: "feedback", rating: "up", comment: form.querySelector(".fb-comment").value.trim() });
    } else {
      vscode.postMessage({
        type: "feedback",
        rating: "down",
        expected: form.querySelector(".fb-expected").value.trim(),
        wentWrong: form.querySelector(".fb-wrong").value.trim(),
      });
    }
    form.remove();
    for (const b of wrap.querySelectorAll('.fb-btn[data-act="up"], .fb-btn[data-act="down"]')) b.disabled = true;
    const done = document.createElement("div");
    done.className = "feedback-done";
    done.textContent = "Thanks — feedback saved";
    wrap.appendChild(done);
    setTimeout(() => done.classList.add("fade"), 1800);
    setTimeout(() => done.remove(), 2400);
    scrollBottom();
  });
  scrollBottom();
}

/** Called at every turn boundary (live or replay); no-op if the turn had no text. */
function maybeAttachFeedback() {
  if (turnHasText && lastAgentEl) attachFeedback(lastAgentEl, currentPromptId);
  turnHasText = false;
  lastAgentEl = null;
}

// ---------- history ----------
const historyPanel = document.getElementById("historyPanel");
const historyBody = document.getElementById("historyBody");
document.getElementById("historyBtn").addEventListener("click", () => {
  vscode.postMessage({ type: "history" });
});
document.getElementById("historyClose").addEventListener("click", () => (historyPanel.hidden = true));

function showHistory(chats) {
  historyBody.innerHTML = chats.length ? "" : `<div class="hint">No saved chats yet.</div>`;
  for (const c of chats) {
    const row = document.createElement("button");
    row.className = "chatrow";
    const when = new Date(c.updatedAt).toLocaleString();
    row.innerHTML = `<span class="ctitle"></span><span class="cwhen">${when}</span>`;
    row.querySelector(".ctitle").textContent = c.title || "Untitled chat";
    row.addEventListener("click", () => {
      historyPanel.hidden = true;
      vscode.postMessage({ type: "loadChat", id: c.id });
    });
    historyBody.appendChild(row);
  }
  historyPanel.hidden = false;
}

// ---------- what's new ----------
const whatsNewBtn = document.getElementById("whatsNewBtn");
const whatsNewPanel = document.getElementById("whatsNewPanel");
const whatsNewBody = document.getElementById("whatsNewBody");
whatsNewBtn.addEventListener("click", () => {
  vscode.postMessage({ type: "whatsNew" });
});
document.getElementById("whatsNewClose").addEventListener("click", () => (whatsNewPanel.hidden = true));

function showWhatsNew(entries) {
  // opening the panel means the extension has already recorded these as
  // seen (extension.js's "whatsNew" handler) — clear the badge to match
  whatsNewBtn.classList.remove("unseen");
  whatsNewBody.innerHTML = entries.length ? "" : `<div class="hint">Nothing new yet.</div>`;
  let lastDate = null;
  for (const entry of entries) {
    if (entry.date !== lastDate) {
      const heading = document.createElement("div");
      heading.className = "wn-date";
      heading.textContent = new Date(`${entry.date}T00:00:00`).toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      whatsNewBody.appendChild(heading);
      lastDate = entry.date;
    }
    const item = document.createElement("div");
    item.className = "wn-item";
    item.innerHTML = `<div class="wn-title"></div><div class="wn-desc"></div>`;
    item.querySelector(".wn-title").textContent = entry.title;
    item.querySelector(".wn-desc").textContent = entry.description;
    whatsNewBody.appendChild(item);
  }
  whatsNewPanel.hidden = false;
}

// ---------- replay (webview rebuilds when hidden) ----------
function applyEvent(m, replaying) {
  switch (m.type) {
    case "user": currentPromptId = m.promptId ?? currentPromptId; addUserMsg(m); break;
    case "chunk": replaying ? bulkChunk(m.text) : streamText(m.text); break;
    case "thought": if (!replaying) streamThought(m.text); break;
    case "tool": addTool(m); break;
    case "toolUpdate": {
      const el = tools.get(m.id);
      if (el) {
        el.className = `tool ${m.status === "completed" ? "done" : m.status === "failed" ? "failed" : "running"}`;
        applyMergeConflictSummary(el, m);
      }
      break;
    }
    case "toolImage": applyToolImage(m); break;
    case "system": addMsg("system", m.text); break;
    case "modeChanged":
      setModeUI(m.mode);
      if (m.auto) addMsg("system", `Plan complete — switched to ${m.mode} mode.`);
      break;
    case "checkpoint": applyCheckpoint(m); break;
    case "checkpointReverted": applyRevert(m.paths); break;
    case "rewindAccepted": dismissRewindRow(m.promptId); break;
    case "subagentsStart": applySubagentsStart(m); break;
    case "subagentActivity": applySubagentActivity(m); break;
    case "subagentsEnd": applySubagentsEnd(m); break;
    case "phaseState": applyPhaseState(m); break;
    case "taskStart": applyTaskStart(m); break;
    case "taskActivity": applyTaskActivity(m); break;
    case "taskDone": applyTaskDone(m); break;
    case "taskSteered": applyTaskSteered(m); break;
    case "turnEnd":
      if (replaying) {
        flushBulk();
        maybeAttachFeedback();
      }
      break;
  }
}

let bulkRaw = null;
function bulkChunk(text) { bulkRaw = (bulkRaw ?? "") + text; turnHasText = true; }
function flushBulk() {
  if (bulkRaw !== null) {
    codeSeq++;
    const el = document.createElement("div");
    el.className = "msg agent";
    el.innerHTML = renderRich(bulkRaw);
    messagesEl.appendChild(el);
    lastAgentEl = el;
    bulkRaw = null;
  }
}

// ---------- BYOK settings (unchanged behavior, no emoji) ----------
const settingsPanel = document.getElementById("settingsPanel");
const settingsBody = document.getElementById("settingsBody");

const PROVIDERS = {
  lakshx: { label: "LakshX (free, no key needed)", managed: true, models: ["gpt-5-mini"] },
  anthropic: { label: "Anthropic (Claude)", keyUrl: "console.anthropic.com", models: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5", "claude-fable-5"] },
  openrouter: { label: "OpenRouter", keyUrl: "openrouter.ai/keys", models: ["anthropic/claude-sonnet-5", "openai/gpt-5.5", "google/gemini-3-pro", "deepseek/deepseek-chat", "qwen/qwen3-coder"] },
  gemini: { label: "Google Gemini", keyUrl: "aistudio.google.com/apikey", models: ["gemini-3-pro", "gemini-3-flash", "gemini-3.1-flash-lite"] },
  openai: { label: "OpenAI", keyUrl: "platform.openai.com/api-keys", models: ["gpt-5.5", "gpt-5.6"] },
  deepseek: { label: "DeepSeek", keyUrl: "platform.deepseek.com", models: ["deepseek-chat", "deepseek-reasoner"] },
  groq: { label: "Groq", keyUrl: "console.groq.com/keys", models: ["gpt-oss-120b", "llama-4-scout"] },
  xai: { label: "xAI (Grok)", keyUrl: "console.x.ai", models: ["grok-4.1-fast", "grok-4"] },
};

let settingsState = { defaultModel: "", set: {} };
const liveModels = {};

function renderSettings() {
  const sel = document.getElementById("providerSelect");
  const firstSet = Object.keys(PROVIDERS).find((id) => settingsState.set?.[id]);
  const providerId = sel?.value || firstSet || Object.keys(PROVIDERS)[0];
  const p = PROVIDERS[providerId];
  const isSet = settingsState.set?.[providerId];
  const currentDefault = settingsState.defaultModel || "";

  settingsBody.innerHTML = `
    <div class="field">
      <label>AI Provider</label>
      <select id="providerSelect" class="big">${Object.entries(PROVIDERS)
        .map(([id, pv]) => `<option value="${id}" ${id === providerId ? "selected" : ""}>${pv.label}${settingsState.set?.[id] ? " — key saved" : ""}</option>`)
        .join("")}</select>
    </div>
    ${
      p.managed
        ? `<div class="field">
      <label>Account ${isSet ? '<span class="pill">signed in</span>' : '<span class="muted">sign in to use the free model</span>'}</label>
      <button type="button" id="lakshxAuthBtn">${isSet ? "Sign Out" : "Sign In"}</button>
    </div>`
        : `<div class="field">
      <label>API key ${isSet ? '<span class="pill">saved</span>' : `<span class="muted">get one at ${p.keyUrl}</span>`}</label>
      <input type="password" id="keyInput" placeholder="${isSet ? "leave blank to keep current key" : "paste API key"}">
    </div>`
    }
    <div class="field">
      <label>Model ${liveModels[providerId] ? `<span class="pill">${liveModels[providerId].length} live</span>` : ""}</label>
      <select id="modelSelect" class="big">
        ${(liveModels[providerId] ?? p.models).map((m) => `<option value="${escapeHtml(m)}" ${`${providerId}/${m}` === currentDefault ? "selected" : ""}>${escapeHtml(m)}</option>`).join("")}
        <option value="__custom__">custom&hellip;</option>
      </select>
      <input id="customModel" placeholder="model id" hidden>
    </div>
    <label class="check"><input type="checkbox" id="makeDefault" checked> Use as default model</label>
    <div id="provStatus" class="muted"></div>
    <div class="field">
      <label>Explain language</label>
      <select id="explainLanguageSelect" class="big">${Object.entries(settingsState.explainLanguages ?? { english: "English (default)" })
        .map(([id, label]) => `<option value="${id}" ${id === (settingsState.explainLanguage || "english") ? "selected" : ""}>${escapeHtml(label)}</option>`)
        .join("")}</select>
      <div class="muted">Errors, plans, and diffs get explained in this code-mixed register — code, commands, and file paths always stay in English.</div>
    </div>
  `;
  document.getElementById("providerSelect").addEventListener("change", renderSettings);
  document.getElementById("modelSelect").addEventListener("change", (e) => {
    document.getElementById("customModel").hidden = e.target.value !== "__custom__";
  });
  document.getElementById("explainLanguageSelect").addEventListener("change", (e) => {
    settingsState.explainLanguage = e.target.value; // survives the next renderSettings() re-render (e.g. on provider change)
    vscode.postMessage({ type: "setExplainLanguage", value: e.target.value });
  });
  if (p.managed) {
    document.getElementById("lakshxAuthBtn").addEventListener("click", () => {
      vscode.postMessage({ type: isSet ? "lakshxLogout" : "lakshxLogin" });
    });
  }
  // "lakshx/validate" probes a live GET /models endpoint the managed proxy
  // doesn't implement (it only speaks POST chat/completions) — not
  // meaningful for a login-token session anyway, so skip it here.
  if (isSet && !liveModels[providerId] && !p.managed) {
    document.getElementById("provStatus").textContent = "checking key, fetching models…";
    vscode.postMessage({ type: "validateProvider", provider: providerId });
  }
}

function showSettings(state) {
  settingsState = state;
  renderSettings();
  settingsPanel.hidden = false;
}
document.getElementById("settingsClose").addEventListener("click", () => (settingsPanel.hidden = true));
document.getElementById("settingsFile").addEventListener("click", () => vscode.postMessage({ type: "openSettingsFile" }));
document.getElementById("settingsSave").addEventListener("click", () => {
  const providerId = document.getElementById("providerSelect").value;
  // no keyInput field for the managed "lakshx" provider — its "key" is the
  // login session, set via the Sign In button instead.
  const key = document.getElementById("keyInput")?.value?.trim() ?? "";
  const modelSel = document.getElementById("modelSelect").value;
  const model = modelSel === "__custom__" ? document.getElementById("customModel").value.trim() : modelSel;
  const keys = {};
  if (key) keys[providerId] = key;
  const defaultModel = document.getElementById("makeDefault").checked && model ? `${providerId}/${model}` : "";
  vscode.postMessage({ type: "saveProviders", keys, defaultModel });
  settingsPanel.hidden = true;
});

// ---------- message routing ----------
window.addEventListener("message", (e) => {
  const m = e.data;
  switch (m.type) {
    case "ready": {
      applyVoiceCapability(m.voice);
      modelEl.innerHTML = "";
      const def = m.models.defaultModel;
      const opts = new Set([def]);
      for (const p of m.models.providers) {
        for (const model of PROVIDERS[p]?.models ?? []) opts.add(`${p}/${model}`);
      }
      let selected = def;
      if (!m.models.providers.includes(def.split("/")[0])) {
        const firstUsable = [...opts].find((o) => m.models.providers.includes(o.split("/")[0]));
        if (firstUsable) {
          selected = firstUsable;
          vscode.postMessage({ type: "setModel", model: selected });
        }
      }
      for (const o of opts) {
        const opt = document.createElement("option");
        opt.value = o;
        opt.textContent = o;
        if (o === selected) opt.selected = true;
        modelEl.appendChild(opt);
      }
      if (m.models.providers.length === 0) {
        addMsg("system", "No API keys yet — use the composer menu to add one.");
      }
      break;
    }
    case "replay":
      messagesEl.innerHTML = "";
      tools.clear();
      checkpointCards.clear();
      subagentCards.clear();
      phaseCard = null;
      bgTasks.clear();
      trayExpanded = false;
      renderTray(); // hides the tray before replay repopulates it; a "tasksReconcile" may follow separately
      sessionFiles.clear();
      resetRewindRows();
      cpbarExpanded = false;
      renderCheckpointBar(); // hides the bar before replay repopulates it
      bulkRaw = null;
      turnHasText = false;
      lastAgentEl = null;
      clearAttachments();
      closeMention();
      closeSlash();
      for (const ev of m.events) applyEvent(ev, true);
      flushBulk();
      if (m.events.length === 0) showEmpty();
      scrollBottom();
      break;
    case "chunk":
      document.getElementById("thinking")?.remove();
      streamText(m.text);
      break;
    case "thought":
      document.getElementById("thinking")?.remove();
      streamThought(m.text);
      break;
    case "user": currentPromptId = m.promptId ?? currentPromptId; addUserMsg(m); break;
    case "tool":
      document.getElementById("thinking")?.remove();
      addTool(m);
      break;
    case "toolInputDelta":
      document.getElementById("thinking")?.remove();
      applyToolInputDelta(m);
      break;
    case "toolUpdate": applyEvent(m, false); break;
    case "toolImage": applyEvent(m, false); break;
    // Live-only heavy payload (never replayed — see extension.js's
    // `onToolImage` doc comment): applyToolImageData is called directly,
    // not through applyEvent, since it must never run during a replay pass.
    case "toolImageData": applyToolImageData(m); break;
    case "modeChanged": applyEvent(m, false); break;
    case "checkpoint": applyEvent(m, false); break;
    case "checkpointReverted": applyEvent(m, false); break;
    case "rewindAccepted": applyEvent(m, false); break;
    case "rewindConflict": handleRewindConflict(m); break;
    case "subagentsStart": applyEvent(m, false); break;
    case "subagentActivity": applyEvent(m, false); break;
    case "subagentsEnd": applyEvent(m, false); break;
    case "phaseState": applyEvent(m, false); break;
    case "taskStart": applyEvent(m, false); break;
    case "taskActivity": applyEvent(m, false); break;
    case "taskDone": applyEvent(m, false); break;
    case "taskSteered": applyEvent(m, false); break;
    // Not itself a REPLAYABLE transcript event (see extension.js's
    // "replayRequest" handler doc comment) — a one-off round-trip that
    // reconciles whatever the "replay" just rebuilt against the live
    // registry, so it's applied directly rather than through applyEvent.
    case "tasksReconcile": applyTasksReconcile(m); break;
    case "undoConflict": handleUndoConflict(m); break;
    case "permission": {
      currentPermissionId = m.id;
      permissionBar.hidden = false;
      permissionBar.innerHTML = `<span class="title"></span>`;
      permissionBar.querySelector(".title").textContent = m.title;
      for (const o of m.options) {
        const b = document.createElement("button");
        b.className = o.kind.startsWith("allow") ? "allow" : "deny";
        b.textContent = o.name;
        b.addEventListener("click", () => {
          permissionBar.hidden = true;
          currentPermissionId = null;
          vscode.postMessage({ type: "permissionChoice", id: m.id, optionId: o.id });
        });
        permissionBar.appendChild(b);
      }
      break;
    }
    // Fired when this permission was resolved from elsewhere — a paired
    // phone's Allow/Deny tap (docs/research/10 Phase B), or, in principle,
    // this same panel a moment ago (already a no-op there since the click
    // handler above already hid the bar and cleared currentPermissionId).
    // Only hide if it's still THIS permission showing — a resolve for an
    // older prompt must never hide a newer one already on screen.
    case "permissionResolved":
      if (m.id === currentPermissionId) {
        permissionBar.hidden = true;
        currentPermissionId = null;
      }
      break;
    case "turnStart":
      setBusy(true);
      turnHasText = false;
      lastAgentEl = null;
      break;
    case "turnEnd":
      endStream();
      setBusy(false);
      permissionBar.hidden = true;
      currentPermissionId = null;
      maybeAttachFeedback();
      break;
    case "showSettings": showSettings(m.providers); break;
    // Fired after a login/logout round-trip completes — refresh the
    // settings panel's signed-in state WITHOUT forcibly popping it open if
    // the user isn't looking at it (unlike "showSettings", which always
    // un-hides the panel).
    case "lakshxAuthChanged":
      settingsState = m.providers;
      if (!settingsPanel.hidden) renderSettings();
      break;
    case "providerModels":
      liveModels[m.provider] = m.models;
      if (!settingsPanel.hidden) renderSettings();
      break;
    case "providerStatus": {
      if (m.ok && m.models?.length) {
        liveModels[m.provider] = m.models;
        if (!settingsPanel.hidden) renderSettings();
      }
      const el = document.getElementById("provStatus");
      if (el) el.textContent = m.ok ? `Key valid — ${m.models?.length ?? 0} models` : `Invalid: ${m.error}`;
      break;
    }
    case "historyList": showHistory(m.chats); break;
    case "whatsNewList": showWhatsNew(m.entries); break;
    case "planReady": showPlanBar(m.path); break;
    case "system": addMsg("system", m.text); break;
    case "addAttachment": addAttachment(m.attachment); break;
    // Voice mode (docs/research/14-voice-mode.md): insert-don't-send — text
    // lands at the caret for the user to review/edit, never auto-submitted.
    case "transcribedText": insertTranscribedTextIntoComposer(m.text); break;
    case "transcribeAudioDone": endVoiceTranscribing(); break;
    case "voiceSetupDone": {
      settingUp = false;
      if (m.ok) voiceStatus = "ready";
      setMicState(voiceStatus === "ready" ? "idle" : voiceStatus);
      break;
    }
    case "fileResults":
      if (mentionActive && m.seq === mentionSeq) renderMentionResults(m.files);
      break;
    case "commands":
      customCommands = m.commands ?? [];
      if (slashActive) renderSlashResults(); // a refresh landed while the popover is open — re-filter live
      break;
    case "diagnosticsCopied": {
      // Same brief inline-note pattern attachFeedback() uses for "Retrying…"
      // (panel.css .fb-note) — a small transient label next to the button,
      // not a modal or a chat message.
      const note = document.createElement("span");
      note.className = "fb-note";
      note.textContent = m.ok ? "Copied!" : "Copy failed";
      diagBtn.insertAdjacentElement("afterend", note);
      setTimeout(() => note.remove(), 2000);
      diagBtn.disabled = false;
      break;
    }
    case "clear":
      messagesEl.innerHTML = "";
      tools.clear();
      checkpointCards.clear();
      subagentCards.clear();
      phaseCard = null;
      bgTasks.clear();
      trayExpanded = false;
      renderTray();
      sessionFiles.clear();
      resetRewindRows();
      cpbarExpanded = false;
      renderCheckpointBar();
      endStream();
      setBusy(false);
      setModeUI("review");
      showEmpty();
      turnHasText = false;
      lastAgentEl = null;
      clearAttachments();
      closeMention();
      closeSlash();
      break;
  }
});

vscode.postMessage({ type: "boot" });
vscode.postMessage({ type: "replayRequest" });
