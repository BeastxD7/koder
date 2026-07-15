// LakshX agent panel UI. No frameworks — small, fast, ours.
const vscode = acquireVsCodeApi();

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
const mentionPopup = document.getElementById("mentionPopup");
const checkpointBarEl = document.getElementById("checkpointBar");
const cpbarHead = document.getElementById("cpbarHead");
const cpbarBody = document.getElementById("cpbarBody");

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
function addTool(t) {
  endStream();
  const el = document.createElement("div");
  el.className = "tool running";
  el.innerHTML = `<span class="dot"></span><span class="title"></span>`;
  el.querySelector(".title").textContent = t.title;
  messagesEl.appendChild(el);
  tools.set(t.id, el);
  scrollBottom();
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
      el.innerHTML = `<span class="dot"></span><span class="title"></span>`;
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
    chip.innerHTML = `<span class="chip-label"></span><button class="chip-x" title="Remove" aria-label="Remove ${base}">&#10005;</button>`;
    const labelEl = chip.querySelector(".chip-label");
    labelEl.textContent = label;
    labelEl.title = a.path;
    chip.querySelector(".chip-x").addEventListener("click", () => removeAttachment(i));
    attachRow.appendChild(chip);
  });
}

attachBtn.addEventListener("click", () => vscode.postMessage({ type: "attachActiveFile" }));

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

// ---------- send ----------
function send() {
  const text = inputEl.value.trim();
  if (busy || (!text && attachments.length === 0)) return;
  inputEl.value = "";
  planBar.hidden = true; // typing a custom reply supersedes the plan buttons
  closeMention();
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
function attachFeedback(msgEl) {
  const wrap = document.createElement("div");
  wrap.className = "feedback";
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
  if (turnHasText && lastAgentEl) attachFeedback(lastAgentEl);
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
    case "user": addMsg("user", m.text); break;
    case "chunk": replaying ? bulkChunk(m.text) : streamText(m.text); break;
    case "thought": if (!replaying) streamThought(m.text); break;
    case "tool": addTool(m); break;
    case "toolUpdate": {
      const el = tools.get(m.id);
      if (el) el.className = `tool ${m.status === "completed" ? "done" : m.status === "failed" ? "failed" : "running"}`;
      break;
    }
    case "system": addMsg("system", m.text); break;
    case "modeChanged":
      setModeUI(m.mode);
      if (m.auto) addMsg("system", `Plan complete — switched to ${m.mode} mode.`);
      break;
    case "checkpoint": applyCheckpoint(m); break;
    case "checkpointReverted": applyRevert(m.paths); break;
    case "subagentsStart": applySubagentsStart(m); break;
    case "subagentActivity": applySubagentActivity(m); break;
    case "subagentsEnd": applySubagentsEnd(m); break;
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
    <div class="field">
      <label>API key ${isSet ? '<span class="pill">saved</span>' : `<span class="muted">get one at ${p.keyUrl}</span>`}</label>
      <input type="password" id="keyInput" placeholder="${isSet ? "leave blank to keep current key" : "paste API key"}">
    </div>
    <div class="field">
      <label>Model ${liveModels[providerId] ? `<span class="pill">${liveModels[providerId].length} live</span>` : ""}</label>
      <select id="modelSelect" class="big">
        ${(liveModels[providerId] ?? p.models).map((m) => `<option value="${m}" ${`${providerId}/${m}` === currentDefault ? "selected" : ""}>${m}</option>`).join("")}
        <option value="__custom__">custom&hellip;</option>
      </select>
      <input id="customModel" placeholder="model id" hidden>
    </div>
    <label class="check"><input type="checkbox" id="makeDefault" checked> Use as default model</label>
    <div id="provStatus" class="muted"></div>
  `;
  document.getElementById("providerSelect").addEventListener("change", renderSettings);
  document.getElementById("modelSelect").addEventListener("change", (e) => {
    document.getElementById("customModel").hidden = e.target.value !== "__custom__";
  });
  if (isSet && !liveModels[providerId]) {
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
  const key = document.getElementById("keyInput").value.trim();
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
      sessionFiles.clear();
      cpbarExpanded = false;
      renderCheckpointBar(); // hides the bar before replay repopulates it
      bulkRaw = null;
      turnHasText = false;
      lastAgentEl = null;
      clearAttachments();
      closeMention();
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
    case "user": addMsg("user", m.text); break;
    case "tool":
      document.getElementById("thinking")?.remove();
      addTool(m);
      break;
    case "toolUpdate": applyEvent(m, false); break;
    case "modeChanged": applyEvent(m, false); break;
    case "checkpoint": applyEvent(m, false); break;
    case "checkpointReverted": applyEvent(m, false); break;
    case "subagentsStart": applyEvent(m, false); break;
    case "subagentActivity": applyEvent(m, false); break;
    case "subagentsEnd": applyEvent(m, false); break;
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
    case "fileResults":
      if (mentionActive && m.seq === mentionSeq) renderMentionResults(m.files);
      break;
    case "clear":
      messagesEl.innerHTML = "";
      tools.clear();
      checkpointCards.clear();
      subagentCards.clear();
      sessionFiles.clear();
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
      break;
  }
});

vscode.postMessage({ type: "boot" });
vscode.postMessage({ type: "replayRequest" });
