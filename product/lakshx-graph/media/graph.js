// LakshX Graph — canvas renderer.
//
// This file is loaded unmodified both by the real webview (extension.js's
// panelHtml()) AND by the standalone test harness under
// product/lakshx-graph/test/harness — see the bootstrap IIFE at the bottom.
// `acquireVsCodeApi` only exists in the former; the harness instead feeds it
// fake `depInit`/tour data directly, exercising the exact same rendering and
// interaction code as production.
//
// (This used to also render a "call" mode — a layered-tree view of a
// function-level call hierarchy seeded from the cursor. It was removed along
// with the rest of the Call Graph feature; see extension.js's header. What
// remains is the force-directed dependency-graph renderer, reused verbatim by
// Guided Tour mode — see the comment above `depTour` below.)
"use strict";

function createGraphApp(canvas, opts) {
  const ctx = canvas.getContext("2d");
  const emptyEl = opts.emptyEl;

  let transport = { openPath() {}, requestScan() {} };

  // ---- dependency-graph mode ----
  let mode = "dep"; // "dep" | "tour"
  let depRaw = null; // { nodes, edges, cycles, stats, tour } straight from the host
  let depNodes = new Map(); // id -> { ...node, x, y, vx, vy, r } (view set, post-filter)
  let depEdges = []; // { from, to, kind } (view set)
  let depFocus = null; // focused node id (highlight neighborhood) — click-to-focus, dep mode
  let depFilter = ""; // search text (lowercased)
  let depHideExternal = false;
  let depCollapseExternal = false;
  let depHover = null; // hovered box (for tooltip)
  const tooltipEl = opts.tooltipEl || null;
  const statsEl = opts.statsEl || null;
  const hintEl = opts.hintEl || null;

  // ---- Guided Tour mode ----
  // Reuses depNodes/depEdges/renderDep() verbatim for the canvas — the tour
  // just drives WHICH node(s) are highlighted (tourFocusIds, a superset of
  // depFocus that can span every member of a collapsed cyclic cluster) and
  // renders a step panel alongside it. No second rendering system.
  let depTour = null; // { stops, tiers } from lib/tour.js, via the host
  let tourIndex = -1; // index into depTour.stops
  let tourFocusIds = null; // Set<nodeId> — the current stop's member(s)
  let pendingTourJumpPath = null; // a jumpToPath request that arrived before tour data did
  const tourPanelEl = opts.tourPanelEl || null;
  const tourTierEl = opts.tourTierEl || null;
  const tourCounterEl = opts.tourCounterEl || null;
  const tourTitleEl = opts.tourTitleEl || null;
  const tourBlurbEl = opts.tourBlurbEl || null;
  const tourPrevEl = opts.tourPrevEl || null;
  const tourNextEl = opts.tourNextEl || null;
  const tourJumpEl = opts.tourJumpEl || null;

  let scale = 1;
  let panX = 0;
  let panY = 0;
  let dragging = false;
  let dragMoved = false;
  let dragStart = { x: 0, y: 0, panX: 0, panY: 0 };
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  function resize() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    draw();
  }

  // Tour mode reuses the exact dep-mode renderer, so both modes draw the same way.
  function draw() {
    renderDep();
  }

  function resetView() {
    fitDep();
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - panX) / scale, y: (sy - panY) / scale };
  }

  function cssVar(name, fallback) {
    return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
  }

  function truncateText(ctx2, text, maxW) {
    if (ctx2.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx2.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    return t + "…";
  }

  // ---------- interaction ----------
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const factor = Math.exp(-ev.deltaY * 0.001);
    const newScale = Math.min(2.5, Math.max(0.25, scale * factor));
    const ratio = newScale / scale;
    panX = mx - (mx - panX) * ratio;
    panY = my - (my - panY) * ratio;
    scale = newScale;
    draw();
  }, { passive: false });

  canvas.addEventListener("mousedown", (ev) => {
    dragging = true;
    dragMoved = false;
    dragStart = { x: ev.clientX, y: ev.clientY, panX, panY };
    canvas.classList.add("dragging");
  });
  window.addEventListener("mousemove", (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - dragStart.x;
    const dy = ev.clientY - dragStart.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
    panX = dragStart.panX + dx;
    panY = dragStart.panY + dy;
    draw();
  });
  window.addEventListener("mouseup", (ev) => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove("dragging");
    if (!dragMoved) handleClick(ev);
  });

  function handleClick(ev) {
    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
    if (mode === "tour") {
      handleTourClick(world);
      return;
    }
    handleDepClick(world);
  }

  // hover → tooltip (dep/tour modes only; call-mode has no tooltip element)
  canvas.addEventListener("mousemove", (ev) => {
    if ((mode !== "dep" && mode !== "tour") || dragging || !tooltipEl) return;
    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top);
    const hit = hitTestDep(world.x, world.y);
    if (hit) {
      depHover = hit.id;
      showTooltip(hit, ev.clientX - rect.left, ev.clientY - rect.top);
    } else {
      depHover = null;
      hideTooltip();
    }
  });
  canvas.addEventListener("mouseleave", () => {
    depHover = null;
    hideTooltip();
  });

  function showTooltip(node, sx, sy) {
    const kind = node.type === "external" ? "external package" : "file";
    const cyc = node.inCycle ? '<span class="tt-cycle">● in circular dependency</span>' : "";
    tooltipEl.innerHTML =
      `<div class="tt-title">${escapeHtml(node.label)}</div>` +
      `<div class="tt-path">${escapeHtml(node.path)}</div>` +
      `<div class="tt-meta">${kind} · in ${node.fanIn} · out ${node.fanOut}</div>` +
      cyc;
    tooltipEl.style.left = sx + 14 + "px";
    tooltipEl.style.top = sy + 14 + "px";
    tooltipEl.hidden = false;
  }
  function hideTooltip() {
    if (tooltipEl) tooltipEl.hidden = true;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  new ResizeObserver(resize).observe(canvas);

  // =========================================================================
  // DEPENDENCY-GRAPH MODE (force-directed) — fully parallel to call-mode above.
  // =========================================================================
  const DEP = {
    MAX_SIM_NODES: 400, // beyond this we skip the O(n^2) sim, use circular layout
    ITER: 320, // fixed pre-settle iterations (deterministic → stable screenshots)
    C: 0.9, // ideal-distance scale for Fruchterman-Reingold
    NODE_MIN_R: 7,
    NODE_MAX_R: 22,
  };

  // Build the *view* set from the raw host payload + current toggles/filter.
  // Filtering, hide-external and collapse-external are pure view concerns, so
  // they live here and never mutate depRaw.
  function buildDepView() {
    depNodes = new Map();
    depEdges = [];
    if (!depRaw) return;

    const cyclic = new Set();
    for (const c of depRaw.cycles || []) for (const id of c) cyclic.add(id);

    // decide which raw nodes are visible
    const visible = new Set();
    for (const n of depRaw.nodes) {
      if (depHideExternal && n.type === "external") continue;
      visible.add(n.id);
    }

    // collapse-external: fold every external node into one aggregate sink
    const AGG = "ext:__aggregate__";
    const useAgg = depCollapseExternal && !depHideExternal;
    const remap = (id) => {
      if (!useAgg) return id;
      const n = rawNodeById.get(id);
      return n && n.type === "external" ? AGG : id;
    };

    for (const n of depRaw.nodes) {
      if (!visible.has(n.id)) continue;
      if (useAgg && n.type === "external") continue; // replaced by aggregate
      depNodes.set(n.id, mkDepNode(n, cyclic.has(n.id)));
    }
    if (useAgg) {
      const extCount = depRaw.nodes.filter((n) => n.type === "external").length;
      if (extCount > 0) {
        depNodes.set(AGG, mkDepNode({ id: AGG, label: `${extCount} packages`, path: `${extCount} external packages`, type: "external", fanIn: 0, fanOut: 0 }, false));
      }
    }

    const seen = new Set();
    for (const e of depRaw.edges) {
      const from = remap(e.from);
      const to = remap(e.to);
      if (from === to) continue;
      if (!depNodes.has(from) || !depNodes.has(to)) continue;
      const key = from + " " + to;
      if (seen.has(key)) continue;
      seen.add(key);
      depEdges.push({ from, to, kind: e.kind });
    }

    // recompute degree-derived radius on the *view* (aggregate needs its own)
    const deg = new Map();
    for (const id of depNodes.keys()) deg.set(id, 0);
    for (const e of depEdges) {
      deg.set(e.from, (deg.get(e.from) || 0) + 1);
      deg.set(e.to, (deg.get(e.to) || 0) + 1);
    }
    let maxDeg = 1;
    for (const d of deg.values()) maxDeg = Math.max(maxDeg, d);
    for (const [id, node] of depNodes) {
      const d = deg.get(id) || 0;
      node.r = DEP.NODE_MIN_R + (DEP.NODE_MAX_R - DEP.NODE_MIN_R) * Math.sqrt(d / maxDeg);
      node.degree = d;
    }
  }

  let rawNodeById = new Map();
  function mkDepNode(n, inCycle) {
    return { ...n, inCycle, x: 0, y: 0, vx: 0, vy: 0, r: DEP.NODE_MIN_R };
  }

  function simulateDep() {
    const nodes = [...depNodes.values()];
    const n = nodes.length;
    if (n === 0) return;

    // deterministic seeded init on a spiral so runs are reproducible
    for (let i = 0; i < n; i++) {
      const a = i * 2.399963; // golden angle
      const rad = 30 + 14 * Math.sqrt(i);
      nodes[i].x = Math.cos(a) * rad;
      nodes[i].y = Math.sin(a) * rad;
      nodes[i].vx = 0;
      nodes[i].vy = 0;
    }

    if (n > DEP.MAX_SIM_NODES) {
      // too big for O(n^2) — leave the spiral (already non-overlapping & readable)
      return;
    }

    const area = Math.max(1, n) * 12000;
    const k = DEP.C * Math.sqrt(area / Math.max(1, n));
    let temp = Math.sqrt(area) / 8;
    const cool = temp / (DEP.ITER + 1);
    const idx = new Map(nodes.map((nd, i) => [nd.id, i]));

    for (let it = 0; it < DEP.ITER; it++) {
      const dispx = new Float64Array(n);
      const dispy = new Float64Array(n);
      // repulsion (all pairs)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          let dx = nodes[i].x - nodes[j].x;
          let dy = nodes[i].y - nodes[j].y;
          let dist = Math.hypot(dx, dy) || 0.01;
          if (dist > k * 6) continue; // ignore far pairs — cheap cutoff
          const f = (k * k) / dist;
          const ux = dx / dist;
          const uy = dy / dist;
          dispx[i] += ux * f; dispy[i] += uy * f;
          dispx[j] -= ux * f; dispy[j] -= uy * f;
        }
      }
      // attraction along edges
      for (const e of depEdges) {
        const a = idx.get(e.from);
        const b = idx.get(e.to);
        if (a === undefined || b === undefined) continue;
        let dx = nodes[a].x - nodes[b].x;
        let dy = nodes[a].y - nodes[b].y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const f = (dist * dist) / k;
        const ux = dx / dist;
        const uy = dy / dist;
        dispx[a] -= ux * f; dispy[a] -= uy * f;
        dispx[b] += ux * f; dispy[b] += uy * f;
      }
      // apply, capped by temperature, plus mild gravity toward origin
      for (let i = 0; i < n; i++) {
        let dx = dispx[i] - nodes[i].x * 0.012;
        let dy = dispy[i] - nodes[i].y * 0.012;
        const d = Math.hypot(dx, dy) || 0.01;
        const lim = Math.min(d, temp);
        nodes[i].x += (dx / d) * lim;
        nodes[i].y += (dy / d) * lim;
      }
      temp = Math.max(0, temp - cool);
    }
  }

  function fitDep() {
    const nodes = [...depNodes.values()];
    if (nodes.length === 0) {
      scale = 1;
      const rect = canvas.getBoundingClientRect();
      panX = rect.width / 2;
      panY = rect.height / 2;
      renderDep();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const nd of nodes) {
      minX = Math.min(minX, nd.x - nd.r);
      minY = Math.min(minY, nd.y - nd.r);
      maxX = Math.max(maxX, nd.x + nd.r);
      maxY = Math.max(maxY, nd.y + nd.r);
    }
    const rect = canvas.getBoundingClientRect();
    const pad = 60;
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    scale = Math.min(2.2, Math.max(0.12, Math.min((rect.width - pad) / w, (rect.height - pad) / h)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    panX = rect.width / 2 - cx * scale;
    panY = rect.height / 2 - cy * scale;
    renderDep();
  }

  // Which node ids are "active" (fully lit): in tour mode, the current stop's
  // member(s) — a cyclic cluster stop lights every one of its files, not just
  // one. Otherwise: the search match set if searching, else the focused node
  // + its direct neighbors, else everything.
  function depActiveSet() {
    if (mode === "tour") return tourFocusIds; // null until a stop is loaded — null means "everything active"
    if (depFilter) {
      const s = new Set();
      for (const nd of depNodes.values()) {
        if (nd.label.toLowerCase().includes(depFilter) || nd.path.toLowerCase().includes(depFilter)) s.add(nd.id);
      }
      return s;
    }
    if (depFocus && depNodes.has(depFocus)) {
      const s = new Set([depFocus]);
      for (const e of depEdges) {
        if (e.from === depFocus) s.add(e.to);
        if (e.to === depFocus) s.add(e.from);
      }
      return s;
    }
    return null; // null = everything active
  }

  function renderDep() {
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    const active = depActiveSet();
    const isActive = (id) => active === null || active.has(id);

    const cycleColor = cssVar("--cycle", "#ff5c7c");
    const extColor = cssVar("--external", "#5cd6a8");
    const intColor = cssVar("--accent", "#7c5cff");

    // edges under nodes
    for (const e of depEdges) {
      const a = depNodes.get(e.from);
      const b = depNodes.get(e.to);
      if (!a || !b) continue;
      const bothActive = isActive(e.from) && isActive(e.to);
      const cyclic = a.inCycle && b.inCycle && edgeInCycle(e);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = cyclic ? cycleColor : cssVar("--edge", "rgba(255,255,255,0.16)");
      ctx.globalAlpha = bothActive ? (cyclic ? 0.85 : 0.5) : 0.08;
      ctx.lineWidth = (cyclic ? 1.8 : 1) / 1;
      ctx.stroke();
      // arrowhead
      if (bothActive) {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const hx = b.x - Math.cos(ang) * (b.r + 2);
        const hy = b.y - Math.sin(ang) * (b.r + 2);
        const ah = 5;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - Math.cos(ang - 0.4) * ah, hy - Math.sin(ang - 0.4) * ah);
        ctx.lineTo(hx - Math.cos(ang + 0.4) * ah, hy - Math.sin(ang + 0.4) * ah);
        ctx.closePath();
        ctx.fillStyle = cyclic ? cycleColor : cssVar("--edge", "rgba(255,255,255,0.16)");
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // nodes
    for (const nd of depNodes.values()) {
      const act = isActive(nd.id);
      ctx.globalAlpha = act ? 1 : 0.18;
      const fill = nd.inCycle ? cycleColor : nd.type === "external" ? extColor : intColor;
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      if (nd.id === depFocus || (mode === "tour" && tourFocusIds && tourFocusIds.has(nd.id))) {
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
      } else if (nd.id === depHover) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.stroke();
      }
      // label (only when zoomed in enough or node is prominent, to avoid clutter)
      if (act && (scale > 0.55 || nd.r > 14 || nd.id === depFocus)) {
        ctx.globalAlpha = act ? 0.92 : 0.15;
        ctx.fillStyle = cssVar("--fg", "#c8cede");
        ctx.font = "600 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(truncateText(ctx, nd.label, 130), nd.x, nd.y + nd.r + 3);
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function edgeInCycle(e) {
    for (const c of depRaw?.cycles || []) {
      const s = new Set(c);
      if (s.has(e.from) && s.has(e.to)) return true;
    }
    return false;
  }

  function hitTestDep(worldX, worldY) {
    let best = null;
    let bestD = Infinity;
    for (const nd of depNodes.values()) {
      const d = Math.hypot(worldX - nd.x, worldY - nd.y);
      if (d <= nd.r + 3 && d < bestD) {
        bestD = d;
        best = nd;
      }
    }
    return best;
  }

  function handleDepClick(world) {
    const hit = hitTestDep(world.x, world.y);
    if (!hit) {
      depFocus = null;
      renderDep();
      return;
    }
    if (depFocus === hit.id) {
      // second click on the already-focused node → open it (internal only)
      if (hit.type === "internal") transport.openPath(hit.path);
    } else {
      depFocus = hit.id;
    }
    renderDep();
  }

  // Clicking a node while touring jumps the tour to whichever stop that node
  // belongs to (a natural way to "ask the tour about this node" without a
  // separate lookup UI) — it never clears the tour position the way an
  // empty-space click does in plain dep-mode.
  function handleTourClick(world) {
    if (!depTour) return;
    const hit = hitTestDep(world.x, world.y);
    if (!hit) return;
    const idx = depTour.stops.findIndex((s) => s.members.includes(hit.id));
    if (idx >= 0) tourGoTo(idx);
  }

  function updateDepStats() {
    if (!statsEl) return;
    if (!depRaw) {
      statsEl.textContent = "";
      return;
    }
    const s = depRaw.stats || {};
    statsEl.textContent = `${s.internalNodes ?? 0} files · ${s.externalNodes ?? 0} packages · ${s.edgeCount ?? 0} imports · ${s.cycleCount ?? 0} cycles · ${s.orphanCount ?? 0} orphans`;
  }

  // ---------- public API ----------
  function showError(message) {
    if (emptyEl) {
      emptyEl.textContent = message;
      emptyEl.hidden = false;
    }
    console.error("LakshX Graph:", message);
  }

  function setTransport(t) {
    transport = { ...transport, ...t };
  }

  // ---------- dep-mode public methods ----------
  function loadDependencyGraph(payload) {
    // Preserve tour mode if that's how we got here (e.g. a scan triggered by
    // switching to the Guided Tour tab, or by "Explain this file"); otherwise
    // this is the normal Dependencies-tab scan entry.
    mode = mode === "tour" ? "tour" : "dep";
    depRaw = payload || { nodes: [], edges: [], cycles: [], stats: {} };
    rawNodeById = new Map((depRaw.nodes || []).map((n) => [n.id, n]));
    depFocus = null;
    depHover = null;
    buildDepView();
    simulateDep();
    if (hintEl) hintEl.hidden = depNodes.size > 0;
    updateDepStats();
    // The host computes the tour alongside the dependency scan (same data,
    // just reordered/tiered — see lib/tour.js) and ships it in the same
    // payload, so one scan feeds both modes.
    loadTour(payload && payload.tour);
    fitDep();
  }

  function setMode(next) {
    if (next !== "dep" && next !== "tour") return;
    mode = next;
    if (emptyEl) emptyEl.hidden = true;
    if (hintEl) hintEl.hidden = !!(depRaw && depNodes.size > 0);
    updateDepStats();
    if (depRaw && depNodes.size > 0) fitDep();
    else { const rect = canvas.getBoundingClientRect(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height); }
    if (mode === "tour") {
      renderTourPanel();
      applyTourFocus();
    }
  }

  function getMode() { return mode; }

  // ---------- Guided Tour public methods ----------
  // `tour` is { stops, tiers } from lib/tour.js, arriving as part of the same
  // depInit payload as the dependency scan (see loadDependencyGraph above).
  function loadTour(tour) {
    depTour = tour && tour.stops ? tour : { stops: [], tiers: [] };
    tourIndex = depTour.stops.length ? 0 : -1;
    if (pendingTourJumpPath) {
      const path = pendingTourJumpPath;
      pendingTourJumpPath = null;
      const idx = depTour.stops.findIndex((s) => s.members.includes(path) || s.path === path);
      if (idx >= 0) tourIndex = idx;
    }
    renderTourPanel();
    if (mode === "tour") applyTourFocus();
  }

  function tourGoTo(i) {
    if (!depTour || i < 0 || i >= depTour.stops.length) return;
    tourIndex = i;
    renderTourPanel();
    applyTourFocus();
  }
  function tourNext() { tourGoTo(tourIndex + 1); }
  function tourPrev() { tourGoTo(tourIndex - 1); }

  /** Open the current stop's representative file in the editor (host round-trip). */
  function tourJumpToFile() {
    if (!depTour || tourIndex < 0) return;
    const stop = depTour.stops[tourIndex];
    if (stop) transport.openPath(stop.path);
  }

  /** Jump the tour straight to whichever stop a given file path belongs to —
   * used by "Explain this file" -> "Show in Guided Tour". If tour data
   * hasn't arrived yet, the request is buffered (see loadTour above). */
  function tourJumpToPath(filePath) {
    if (!depTour || depTour.stops.length === 0) {
      pendingTourJumpPath = filePath;
      return;
    }
    const idx = depTour.stops.findIndex((s) => s.members.includes(filePath) || s.path === filePath);
    if (idx >= 0) tourGoTo(idx);
  }

  /** Highlight the current stop's member node(s) and center the view on them
   * (reuses fitDep's canvas, just pans instead of re-fitting zoom so the
   * user keeps their bearings stop-to-stop). */
  function applyTourFocus() {
    if (mode !== "tour" || !depTour || tourIndex < 0 || !depTour.stops[tourIndex]) {
      tourFocusIds = null;
      renderDep();
      return;
    }
    const stop = depTour.stops[tourIndex];
    tourFocusIds = new Set(stop.members);
    const pts = stop.members.map((id) => depNodes.get(id)).filter(Boolean);
    if (pts.length) {
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const rect = canvas.getBoundingClientRect();
      panX = rect.width / 2 - cx * scale;
      panY = rect.height / 2 - cy * scale;
    }
    renderDep();
  }

  /** Sync the step-panel DOM (tier/counter/title/blurb/nav button states)
   * to the current stop. All text is accurate metric-derived data from
   * lib/tour.js — nothing fabricated here. */
  function renderTourPanel() {
    if (!tourTierEl && !tourCounterEl && !tourTitleEl && !tourBlurbEl) return; // no tour DOM wired
    const stops = (depTour && depTour.stops) || [];
    if (stops.length === 0 || tourIndex < 0) {
      if (tourTierEl) tourTierEl.textContent = "";
      if (tourCounterEl) tourCounterEl.textContent = "";
      if (tourTitleEl) {
        // Distinguish "hasn't scanned yet" (depRaw not populated — switching
        // to this tab already auto-triggers a scan, see __needsScan below;
        // this is just the brief in-flight window) from "scanned and there's
        // genuinely nothing to walk through" (e.g. no scannable source files
        // in this workspace) — a bare "No tour data yet." explained neither,
        // a real reported point of confusion ("I don't know how to use it").
        tourTitleEl.textContent = depRaw
          ? "Nothing to walk through — this workspace has no scannable source files for a Guided Tour."
          : "Scanning your workspace for a Guided Tour (same scan as Dependencies) — one moment…";
      }
      if (tourBlurbEl) {
        tourBlurbEl.textContent = depRaw
          ? ""
          : "A Guided Tour orders every file/package by role — entry points first, shared utilities and persistence last — with a one-line blurb per stop, so you can walk an unfamiliar codebase top-down instead of guessing where to start.";
      }
      if (tourPrevEl) tourPrevEl.disabled = true;
      if (tourNextEl) tourNextEl.disabled = true;
      if (tourJumpEl) tourJumpEl.disabled = true;
      return;
    }
    const stop = stops[tourIndex];
    if (tourTierEl) tourTierEl.textContent = stop.tier;
    if (tourCounterEl) tourCounterEl.textContent = `Stop ${tourIndex + 1} of ${stops.length}`;
    if (tourTitleEl) tourTitleEl.textContent = stop.kind === "cycle" ? `${stop.label}: ${stop.members.join(", ")}` : stop.path;
    if (tourBlurbEl) tourBlurbEl.textContent = stop.blurb;
    if (tourPrevEl) tourPrevEl.disabled = tourIndex <= 0;
    if (tourNextEl) tourNextEl.disabled = tourIndex >= stops.length - 1;
    if (tourJumpEl) tourJumpEl.disabled = false;
  }

  function setDepFilter(text) {
    depFilter = String(text || "").trim().toLowerCase();
    if (mode === "dep") renderDep();
  }

  function setDepHideExternal(v) {
    depHideExternal = !!v;
    rebuildDep();
  }
  function setDepCollapseExternal(v) {
    depCollapseExternal = !!v;
    rebuildDep();
  }
  function rebuildDep() {
    if (!depRaw) return;
    depFocus = null;
    buildDepView();
    simulateDep();
    if (hintEl) hintEl.hidden = depNodes.size > 0;
    fitDep();
  }
  // jump the view to the first search match (used by Enter in the search box)
  function focusFirstMatch() {
    if (!depFilter) return;
    for (const nd of depNodes.values()) {
      if (nd.label.toLowerCase().includes(depFilter) || nd.path.toLowerCase().includes(depFilter)) {
        depFocus = nd.id;
        const rect = canvas.getBoundingClientRect();
        panX = rect.width / 2 - nd.x * scale;
        panY = rect.height / 2 - nd.y * scale;
        renderDep();
        return;
      }
    }
  }

  return {
    showError, setTransport, resetView, resize,
    zoomBy: (f) => { scale = Math.min(2.5, Math.max(0.12, scale * f)); draw(); },
    render: draw,
    // dep-mode surface
    loadDependencyGraph, setMode, getMode, setDepFilter, setDepHideExternal, setDepCollapseExternal, focusFirstMatch,
    // Guided Tour surface
    loadTour, tourGoTo, tourNext, tourPrev, tourJumpToFile, tourJumpToPath,
  };
}

// ---------- bootstrap ----------
(function bootstrap() {
  const canvas = document.getElementById("canvas");
  if (!canvas) return; // not in a page that has this markup (defensive, shouldn't happen)

  const app = createGraphApp(canvas, {
    emptyEl: document.getElementById("empty"),
    tooltipEl: document.getElementById("tooltip"),
    statsEl: document.getElementById("stats"),
    hintEl: document.getElementById("depHint"),
    tourPanelEl: document.getElementById("tourPanel"),
    tourTierEl: document.getElementById("tourTier"),
    tourCounterEl: document.getElementById("tourCounter"),
    tourTitleEl: document.getElementById("tourTitle"),
    tourBlurbEl: document.getElementById("tourBlurb"),
    tourPrevEl: document.getElementById("tourPrev"),
    tourNextEl: document.getElementById("tourNext"),
    tourJumpEl: document.getElementById("tourJump"),
  });
  window.__lakshxGraphApp = app;

  document.getElementById("zoomIn")?.addEventListener("click", () => app.zoomBy(1.2));
  document.getElementById("zoomOut")?.addEventListener("click", () => app.zoomBy(1 / 1.2));
  document.getElementById("zoomReset")?.addEventListener("click", () => app.resetView());

  // ---- mode toggle (segmented control) ----
  const modeDep = document.getElementById("modeDep");
  const modeTour = document.getElementById("modeTour");
  const depControls = document.getElementById("depControls");
  const tourPanel = document.getElementById("tourPanel");
  function reflectMode(m) {
    modeDep?.classList.toggle("active", m === "dep");
    modeTour?.classList.toggle("active", m === "tour");
    // search/hide-externals/collapse/re-scan controls only make sense for the
    // free-exploration dependency view, not the guided step-through.
    if (depControls) depControls.hidden = m !== "dep";
    if (tourPanel) tourPanel.hidden = m !== "tour";
  }
  modeDep?.addEventListener("click", () => {
    app.setMode("dep");
    reflectMode("dep");
    if (app.__needsScan) { app.__needsScan(); }
  });
  modeTour?.addEventListener("click", () => {
    app.setMode("tour");
    reflectMode("tour");
    if (app.__needsScan) { app.__needsScan(); }
  });

  // ---- dep controls ----
  const search = document.getElementById("depSearch");
  search?.addEventListener("input", () => app.setDepFilter(search.value));
  search?.addEventListener("keydown", (e) => { if (e.key === "Enter") app.focusFirstMatch(); });
  const hideExt = document.getElementById("depHideExt");
  hideExt?.addEventListener("change", () => app.setDepHideExternal(hideExt.checked));
  const collapseExt = document.getElementById("depCollapseExt");
  collapseExt?.addEventListener("change", () => app.setDepCollapseExternal(collapseExt.checked));

  // ---- Guided Tour controls ----
  document.getElementById("tourPrev")?.addEventListener("click", () => app.tourPrev());
  document.getElementById("tourNext")?.addEventListener("click", () => app.tourNext());
  document.getElementById("tourJump")?.addEventListener("click", () => app.tourJumpToFile());

  const hasVsCodeApi = typeof acquireVsCodeApi === "function";
  if (hasVsCodeApi) {
    const vscode = acquireVsCodeApi();
    let scanned = false;
    app.setTransport({
      openPath: (p) => vscode.postMessage({ type: "openPath", path: p }),
      requestScan: () => vscode.postMessage({ type: "scanDependencies" }),
    });
    // when the user first switches to dep/tour mode with no data, ask the
    // host to scan (both modes are fed by the exact same scan+tour payload)
    app.__needsScan = () => { if (!scanned) { scanned = true; vscode.postMessage({ type: "scanDependencies" }); } };
    const rescan = document.getElementById("depRescan");
    rescan?.addEventListener("click", () => { scanned = true; vscode.postMessage({ type: "scanDependencies" }); });
    document.getElementById("depScanBtn")?.addEventListener("click", () => { scanned = true; vscode.postMessage({ type: "scanDependencies" }); });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "depInit") {
        scanned = true;
        app.loadDependencyGraph(msg); // loadDependencyGraph also loads msg.tour internally
        reflectMode(app.getMode()); // preserves "tour" if that's why the scan was requested
      }
      else if (msg.type === "switchToDep") { app.setMode("dep"); reflectMode("dep"); app.__needsScan(); }
      else if (msg.type === "switchToTour") { app.setMode("tour"); reflectMode("tour"); app.__needsScan(); }
      // host already had a cached scan (e.g. "Explain this file" -> "Show in
      // Guided Tour" on a panel that was scanned earlier) and pushed mode
      // directly instead of waiting on a round-trip scan request.
      else if (msg.type === "setMode") { app.setMode(msg.mode); reflectMode(msg.mode); }
      else if (msg.type === "tourJumpToPath") app.tourJumpToPath(msg.path);
      else if (msg.type === "error") app.showError(msg.message);
    });
  }
})();
