// Webview-side script for the LakshX Database panel. Receives already-built
// Mermaid source + relationship metadata from extension.js via postMessage
// (the mongodb driver and every credential stay in the extension host —
// this script never sees a connection string). Loaded as an external
// <script src> file, not inline: this webview's CSP has no 'unsafe-inline'
// for script-src, only for style-src (mermaid injects a <style> tag inside
// its rendered SVG, which does need that) — see extension.js's panelHtml().
(function () {
  const vscodeApi = acquireVsCodeApi();

  const el = {
    banner: document.getElementById("banner"),
    loading: document.getElementById("loading"),
    error: document.getElementById("error"),
    diagramWrap: document.getElementById("diagramWrap"),
    diagram: document.getElementById("diagram"),
    relPanel: document.getElementById("relPanel"),
    relList: document.getElementById("relList"),
    title: document.getElementById("title"),
  };

  document.getElementById("refresh").addEventListener("click", () => {
    vscodeApi.postMessage({ type: "refresh" });
  });
  document.getElementById("changeConnection").addEventListener("click", () => {
    vscodeApi.postMessage({ type: "changeConnection" });
  });

  function showOnly(name) {
    for (const key of ["loading", "error", "diagramWrap", "relPanel"]) {
      el[key].hidden = key !== name;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let mermaidReady = false;
  try {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict", // no click/tooltip callbacks eval'd from diagram text — this diagram is built from live DB content
      theme: "dark",
      er: { useMaxWidth: false },
    });
    mermaidReady = true;
  } catch (e) {
    showOnly("error");
    el.error.textContent = "Diagram renderer failed to initialize: " + (e && e.message ? e.message : String(e));
  }

  let renderSeq = 0;

  async function renderSchema(payload) {
    el.title.textContent = `MongoDB: ${payload.databaseName}`;
    el.banner.hidden = false;
    el.banner.textContent =
      `Inferred from up to ${payload.sampleSize} sampled documents per collection — MongoDB has no enforced schema. ` +
      (payload.truncatedCollectionCount > 0
        ? `Showing ${payload.collections.length} of ${payload.collections.length + payload.truncatedCollectionCount} collections.`
        : `${payload.collections.length} collection(s) shown.`);

    if (!mermaidReady) return;
    const seq = ++renderSeq;
    try {
      const { svg } = await window.mermaid.render("lakshxMongoErd", payload.mermaidSource || "erDiagram");
      if (seq !== renderSeq) return; // a newer refresh landed while this one was rendering — drop the stale result
      el.diagram.innerHTML = svg;
      showOnly("diagramWrap");
    } catch (e) {
      showOnly("error");
      el.error.textContent = "Couldn't render the diagram: " + (e && e.message ? e.message : String(e));
      return;
    }

    renderRelationships(payload.relationships || []);
  }

  function renderRelationships(relationships) {
    el.relList.innerHTML = "";
    el.relPanel.hidden = relationships.length === 0;
    for (const rel of relationships) {
      const li = document.createElement("li");
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = rel.kind === "manualRef" ? "$ref" : "naming guess";
      const path = document.createElement("span");
      path.textContent = `${rel.from}.${rel.fromField} → ${rel.to}`;
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = rel.note;
      li.append(badge, path, note);
      el.relList.appendChild(li);
    }
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "loading":
        showOnly("loading");
        el.banner.hidden = true;
        break;
      case "schema":
        renderSchema(msg);
        break;
      case "error":
        showOnly("error");
        el.banner.hidden = true; // don't leave a stale "N collections shown" banner sitting above an error from a failed refresh
        el.error.textContent = msg.message || "Unknown error.";
        break;
    }
  });

  vscodeApi.postMessage({ type: "refresh" }); // kick off the first load
})();
