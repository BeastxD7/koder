// LakshX Call Graph — canvas renderer.
//
// Deliberately NOT a force-directed physics simulation: the data is a tree
// grown outward from one seed symbol (VS Code's own call-hierarchy LSP
// surface, seed-and-expand — there's no whole-repo crawl to lay out), so a
// simple layered tree is enough and far cheaper to get right than a physics
// sim. Callers (incoming) are laid out in columns to the left of the seed,
// callees (outgoing) in columns to the right; every edge — regardless of
// direction — points from its lower-column endpoint to its higher-column
// one, so the whole picture reads left-to-right as "callers -> seed ->
// callees".
//
// This file is loaded unmodified both by the real webview (extension.js's
// panelHtml()) AND by the standalone test harness under
// product/lakshx-graph/test/harness — see the bootstrap IIFE at the bottom.
// `acquireVsCodeApi` only exists in the former; the harness instead calls
// `window.__lakshxGraphApp.setTransport(...)` with fake handlers and feeds
// `loadGraph(...)` fake data directly, exercising the exact same rendering
// and interaction code as production.
"use strict";

const SYMBOL_KIND_LABELS = [
  "File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field",
  "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String",
  "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct",
  "Event", "Operator", "TypeParameter",
];

function kindLabel(kind) {
  return SYMBOL_KIND_LABELS[kind] || "Symbol";
}

const ROW_H = 56;
const COL_W = 240;
const NODE_W = 190;
const NODE_H = 46;
const MORE_W = 110;
const MORE_H = 30;

