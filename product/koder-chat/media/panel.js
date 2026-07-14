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

let streamEl = null;
let streamRaw = "";
let thoughtEl = null;
let thoughtRaw = "";
let busy = false;
let codeStore = {};
let codeSeq = 0;

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

// ---------- send ----------
function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = "";
  vscode.postMessage({ type: "send", text }); // extension echoes back "user" for transcript
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

// copy buttons in code blocks (delegated)
messagesEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button.copy");
  if (!btn) return;
  const code = codeStore[btn.dataset.codeId];
  if (code !== undefined) {
    navigator.clipboard.writeText(code);
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1200);
  }
});

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
    case "turnEnd": if (replaying) flushBulk(); break;
  }
}

let bulkRaw = null;
function bulkChunk(text) { bulkRaw = (bulkRaw ?? "") + text; }
function flushBulk() {
  if (bulkRaw !== null) {
    codeSeq++;
    const el = document.createElement("div");
    el.className = "msg agent";
    el.innerHTML = renderRich(bulkRaw);
    messagesEl.appendChild(el);
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
      permissionBar.hidden = false;
      permissionBar.innerHTML = `<span class="title"></span>`;
      permissionBar.querySelector(".title").textContent = m.title;
      for (const o of m.options) {
        const b = document.createElement("button");
        b.className = o.kind.startsWith("allow") ? "allow" : "deny";
        b.textContent = o.name;
        b.addEventListener("click", () => {
          permissionBar.hidden = true;
          vscode.postMessage({ type: "permissionChoice", id: m.id, optionId: o.id });
        });
        permissionBar.appendChild(b);
      }
      break;
    }
    case "turnStart": setBusy(true); break;
    case "turnEnd":
      endStream();
      setBusy(false);
      permissionBar.hidden = true;
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
    case "system": addMsg("system", m.text); break;
    case "clear":
      messagesEl.innerHTML = "";
      tools.clear();
      endStream();
      setBusy(false);
      setModeUI("review");
      showEmpty();
      break;
  }
});

vscode.postMessage({ type: "boot" });
vscode.postMessage({ type: "replayRequest" });
