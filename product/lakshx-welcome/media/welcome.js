// LakshX Welcome — webview-side rendering. Framework-free, CSP-locked
// (default-src 'none'; only the extension's own css/js load, both served via
// asWebviewUri). Talks to extension.js purely through postMessage — no fs,
// no node, no network — same contract shape as lakshx-graph/media/graph.js
// and lakshx-db/media/db.js.
"use strict";

const vscode = acquireVsCodeApi();

// Kept intentionally in sync with docs/architecture.md — every line here
// describes something that actually ships in this build, not aspirational
// copy. See the extension.js header comment for why a custom webview was
// chosen over the `walkthroughs` contribution point.
const FEATURES = [
  {
    icon: "\u{1F4AC}", // speech balloon
    title: "Agent Chat & Modes",
    body: "Review, Approve, Auto, and Royal modes trade autonomy for safety. Royal skips the destructive-command floor entirely; Auto keeps it but asks nothing; Review only plans.",
  },
  {
    icon: "/",
    title: "Slash Commands",
    body: "Drop a markdown file in .lakshx/commands/ and it becomes a /command with $ARGUMENTS templating — no code required.",
  },
  {
    icon: "\u{1F310}", // globe
    title: "Browser Verification",
    body: "The browser_preview tool opens a real browser so the agent can check a UI change actually rendered — not just that the code compiled.",
  },
  {
    icon: "↩", // undo arrow
    title: "Checkpoints & Rewind",
    body: "Every mutating tool call commits to a private shadow-git repo. Undo one file or a whole prompt, without ever touching your real git history.",
  },
  {
    icon: "\u{1F5C4}️", // file cabinet
    title: "Database Visualization",
    body: "Postgres, MySQL, SQLite, and MongoDB schemas rendered as a Mermaid ER diagram, plus a live data browser — no separate DB client needed.",
  },
  {
    icon: "\u{1F578}️", // spider web
    title: "Call & Dependency Graphs",
    body: "Interactive call-hierarchy from your cursor, or a whole-workspace import graph with cycle detection — both native webview panels.",
  },
  {
    icon: "\u{1F3B5}", // musical note
    title: "Music Player",
    body: "An opt-in internet-radio player (Radio Paradise) or your own local tracks, right in the IDE. Off by default.",
  },
];

const QUICKSTART = [
  {
    icon: "\u{1F4AC}",
    label: "Open Chat",
    desc: "Start talking to the LakshX agent",
    command: "lakshx.openAgent",
  },
  {
    icon: "\u{1F3A8}", // palette
    label: "Pick a Theme",
    desc: "LakshX Dark is the default — browse others",
    command: "workbench.action.selectTheme",
  },
  {
    icon: "\u{1F4C1}", // folder
    label: "Open a Folder",
    desc: "Point LakshX at a project to get started",
    command: "workbench.action.files.openFolder",
  },
];

function el(tag, className, children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children || []) node.appendChild(child);
  return node;
}

function text(tag, className, str) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = str;
  return node;
}

function renderFeatures() {
  const grid = document.getElementById("feature-grid");
  for (const f of FEATURES) {
    const card = el("div", "card", [
      text("span", "icon", f.icon),
      text("h3", "", f.title),
      text("p", "", f.body),
    ]);
    grid.appendChild(card);
  }
}

function showToast(msg) {
  let toast = document.querySelector('[data-testid="toast"]');
  if (!toast) {
    toast = document.createElement("div");
    toast.setAttribute("data-testid", "toast");
    document.getElementById("app").appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("show"), 1800);
}

function renderQuickstart() {
  const grid = document.getElementById("quickstart-actions");
  for (const q of QUICKSTART) {
    const btn = document.createElement("button");
    btn.className = "action";
    btn.type = "button";
    btn.setAttribute("data-testid", "quickstart-" + q.command);

    const label = document.createElement("span");
    label.className = "label";
    label.setAttribute("data-icon", q.icon);
    label.textContent = q.label;

    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = q.desc;

    btn.appendChild(label);
    btn.appendChild(desc);

    btn.addEventListener("click", () => {
      vscode.postMessage({ type: "runCommand", command: q.command });
      showToast("Sent: " + q.command);
    });

    grid.appendChild(btn);
  }
}

renderFeatures();
renderQuickstart();
