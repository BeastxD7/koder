// Koder agent panel UI. No frameworks — small, fast, ours.
const vscode = acquireVsCodeApi();

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop");
const modelEl = document.getElementById("model");
const settingsBtn = document.getElementById("settings");
const permissionBar = document.getElementById("permissionBar");

let streamEl = null; // current streaming agent message
let streamRaw = "";
let busy = false;

function showEmpty() {
  messagesEl.innerHTML = `<div class="empty">
    <div class="mark">✦</div>
    <div class="title">Koder Agent</div>
    <div class="hint">Your code, your keys, your agent.</div>
    <button id="ctaProviders" class="cta">⚙ Configure AI Providers</button>
    <div class="hint"><kbd>⌘L</kbd> open · <kbd>⏎</kbd> send · <kbd>⇧⏎</kbd> newline</div>
  </div>`;
  document.getElementById("ctaProviders")?.addEventListener("click", () =>
    vscode.postMessage({ type: "openSettings" }),
  );
}
showEmpty();

function clearEmpty() {
  messagesEl.querySelector(".empty")?.remove();
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMsg(cls, text) {
  clearEmpty();
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollBottom();
  return el;
}

// minimal safe markdown: escape everything, then bold/inline-code/fences
function renderMd(raw) {
  let s = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/```([\s\S]*?)(```|$)/g, (_, code) => `<pre>${code.replace(/^\w*\n/, "")}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  return s;
}

let renderTimer = null;
function streamText(text) {
  clearEmpty();
  if (!streamEl) {
    streamEl = document.createElement("div");
    streamEl.className = "msg agent";
    messagesEl.appendChild(streamEl);
    streamRaw = "";
  }
  streamRaw += text;
  if (!renderTimer) {
    renderTimer = setTimeout(() => {
      renderTimer = null;
      streamEl.innerHTML = renderMd(streamRaw);
      scrollBottom();
    }, 60); // debounced re-render — no per-token thrash
  }
}

function endStream() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  if (streamEl) streamEl.innerHTML = renderMd(streamRaw);
  streamEl = null;
  streamRaw = "";
  scrollBottom();
}

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
  if (b) {
    clearEmpty();
    const th = document.createElement("div");
    th.className = "thinking";
    th.id = "thinking";
    th.innerHTML = "<i></i><i></i><i></i>";
    messagesEl.appendChild(th);
    scrollBottom();
  } else {
    document.getElementById("thinking")?.remove();
  }
}

function send() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  addMsg("user", text);
  inputEl.value = "";
  vscode.postMessage({ type: "send", text });
}

// ---------- BYOK settings panel (provider → key → model) ----------
const settingsPanel = document.getElementById("settingsPanel");
const settingsBody = document.getElementById("settingsBody");

const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    keyUrl: "console.anthropic.com",
    models: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5", "claude-fable-5"],
  },
  openrouter: {
    label: "OpenRouter — one key, 400+ models",
    keyUrl: "openrouter.ai/keys",
    models: [
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-4.8",
      "openai/gpt-5.5",
      "google/gemini-3-pro",
      "deepseek/deepseek-chat",
      "qwen/qwen3-coder",
    ],
  },
  gemini: {
    label: "Google Gemini",
    keyUrl: "aistudio.google.com/apikey",
    models: ["gemini-3-pro", "gemini-3-flash", "gemini-3.1-flash-lite"],
  },
  openai: {
    label: "OpenAI",
    keyUrl: "platform.openai.com/api-keys",
    models: ["gpt-5.5", "gpt-5.6", "gpt-5.6-luna"],
  },
  deepseek: { label: "DeepSeek", keyUrl: "platform.deepseek.com", models: ["deepseek-chat", "deepseek-reasoner"] },
  groq: { label: "Groq", keyUrl: "console.groq.com/keys", models: ["gpt-oss-120b", "llama-4-scout"] },
  xai: { label: "xAI (Grok)", keyUrl: "console.x.ai", models: ["grok-4.1-fast", "grok-4"] },
};

let settingsState = { defaultModel: "", set: {} };
const liveModels = {}; // provider → models fetched from the provider's API

function renderSettings() {
  const sel = document.getElementById("providerSelect");
  // initial selection: the provider that already has a key, else the first
  const firstSet = Object.keys(PROVIDERS).find((id) => settingsState.set?.[id]);
  const providerId = sel?.value || firstSet || Object.keys(PROVIDERS)[0];
  const p = PROVIDERS[providerId];
  const isSet = settingsState.set?.[providerId];
  const currentDefault = settingsState.defaultModel || "";

  settingsBody.innerHTML = `
    <div class="field">
      <label>AI Provider</label>
      <select id="providerSelect" class="big">${Object.entries(PROVIDERS)
        .map(
          ([id, pv]) =>
            `<option value="${id}" ${id === providerId ? "selected" : ""}>${pv.label}${settingsState.set?.[id] ? "  ✓" : ""}</option>`,
        )
        .join("")}</select>
    </div>
    <div class="field">
      <label>API key ${isSet ? '<span class="pill">saved</span>' : `<span class="muted">get one at ${p.keyUrl}</span>`}</label>
      <input type="password" id="keyInput" placeholder="${isSet ? "•••••••• (leave blank to keep)" : "sk-…"}">
    </div>
    <div class="field">
      <label>Model ${liveModels[providerId] ? `<span class="pill">${liveModels[providerId].length} live from provider</span>` : ""}</label>
      <select id="modelSelect" class="big">
        ${(liveModels[providerId] ?? p.models)
          .map((m) => {
            const full = `${providerId}/${m}`;
            return `<option value="${m}" ${full === currentDefault ? "selected" : ""}>${m}</option>`;
          })
          .join("")}
        <option value="__custom__">custom…</option>
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

  // key already saved for this provider → fetch its real model list
  if (isSet && !liveModels[providerId]) {
    document.getElementById("provStatus").textContent = "checking key + fetching models…";
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
  const defaultModel =
    document.getElementById("makeDefault").checked && model ? `${providerId}/${model}` : "";
  vscode.postMessage({ type: "saveProviders", keys, defaultModel });
  settingsPanel.hidden = true;
});

sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
settingsBtn.addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
modelEl.addEventListener("change", () =>
  vscode.postMessage({ type: "setModel", model: modelEl.value }),
);

window.addEventListener("message", (e) => {
  const m = e.data;
  switch (m.type) {
    case "ready": {
      modelEl.innerHTML = "";
      const def = m.models.defaultModel;
      const opts = new Set([def]);
      const suggestions = {
        anthropic: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"],
        openai: ["gpt-5.5"],
        openrouter: ["deepseek/deepseek-chat"],
        gemini: ["gemini-3-flash"],
        deepseek: ["deepseek-chat"],
        groq: [],
        xai: [],
      };
      for (const p of m.models.providers) {
        for (const model of suggestions[p] ?? []) opts.add(`${p}/${model}`);
      }
      // if the default model's provider has no key, fall back to the first
      // model of a provider that does — and tell the runtime
      let selected = def;
      const defProvider = def.split("/")[0];
      if (!m.models.providers.includes(defProvider)) {
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
      // chat UI first, always — the sheet only opens when the user asks
      if (m.models.providers.length === 0) {
        addMsg("system", "No API keys yet — click ⚙ below to add one (BYOK).");
      } else {
        addMsg("system", `Ready — ${modelEl.value || m.models.defaultModel}`);
      }
      break;
    }
    case "chunk":
      document.getElementById("thinking")?.remove();
      streamText(m.text);
      break;
    case "tool":
      document.getElementById("thinking")?.remove();
      addTool(m);
      break;
    case "toolUpdate": {
      const el = tools.get(m.id);
      if (el) el.className = `tool ${m.status === "completed" ? "done" : m.status === "failed" ? "failed" : "running"}`;
      break;
    }
    case "permission": {
      permissionBar.hidden = false;
      permissionBar.innerHTML = `<span>🔐</span><span class="title"></span>`;
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
    case "turnStart":
      setBusy(true);
      break;
    case "turnEnd":
      endStream();
      setBusy(false);
      permissionBar.hidden = true;
      break;
    case "showSettings":
      showSettings(m.providers);
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
      if (el) el.textContent = m.ok ? `✓ key valid — ${m.models?.length ?? 0} models` : `✗ ${m.error}`;
      break;
    }
    case "system":
      addMsg("system", m.text);
      break;
    case "clear":
      messagesEl.innerHTML = "";
      tools.clear();
      endStream();
      setBusy(false);
      showEmpty();
      break;
  }
});

vscode.postMessage({ type: "boot" });
