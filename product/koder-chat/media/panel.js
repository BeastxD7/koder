// Koder agent panel UI. No frameworks — small, fast, ours.
const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop");
const modelEl = document.getElementById("model");
const settingsBtn = document.getElementById("settings");
const permissionBar = document.getElementById("permissionBar");
const modesEl = document.getElementById("modes");
const composerEl = document.getElementById("composer");
const attachRow = document.getElementById("attachRow");
const attachBtn = document.getElementById("attachBtn");
const mentionPopup = document.getElementById("mentionPopup");

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
  if (window.koderMarkdown) {
    const { html, codes } = window.koderMarkdown.render(raw);
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
    <div class="title">Koder Agent</div>
    <div class="hint">Review plans first. Approve executes with your OK. Auto runs free.</div>
    <button id="ctaProviders" class="cta">Configure AI providers</button>
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
  for (const b of modesEl.querySelectorAll(".mode")) {
    b.classList.toggle("active", b.dataset.mode === mode);
  }
}
modesEl.addEventListener("click", (e) => {
  const b = e.target.closest(".mode");
  if (!b) return;
  setModeUI(b.dataset.mode);
  vscode.postMessage({ type: "setMode", mode: b.dataset.mode });
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
settingsBtn.addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));
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
  form.innerHTML = kind === "up"
    ? `<input type="text" class="fb-comment" placeholder="Anything you want to add? (optional)">
       <div class="feedback-form-actions"><div class="spacer"></div><button class="fb-submit">Submit</button></div>`
    : `<textarea class="fb-expected" rows="2" placeholder="What did you expect?"></textarea>
       <textarea class="fb-wrong" rows="2" placeholder="What went wrong?"></textarea>
       <div class="feedback-form-actions">
         <button class="ghost fb-viewlog">View log for this response</button>
         <div class="spacer"></div>
         <button class="fb-submit">Submit</button>
       </div>`;
  wrap.appendChild(form);
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
    case "planReady": showPlanBar(m.path); break;
    case "system": addMsg("system", m.text); break;
    case "addAttachment": addAttachment(m.attachment); break;
    case "fileResults":
      if (mentionActive && m.seq === mentionSeq) renderMentionResults(m.files);
      break;
    case "clear":
      messagesEl.innerHTML = "";
      tools.clear();
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