function createGraphApp(canvas, opts) {
  const ctx = canvas.getContext("2d");
  const emptyEl = opts.emptyEl;
  const titleEl = opts.titleEl;

  /** @type {Map<string, object>} */
  let nodesById = new Map();
  let edges = []; // {from, to, direction}
  let parentOf = new Map(); // childId -> {id: parentId, direction}
  let rootId = null;
  let boxes = []; // laid-out render boxes (nodes + "more" markers), world coords

  let transport = { expand() {}, loadMore() {}, openFile() {}, openPath() {}, requestScan() {} };

  // ---- dependency-graph mode (parallel to the call-graph state above) ----
  // Kept in its own maps so call-mode's nodesById/edges/parentOf semantics are
  // never touched. `mode` gates which layout/render/hit-test path runs.
  let mode = "call"; // "call" | "dep" | "tour"
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

  // Single dispatch point for the interaction handlers so call-mode and
  // dep-mode never cross wires. Tour mode reuses the exact dep-mode renderer.
  function draw() {
    if (mode === "dep" || mode === "tour") renderDep();
    else render();
  }

  function resetView() {
    if (mode === "dep" || mode === "tour") {
      fitDep();
      return;
    }
    scale = 1;
    const rect = canvas.getBoundingClientRect();
    panX = rect.width / 2;
    panY = rect.height / 2;
    render();
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - panX) / scale, y: (sy - panY) / scale };
  }

  // ---------- layout ----------
  function layout() {
    boxes = [];
    if (!rootId || !nodesById.has(rootId)) return;

    // children[parentId] = ordered [{id, direction, isMore, moreCount}]
    const children = new Map();
    const columnOf = new Map();
    columnOf.set(rootId, 0);

    // BFS over the (deduped) parent tree to assign columns.
    const order = [rootId];
    for (let i = 0; i < order.length; i++) {
      const pid = order[i];
      const kids = [];
      for (const [cid, p] of parentOf) {
        if (p.id === pid) {
          const col = columnOf.get(pid) + (p.direction === "outgoing" ? 1 : -1);
          columnOf.set(cid, col);
          kids.push({ id: cid, direction: p.direction, isMore: false });
          order.push(cid);
        }
      }
      const node = nodesById.get(pid);
      if (node) {
        if (node.truncated?.incoming) kids.unshift({ id: `${pid}::more::incoming`, direction: "incoming", isMore: true, parentId: pid, count: node.truncated.incoming });
        if (node.truncated?.outgoing) kids.push({ id: `${pid}::more::outgoing`, direction: "outgoing", isMore: true, parentId: pid, count: node.truncated.outgoing });
      }
      children.set(pid, kids);
    }

    // Desired y = parent's y (root = 0), then resolve column-by-column,
    // processing columns in ring order (0, then |1|, then |2|, ...) since a
    // column's desired-y depends only on columns strictly closer to 0.
    const yOf = new Map();
    yOf.set(rootId, 0);
    const cols = new Set(columnOf.values());
    const maxAbs = Math.max(0, ...[...cols].map(Math.abs));
    for (let ring = 1; ring <= maxAbs; ring++) {
      for (const sign of [-1, 1]) {
        const col = ring * sign;
        if (!cols.has(col)) continue;
        // gather entries in this column in parent-then-child order
        const entries = [];
        for (const [id, c] of columnOf) {
          if (c === col) {
            const p = parentOf.get(id);
            entries.push({ id, parentY: yOf.get(p.id) ?? 0, isMore: false });
          }
        }
        // include "more" markers, which live in the same column as their
        // parent's children (one hop further out than the parent). A single
        // parent can have both an incoming-more and an outgoing-more marker
        // (truncated in both directions) that belong to opposite columns —
        // filter by the marker's own direction, not just the parent's
        // column, or a ring==1 parent (column offset 0 either way) would
        // wrongly feed both markers into both passes.
        for (const [pid, kids] of children) {
          if (columnOf.get(pid) !== col - sign) continue;
          for (const k of kids) {
            if (!k.isMore) continue;
            const markerSign = k.direction === "outgoing" ? 1 : -1;
            if (markerSign !== sign) continue;
            entries.push({ id: k.id, parentY: yOf.get(pid) ?? 0, isMore: true, count: k.count, parentId: pid, direction: k.direction });
          }
        }
        entries.sort((a, b) => a.parentY - b.parentY);
        let prevY = -Infinity;
        for (const e of entries) {
          let y = e.parentY;
          if (y <= prevY) y = prevY + ROW_H;
          yOf.set(e.id, y);
          prevY = y;
        }
      }
    }

    for (const [id, col] of columnOf) {
      const node = nodesById.get(id);
      if (!node) continue;
      boxes.push({
        kind: "node",
        id,
        x: col * COL_W,
        y: yOf.get(id) ?? 0,
        w: NODE_W,
        h: NODE_H,
        node,
      });
    }
    for (const [pid, kids] of children) {
      for (const k of kids) {
        if (!k.isMore) continue;
        boxes.push({
          kind: "more",
          id: k.id,
          parentId: k.parentId,
          direction: k.direction,
          count: k.count,
          x: columnOf.get(pid) * COL_W + (k.direction === "outgoing" ? COL_W : -COL_W),
          y: yOf.get(k.id) ?? 0,
          w: MORE_W,
          h: MORE_H,
        });
      }
    }
  }

  // ---------- rendering ----------
  function render() {
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    if (!rootId) {
      ctx.restore();
      return;
    }

    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    const boxAt = (id) => boxes.find((b) => b.id === id);

    // edges first, under nodes
    for (const e of edges) {
      const a = boxAt(e.from);
      const b = boxAt(e.to);
      if (!a || !b) continue;
      const [src, dst] = a.x <= b.x ? [a, b] : [b, a];
      drawEdge(src, dst, e.direction);
    }

    for (const box of boxes) {
      if (box.kind === "more") drawMoreBox(box);
      else drawNodeBox(box);
    }

    ctx.restore();
  }

  function drawEdge(src, dst, direction) {
    const resolved = direction === "incoming" ? cssVar("--incoming", "#45c4ff") : cssVar("--outgoing", "#ff9d5c");
    const x1 = src.x + src.w / 2;
    const y1 = src.y;
    const x2 = dst.x - dst.w / 2;
    const y2 = dst.y;
    const midX = (x1 + x2) / 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(midX, y1, midX, y2, x2, y2);
    ctx.strokeStyle = resolved;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // arrowhead at the target end, pointing left-to-right
    const ah = 5;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - ah, y2 - ah * 0.7);
    ctx.lineTo(x2 - ah, y2 + ah * 0.7);
    ctx.closePath();
    ctx.fillStyle = resolved;
    ctx.fill();
  }

  function cssVar(name, fallback) {
    return getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;
  }

  function drawNodeBox(box) {
    const { x, y, w, h, node, id } = box;
    const left = x - w / 2;
    const top = y - h / 2;
    const isRoot = id === rootId;
    const dirColor = node.dir === "incoming" ? cssVar("--incoming", "#45c4ff") : node.dir === "outgoing" ? cssVar("--outgoing", "#ff9d5c") : cssVar("--accent", "#7c5cff");

    roundRect(left, top, w, h, 8);
    ctx.fillStyle = cssVar("--node-bg", "#171b23");
    ctx.fill();
    ctx.lineWidth = isRoot ? 2 : 1;
    ctx.strokeStyle = isRoot ? cssVar("--node-root-border", "#7c5cff") : cssVar("--node-border", "rgba(255,255,255,0.1)");
    ctx.stroke();

    // left accent bar for direction/kind color
    roundRect(left, top, 3, h, 1.5);
    ctx.fillStyle = dirColor;
    ctx.fill();

    ctx.fillStyle = cssVar("--fg", "#c8cede");
    ctx.font = "600 12.5px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textBaseline = "alphabetic";
    const name = truncateText(ctx, node.name, w - 20);
    ctx.fillText(name, left + 14, top + 19);

    ctx.fillStyle = cssVar("--muted", "#8a93a8");
    ctx.font = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    const sub = truncateText(ctx, `${kindLabel(node.kind)} · ${node.file}`, w - 20);
    ctx.fillText(sub, left + 14, top + 34);

    // expand affordance: a small chevron on the outward-facing edge, only
    // when this node hasn't been expanded in its own direction yet.
    const needsExpand = !isRoot && node.dir && !node.expanded[node.dir];
    if (needsExpand) {
      const cx = node.dir === "incoming" ? left - 2 : left + w + 2;
      ctx.beginPath();
      ctx.arc(cx, y, 7, 0, Math.PI * 2);
      ctx.fillStyle = cssVar("--accent", "#7c5cff");
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("+", cx, y + 4);
      ctx.textAlign = "left";
    }
  }

  function drawMoreBox(box) {
    const { x, y, w, h, count } = box;
    const left = x - w / 2;
    const top = y - h / 2;
    roundRect(left, top, w, h, 14);
    ctx.fillStyle = cssVar("--accent-soft", "rgba(124,92,255,0.14)");
    ctx.fill();
    ctx.strokeStyle = cssVar("--accent", "#7c5cff");
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = cssVar("--accent", "#7c5cff");
    ctx.font = "600 11px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`+${count} more`, x, y + 4);
    ctx.textAlign = "left";
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function truncateText(ctx2, text, maxW) {
    if (ctx2.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx2.measureText(t + "…").width > maxW) t = t.slice(0, -1);
    return t + "…";
  }

  function hitTest(worldX, worldY) {
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      if (worldX >= b.x - b.w / 2 && worldX <= b.x + b.w / 2 && worldY >= b.y - b.h / 2 && worldY <= b.y + b.h / 2) return b;
    }
    return null;
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
    if (mode === "dep") {
      handleDepClick(world);
      return;
    }
    if (mode === "tour") {
      handleTourClick(world);
      return;
    }
    const hit = hitTest(world.x, world.y);
    if (!hit) return;
    if (hit.kind === "more") {
      transport.loadMore(hit.parentId, hit.direction);
      return;
    }
    const node = hit.node;
    const isRoot = hit.id === rootId;
    if (!isRoot && node.dir && !node.expanded[node.dir]) {
      transport.expand(hit.id, node.dir);
    } else {
      transport.openFile(hit.id);
    }
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
  function loadGraph({ rootId: rid, nodes, edges: incomingEdges, truncated }) {
    nodesById = new Map();
    parentOf = new Map();
    edges = [];
    rootId = rid;

    for (const n of nodes) {
      nodesById.set(n.id, { ...n, dir: null, expanded: { incoming: n.id === rid, outgoing: n.id === rid }, truncated: {} });
    }
    for (const e of incomingEdges) addEdge(e);
    // a node's own "direction" (which further hop it expands via on click)
    // is inherited from the edge that first discovered it — derive it now
    // that parentOf is populated, since the flat `nodes` array from the
    // extension host doesn't carry it directly.
    for (const [id, p] of parentOf) {
      const node = nodesById.get(id);
      if (node) node.dir = p.direction;
    }
    applyTruncated(truncated);

    if (emptyEl) emptyEl.hidden = nodes.length > 0;
    if (titleEl && nodesById.has(rid)) titleEl.textContent = `Call Graph: ${nodesById.get(rid).name}`;
    layout();
    resetView(); // resetView() renders
  }

  function addEdge(e) {
    edges.push(e);
    if (!parentOf.has(e.to) && e.to !== rootId) parentOf.set(e.to, { id: e.from, direction: e.direction });
  }

  // `truncated` is keyed by node id (not a combined "id:direction" string —
  // ids are URIs and already contain colons, which would make splitting
  // that back apart ambiguous): { [nodeId]: { incoming?: n, outgoing?: n } }
  function applyTruncated(truncated) {
    if (!truncated) return;
    for (const [id, byDir] of Object.entries(truncated)) {
      const node = nodesById.get(id);
      if (!node) continue;
      for (const [dir, count] of Object.entries(byDir)) {
        if (count > 0) node.truncated[dir] = count;
      }
    }
  }

  function applyExpand({ parentId, direction, nodes, edges: newEdges, truncated }) {
    for (const n of nodes) {
      if (!nodesById.has(n.id)) {
        nodesById.set(n.id, { ...n, dir: direction, expanded: { incoming: false, outgoing: false }, truncated: {} });
      }
    }
    for (const e of newEdges) addEdge(e);
    const parent = nodesById.get(parentId);
    if (parent) {
      parent.expanded[direction] = true;
      if (truncated > 0) parent.truncated[direction] = truncated;
      else delete parent.truncated[direction];
    }
    layout();
    render();
  }

  function showError(message) {
    if (emptyEl) {
      emptyEl.textContent = message;
      emptyEl.hidden = false;
    }
    console.error("LakshX Call Graph:", message);
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
    // payload, so one scan feeds all three modes.
    loadTour(payload && payload.tour);
    fitDep();
  }

  function setMode(next) {
    if (next !== "call" && next !== "dep" && next !== "tour") return;
    mode = next;
    if (mode === "dep" || mode === "tour") {
      // Call-graph mode's own empty-state ("No call graph yet...") must be
      // cleared here — it only ever gets HIDDEN by the `else` branch below,
      // never by this one, so switching straight from Call graph into
      // Dependencies/Guided Tour left it sitting on screen, overlapping
      // dep-mode's own #depHint text (real bug, hit in the wild).
      if (emptyEl) emptyEl.hidden = true;
      if (hintEl) hintEl.hidden = !!(depRaw && depNodes.size > 0);
      updateDepStats();
      if (depRaw && depNodes.size > 0) fitDep();
      else { const rect = canvas.getBoundingClientRect(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height); }
      if (mode === "tour") {
        renderTourPanel();
        applyTourFocus();
      }
    } else {
      if (hintEl) hintEl.hidden = true;
      hideTooltip();
      render();
      // if no call graph has been loaded yet, show the guidance empty-state
      // rather than a blank canvas (mirrors dep-mode's #depHint).
      if (emptyEl && !rootId) {
        emptyEl.textContent = "No call graph yet. Put your cursor on a function or method and run “LakshX: Show Call Graph” (or click the “Call Graph” status bar item).";
        emptyEl.hidden = false;
      } else if (emptyEl && rootId) {
        emptyEl.hidden = true;
      }
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
      if (tourTitleEl) tourTitleEl.textContent = "No tour data yet.";
      if (tourBlurbEl) tourBlurbEl.textContent = "";
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

  // re-layout whenever nodes/edges change via loadGraph
  const _loadGraph = loadGraph;
  loadGraph = function (data) {
    mode = "call";
    if (hintEl) hintEl.hidden = true;
    _loadGraph(data);
    layout();
    render();
  };

  return {
    loadGraph, applyExpand, showError, setTransport, resetView, resize,
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
    titleEl: document.getElementById("title"),
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
  const modeCall = document.getElementById("modeCall");
  const modeDep = document.getElementById("modeDep");
  const modeTour = document.getElementById("modeTour");
  const callLegend = document.getElementById("legend");
  const depLegend = document.getElementById("depLegend");
  const depControls = document.getElementById("depControls");
  const statsBar = document.getElementById("stats");
  const tourPanel = document.getElementById("tourPanel");
  const titleEl = document.getElementById("title");
  function reflectMode(m) {
    modeCall?.classList.toggle("active", m === "call");
    modeDep?.classList.toggle("active", m === "dep");
    modeTour?.classList.toggle("active", m === "tour");
    // #title ("Call Graph" / "Call Graph: <fn>") is call-mode-only context —
    // left out of this mode-based show/hide before, so it sat next to the
    // tabs reading like a stray 4th tab in Dependencies/Guided Tour mode.
    if (titleEl) titleEl.hidden = m !== "call";
    if (callLegend) callLegend.hidden = m !== "call";
    if (depLegend) depLegend.hidden = m === "call";
    // search/hide-externals/collapse/re-scan controls only make sense for the
    // free-exploration dependency view, not the guided step-through.
    if (depControls) depControls.hidden = m !== "dep";
    if (statsBar) statsBar.hidden = m === "call";
    if (tourPanel) tourPanel.hidden = m !== "tour";
  }
  modeCall?.addEventListener("click", () => { app.setMode("call"); reflectMode("call"); });
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
      expand: (id, direction) => vscode.postMessage({ type: "expand", id, direction }),
      loadMore: (id, direction) => vscode.postMessage({ type: "loadMore", id, direction }),
      openFile: (id) => vscode.postMessage({ type: "openFile", id }),
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
      if (msg.type === "init") { app.loadGraph(msg); reflectMode("call"); }
      else if (msg.type === "expandResult") app.applyExpand(msg);
      else if (msg.type === "depInit") {
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
