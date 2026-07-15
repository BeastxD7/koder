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

  let transport = { expand() {}, loadMore() {}, openFile() {} };

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
    render();
  }

  function resetView() {
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
    render();
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
    render();
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

  new ResizeObserver(resize).observe(canvas);

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

  // re-layout whenever nodes/edges change via loadGraph
  const _loadGraph = loadGraph;
  loadGraph = function (data) {
    _loadGraph(data);
    layout();
    render();
  };

  return { loadGraph, applyExpand, showError, setTransport, resetView, resize, zoomBy: (f) => { scale = Math.min(2.5, Math.max(0.25, scale * f)); render(); }, render };
}

// ---------- bootstrap ----------
(function bootstrap() {
  const canvas = document.getElementById("canvas");
  if (!canvas) return; // not in a page that has this markup (defensive, shouldn't happen)

  const app = createGraphApp(canvas, {
    emptyEl: document.getElementById("empty"),
    titleEl: document.getElementById("title"),
  });
  window.__lakshxGraphApp = app;

  document.getElementById("zoomIn")?.addEventListener("click", () => app.zoomBy(1.2));
  document.getElementById("zoomOut")?.addEventListener("click", () => app.zoomBy(1 / 1.2));
  document.getElementById("zoomReset")?.addEventListener("click", () => app.resetView());

  const hasVsCodeApi = typeof acquireVsCodeApi === "function";
  if (hasVsCodeApi) {
    const vscode = acquireVsCodeApi();
    app.setTransport({
      expand: (id, direction) => vscode.postMessage({ type: "expand", id, direction }),
      loadMore: (id, direction) => vscode.postMessage({ type: "loadMore", id, direction }),
      openFile: (id) => vscode.postMessage({ type: "openFile", id }),
    });
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "init") app.loadGraph(msg);
      else if (msg.type === "expandResult") app.applyExpand(msg);
      else if (msg.type === "error") app.showError(msg.message);
    });
  }
})();
