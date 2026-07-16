// Webview-side script for the LakshX "Recommended & Verified" extensions
// panel. No frameworks — this list is small and changes rarely, so plain
// DOM building keeps the CSP simple (no unsafe-eval, no bundler).
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const listEl = document.getElementById("list");
  const recheckBtn = document.getElementById("recheck");

  function badgeHtml(trust) {
    const label = trust.label.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    return `<span class="badge ${trust.status}" title="${label}">${iconFor(trust.status)} ${shortLabel(trust.status)}</span>`;
  }

  function iconFor(status) {
    if (status === "pass") return "✓"; // check
    if (status === "fail") return "✗"; // cross
    return "⚠"; // warning
  }

  function shortLabel(status) {
    if (status === "pass") return "Verified on Open VSX";
    if (status === "fail") return "Not on Open VSX";
    if (status === "unchecked") return "Not yet checked";
    return "Couldn't check";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function render(categories) {
    listEl.innerHTML = "";
    for (const group of categories) {
      const section = document.createElement("div");
      section.className = "category";

      const h3 = document.createElement("h3");
      h3.textContent = group.category;
      section.appendChild(h3);

      for (const ext of group.extensions) {
        const row = document.createElement("div");
        row.className = "entry";
        row.innerHTML = `
          <div class="entry-main">
            <div class="entry-name-row">
              <span class="entry-name">${escapeHtml(ext.displayName)}</span>
              <span class="entry-id">${escapeHtml(ext.id)}</span>
              ${badgeHtml(ext.trust)}
            </div>
            <div class="entry-desc">${escapeHtml(ext.description)}</div>
            <div class="entry-reason">${escapeHtml(ext.reason)}</div>
          </div>
          <div class="entry-actions">
            <button class="install" data-id="${escapeHtml(ext.id)}" ${ext.trust.status === "fail" ? "disabled" : ""}>Install</button>
          </div>
        `;
        section.appendChild(row);
      }
      listEl.appendChild(section);
    }

    listEl.querySelectorAll("button.install").forEach((btn) => {
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "install", id: btn.dataset.id });
      });
    });
  }

  recheckBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "recheck" });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "model") {
      render(message.categories);
    }
  });

  vscode.postMessage({ type: "ready" });
})();
