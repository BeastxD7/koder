// Webview-side script for the LakshX Database panel. Receives already-built
// Mermaid source + relationship metadata from extension.js via postMessage
// (the database drivers and every credential stay in the extension host —
// this script never sees a connection string). Loaded as an external
// <script src> file, not inline: this webview's CSP has no 'unsafe-inline'
// for script-src, only for style-src (mermaid injects a <style> tag inside
// its rendered SVG, which does need that) — see extension.js's panelHtml().
//
// The payload's `authoritative` flag is what separates the two visual
// languages this panel speaks: SQL engines (Postgres/MySQL/SQLite) send
// enforced foreign keys — solid edges, blue "FK" badges, matter-of-fact
// copy — while MongoDB sends sampled-and-guessed suggestions — dashed
// edges, amber badges, and copy that keeps saying "unverified".
(function () {
  const vscodeApi = acquireVsCodeApi();

  const el = {
    banner: document.getElementById("banner"),
    loading: document.getElementById("loading"),
    error: document.getElementById("error"),
    diagramWrap: document.getElementById("diagramWrap"),
    diagram: document.getElementById("diagram"),
    relPanel: document.getElementById("relPanel"),
    relTitle: document.getElementById("relTitle"),
    relHint: document.getElementById("relHint"),
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

  function bannerText(payload) {
    const shown = payload.collections.length;
    const total = shown + (payload.truncatedCollectionCount || 0);
    const shownPart = payload.truncatedCollectionCount > 0 ? `Showing ${shown} of ${total}` : `${shown}`;
    if (payload.authoritative) {
      return `Schema and foreign keys read live from ${payload.engineLabel}'s catalog — nothing here is sampled or guessed. ${shownPart} table(s) shown.`;
    }
    return (
      `Inferred from up to ${payload.sampleSize} sampled documents per collection — MongoDB has no enforced schema. ` +
      `${shownPart} collection(s) shown.`
    );
  }

  async function renderSchema(payload) {
    el.title.textContent = `${payload.engineLabel || "Database"}: ${payload.databaseName}`;
    el.banner.hidden = false;
    el.banner.classList.toggle("info", !!payload.authoritative); // neutral for facts, amber for inference
    el.banner.textContent = bannerText(payload);

    if (!mermaidReady) return;
    const seq = ++renderSeq;
    try {
      const { svg } = await window.mermaid.render("lakshxDbErd", payload.mermaidSource || "erDiagram");
      if (seq !== renderSeq) return; // a newer refresh landed while this one was rendering — drop the stale result
      el.diagram.innerHTML = svg;
      showOnly("diagramWrap");
    } catch (e) {
      showOnly("error");
      el.error.textContent = "Couldn't render the diagram: " + (e && e.message ? e.message : String(e));
      return;
    }

    renderRelationships(payload);
  }

  function renderRelationships(payload) {
    const relationships = payload.relationships || [];
    const authoritative = !!payload.authoritative;
    el.relTitle.textContent = authoritative ? "Foreign keys" : "Suggested relationships";
    el.relHint.textContent = authoritative
      ? "Read from the engine's constraint catalog — these are enforced foreign keys, not guesses."
      : "MongoDB has no enforced foreign keys. These are pattern-matched guesses over the sampled documents — verify before relying on them.";
    el.relList.innerHTML = "";
    el.relPanel.hidden = relationships.length === 0;
    for (const rel of relationships) {
      const li = document.createElement("li");
      li.className = authoritative ? "fk" : "suggested";
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = authoritative ? "FK" : rel.kind === "manualRef" ? "$ref" : "naming guess";
      const path = document.createElement("span");
      path.textContent = rel.toField
        ? `${rel.from}.${rel.fromField} → ${rel.to}.${rel.toField}`
        : `${rel.from}.${rel.fromField} → ${rel.to}`;
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
