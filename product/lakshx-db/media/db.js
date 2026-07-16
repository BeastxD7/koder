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
    aiQueries: document.getElementById("aiQueries"),
    // tabs + views
    tabSchema: document.getElementById("tabSchema"),
    tabData: document.getElementById("tabData"),
    schemaView: document.getElementById("schemaView"),
    dataView: document.getElementById("dataView"),
    // data view
    tableSelect: document.getElementById("tableSelect"),
    pagePrev: document.getElementById("pagePrev"),
    pageNext: document.getElementById("pageNext"),
    pageInfo: document.getElementById("pageInfo"),
    dataBanner: document.getElementById("dataBanner"),
    dataEmpty: document.getElementById("dataEmpty"),
    dataLoading: document.getElementById("dataLoading"),
    dataError: document.getElementById("dataError"),
    tableWrap: document.getElementById("tableWrap"),
    dataTable: document.getElementById("dataTable"),
  };

  // Data-view state. `collections` is populated from every schema payload so
  // the Data tab's dropdown always reflects the current connection. The rest
  // tracks the page currently displayed for client-side sorting + pagination.
  const state = {
    collections: [],
    isSql: true,
    currentTable: null,
    currentPage: 0,
    hasMore: false,
    columns: [],
    rows: [], // last-rendered page's rows (array of {kind,text} cell objects)
    sortCol: -1,
    sortDir: 1,
  };

  document.getElementById("refresh").addEventListener("click", () => {
    vscodeApi.postMessage({ type: "refresh" });
  });
  document.getElementById("changeConnection").addEventListener("click", () => {
    vscodeApi.postMessage({ type: "changeConnection" });
  });
  // "Allow AI queries" opt-in (design §6): the confirmation dialog and the
  // actual flag live in the extension host — this just requests the toggle
  // and reflects whatever state comes back.
  el.aiQueries.addEventListener("click", () => {
    vscodeApi.postMessage({ type: "toggleAiQueries" });
  });

  // ---- tabs: Schema <-> Data ------------------------------------------------
  function setTab(which) {
    const dataActive = which === "data";
    el.tabData.classList.toggle("active", dataActive);
    el.tabSchema.classList.toggle("active", !dataActive);
    el.tabData.setAttribute("aria-selected", String(dataActive));
    el.tabSchema.setAttribute("aria-selected", String(!dataActive));
    el.schemaView.hidden = dataActive;
    el.dataView.hidden = !dataActive;
  }
  el.tabSchema.addEventListener("click", () => setTab("schema"));
  el.tabData.addEventListener("click", () => setTab("data"));

  // ---- data view: table picker + pagination --------------------------------
  function populateTableSelect() {
    const prev = state.currentTable;
    el.tableSelect.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = state.collections.length ? "Select a table…" : "No tables available";
    el.tableSelect.appendChild(placeholder);
    for (const c of state.collections) {
      const opt = document.createElement("option");
      opt.value = c.name;
      opt.textContent = c.name;
      el.tableSelect.appendChild(opt);
    }
    // Keep the current selection if it still exists after a refresh.
    if (prev && state.collections.some((c) => c.name === prev)) {
      el.tableSelect.value = prev;
    } else {
      state.currentTable = null;
    }
  }

  function requestPage(table, page) {
    if (!table) return;
    state.currentTable = table;
    state.currentPage = Math.max(0, page | 0);
    showDataMsg("loading");
    vscodeApi.postMessage({ type: "loadTable", table, page: state.currentPage });
  }

  el.tableSelect.addEventListener("change", () => {
    const table = el.tableSelect.value;
    if (!table) {
      state.currentTable = null;
      showDataMsg("empty");
      updatePager();
      return;
    }
    requestPage(table, 0);
  });
  el.pagePrev.addEventListener("click", () => {
    if (state.currentTable && state.currentPage > 0) requestPage(state.currentTable, state.currentPage - 1);
  });
  el.pageNext.addEventListener("click", () => {
    if (state.currentTable && state.hasMore) requestPage(state.currentTable, state.currentPage + 1);
  });

  function updatePager() {
    const active = !!state.currentTable;
    el.pagePrev.disabled = !active || state.currentPage <= 0;
    el.pageNext.disabled = !active || !state.hasMore;
    if (!active) {
      el.pageInfo.textContent = "";
      return;
    }
    const start = state.currentPage * (state.pageSize || 50);
    const shown = state.rows.length;
    if (shown === 0) {
      el.pageInfo.textContent = `Page ${state.currentPage + 1} — no rows`;
    } else {
      el.pageInfo.textContent =
        `Rows ${start + 1}–${start + shown}` + (state.hasMore ? " (more)" : "");
    }
  }

  // Data-view single-visible-region switch (mirrors schema's showOnly).
  function showDataMsg(name) {
    el.dataEmpty.hidden = name !== "empty";
    el.dataLoading.hidden = name !== "loading";
    el.dataError.hidden = name !== "error";
    el.tableWrap.hidden = name !== "table";
  }

  function renderRows(msg) {
    state.currentTable = msg.table;
    state.currentPage = msg.page || 0;
    state.hasMore = !!msg.hasMore;
    state.pageSize = msg.pageSize || 50;
    state.columns = msg.columns || [];
    state.rows = msg.rows || [];
    state.sortCol = -1;
    state.sortDir = 1;
    el.dataBanner.hidden = true;

    if (el.tableSelect.value !== msg.table) el.tableSelect.value = msg.table;

    if (state.columns.length === 0 && state.rows.length === 0) {
      showDataMsg("error");
      el.dataError.textContent = "This table/collection has no columns to show on this page (it may be empty).";
      updatePager();
      return;
    }
    paintTable();
    showDataMsg("table");
    updatePager();
  }

  function paintTable() {
    const thead = el.dataTable.querySelector("thead");
    const tbody = el.dataTable.querySelector("tbody");
    thead.innerHTML = "";
    tbody.innerHTML = "";

    const headRow = document.createElement("tr");
    state.columns.forEach((col, i) => {
      const th = document.createElement("th");
      th.textContent = col;
      if (state.sortCol === i) {
        const arrow = document.createElement("span");
        arrow.className = "sortArrow";
        arrow.textContent = state.sortDir === 1 ? " ▲" : " ▼";
        th.appendChild(arrow);
      }
      th.title = "Click to sort this page by " + col;
      th.addEventListener("click", () => sortBy(i));
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    const order = sortedRowIndexes();
    for (const ri of order) {
      const row = state.rows[ri];
      const tr = document.createElement("tr");
      for (const cell of row) {
        tr.appendChild(renderCell(cell));
      }
      tbody.appendChild(tr);
    }
  }

  // Client-side sort of the CURRENT page only (the row set already in the
  // webview) — a lightweight "sortable-ish" affordance, not a server re-query.
  function sortedRowIndexes() {
    const idx = state.rows.map((_, i) => i);
    if (state.sortCol < 0) return idx;
    const col = state.sortCol;
    idx.sort((a, b) => {
      const ca = state.rows[a][col];
      const cb = state.rows[b][col];
      return compareCells(ca, cb) * state.sortDir;
    });
    return idx;
  }

  function compareCells(a, b) {
    if (!a) return -1;
    if (!b) return 1;
    // NULLs sort last on ascending.
    if (a.kind === "null" && b.kind === "null") return 0;
    if (a.kind === "null") return 1;
    if (b.kind === "null") return -1;
    if (a.kind === "number" && b.kind === "number") {
      return Number(a.text) - Number(b.text);
    }
    return String(a.text).localeCompare(String(b.text), undefined, { numeric: true });
  }

  function sortBy(col) {
    if (state.sortCol === col) {
      state.sortDir = -state.sortDir;
    } else {
      state.sortCol = col;
      state.sortDir = 1;
    }
    paintTable();
  }

  const PREVIEW_LEN = 200;
  function renderCell(cell) {
    const td = document.createElement("td");
    const kind = (cell && cell.kind) || "string";
    td.className = "cell-" + kind;
    const text = cell ? cell.text : "";
    if (text.length > PREVIEW_LEN) {
      const span = document.createElement("span");
      span.className = "cellText";
      span.textContent = text.slice(0, PREVIEW_LEN);
      const more = document.createElement("button");
      more.className = "cellMore";
      more.textContent = "…more";
      let expanded = false;
      more.addEventListener("click", () => {
        expanded = !expanded;
        span.textContent = expanded ? text : text.slice(0, PREVIEW_LEN);
        more.textContent = expanded ? "less" : "…more";
      });
      td.append(span, more);
    } else {
      td.textContent = text;
    }
    return td;
  }

  function showDataError(message) {
    showDataMsg("error");
    el.dataError.textContent = message || "Couldn't load rows.";
    updatePager();
  }

  function renderAiQueries(enabled) {
    el.aiQueries.classList.toggle("on", !!enabled);
    el.aiQueries.textContent = enabled ? "AI queries: On" : "Allow AI queries";
    el.aiQueries.title = enabled
      ? "The AI assistant may run read-only queries against this connection. Click to disable."
      : "Let the AI assistant run read-only queries against this connection";
  }

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
    // Feed the Data tab's picker from the SAME introspection payload — no extra
    // round trip. `collections` covers both SQL tables and Mongo collections.
    state.collections = Array.isArray(payload.collections) ? payload.collections : [];
    state.isSql = !!payload.authoritative;
    el.tabData.disabled = state.collections.length === 0;
    populateTableSelect();
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
      case "aiQueries":
        renderAiQueries(msg.enabled);
        break;
      case "rowsLoading":
        // Only reflect loading for the table the user is currently on.
        if (msg.table === state.currentTable) showDataMsg("loading");
        break;
      case "rows":
        renderRows(msg);
        break;
      case "rowsError":
        if (msg.table === state.currentTable) showDataError(msg.message);
        break;
    }
  });

  vscodeApi.postMessage({ type: "refresh" }); // kick off the first load
  vscodeApi.postMessage({ type: "getAiQueries" }); // reflect the current opt-in state in the toolbar
})();
