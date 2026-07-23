/**
 * Enhanced Prompt Editor — Standalone ComfyUI Node
 * The EPE renders directly inside the node on the canvas via addDOMWidget().
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const _epeFont = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

// ── Graph helpers ─────────────────────────────────────────────────────────────
function _epeGetInnerGraph(n) {
  if (!n) return null;

  // Common patterns used by Subgraph/Group wrapper nodes
  let g = null;
  try { g = n.getInnerGraph ? n.getInnerGraph() : null; } catch(_) { g = null; }
  if (!g) g = n.innerGraph || null;
  if (!g) g = n.subgraph || null;

  // Sometimes wrappers store subgraph info as an object with `.graph`
  if (g && !g._nodes && !g.nodes && g.graph && (g.graph._nodes || g.graph.nodes || g.graph.getNodeById)) {
    g = g.graph;
  }

  // Only accept a real graph object
  if (g && (g._nodes || g.nodes || g.getNodeById)) return g;
  return null;
}

function _epeIsSubgraphWrapper(n) {
  const t = String(n?.type || "").toLowerCase();
  const title = String(n?.title || "").toLowerCase();
  // Be conservative: only treat obvious Subgraph wrappers as wrappers
  return t === "subgraph" || t.includes("subgraph") || title === "subgraph" || title.includes("subgraph");
}

function _epeGetNode(graph, id) {
  if (graph && graph.getNodeById) {
    const n = graph.getNodeById(id);
    if (n) return n;
  }
  const nodes = graph ? (graph._nodes || graph.nodes) : null;
  if (nodes && Array.isArray(nodes)) return nodes.find(n => n.id == id);
  return null;
}
// ═══════════════════════════════════════════════════════════════════════════
// Unified Node Lookup System
// ═══════════════════════════════════════════════════════════════════════════
// Single entry point for ALL node lookups with three-tier relocation.
// Every control that binds to a node should store a ref object with:
//   { nodeKey, nodeType?, nodeTitle?, slotName? }
// The lookup mutates ref.nodeKey when a node is relocated.
//
// Tier 1: Direct chain key lookup (e.g. "49:66" → walk graph chain)
// Tier 2: Deep search by leaf ID across all subgraphs
// Tier 3: Class_type + slot/widget name + title scoring (handles ID reassignment)
// Grace:  1s window for temporary misses during graph restructuring
// ═══════════════════════════════════════════════════════════════════════════

// Low-level: walk a chain key to find a node. No relocation, no fallback.
function _epeFindNodeGlobal(chainKey) {
  if (!chainKey) return null;
  const parts = String(chainKey).split(":");
  // Always start from the ROOT graph, not app.graph which changes during subgraph nav
  let g = (app.canvas?._graph_stack?.length > 0) ? app.canvas._graph_stack[0] : app.graph;
  let node = null;
  for (const pid of parts) {
    if (!g) return null;
    node = _epeGetNode(g, parseInt(pid));
    if (!node) return null;
    g = _epeGetInnerGraph(node);
  }
  return node;
}

function _epeTraverseNodes(graph, chain, pathLabel, outList, includeSubgraphs = true, visited = new Set()) {
  if (!graph) return;

  // Cycle detection: prevent infinite recursion on circular graph references
  const graphId = graph.id || graph._id || JSON.stringify(graph._nodes?.map(n => n?.id).slice(0, 5));
  if (visited.has(graphId)) return;
  visited.add(graphId);

  const nodes = graph._nodes || graph.nodes || [];
  for (const n of nodes) {
    if (!n || !n.id) continue;
    const title = n.title || n.type || ("Node " + n.id);
    const myChain = [...chain, n.id];
    const key = myChain.join(":");
    const inner = _epeGetInnerGraph(n);

    const t = (n.type || "").toLowerCase();
    const ignore = t === "primitive" || t === "reroute" || t.includes("note") || t.startsWith("set") || t.startsWith("get");
    
    // If it's a subgraph, recurse into it but also add the subgraph itself as a node (if allowed)
    if (inner) {
      // Add the subgraph wrapper as a pickable node only if includeSubgraphs is true
      if (includeSubgraphs) {
        outList.push({
          node: n,
          nodeTitle: title,
          path: pathLabel,
          nodeKey: key,
          nodeType: n.type || n.comfyClass || "Subgraph",
          isSubgraph: true,
        });
      }
      
      const nextPath = (pathLabel === "Root") ? title : `${pathLabel} > ${title}`;
      _epeTraverseNodes(inner, myChain, nextPath, outList, includeSubgraphs, visited);
      continue;
    }
    
    if (ignore) continue;

    // Add regular nodes
    outList.push({
      node: n,
      nodeTitle: title,
      path: pathLabel,
      nodeKey: key,
      nodeType: n.type || n.comfyClass || "Node",
      isSubgraph: false,
    });
  }
}

function _epeResolveNodeOutputKey(nodeBind) {
  if (!nodeBind) return null;
  const parts = String(nodeBind).split(":");
  if (parts.length < 2) return null;
  const leafId = parts[parts.length - 1];
  // Walk the parent chain (all parts except the last) using _epeFindNodeGlobal
  // to find the direct parent node, whose type is the UUID used in nodeOutputs.
  const parentChain = parts.slice(0, -1).join(":");
  let parentNode = null;
  try { parentNode = _epeFindNodeGlobal(parentChain); } catch(_e) {}
  if (!parentNode) return null;
  // The parent node's type is the subgraph UUID (e.g. "932f407c-...")
  const uuid = parentNode.type || null;
  if (!uuid) return null;
  return uuid + ":" + leafId;
}

// ═══════════════════════════════════════════════════════════════════════════
// EPE Wireless: bind resolution + 3-tier relocation
// ═══════════════════════════════════════════════════════════════════════════
// A wireless target is stored as a bind ref:
//   { bind:"<chainKey>|<widgetIndex>", bindNodeType, bindNodeTitle,
//     bindWidgetName, bindWidgetLabel, _bindRef:{nodeKey,nodeType,nodeTitle,slotName,_missTime} }
// chainKey is the colon-joined node path through subgraphs (e.g. "88:30:45").
// The relocation cascade keeps a target valid when the graph is restructured:
//   Tier 1: direct chain-key lookup
//   Tier 2: deep leaf-ID search across all subgraphs
//   Tier 3: nodeType + widget-name match with title scoring
//   Grace:  short window for transient misses during graph load/restructure
const _EPE_GRACE_MS = 3000;

function _epeWidgetLabel(w) {
  return String(w?.label ?? w?.name ?? w?.type ?? "Widget");
}

// Tier-cascade node lookup. Mutates ref.nodeKey when a node is relocated so the
// next resolve takes the fast path. Returns the live node or null.
function _epeLookupTargetNode(ref) {
  if (!ref || !ref.nodeKey) return null;

  // Tier 1 — direct chain-key lookup
  const direct = _epeFindNodeGlobal(ref.nodeKey);
  if (direct) {
    ref._missTime = 0;
    if (!ref.nodeType && direct.type) ref.nodeType = direct.type;
    if (!ref.nodeTitle && (direct.title || direct.type)) ref.nodeTitle = direct.title || direct.type;
    return direct;
  }

  const rootGraph = (app.canvas?._graph_stack?.length > 0) ? app.canvas._graph_stack[0] : app.graph;

  // Tier 2 — deep leaf-ID search across all subgraphs
  const leafId = parseInt(String(ref.nodeKey).split(":").pop());
  if (!isNaN(leafId)) {
    const rootNode = _epeGetNode(rootGraph, leafId);
    if (rootNode) {
      ref.nodeKey = String(leafId);
      ref._missTime = 0;
      if (!ref.nodeType && rootNode.type) ref.nodeType = rootNode.type;
      if (!ref.nodeTitle && (rootNode.title || rootNode.type)) ref.nodeTitle = rootNode.title || rootNode.type;
      return rootNode;
    }
    const deepSearch = (graph, chain) => {
      if (!graph) return null;
      const nodes = graph._nodes || graph.nodes || [];
      for (const n of nodes) {
        if (!n || !n.id) continue;
        const inner = _epeGetInnerGraph(n);
        if (inner) {
          const newChain = [...chain, n.id];
          const found = _epeGetNode(inner, leafId);
          if (found) return { node: found, chainKey: [...newChain, leafId].join(":") };
          const deeper = deepSearch(inner, newChain);
          if (deeper) return deeper;
        }
      }
      return null;
    };
    const result = deepSearch(rootGraph, []);
    if (result) {
      ref.nodeKey = result.chainKey;
      ref._missTime = 0;
      if (!ref.nodeType && result.node.type) ref.nodeType = result.node.type;
      if (!ref.nodeTitle && (result.node.title || result.node.type)) ref.nodeTitle = result.node.title || result.node.type;
      return result.node;
    }
  }

  // Tier 3 — nodeType + widget-name match with title scoring
  if (ref.nodeType) {
    const matchByType = (graph, chain) => {
      if (!graph) return null;
      const nodes = graph._nodes || graph.nodes || [];
      let bestMatch = null, bestScore = 0;
      for (const n of nodes) {
        if (!n || !n.id) continue;
        if ((n.type || "") !== ref.nodeType) continue;
        let slotOk = true;
        if (ref.slotName != null) {
          slotOk = (n.widgets || []).some(w => w && w.name === ref.slotName);
        }
        if (!slotOk) continue;
        let score = 1;
        if (ref.nodeTitle && (n.title || n.type) === ref.nodeTitle) score += 2;
        if (score > bestScore) { bestScore = score; bestMatch = { node: n, chain }; }
      }
      if (bestMatch) {
        const newKey = bestMatch.chain.length ? [...bestMatch.chain, bestMatch.node.id].join(":") : String(bestMatch.node.id);
        ref.nodeKey = newKey;
        ref._missTime = 0;
        return bestMatch.node;
      }
      for (const n of nodes) {
        if (!n || !n.id) continue;
        const inner = _epeGetInnerGraph(n);
        if (inner) {
          const found = matchByType(inner, [...chain, n.id]);
          if (found) return found;
        }
      }
      return null;
    };
    const matched = matchByType(rootGraph, []);
    if (matched) return matched;
  }

  // Grace period — tolerate transient misses during restructuring
  if (!ref._missTime) ref._missTime = Date.now();
  if (Date.now() - ref._missTime < _EPE_GRACE_MS) return null;
  return null;
}

// Resolve a target's live { node, widget, widgetIndex }. Widget is matched by
// name/label first (robust to ComfyUI widget reordering), index as fallback,
// and the stored bind key self-heals if the index drifted.
function _epeResolveTargetWidget(target) {
  if (!target || !target.bind) return null;
  const s = String(target.bind);
  const bar = s.lastIndexOf("|");
  if (bar === -1) return null;
  const nodeKey = s.slice(0, bar);
  const wIndexStr = s.slice(bar + 1);

  if (!target._bindRef) {
    target._bindRef = {
      nodeKey,
      nodeType: target.bindNodeType || null,
      nodeTitle: target.bindNodeTitle || null,
      slotName: target.bindWidgetName || null,
    };
  }
  target._bindRef.nodeKey = nodeKey;
  if (target.bindNodeType) target._bindRef.nodeType = target.bindNodeType;
  if (target.bindNodeTitle) target._bindRef.nodeTitle = target.bindNodeTitle;
  if (target.bindWidgetName) target._bindRef.slotName = target.bindWidgetName;

  const node = _epeLookupTargetNode(target._bindRef);
  if (!node) return null;

  // Self-heal the bind key if the node relocated
  if (target._bindRef.nodeKey !== nodeKey) {
    target.bind = target._bindRef.nodeKey + "|" + wIndexStr;
  }

  const ws = node.widgets || [];
  const wIndex = parseInt(wIndexStr);
  let w = null, resolvedIndex = wIndex;
  const expectedName = target.bindWidgetName;
  const expectedLabel = target.bindWidgetLabel;

  if (expectedName || expectedLabel) {
    let idx = expectedName ? ws.findIndex(cw => cw && cw.name === expectedName) : -1;
    if (idx < 0 && expectedLabel) idx = ws.findIndex(cw => cw && (cw.name === expectedLabel || cw.label === expectedLabel));
    if (idx < 0 && expectedName) idx = ws.findIndex(cw => cw && cw.label === expectedName);
    if (idx >= 0) {
      w = ws[idx]; resolvedIndex = idx;
      if (idx !== wIndex) target.bind = target._bindRef.nodeKey + "|" + idx;
    } else {
      w = Number.isFinite(wIndex) ? ws[wIndex] : null;
    }
  } else {
    w = Number.isFinite(wIndex) ? ws[wIndex] : null;
  }

  if (!w) return null;
  return { node, widget: w, widgetIndex: resolvedIndex, nodeKey: target._bindRef.nodeKey };
}

// Write text into a target's resolved widget. Returns true on success.
function _epeApplyToTarget(target, text) {
  const r = _epeResolveTargetWidget(target);
  if (!r || !r.widget) return false;
  try { r.widget.value = text; } catch (_e) { return false; }
  return true;
}

// Store bind + relocation metadata from a picker selection.
function _epeSetTargetBind(target, sel) {
  if (!target || !sel) return;
  target.bind = sel.bindKey;
  target.bindNodeType = sel.node?.type || sel.nodeType || null;
  target.bindNodeTitle = sel.nodeTitle || sel.node?.title || sel.node?.type || null;
  target.bindWidgetName = sel.widgetName || sel.widgetLabel || null;
  target.bindWidgetLabel = sel.widgetLabel || sel.widgetName || null;
  target.bindLabel = (sel.path === "Root" || !sel.path)
    ? `${target.bindNodeTitle} > ${target.bindWidgetLabel}`
    : `${sel.path} > ${target.bindNodeTitle} > ${target.bindWidgetLabel}`;
  target._bindRef = {
    nodeKey: String(sel.bindKey).slice(0, String(sel.bindKey).lastIndexOf("|")),
    nodeType: target.bindNodeType,
    nodeTitle: target.bindNodeTitle,
    slotName: target.bindWidgetName,
    _missTime: 0,
  };
}

// Rebuild a target's display label from the current graph (used when a stored
// label is missing or after relocation).
function _epeRebuildTargetLabel(target) {
  if (!target || !target.bind) return;
  const s = String(target.bind);
  const bar = s.lastIndexOf("|");
  if (bar === -1) return;
  const nodeKey = s.slice(0, bar);
  const wIndexStr = s.slice(bar + 1);
  const node = _epeFindNodeGlobal(nodeKey);
  if (!node) return;
  const w = (node.widgets || [])[parseInt(wIndexStr)];
  const wLabel = w ? _epeWidgetLabel(w) : (target.bindWidgetLabel || "Widget");
  const nTitle = node.title || node.type || "Node";
  const parts = nodeKey.split(":");
  if (parts.length === 1) {
    target.bindLabel = nTitle + " > " + wLabel;
  } else {
    const rootGraph = (app.canvas?._graph_stack?.length > 0) ? app.canvas._graph_stack[0] : app.graph;
    let pathStr = "", g = rootGraph;
    for (let pi = 0; pi < parts.length - 1; pi++) {
      const wrapper = _epeGetNode(g, parseInt(parts[pi]));
      if (wrapper) {
        pathStr += (pathStr ? " > " : "") + (wrapper.title || wrapper.type || "Subgraph");
        g = _epeGetInnerGraph(wrapper);
      }
    }
    target.bindLabel = (pathStr || "Subgraph") + " > " + nTitle + " > " + wLabel;
  }
}

function _epeEnumerateTextTargets() {
  const results = [];
  const entries = [];
  try { _epeTraverseNodes(app.graph, [], 'Root', entries, true); } catch(_e) { return results; }
  for (const e of entries) {
    if (e.isSubgraph || !e.node) continue;
    const n = e.node;
    if (n.mode === 2 || n.mode === 4) continue;
    if (!n.widgets) continue;
    for (let wi = 0; wi < n.widgets.length; wi++) {
      const w = n.widgets[wi];
      if (w.type !== 'customtext') continue;
      const title = n.title || n.type || ('Node ' + n.id);
      const wLabel = (w.label && w.label !== w.name) ? w.label : w.name;
      results.push({
        nodeKey: e.nodeKey, nodeTitle: title, path: e.path,
        widgetIndex: wi, widgetName: w.name, widget: w, node: n,
        displayName: title + '  ·  ' + wLabel,
        displayPath: (e.path === 'Root' || !e.path) ? '' : e.path,
      });
    }
  }
  return results;
}

function _epeShowTextNodeDropdown(anchorBtn, items, onSelect) {
  const DID = 'epe-epe-node-dropdown';
  const existing = document.getElementById(DID);
  if (existing) { existing.remove(); return; }
  if (!items.length) {
    const orig = anchorBtn.textContent;
    anchorBtn.textContent = 'No text nodes found';
    setTimeout(() => { anchorBtn.textContent = orig; }, 1500);
    return;
  }
  const dd = document.createElement('div');
  dd.id = DID;
  dd.style.cssText = 'position:fixed;z-index:999999;background:#141a24;border:1px solid #31415a;border-radius:5px;box-shadow:0 4px 18px rgba(0,0,0,0.75);overflow-y:auto;max-height:320px;min-width:280px;font-size:11px;';
  // Forward reference — assigned once listeners are wired below; row clicks use it.
  let _closeDD = () => { if (dd.isConnected) dd.remove(); };
  for (const item of items) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:7px 12px;cursor:pointer;border-bottom:1px solid #1c2431;display:flex;flex-direction:column;gap:2px;';
    const nameEl = document.createElement('span');
    nameEl.textContent = item.displayName;
    nameEl.style.cssText = 'color:#d4dfea;';
    row.appendChild(nameEl);
    if (item.displayPath) {
      const pathEl = document.createElement('span');
      pathEl.textContent = item.displayPath;
      pathEl.style.cssText = 'color:#4e5c6e;font-size:9px;';
      row.appendChild(pathEl);
    }
    row.onmouseenter = () => { row.style.background = '#1a2a3a'; };
    row.onmouseleave = () => { row.style.background = ''; };
    row.onclick = (ev) => { ev.stopPropagation(); _closeDD(); onSelect(item); };
    dd.appendChild(row);
  }
  document.body.appendChild(dd);
  const r = anchorBtn.getBoundingClientRect();
  const ddW = 280;
  dd.style.left = Math.min(r.left, window.innerWidth - ddW - 8) + 'px';
  dd.style.top = (r.bottom + 4) + 'px';

  // Dismiss on any interaction outside the dropdown/button — including clicks on
  // the ComfyUI canvas (which can swallow document mousedown), canvas panning,
  // and scroll. Listen on multiple channels so canvas/node clicks also close it.
  let _ddCleanup = null;
  _closeDD = () => {
    if (!dd.isConnected) return;
    dd.remove();
    if (_ddCleanup) _ddCleanup();
  };
  const _onDocDown = (ev) => {
    if (!dd.contains(ev.target) && ev.target !== anchorBtn) _closeDD();
  };
  const _onCanvasDown = () => _closeDD();
  const _onScroll = () => _closeDD();
  _ddCleanup = () => {
    document.removeEventListener('mousedown', _onDocDown, true);
    document.removeEventListener('wheel', _onScroll, true);
    const cv = app.canvas?.canvas;
    if (cv) {
      cv.removeEventListener('pointerdown', _onCanvasDown, true);
      cv.removeEventListener('mousedown', _onCanvasDown, true);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', _onDocDown, true);
    document.addEventListener('wheel', _onScroll, true);
    const cv = app.canvas?.canvas;
    if (cv) {
      cv.addEventListener('pointerdown', _onCanvasDown, true);
      cv.addEventListener('mousedown', _onCanvasDown, true);
    }
  }, 0);
}

// ── Wireless target picker (modal) ────────────────────────────────────────────
// Self-contained searchable modal listing every text widget in the graph
// (including nested subgraphs), grouped by node, with a search box. Mirrors the
// WCP widget-picker UX without depending on WCP. onSelect receives an entry
// enriched with a `bindKey` ("<chainKey>|<widgetIndex>").
function _epeEnsurePickerCss() {
  if (document.getElementById("epe-target-picker-css")) return;
  const st = document.createElement("style");
  st.id = "epe-target-picker-css";
  st.textContent = `
    .epe-picker-overlay{position:fixed;inset:0;z-index:1000000;background:rgba(0,0,0,0.55);display:flex;align-items:flex-start;justify-content:center;}
    .epe-picker-modal{margin-top:8vh;background:#141a24;border:1px solid #31415a;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,0.7);width:460px;max-width:92vw;display:flex;flex-direction:column;overflow:hidden;font-family:${_epeFont};}
    .epe-picker-head{padding:12px 14px 10px;border-bottom:1px solid #1c2431;}
    .epe-picker-title{color:#9aaaba;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;}
    .epe-picker-search{width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #28364a;border-radius:5px;color:#d4dfea;font-size:12px;padding:7px 10px;outline:none;}
    .epe-picker-search:focus{border-color:#3a6080;}
    .epe-picker-list{list-style:none;margin:0;padding:6px 0;overflow-y:auto;max-height:50vh;}
    .epe-picker-group{display:flex;align-items:center;gap:8px;padding:6px 14px;cursor:pointer;color:#cfcfcf;font-size:12px;}
    .epe-picker-group:hover{background:rgba(255,255,255,0.04);}
    .epe-picker-group .arrow{font-size:9px;color:#7a8a9c;transition:transform 0.1s;}
    .epe-picker-group.expanded .arrow{transform:rotate(90deg);}
    .epe-picker-group .gmeta{color:#5b6b7e;font-size:10px;margin-left:auto;}
    .epe-picker-item{display:flex;align-items:center;gap:8px;padding:6px 14px 6px 30px;cursor:pointer;}
    .epe-picker-item:hover{background:rgba(255,255,255,0.05);}
    .epe-picker-item.current{background:rgba(58,96,128,0.25);}
    .epe-picker-item .dot{width:6px;height:6px;border-radius:50%;background:#6a9955;flex-shrink:0;}
    .epe-picker-item .row-title{color:#d4dfea;font-size:12px;}
    .epe-picker-item .row-id{color:#6a7a8d;font-size:10px;}
    .epe-picker-item .row-meta{color:#6a7a8d;font-size:10px;margin-left:auto;}
    .epe-picker-empty{padding:18px;text-align:center;color:#6a7a8d;font-size:12px;}
  `;
  document.head.appendChild(st);
}

function _epeShowTargetPicker(currentBindKey, onSelect) {
  _epeEnsurePickerCss();

  // Enrich enumerated text targets with bindKey + widgetLabel.
  const entries = _epeEnumerateTextTargets().map(e => ({
    ...e,
    bindKey: `${e.nodeKey}|${e.widgetIndex}`,
    widgetLabel: (() => {
      const w = e.widget;
      return String(w?.label ?? w?.name ?? "text");
    })(),
  }));

  const overlay = document.createElement("div");
  overlay.className = "epe-picker-overlay";
  overlay.onclick = (ev) => { if (ev.target === overlay) overlay.remove(); };

  const modal = document.createElement("div");
  modal.className = "epe-picker-modal";
  modal.onclick = (ev) => ev.stopPropagation();

  const head = document.createElement("div");
  head.className = "epe-picker-head";
  const title = document.createElement("div");
  title.className = "epe-picker-title";
  title.textContent = "Select wireless target (text input)";
  head.appendChild(title);
  const search = document.createElement("input");
  search.type = "text";
  search.className = "epe-picker-search";
  search.placeholder = "Search subgraphs, nodes, widgets, IDs…";
  head.appendChild(search);
  modal.appendChild(head);

  const list = document.createElement("ul");
  list.className = "epe-picker-list";
  modal.appendChild(list);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const state = { filter: "" };
  // Collapsible by graph path (Root Canvas / subgraph names). Default expanded.
  const collapsed = new Set();

  // Leaf node id from a chain key (e.g. "88:30:45" → "45").
  const _leafId = (nodeKey) => String(nodeKey).split(":").pop();
  // Path label for grouping; "Root" is shown as "Root Canvas" to match WCP.
  const _pathLabel = (e) => (!e.path || e.path === "Root") ? "Root Canvas" : e.path;

  function render() {
    list.innerHTML = "";
    const f = state.filter.toLowerCase();

    // Group by graph path; each group is a flat list of input rows.
    const groups = new Map(); // pathLabel -> items[]
    for (const e of entries) {
      if (f) {
        const idStr = _leafId(e.nodeKey);
        const match =
          e.nodeTitle.toLowerCase().includes(f) ||
          (e.widgetLabel || "").toLowerCase().includes(f) ||
          (e.widgetName || "").toLowerCase().includes(f) ||
          (e.path || "").toLowerCase().includes(f) ||
          String(e.nodeKey).toLowerCase() === f ||
          idStr === f;
        if (!match) continue;
      }
      const pl = _pathLabel(e);
      if (!groups.has(pl)) groups.set(pl, []);
      groups.get(pl).push(e);
    }

    if (groups.size === 0) {
      const empty = document.createElement("li");
      empty.className = "epe-picker-empty";
      empty.textContent = f ? "No matches." : "No pickable text widgets";
      list.appendChild(empty);
      return;
    }

    for (const [pathLabel, items] of groups) {
      const isExpanded = !collapsed.has(pathLabel) || !!f;

      // Path header (collapsible)
      const gRow = document.createElement("li");
      gRow.className = "epe-picker-group" + (isExpanded ? " expanded" : "");
      const arrow = document.createElement("span");
      arrow.className = "arrow";
      arrow.textContent = "\u25B6";
      gRow.appendChild(arrow);
      const gName = document.createElement("span");
      gName.textContent = pathLabel;
      gRow.appendChild(gName);
      const gMeta = document.createElement("span");
      gMeta.className = "gmeta";
      gMeta.textContent = String(items.length);
      gRow.appendChild(gMeta);
      gRow.onclick = () => {
        if (collapsed.has(pathLabel)) collapsed.delete(pathLabel);
        else collapsed.add(pathLabel);
        render();
      };
      list.appendChild(gRow);

      if (!isExpanded) continue;

      // One flat row per input: dot + node title + (id) … widget name
      for (const e of items) {
        const isCurrent = e.bindKey === currentBindKey;
        const row = document.createElement("li");
        row.className = "epe-picker-item" + (isCurrent ? " current" : "");
        const dot = document.createElement("span");
        dot.className = "dot";
        row.appendChild(dot);
        const rt = document.createElement("span");
        rt.className = "row-title";
        rt.textContent = e.nodeTitle;
        row.appendChild(rt);
        const rid = document.createElement("span");
        rid.className = "row-id";
        rid.textContent = "(" + _leafId(e.nodeKey) + ")";
        row.appendChild(rid);
        const rm = document.createElement("span");
        rm.className = "row-meta";
        rm.textContent = e.widgetName || e.widgetLabel || "";
        row.appendChild(rm);
        row.onclick = () => { onSelect(e); overlay.remove(); };
        list.appendChild(row);
      }
    }
  }

  search.oninput = () => { state.filter = search.value; render(); };
  search.addEventListener("keydown", (ev) => { if (ev.key === "Escape") overlay.remove(); });
  render();
  requestAnimationFrame(() => search.focus());
}

// ── Workflow template opener ──────────────────────────────────────────────────

async function _epeOpenTemplate(templateJSON, format = "graph") {
  // API-format graphs (from a PNG's 'prompt' chunk) load via loadApiJson.
  if (format === "api") {
    if (typeof app.loadApiJson !== "function") {
      throw new Error("This ComfyUI version cannot load API-format workflows");
    }
    try {
      await app.extensionManager.commands.execute('Comfy.NewBlankWorkflow');
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    } catch(e) { /* fall through — load into the current tab instead */ }
    await app.loadApiJson(templateJSON, "workflow.json");
    return;
  }
  try {
    // Step 1: create exactly one new blank tab via ComfyUI's own command.
    await app.extensionManager.commands.execute('Comfy.NewBlankWorkflow');

    // Step 2: wait two rAF frames for the new tab to become active and its
    // workflow UUID to be assigned, then read that UUID.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Step 3: patch the template UUID to match the new tab so loadGraphData
    // loads INTO the current tab rather than spawning a second one.
    const currentId = app.graph?.serialize?.()?.id;
    const patched = Object.assign({}, templateJSON);
    if (currentId) patched.id = currentId;

    // Step 4: load the workflow into the already-active new tab.
    await app.loadGraphData(patched);
  } catch(e) {
    // Fallback: just load directly if anything above fails.
    await app.loadGraphData(templateJSON);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AESTHETIC POOL — rotates per call to give the LLM diverse, committed aesthetic
// references without collapsing onto a fixed menu every generation.
//
// You can edit this pool freely. Add, remove, or reorder entries. The prompts
// below pick a random subset each call (via {{CATEGORY_EXAMPLES}} placeholders),
// so the pool's total size becomes the creative breadth of the node over time.
//
// Each entry is a concrete, named aesthetic tradition with enough specificity
// that a language model will recognize it. Avoid vague terms like "cinematic"
// or "painterly" — those are what the pool exists to replace.
//
// To disable rotation for any prompt: remove the {{…_EXAMPLES}} placeholders
// from that prompt's template in the AI Setup panel. The prompt will then be
// sent to the LLM exactly as you wrote it, with no runtime injection.
// ═══════════════════════════════════════════════════════════════════════════════
const _EPE_AESTHETIC_POOL = {
  photographic: [
    "Kodak Portra 400 color negative, soft skin tones, forgiving highlight rolloff",
    "Kodak Portra 160 with cooler shadows and smooth grain",
    "Kodak Portra 800 for low-light portraiture with characteristic magenta shadows",
    "Kodak Ektar 100, highly saturated fine-grain color for landscape",
    "Kodak Gold 200, warm consumer-grade nostalgia",
    "Kodak UltraMax 400 with punchy saturated color",
    "Kodak ColorPlus 200 with muted vintage palette",
    "Kodachrome slide film, deep blues and reds, mid-century magazine look",
    "Kodak Vision3 500T cinema stock, warm-cool split color science",
    "Fujifilm Pro 400H, cooler greens and pastel skin tones",
    "Fuji Velvia 50, hyper-saturated landscape slide film",
    "Fuji Superia 400 with pronounced green shift",
    "Fuji Acros 100 black and white, smooth mid-tones",
    "CineStill 800T, halation-bloom around highlights, tungsten-balanced",
    "CineStill 50D daylight cinema stock with clean grain",
    "CineStill BwXX (Eastman Double-X), Schindler's List / Raging Bull look",
    "Kodak Tri-X 400, gritty documentary grain, deep blacks",
    "Kodak T-MAX 400, clean fine-grain portrait black and white",
    "Kodak T-MAX 3200 pushed, heavy grain for low-light reportage",
    "Ilford HP5 Plus 400, medium-contrast documentary monochrome",
    "Ilford Delta 3200 pushed for available-light night work",
    "Ilford FP4 Plus 125, crisp medium-speed mid-century b&w look",
    "Harman Phoenix stylized color film with shifted palette",
    "LomoChrome Metropolis, muted cinematic desaturated color",
    "LomoChrome Purple with shifted foliage to magenta",
    "LomoChrome Turquoise with cool tonal shift",
    "Agfa Vista 400 with warm natural tones",
    "Agfa Ultra 50, intensely saturated vintage color",
    "Cross-processed Ektachrome, E-6 in C-41, pushed contrast and shifted hue",
    "Bleach-bypass processing, silver retention, desaturated with crushed shadows",
    "Expired film aesthetic, color shifts, light leaks, unpredictable grain",
    "Autochrome early-1900s color, potato-starch mosaic texture, pastel muted hues",
    "Large-format 4x5 view camera, tilt-shift, slow shallow depth",
    "Hasselblad medium format 80mm f/2.8 square frame, rich tonality",
    "Mamiya 7 medium format rangefinder, sharp and quiet",
    "Pentax 67 medium format with creamy bokeh",
    "Leica M rangefinder 35mm, street documentary distance",
    "Leica summilux 50mm wide open, natural bokeh and micro-contrast",
    "Polaroid SX-70 instant with characteristic border and faded color",
    "Holga 120N plastic lens, vignetting, center sharpness, toy-camera softness",
    "Direct-flash fashion editorial with hard shadow and flat foreground",
    "Phone-camera snapshot with digital noise and auto-HDR flatness",
    "Anamorphic lens flare with horizontal blue streaks, 2.39:1 compression",
    "Tilt-shift miniaturization effect with selective plane of focus",
    "Wet-plate collodion with period-correct tonal range and imperfections",
    "Early daguerreotype plate, silvery high-key monochrome with frame edge"
  ],
  painting: [
    "Mughal miniature manuscript technique in the Akbar atelier mode, fine brush on paper, intricate ornamental border, flat layered picture space, gold leaf accents and mineral pigments",
    "Mughal Hamzanama technique with dense narrative picture space, fine vermilion linework, tight overlapping compositional layers",
    "Rajput painting in the Kishangarh mode with flat mineral color, stylized elongated proportions, decorative border framing",
    "Pahari painting from the Kangra school with soft contour linework, pastel mineral washes, rolling green landscape backdrop",
    "Persian Safavid miniature, flat perspective, layered architecture, detailed textiles",
    "Ottoman miniature with calligraphic borders and jewel-bright pigments",
    "Tanjore painting with gold leaf and gemstone inlay, raised gesso relief",
    "Ajanta cave fresco style, earth pigments, curving female figures in tribhanga pose",
    "Bengal School watercolor technique in the Abanindranath Tagore manner, soft wet-on-wet wash, muted earth-tone palette, delicate outline",
    "Jamini Roy folk-art flat color with bold black outline",
    "Chinese gongbi meticulous court painting, fine line on silk, mineral pigment",
    "Chinese xieyi freehand ink wash, energetic brush, expressive landscape",
    "Song Dynasty landscape scroll, misty mountains, tiny travelers, blank-space composition",
    "Tang Dynasty court painting of elegant figures on silk",
    "Dunhuang Mogao cave mural, Buddhist iconography, earth-red and lapis",
    "Japanese Yamato-e style with gently sloping hills and decorative clouds",
    "Heian emaki handscroll composition, rooftop-removed interior view",
    "Sumi-e Zen ink wash, minimal brushstrokes, unmarked rice paper",
    "Japanese nihonga with mineral pigments and gold leaf ground",
    "Tibetan thangka technique with rigid symmetrical composition, flat mineral pigment in vermilion and turquoise, halo of gold flame pattern, fine-line detail",
    "Korean minhwa folk painting with flat stylized tigers or scholar's stationery",
    "Ethiopian Orthodox icon painting technique with flat frontal picture space, large-eyed stylized proportion, red-and-gold palette, fine linework on primed panel",
    "Ndebele painting technique with bold black-outlined geometric blocks, flat saturated color, architectural surface application",
    "Aboriginal Australian dot-painting technique with dense dotted pigment application, radial and linear patterning, earth-pigment palette",
    "Navajo sand-painting technique with symmetrical radial composition, earth-pigment color laid on flat ground, bold geometric shape",
    "Haida formline drawing technique with ovoid and U-shape building blocks, bold red-and-black two-color palette, interlocking positive/negative shape",
    "Mexican muralist style in the tradition of Rivera, Orozco, Siqueiros, monumental figures and social narrative",
    "Huichol yarn-on-beeswax technique with tight parallel yarn lines, saturated psychedelic color, bold flat symmetric patterning",
    "Dutch Golden Age chiaroscuro, Rembrandt-tradition portraiture, deep shadow, warm key light",
    "Vermeer-style Dutch interior with cool north-window light and precise still-life objects",
    "Baroque tenebrism in the Caravaggio manner, theatrical spotlighting from offscreen",
    "Pre-Raphaelite oil with botanical precision and saturated jewel tones",
    "Tonalist oil sketch, narrow value range, earth pigments, atmospheric haze",
    "Hudson River School landscape with luminous sky and sublime scale",
    "Impressionist plein air in the tradition of Monet, broken color, dappled light",
    "Post-impressionist impasto with thick palette-knife strokes",
    "Sorolla Spanish luminism, beach light, loose confident brushwork",
    "Fauvist flat areas of non-naturalistic color, Matisse tradition",
    "Cubist faceted-plane analysis in Picasso/Braque mode, muted palette",
    "Surrealist dreamscape with uncanny scale shifts in the Dalí or Magritte mode",
    "Abstract Expressionist action painting, gestural drips, large scale",
    "Nabi decorative flatness, Bonnard/Vuillard patterning",
    "Hopper-style American realism, stark shadows, isolated figures in empty architecture",
    "Frida Kahlo painting technique with flat folk-tradition figuration, saturated primary palette, symbolic still-life elements arranged around the subject",
    "Wifredo Lam painting technique in the Afro-Cuban modernist mode, cubist-influenced faceted forms, muted jungle-green and ochre palette",
    "Byzantine icon with gold ground, stylized elongated figures, flat hierarchic space",
    "Russian iconography in the Andrei Rublev tradition, soft tempera, luminous flesh tones"
  ],
  illustration: [
    "Ukiyo-e woodblock technique in the Hokusai manner with bold black keyblock outline, flat areas of mineral pigment, Prussian blue accent, decorative compositional rhythm",
    "Ukiyo-e print technique in the Utamaro manner with elongated stylized proportion, richly patterned flat color areas, delicate keyblock linework",
    "Ukiyo-e print technique in the Hiroshige manner with stylized atmospheric color blocks, graded sky wash, rhythmic linear pattern",
    "Shin-hanga 20th-century Japanese print with Western perspective and moody lighting",
    "Sōsaku-hanga creative print, sole-artist carving, expressive gouge marks",
    "Chinese Suzhou woodblock print, Ming-Qing era, hand-colored bright pigments",
    "Ten Bamboo Studio multi-color block-printed album of flowers and birds",
    "Mianzhu folk New Year woodblock with bold auspicious figures",
    "Dürer-style Renaissance woodcut technique with dense cross-hatch, fine keyblock linework, high tonal contrast from pure white to deep black",
    "Chiaroscuro woodcut in the Ugo da Carpi manner, tonal color-block registration",
    "Edmund Evans color wood-block book illustration, Walter Crane/Kate Greenaway lineage",
    "Art Nouveau poster in the Mucha tradition, ornamental linework and muted flat color",
    "Art Deco poster in the Cassandre manner, streamlined geometry, airbrushed gradient",
    "Risograph print with registration offset, limited spot colors, grainy fill",
    "Silkscreen/screenprint with flat inks and halftone dot fills",
    "Linocut with confident knife-mark texture and bold contrast",
    "Ligne claire comic inking in the Hergé/Tintin tradition, even line weight, flat color",
    "Moebius European bande dessinée with intricate line and surreal landscape",
    "Gekiga adult Japanese comic with heavy hatching and noir mood",
    "Shoujo manga with decorative screentones, large eyes, floral backgrounds",
    "Seinen noir manga with dense crosshatch and hard shadow",
    "1960s children's book gouache in the Richard Scarry or Mary Blair mode",
    "1970s pulp paperback cover painting, airbrushed detail, saturated drama",
    "Push Pin Studios illustration in the Milton Glaser mode, flat color, psychedelic lettering",
    "1960s psychedelic concert poster, swirling organic lettering, vibrating complementary colors",
    "Polish poster school, expressive painterly illustration with surreal metaphor",
    "Cuban ICAIC film poster, flat silkscreen color, folk-political imagery",
    "Soviet propaganda poster in the Rodchenko mode, diagonal photomontage, red and black",
    "Saul Bass film-title graphic, cut-paper silhouette with bold color",
    "Emory Douglas-style political newspaper rendering with stark high-contrast black-and-white linework, bold flat color accent, poster-scale simplified silhouette",
    "Indian Rangoli floor design with symmetric geometric pattern in pigmented powder",
    "Islamic geometric zellij tile pattern, interlocking stars and polygons",
    "Persian manuscript border illumination with arabesque vine and gold",
    "Ethiopian magic scroll with stylized figures and talismanic lettering",
    "Papel picado cut-paper rendering with crisp silhouette cutouts, flat saturated color, lace-like perforation pattern",
    "Posada-style engraving rendering with crisp black linework, flat color fills, dense newspaper-era mark-making",
    "Soviet Constructivist book cover by Rodchenko with diagonal type and photomontage",
    "Scratchboard illustration with fine white lines on black background",
    "Pen-and-ink stippled editorial illustration in the Wall Street Journal hedcut style",
    "Watercolor children's book in the Beatrix Potter manner, soft washes, delicate contour"
  ],
  animation: [
    "Studio Ghibli hand-painted watercolor backgrounds with detailed nature and pastel palette",
    "Studio Ghibli-adjacent Takahata Princess Kaguya soft-watercolor storybook mode",
    "Cartoon Saloon-style 2D rendering with geometric interlacing pattern decoration, flat saturated color fills, bold simplified silhouette",
    "Cartoon Saloon Wolfwalkers-style rendering with loose charcoal-drawn linework, hand-inked flat color fills, rough-paper paper texture",
    "Laika stop-motion with 3D-printed facial replacement, painterly miniature sets",
    "Aardman Animations British clay stop-motion in the Wallace and Gromit tradition",
    "Henry Selick dark puppet stop-motion with gothic miniature architecture",
    "Jan Švankmajer Czech stop-motion with found-object collage and uncanny texture",
    "Quay Brothers stop-motion in dusty amber light with decayed materials",
    "Pixar photoreal CGI with rich subsurface scattering and emotional lighting",
    "DreamWorks 3D animation with exaggerated character shapes and cinematic lighting",
    "Spider-Verse-style 2D/3D hybrid rendering with halftone dot patterns, chromatic aberration offsets, comic-panel linework and onomatopoeia flourishes",
    "Arcane painterly 3D with visible brushstroke texture and hand-painted look over 3D geometry",
    "Late-80s/early-90s Disney-era hand-drawn 2D rendering with clean keyblock outline, painted cel-style flat color, soft painted backgrounds",
    "Eyvind Earle-style rendering with flat decorative tapestry-like color areas, sharp geometric foliage silhouettes, gothic-arch compositional rhythm",
    "Richard Linklater rotoscope animation over live-action reference",
    "Ralph Bakshi rotoscoped fantasy with painterly gouache backgrounds",
    "Toei anime in the Dragon Ball / Sailor Moon mode, flat cel shading, high-contrast action",
    "Studio Trigger anime with saturated colors, bold linework, exaggerated action",
    "MAPPA / Ufotable compositing with painted-in rim light and particle VFX",
    "Satoshi Kon anime with grounded adult realism and unsettling editing",
    "Makoto Shinkai anime with hyper-detailed lit backgrounds and god-ray atmosphere",
    "Masaaki Yuasa fluid hand-drawn anime with loose proportion and surreal transformation",
    "UPA mid-century flat limited animation in the 1950s Gerald McBoing-Boing style",
    "Fleischer rubber-hose 1930s black-and-white cartoon with bouncy physicality",
    "Marvel/DC comic panel coloring with Ben-Day dots and bold ink outline",
    "Frank Miller-style comic rendering with high-contrast pure-black silhouettes, sparse spot-red accents, heavy negative space",
    "Watercolor indie comic in the David Mack Kabuki manner, loose painterly pages",
    "Mignola-style comic rendering with heavy black shadow shapes defining form, flat color held within the shapes, angular geometric poses",
    "French/Belgian bande dessinée album page, structured panel grid, precise color",
    "Cartoon Network Adventure Time loose wobbly-outline 2D with pastel backgrounds",
    "Rick and Morty style wobbly outline with oversized features and deadpan color",
    "Love Death and Robots anthology-range, photoreal to stylized 2D",
    "French Ernest et Célestine watercolor-outline storybook 2D",
    "Flow / Latvian 3D animation with minimalist painterly surfaces"
  ],
  cinematography: [
    "Roger Deakins natural-source lighting with controlled shadow and innovative color, Blade Runner 2049 sulfur-haze and silver-winter register",
    "Roger Deakins sepia monochromatic grade in the Shawshank / Assassination of Jesse James mode",
    "Emmanuel Lubezki floating long takes with wide-angle lens and natural light, Tree of Life / Revenant mode",
    "Christopher Doyle smushy subjectivism and neon sadness, Wong Kar-wai handheld layered clutter",
    "Christopher Doyle step-printing blur and saturated mirror-surface reflection in the Chungking Express mode",
    "Vittorio Storaro Technicolor-inspired color theory with expressive key-hue staging, Apocalypse Now / Last Emperor",
    "Gordon Willis low-key chiaroscuro, overhead practical key light, Godfather Prince of Darkness mode",
    "John Alcott candlelit Barry Lyndon with period lens and no-electric sources, diffusion filters",
    "John Alcott / Kubrick one-point symmetry with wide-angle framing, Shining and 2001 mode",
    "Hoyte van Hoytema practical effects with large-format IMAX detail, Interstellar / Dunkirk",
    "Darius Khondji deep-dish paintbox saturation in the Se7en / City of Lost Children mode",
    "Robert Richardson halo backlighting bouncing off subject's face",
    "Bradford Young warm naturalism and soft underexposure in Selma / Arrival",
    "Greig Fraser desaturated cool-neutral with heavy atmosphere, Dune / Batman mode",
    "Chung Chung-hoon punchy saturated color with elegant camera movement, Park Chan-wook collaboration",
    "Sayombhu Mukdeeprom natural tropical light with Weerasethakul / Guadagnino grounded texture",
    "Janusz Kamiński warm period grading with harsh backlit windows, Spielberg collaboration",
    "Rodrigo Prieto handheld documentary urgency with practical-light realism",
    "Bill Pope wire-fu bluish steel Matrix world with green digital cast",
    "Conrad Hall backlit hair and golden-hour warm low-angle, American Beauty mode",
    "Néstor Almendros natural magic-hour light in the Days of Heaven mode",
    "Michael Ballhaus Scorsese tracking shots with warm saloon-tungsten practical light",
    "Vilmos Zsigmond flashed-negative muted pastel, McCabe & Mrs. Miller mode",
    "Storaro/Bertolucci theatrical color-coded interior, Conformist mode",
    "Eric Gautier French handheld naturalism with pastel grading",
    "Jordan Cronenweth Blade Runner 1982 smoke-and-neon chiaroscuro",
    "Anamorphic 2.39:1 with characteristic oval bokeh and horizontal lens flare",
    "Academy 1.37:1 locked-off classical framing",
    "Handheld vérité with motion-blur and rolling-shutter skew",
    "Steadicam floating follow through architectural space",
    "Dogme 95 handheld available-light grit with no artificial sources",
    "Neo-noir wet-street sodium-vapor reflection with rain haze",
    "Giallo saturated magenta-and-teal Dario Argento horror lighting",
    "Technicolor three-strip vivid primary color, Wizard of Oz / Singin' in the Rain mode"
  ],
  graphic_design: [
    "Bauhaus geometric primary-color poster, sans-serif Futura/Kabel, asymmetric composition",
    "Russian Constructivist poster in the Rodchenko/Lissitzky mode, red-and-black diagonal photomontage",
    "Suprematist flat geometric composition in the Malevich mode, pure shape and primary color",
    "De Stijl red-yellow-blue grid with heavy black rules in the Mondrian manner",
    "Swiss International Typographic Style with Akzidenz-Grotesk/Helvetica on a tight grid, flush-left ragged right",
    "Memphis Group 1981 Sottsass playful eclectic with zigzags, squiggles, and terrazzo speckle",
    "Wolfgang Weingart Swiss Punk / New Wave typography with layered type and disrupted grid",
    "Push Pin Studios illustration-led design in the Milton Glaser / Seymour Chwast manner",
    "Art Nouveau Mucha poster with arched frame and ornamental flowing hair",
    "Art Deco Cassandre streamlined transportation poster, airbrush gradients, geometric type",
    "Italian Futurist typography with explosive word-lines in the Marinetti mode",
    "Dada photomontage with cut-paper fragmentation and ransom-note type",
    "Wiener Werkstätte geometric patterns with black-and-white grid motifs",
    "Brutalist graphic design with raw exposed elements, crude oversized type, asymmetric layout",
    "Cuban ICAIC film poster in the Niko / Reboiro / Azcuy tradition, silkscreen flat color, political metaphor",
    "Polish poster school, painterly surreal metaphor, hand-painted title type",
    "Grapus French collective poster with collaged political graphic energy",
    "Japanese graphic design in the Ikko Tanaka / Yusaku Kamekura mode, flat bold graphic with geometric face",
    "Chinese graphic design blending Western modernism with calligraphic ink",
    "Vignelli modernist American corporate identity in the NYC Subway / Helvetica tradition",
    "Tibor Kalman editorial irony with juxtaposition, Colors magazine mode",
    "Saul Bass cut-paper title sequence with bold silhouette and limited palette",
    "Paula Scher bold typographic Public Theater poster with colossal wood-type blocks",
    "Barbara Kruger declarative red-box-and-Futura-Bold Extended overlay on black-and-white photo",
    "David Carson Ray Gun magazine chaotic grid with overlapping type and disruptive layout",
    "Vaughan Oliver 4AD album cover with experimental photography and impressionistic type",
    "Peter Saville Factory Records minimalism with austere typography and restrained color"
  ],
  digital_3d: [
    "Octane photoreal CGI with global illumination, chrome reflections, and physical-material accuracy",
    "Arnold ray-traced render with subsurface skin scattering and studio HDRI lighting",
    "Unreal Engine 5 real-time render with Lumen GI, Nanite detail, slight cinematic bloom",
    "V-Ray architectural render with cool neutral GI and sharp glass reflections",
    "Blender Cycles photoreal product render with studio softbox lighting",
    "Matte concept painting in the Syd Mead / Feng Zhu tradition, soft edges, atmospheric perspective",
    "Low-poly flat-shaded 3D with faceted geometry and pastel gradient sky",
    "Cel-shaded 3D with hand-inked outline and flat anime-style fill",
    "Arcane-style painterly 3D with hand-painted texture over 3D geometry, visible brushstrokes",
    "Gorillaz-style 2D-on-3D compositing with flat graphic character on photoreal background",
    "Voxel art with cubic block construction in the MagicaVoxel aesthetic",
    "Pixel art in a specific era — 8-bit NES palette, 16-bit Super Famicom, or 32-bit CPS-2 arcade",
    "Generative algorithmic art with code-driven geometric iteration",
    "Point-cloud LIDAR scan with dotted surface reconstruction",
    "Wireframe schematic with transparent surfaces and vector-grid background",
    "Clay render with uniform neutral matte material showing pure form and light",
    "Photogrammetry scan with real-world texture and slight mesh artifacts",
    "ASCII art character-grid rendering of the scene",
    "Retro CRT vaporwave aesthetic with scanlines, chromatic aberration, and glitch offset",
    "Houdini FX rigid-body destruction with volumetric dust and debris",
    "RenderMan Pixar-style physical render with soft shadows and bounce light",
    "Cinema 4D product visualization with gradient-infinity backdrop and rim light",
    "Glitched digital corruption with datamoshed color blocks and scan errors",
    "Early CGI 1990s aesthetic with gouraud-shaded low-detail models and reflective chrome",
    "Isometric 3D illustration with flat color, long shadow, and Monument Valley depth",
    "Risograph-over-3D with grainy two-tone finish applied to rendered geometry"
  ],
  lighting: [
    "Rembrandt key lighting with triangular light on the far cheek and deep shadow on the near side",
    "Clamshell beauty lighting, twin sources from above and below, minimal shadow, even skin",
    "Split lighting with one side in full light and the other in full shadow",
    "Rim-lit silhouette with bright edge outline against a dark surround",
    "Chiaroscuro Caravaggio key light from upper-left with rapidly falling shadow",
    "Golden hour warm low-angle with long shadows and hazy backlight",
    "Blue hour cool ambient twilight, practical lights beginning to glow",
    "Overcast diffused sky as giant softbox, shadowless, slightly cool",
    "Sodium-vapor streetlight, amber-orange cast, high-color-temperature sky fill",
    "Mercury-vapor industrial light, greenish cool color",
    "Tungsten practical lamp in the frame as motivated warm key",
    "Fluorescent office light with green cast and hard overhead shadow",
    "Neon signage as key light with saturated magenta or cyan on face",
    "Candlelight only in the Barry Lyndon Alcott mode, warm flicker from below frame",
    "Firelight with warm flickering rim and dancing shadow",
    "Moonlight cool directional key with deep star-dotted sky",
    "Volumetric god-rays cutting through dusty air or mist",
    "Underwater caustics with wavering light patterns on subject",
    "Stage spotlight with hard circular pool of light and falloff darkness",
    "Window light with lace-curtain dappled pattern",
    "Bioluminescent underlight from below in cool cyan or green",
    "Thunderstorm strobing flash with momentary high-contrast reveal",
    "Snow-bounce fill, soft high-key with blue shadow tones",
    "Dappled forest light with sharp beams between leaves",
    "Sunrise rim-backlight with flare halos and lens ghosting",
    "High-noon hard overhead with deep self-shadow and bleached highlights",
    "Neon-wet-street reflection off rain-soaked asphalt",
    "Incandescent bare-bulb single-source hard shadow with warm spill"
  ],
  color: [
    "Split-toning with teal shadows and amber highlights, Hollywood-blockbuster orange-and-teal grade",
    "Kodak Vision3 warm-cool cinema color science with natural skin tones",
    "Cross-processed E-6-in-C-41 with shifted shadow hues and boosted contrast",
    "Bleach-bypass desaturation with retained silver and crushed shadows",
    "Muted Wes Anderson-adjacent palette of dusty pink, mustard, and sage",
    "Oversaturated Kodachrome vintage slide palette with deep reds and blues",
    "Monochrome silver-gelatin print tonal range with full black to paper white",
    "Duotone print with two-color spot palette, e.g. black and Pantone red",
    "Risograph two-color overprint with visible registration offset and grainy fill",
    "Night scene in deep cyan and magenta neon contrast",
    "Earth-pigment palette with ochre, umber, raw sienna, and lead white",
    "Fauvist non-naturalistic saturated flat planes, green faces and orange trees",
    "Hopper palette of muted warm lamp-yellow against deep cool shadow",
    "Early technicolor three-strip vivid primaries with rich ruby reds",
    "Instagram filter-era muted teal-olive with faded blacks",
    "High-contrast grayscale with no mid-tones, Sin City aesthetic",
    "Pastel dream palette of soft pink, lavender, cream, and baby blue",
    "Autumnal warm palette with burnt orange, mustard yellow, deep maroon",
    "Arctic cool palette with white, ice blue, slate, and frost",
    "Desaturated wartime documentary palette with slight green shift",
    "Nan Goldin flash-saturated snapshot palette with red-eye and warm indoor mix",
    "Indian textile-inspired palette of saffron, indigo, vermilion, gold",
    "Japanese shibui restrained palette with muted earth tones and subtle accent",
    "Pantone-perfect graphic-design flat spot colors with no gradient"
  ]
};

// Placeholder tokens that prompts can use to inject rotated examples.
// At generate-time, each placeholder is replaced with a random subset (default 4)
// from the corresponding pool category, joined like "A; B; C; D".
const _EPE_AESTHETIC_PLACEHOLDERS = {
  "{{PHOTO_EXAMPLES}}":        "photographic",
  "{{PAINTING_EXAMPLES}}":     "painting",
  "{{ILLUSTRATION_EXAMPLES}}": "illustration",
  "{{ANIMATION_EXAMPLES}}":    "animation",
  "{{CINEMA_EXAMPLES}}":       "cinematography",
  "{{GRAPHIC_EXAMPLES}}":      "graphic_design",
  "{{DIGITAL_EXAMPLES}}":      "digital_3d",
  "{{LIGHTING_EXAMPLES}}":     "lighting",
  "{{COLOR_EXAMPLES}}":        "color"
};

// Pick N random items from an array without replacement. If N >= array length,
// returns a shuffled copy of the whole array.
function _epePickRandomN(arr, n) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const copy = arr.slice();
  const take = Math.min(n, copy.length);
  // Fisher–Yates partial shuffle
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    const tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp;
  }
  return copy.slice(0, take);
}

// ── Style pool rules ─────────────────────────────────────────────────────────
// Per target style: which tradition categories feed the rotating menus
// (exclude = those bullet lines removed), plus dedicated lighting/color pools
// replacing the global ones. The pool — the strongest steering channel —
// carries the style instead of an addendum arguing with random anchors.
// Mirrored in api.py (_EPE_STYLE_POOL_RULES).
const _EPE_STYLE_POOL_RULES = {
  midjourney: {
    exclude: ["photographic", "graphic_design", "animation"],
    lighting: [
      "volumetric god rays breaking through mist",
      "dramatic chiaroscuro with deep luminous shadow",
      "golden-hour rim light with atmospheric haze",
      "bioluminescent glow against dusk",
      "shafts of dusty light in a dark interior",
    ],
    color: [
      "deeply saturated jewel tones with rich shadow color",
      "teal-and-gold complementary grade",
      "iridescent highlights over moody desaturated midtones",
      "ember-warm palette against cool atmospheric depth",
      "luminous pastels dissolving into darkness",
    ],
  },
  dalle: {
    exclude: ["photographic", "cinematography"],
    lighting: [
      "soft directional key with gentle wraparound fill",
      "even friendly daylight, shadows soft and open",
      "warm lamplight with clean ambient bounce",
      "bright overcast with no hard edges",
      "cheerful morning sun through a window",
    ],
    color: [
      "vibrant but harmonious palette, no clashing hues",
      "warm inviting tones with clean white breathing room",
      "candy-bright accents over soft neutrals",
      "storybook palette of friendly saturated primaries",
      "gentle pastel wash with one bold accent color",
    ],
  },
  gemini: {
    exclude: ["painting", "illustration", "animation", "graphic_design", "digital_3d"],
    lighting: [
      "natural available daylight, unmodified",
      "soft overcast with true-to-life shadow falloff",
      "window light with realistic ambient bounce",
      "open shade, even and neutral",
      "late-afternoon sun at a believable angle",
    ],
    color: [
      "neutral true-to-life color, no visible grade",
      "accurate white balance with natural saturation",
      "documentary-neutral palette, faithful skin tones",
      "as-shot color with mild contrast",
      "clean daylight color rendition",
    ],
  },
  meta: {
    exclude: ["painting", "illustration", "animation", "graphic_design"],
    lighting: [
      "golden-hour glow with soft directional warmth",
      "magic-hour backlight with gentle halation",
      "warm window light with dreamy falloff",
      "soft key with amber practicals in the background",
      "hazy late sun with gentle lens bloom",
    ],
    color: [
      "warm moderate saturation with soft contrast",
      "honeyed golden palette with natural skin tones",
      "gentle warm grade, slightly lifted blacks",
      "sun-washed tones with creamy highlights",
      "amber-and-teal but restrained, grounded",
    ],
  },
  photorealistic: {
    exclude: ["painting", "illustration", "animation", "graphic_design", "digital_3d", "cinematography"],
    lighting: [
      "Rembrandt key with soft fill, catchlight in the eyes",
      "single large softbox at 45 degrees, gentle falloff",
      "hard direct sunlight with crisp true shadows",
      "north-window light, painterly but real",
      "three-point studio setup with subtle rim separation",
    ],
    color: [
      "faithful film-stock color, Portra-like skin rendition",
      "neutral grade with true blacks and unclipped highlights",
      "natural daylight balance, realistic saturation",
      "subtle warm bias, accurate fabric and skin tones",
      "clean colorimetric accuracy, no stylized grade",
    ],
  },
  cinematic: {
    exclude: ["painting", "illustration", "animation", "graphic_design", "digital_3d"],
    lighting: [
      "motivated practicals with low-key falloff",
      "sodium-vapor streetlight against blue dusk",
      "hard slash of light through venetian blinds",
      "soft toplight with negative fill, moody contrast",
      "backlit smoke with anamorphic flare",
    ],
    color: [
      "teal-orange complementary grade",
      "blue-graded night with warm practical accents",
      "bleach-bypass desaturation with hard contrast",
      "desaturated naturals, filmic contrast curve",
      "monochrome-leaning grade with one saturated accent",
    ],
  },
  anime: {
    exclude: ["photographic", "painting", "graphic_design", "digital_3d", "cinematography"],
    lighting: [
      "cel-style two-tone shadow shapes with hard terminator",
      "gradient dusk sky glow behind the subject",
      "lens bloom off highlights, anime-style flare",
      "god rays through clouds in flat graded bands",
      "rim light drawn as a clean bright edge line",
    ],
    color: [
      "flat cel color with saturated fills and clean edges",
      "Shinkai-style luminous sky gradients",
      "Ghibli-warm naturals with painterly background softness",
      "high-key pastel palette with pop accents",
      "dramatic seinen palette, desaturated with blood-red accent",
    ],
  },
  conceptArt: {
    exclude: ["photographic", "graphic_design", "animation"],
    lighting: [
      "mood-first atmospheric light, forms dissolving in haze",
      "single strong value read: dark silhouette against glowing sky",
      "bounce light blocked in loose planes",
      "rim-lit silhouette with unfinished edges",
      "overcast value study, local color suppressed",
    ],
    color: [
      "limited three-color palette, value-first",
      "muted earth gamut with one saturated focal note",
      "gouache-like opaque color with visible strokes",
      "desaturated blues and grays with warm story accent",
      "monochromatic underpainting peeking through",
    ],
  },
};

// Substitute every {{CATEGORY_EXAMPLES}} token in `text` with a freshly-picked
// random subset from the corresponding pool category. Called once per generate.
// Safe to call on prompts that don't contain any placeholders — returns unchanged.
// styleId (optional): applies _EPE_STYLE_POOL_RULES — excluded tradition
// categories have their menu lines removed; custom lighting/color pools
// replace the global ones.
function _epeApplyAestheticRotation(text, perCategory, styleId) {
  if (typeof text !== "string" || text.length === 0) return text;
  const n = Math.max(1, Math.min(10, perCategory || 4));
  const rules = (styleId && styleId !== "default" && _EPE_STYLE_POOL_RULES[styleId]) || null;
  let out = text;
  for (const [token, category] of Object.entries(_EPE_AESTHETIC_PLACEHOLDERS)) {
    if (out.indexOf(token) === -1) continue;
    if (rules && rules.exclude && rules.exclude.indexOf(category) !== -1) {
      // Remove the entire menu line(s) containing this token.
      out = out.split("\n").filter(l => l.indexOf(token) === -1).join("\n");
      continue;
    }
    let pool = _EPE_AESTHETIC_POOL[category] || [];
    if (rules && category === "lighting" && rules.lighting) pool = rules.lighting;
    if (rules && category === "color" && rules.color) pool = rules.color;
    const picks = _epePickRandomN(pool, n);
    const replacement = picks.length
      ? picks.join("; ")
      : "(aesthetic examples unavailable)";
    // Replace all occurrences of this token
    out = out.split(token).join(replacement);
  }
  return out;
}

// ── Ollama AI system ─────────────────────────────────────────────────────────
const _epeOllama = {
  // Default settings
  _defaults: {
    url: "http://localhost:11434",
    model: "",
    expandPrompt: `You write image generation prompts for modern open-weight diffusion models (Flux 2, Qwen-Image, Z-Image, and similar). These models reward specificity and committed aesthetic choices, not keyword soup.

The user will give you a brief description. Expand it into one complete image generation prompt. Where they left gaps, fill them with commitments, not generic coverage.

SUBJECT PRESERVATION — hard rule. The subject the user wrote is locked. Every named thing — animal, object, person, place, count, action, pose — must survive unchanged. Apply the aesthetic TO the user's subject; never swap the subject to match the aesthetic.

- User wrote "elephant" → output says elephant, not jaguar or "a sacred creature."
- User wrote "three children playing chess" → three children, playing chess. Not two, not checkers.

If a tradition implies a different subject, apply its technique to the user's actual subject.

IMMERSIVE VISUAL DETAIL — every noun earns concrete visible detail. Flesh out what the user left generic.

- Generic "lawn" → neatly edged, lush emerald green, freshly mowed with visible stripes, meeting a brick path.
- Generic "woman" → age range, eye color, hair color and style, expression, posture, fabric and cut of clothing, what her hands are doing. DO NOT invent ethnicity, religion, nationality, or other identity-defining traits the user didn't specify.
- Surfaces get ACTIVE behavior: subsurface scattering catching the ear, fabric fibers picked out in rim light, wet asphalt holding oil-slick rainbow.

The rendering tradition you pick isn't just named — its vocabulary describes the scene.

ENCODER RULES — written for diffusion text encoders:
- The FIRST sentence names the subject and the rendering tradition.
- Direct declarative description only. Never "The scene captures," "The composition utilizes," "creating a sense of."
- State what IS there. Never describe by absence — "no harsh shadows" becomes "soft diffuse shadows."
- Place elements spatially: "to her left," "lower foreground," "behind the fence."
- Words the user wants rendered as text in the image stay in "double quotes" verbatim.

Pick ONE rendering tradition and commit. Example anchors (rotating — use one, combine, or invent similar):
• photographic: {{PHOTO_EXAMPLES}}
• painting: {{PAINTING_EXAMPLES}}
• illustration/print: {{ILLUSTRATION_EXAMPLES}}
• graphic-design/poster: {{GRAPHIC_EXAMPLES}}
• cinematography: {{CINEMA_EXAMPLES}}
• animation/comic: {{ANIMATION_EXAMPLES}}
• digital/3D: {{DIGITAL_EXAMPLES}}

Pair with specific lighting (direction, hardness, color) — anchors: {{LIGHTING_EXAMPLES}}. And specific color treatment — anchors: {{COLOR_EXAMPLES}}. Give composition a reason ("right-aligned against negative space," not "balanced").

Empty quality words ("beautiful," "detailed," "stunning," "masterpiece," "4k/8k," "award-winning") → replace with the concrete quality or detail you mean, or delete.

Write one flowing paragraph of 170-190 words. Plain descriptive prose. No keyword lists, no comma-stacks, no parentheses weighting, no markdown.

Output ONLY the expanded prompt paragraph. No preamble, no explanation, no <think> tags.`,
    variationsPrompt: `You write image generation prompts for modern open-weight diffusion models (Flux 2, Qwen-Image, Z-Image, and similar). You will receive an existing prompt. Produce 3 variations that keep the same subject but each commits to a completely different aesthetic tradition.

Each variation should feel like a genuinely different creative vision of the same moment, not a tonal nudge. The subject stays intact; the visual world changes entirely.

SUBJECT PRESERVATION — hard rule, across all three variations. Every named thing in the source — animal, object, person, place, count, action, pose — must appear unchanged in every variation.

- Source says "elephant" → all three variations say elephant, not a jaguar.
- Source says "three children playing chess" → all three have three children playing chess.

If a tradition implies a different subject, pick another or apply its technique to the actual subject.

IMMERSIVE VISUAL DETAIL — every noun earns concrete visible detail, in every variation. Generic "lawn" → neatly edged, lush emerald green, freshly mowed. Generic "woman" → age range, eye color, hair, expression, posture, fabric and cut of clothing. DO NOT invent ethnicity, religion, or identity-defining traits the user didn't specify. Surfaces get active behavior: subsurface scattering, fabric fibers in rim light, wet asphalt holding oil-slick rainbow. The rendering tradition you pick isn't just named — its vocabulary describes the scene.

ENCODER RULES — written for diffusion text encoders:
- Each variation's FIRST sentence names the subject and the rendering tradition.
- Direct declarative description only. Never "The scene captures" or "creating a sense of."
- State what IS there. Never describe by absence — "no harsh shadows" becomes "soft diffuse shadows."
- Place elements spatially: "to her left," "lower foreground."
- Words meant to render as text in the image stay in "double quotes" verbatim.

For each of the three variations, pick ONE aesthetic tradition and commit fully. The three traditions must differ from each other AND from the source's tradition. Rotating anchors (use, combine, or invent similar):
• photographic: {{PHOTO_EXAMPLES}}
• painting: {{PAINTING_EXAMPLES}}
• illustration/print: {{ILLUSTRATION_EXAMPLES}}
• graphic-design/poster: {{GRAPHIC_EXAMPLES}}
• cinematography: {{CINEMA_EXAMPLES}}
• animation/comic: {{ANIMATION_EXAMPLES}}
• digital/3D: {{DIGITAL_EXAMPLES}}

Lighting and color follow from the tradition. Lighting anchors (rotating): {{LIGHTING_EXAMPLES}}. Color anchors (rotating): {{COLOR_EXAMPLES}}.

Empty quality words ("beautiful," "detailed," "stunning," "masterpiece," "4k/8k") → replace with the concrete quality or detail you mean, or delete.

Write each variation as one flowing paragraph of 170-190 words. Plain descriptive prose. No keyword lists, no parentheses weighting, no markdown.

Output EXACTLY this format:
1. [first variation]
2. [second variation]
3. [third variation]

No preamble, no explanation, no <think> tags, no headers.`,
    img2imgPrompt: `You write image generation prompts for modern open-weight diffusion models (Flux 2, Qwen-Image, Z-Image, and similar). The user has provided an image. Describe what is actually visible, with enough specificity that the resulting prompt could recreate the look.

VISIBLE-SUBJECT FIDELITY — hard rule. Describe the actual subject(s) in the image. Do not substitute similar-looking things, do not upgrade to sound evocative, and do not let an aesthetic tradition you recognize pull the subject toward that tradition's typical content.

- Image shows an elephant → say elephant. Not jaguar, not "a sacred creature."
- Image shows a coffee cup → say coffee cup. Not "a vessel."
- Image shows three people → say three. Not two, not four.

The tradition is the HOW, not the WHAT. Name the tradition to describe technique; describe the subject that is actually there.

IMMERSIVE VISUAL DETAIL — describe every visible noun with concrete detail. Don't abstract away. Observed "lawn" → describe its edging, color, mow pattern, condition. Observed "woman" → age range visible, eye color, hair, expression, posture, fabric and cut of clothing, what her hands are doing. DO NOT invent ethnicity, religion, or identity-defining traits not visibly clear in the image. Observed "window" → leaded pane or modern, what's on the sill, light quality. Surfaces get active behavior: what does the material do under the observed light.

ENCODER RULES — written for diffusion text encoders:
- The FIRST sentence names the subject and the rendering tradition.
- Direct declarative description only. Never "The scene captures" or "creating a sense of."
- State what IS there. Never describe by absence — "no harsh shadows" becomes "soft diffuse shadows."
- Place elements spatially: "to her left," "lower foreground."
- Words meant to render as text in the image stay in "double quotes" verbatim.

Identify and name the specific tradition visible in the image. If it looks like film photography, name plausible film stock and lens behavior. If it looks like a painting, name the likely medium and tradition. Rotating anchors (match against, or name a similar one):
• photographic: {{PHOTO_EXAMPLES}}
• painting: {{PAINTING_EXAMPLES}}
• illustration/print: {{ILLUSTRATION_EXAMPLES}}
• graphic-design/poster: {{GRAPHIC_EXAMPLES}}
• cinematography: {{CINEMA_EXAMPLES}}
• animation/comic: {{ANIMATION_EXAMPLES}}
• digital/3D: {{DIGITAL_EXAMPLES}}

Cover in one flowing paragraph of 170-190 words: rendering tradition and medium; the actual subject(s) with immersive detail; composition; environment; lighting — anchors: {{LIGHTING_EXAMPLES}}; color treatment — anchors: {{COLOR_EXAMPLES}}; surface texture behavior.

Empty quality words ("beautiful," "detailed," "stunning," "masterpiece," "4k/8k") → replace with the concrete quality or detail you mean, or delete.

Plain descriptive prose. No keyword lists, no parentheses weighting, no markdown. Describe only what is in the image.

Output ONLY the prompt paragraph. No preamble, no labels, no explanation, no <think> tags.`,
    invertPrompt: `You write image generation prompts for modern open-weight diffusion models (Flux 2, Qwen-Image, Z-Image, and similar). The user will give you an existing prompt. Produce a counterpart that reinterprets the source in a different aesthetic tradition — same creative energy, different visual world. Not a destructive reversal. Shadow, melancholy, and grit are welcome; wounds, ruin, horror, and despair are not.

SUBJECT PRESERVATION — hard rule. What changes is the AESTHETIC WORLD. What does NOT change is the subject. Every named thing in the source — animal, object, person, place, count, action, pose — must appear unchanged in the counterpart.

- Source says "elephant" → counterpart says elephant, in a different aesthetic.
- Source says "three children playing chess" → counterpart has three children playing chess.

If a tradition implies a different subject, pick another, or apply its technique to the user's actual subject.

IMMERSIVE VISUAL DETAIL — every noun earns concrete visible detail in the counterpart, same as the source. Generic "woman" → age range, eye color, hair, expression, posture, clothing. DO NOT invent ethnicity, religion, or identity-defining traits not in the source. Surfaces get active behavior: subsurface scattering, fabric fibers in rim light, impasto brushstrokes — whatever the new tradition's materials actually do.

ENCODER RULES — written for diffusion text encoders:
- The FIRST sentence names the subject and the rendering tradition.
- Direct declarative description only. Never "The scene captures" or "creating a sense of."
- State what IS there. Never describe by absence — "no harsh shadows" becomes "soft diffuse shadows."
- Place elements spatially: "to her left," "lower foreground."
- Words meant to render as text in the image stay in "double quotes" verbatim.

Approach:

1. Identify the source's primary tradition and tonal register.
2. Commit to a DIFFERENT named tradition for the counterpart. Rotating anchors (use, combine, or invent similar):
• photographic: {{PHOTO_EXAMPLES}}
• painting: {{PAINTING_EXAMPLES}}
• illustration/print: {{ILLUSTRATION_EXAMPLES}}
• graphic-design/poster: {{GRAPHIC_EXAMPLES}}
• cinematography: {{CINEMA_EXAMPLES}}
• animation/comic: {{ANIMATION_EXAMPLES}}
• digital/3D: {{DIGITAL_EXAMPLES}}

3. Pair with one supporting tonal shift. Lighting anchors (rotating): {{LIGHTING_EXAMPLES}}. Color anchors (rotating): {{COLOR_EXAMPLES}}.

4. Carry the commitment through the description. If counterpart is sumi-e ink wash, describe ink bleeding into rice paper, the economy of brushstrokes.

A firm commitment to one different tradition plus one supporting tonal shift beats nudging twelve dimensions slightly. Never rewrite the subject.

Empty quality words ("beautiful," "detailed," "stunning," "masterpiece," "4k/8k") → replace with the concrete quality or detail you mean, or delete.

Write one flowing paragraph of 170-190 words. Plain descriptive prose. No keyword lists, no parentheses weighting, no markdown.

Output ONLY the inverted prompt paragraph. No preamble, no explanation, no <think> tags.`
  },

  // Get stored settings from localStorage
  getSettings() {
    try {
      const stored = localStorage.getItem("epe_ollama_settings");
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...this._defaults, ...parsed };
      }
    } catch (e) { /* ignore */ }
    return { ...this._defaults };
  },

  // Save settings to localStorage
  saveSettings(settings) {
    try {
      localStorage.setItem("epe_ollama_settings", JSON.stringify(settings));
    } catch (e) { /* ignore */ }
  },

  // Clean LLM response — strip thinking tags, code blocks, etc.
  cleanResponse(text) {
    if (!text) return "";
    let cleaned = text;
    // Strip thinking/reasoning tags (greedy across newlines)
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, "");
    cleaned = cleaned.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "");
    cleaned = cleaned.replace(/<reflection>[\s\S]*?<\/reflection>/gi, "");
    cleaned = cleaned.replace(/<output>[\s\S]*?<\/output>/gi, function(m) {
      // Keep content inside <output> tags
      return m.replace(/<\/?output>/gi, "");
    });
    // Strip markdown code blocks
    cleaned = cleaned.replace(/```[\s\S]*?```/g, "");
    // Strip leading/trailing quotes
    cleaned = cleaned.replace(/^["']+|["']+$/g, "");
    // Collapse excessive whitespace
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
    return cleaned.trim();
  },

  // Parse numbered variations from response
  parseVariations(text) {
    const cleaned = this.cleanResponse(text);
    const lines = cleaned.split("\n").filter(l => l.trim());
    const variations = [];
    for (const line of lines) {
      // Match "1." or "1)" or "1:" or just numbered lines
      const match = line.match(/^\s*(\d+)[.):\-]\s*(.+)/);
      if (match) {
        variations.push(match[2].trim());
      }
    }
    // If no numbered lines found, try splitting by double newline
    if (variations.length === 0 && cleaned.length > 0) {
      const blocks = cleaned.split(/\n\n+/).filter(b => b.trim());
      if (blocks.length > 1) return blocks.map(b => b.trim());
      // Last resort: return as single variation
      return [cleaned];
    }
    return variations;
  },

  // Check if Ollama is reachable
  // Backend check: probes Ollama server-side (no browser CORS) and
  // auto-starts a local Ollama if it isn't running yet.
  async _backendCheck(url) {
    try {
      const resp = await fetch("/epe/ollama/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ollamaUrl: url || this.getSettings().url }),
        signal: AbortSignal.timeout(20000)
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      return null;
    }
  },

  async checkConnection(url) {
    const c = await this._backendCheck(url);
    return !!(c && c.running);
  },

  // Fetch available models (server-side via the backend — CORS-free)
  async fetchModels(url) {
    const c = await this._backendCheck(url);
    return (c && c.installedModels) || [];
  },

  // Generate text (non-streaming for simplicity)
  async generate(systemPrompt, userPrompt, opts = {}) {
    try {
      const out = await this._generateOnce(systemPrompt, userPrompt, opts);
      if (out && out.trim()) return out;
      // Empty response — retry once with a larger budget for thinking models.
      if (opts.onRetry) { try { opts.onRetry(); } catch (_e) {} }
      return await this._generateOnce(systemPrompt, userPrompt,
        { ...opts, onToken: null, options: { ...(opts.options || {}), num_predict: Math.max(1024, (opts.options && opts.options.num_predict) || 0) } });
    } catch (e) {
      if (e && e.message === "__EPE_THINKING_TRUNCATED__") {
        // Model burned its budget thinking — retry once at 1024 tokens.
        if (opts.onRetry) { try { opts.onRetry(); } catch (_e) {} }
        try {
          const out2 = await this._generateOnce(systemPrompt, userPrompt,
            { ...opts, onToken: null, options: { ...(opts.options || {}), num_predict: Math.max(1024, (opts.options && opts.options.num_predict) || 0) } });
          if (out2 && out2.trim()) return out2;
        } catch (e2) {
          if (e2 && e2.message === "__EPE_THINKING_TRUNCATED__") {
            const _f = new Error("The model spent its whole response thinking. Try a non-thinking model, or increase Length.");
            _f.thinking = e2.thinking || "";
            throw _f;
          }
          throw e2;
        }
      }
      throw e;
    }
  },

  async _generateOnce(systemPrompt, userPrompt, opts = {}) {
    const settings = this.getSettings();
    // Route through the ComfyUI backend so the browser never talks to Ollama
    // directly (avoids CORS when ComfyUI is opened from a non-localhost URL).
    const url = "/epe/ollama/generate";
    const model = opts.model || settings.model;
    if (!model) throw new Error("No model selected");
    
    // Create a combined abort: user cancel OR timeout (120s)
    const timeoutMs = 120000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    // If external signal provided, link it
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => controller.abort());
    }
    
    const onToken = opts.onToken || null; // callback(partialText) for streaming UI
    
    try {
      const body = {
          ollamaUrl: settings.url,
          model: model,
          system: systemPrompt,
          prompt: userPrompt,
          stream: true,
          keep_alive: (opts.keep_alive !== undefined) ? opts.keep_alive : 0,
          think: false,
          options: {
            temperature: opts.temperature || 0.7,
            // forward any extra Ollama options (top_p, top_k,
            // num_predict, min_p, seed, presence_penalty) supplied by callers.
            // Spread comes last so option fields here override the temperature
            // default above when the caller provides their own.
            ...(opts.options || {}),
          }
      };
      if (opts.images && opts.images.length > 0) {
        body.images = opts.images;
      }
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      
      if (!resp.ok) {
        clearTimeout(timeoutId);
        const errText = await resp.text().catch(() => "");
        throw new Error(`Ollama error ${resp.status}: ${errText}`);
      }
      
      // Stream NDJSON response
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = "";
      let fullThinking = "";
      let buffer = "";

      // Some thinking-capable models (e.g. qwen3-vl) ignore think:false and put
      // their answer in the separate "thinking" field, leaving "response" empty.
      // If that happens, fall back to any answer that follows a </think> marker
      // in the thinking stream, or the cleaned thinking text itself.
      const _fromThinking = () => {
        if (!fullThinking) return "";
        // Only trust thinking output if the model actually finished reasoning
        // (emitted </think>) and wrote an answer after it. An unterminated
        // thinking stream means the token budget ran out mid-thought — signal
        // that so the caller can retry with a larger budget.
        if (/<\/think>/i.test(fullThinking)) {
          const after = fullThinking.split(/<\/think>/i).pop();
          if (after && after.trim()) return after;
        }
        const _err = new Error("__EPE_THINKING_TRUNCATED__");
        _err.thinking = fullThinking;
        throw _err;
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // Reset timeout on each chunk (model is actively generating)
        clearTimeout(timeoutId);
        
        buffer += decoder.decode(value, { stream: true });
        
        // Parse complete JSON lines from buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep incomplete last line
        
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            if (chunk.response) {
              fullResponse += chunk.response;
              if (onToken) onToken(fullResponse);
            }
            if (chunk.thinking) fullThinking += chunk.thinking;
            if (chunk.done) {
              return fullResponse.trim() ? fullResponse : _fromThinking();
            }
          } catch (e) { /* skip malformed JSON lines */ }
        }
      }
      
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer);
          if (chunk.response) fullResponse += chunk.response;
          if (chunk.thinking) fullThinking += chunk.thinking;
        } catch (e) { /* ignore */ }
      }
      
      return fullResponse.trim() ? fullResponse : _fromThinking();
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  },

  // Unload model from VRAM/RAM
  async unloadModel() {
    try {
      const settings = this.getSettings();
      if (!settings.model) return;
      await fetch("/epe/ollama/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ollamaUrl: settings.url,
          model: settings.model,
          keep_alive: 0
        }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (e) {
      // Silently fail — cleanup is best-effort
    }
  }
};

// ── Ollama Vision ────────────────────────────────────────────────────────────
const _epeOllamaVision = {

  _ollamaUrl: "http://localhost:11434",

  // Style bridge — updated by the editor's style strip; sent with every
  // vision request so the server can style-filter its pool and apply the
  // safe slider subset (length, focus).
  _styleBridge: { style: "default", lengthSlider: 50, focusSlider: 50 },

  // Shared abort controller — cancels any in-flight vision request when a new one starts
  _abortController: null,

  _abortPrevious() {
    if (this._abortController) {
      try { this._abortController.abort(); } catch(e) {}
    }
    this._abortController = new AbortController();
    return this._abortController.signal;
  },
  async check() {
    try {
      const resp = await fetch("/epe/ollama/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ollamaUrl: this._ollamaUrl }),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch(e) { return null; }
  },

  // Show "Ollama not running" panel in the AI panel area.
  showNotRunning(showAiPanel, hideAiPanel) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:14px 16px;display:flex;flex-direction:column;gap:10px;";

    const title = document.createElement("div");
    title.style.cssText = "color:#6db8e8;font-size:11px;font-weight:600;";
    title.textContent = "⚠ Ollama Not Running";

    const msg = document.createElement("div");
    msg.style.cssText = "color:#8a9aac;font-size:10px;line-height:1.6;";
    msg.innerHTML =
      "Ollama must be running to use Image/Video to Prompt.<br><br>" +
      "<b style='color:#c2cddb;'>To install:</b> Visit <a href='https://ollama.com' target='_blank' " +
      "style='color:#8ab4f8;'>ollama.com</a> and download for your platform.<br><br>" +
      "<b style='color:#c2cddb;'>To start:</b> Run <code style='background:#1c2431;padding:1px 5px;" +
      "border-radius:3px;font-size:10px;'>ollama serve</code> in a terminal, " +
      "then pull a model:<br>" +
      "<code style='background:#1c2431;padding:1px 5px;border-radius:3px;font-size:10px;'>" +
      "ollama pull qwen3.5:4b</code>";

    const dismissBtn = document.createElement("button");
    dismissBtn.textContent = "Dismiss";
    dismissBtn.style.cssText =
      "align-self:flex-end;background:#1c2431;border:1px solid rgba(255,255,255,0.08);" +
      "border-radius:4px;color:#9aaaba;padding:4px 14px;cursor:pointer;font-size:11px;";
    dismissBtn.onclick = () => hideAiPanel();

    wrap.appendChild(title);
    wrap.appendChild(msg);
    wrap.appendChild(dismissBtn);
    showAiPanel(wrap);
  },

  // Show model picker panel. knownModels = [{name,diskGb,label}], installedModels = [str].
  // onSelect(modelName) called when user picks a model.
  showModelPicker(knownModels, installedModels, showAiPanel, hideAiPanel, onSelect) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:12px 14px;display:flex;flex-direction:column;gap:8px;";

    knownModels.forEach(m => {
      const isInstalled = installedModels.some(n => n === m.name || n.startsWith(m.name + ":"));
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:7px 10px;" +
        "background:#141a24;border:1px solid #1c2431;border-radius:4px;cursor:pointer;";
      row.onmouseenter = () => { row.style.borderColor = "#4e5c6e"; };
      row.onmouseleave = () => { row.style.borderColor = isInstalled ? "#1c2431" : "#1c2431"; };

      const dot = document.createElement("span");
      dot.style.cssText = `width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${isInstalled ? "#4c8" : "#4e5c6e"};`;

      const info = document.createElement("div");
      info.style.cssText = "flex:1;";

      const label = document.createElement("div");
      label.style.cssText = "color:#c2cddb;font-size:10px;font-weight:600;";
      label.textContent = m.label;

      const sub = document.createElement("div");
      sub.style.cssText = "color:#4e5c6e;font-size:9px;margin-top:1px;";
      sub.textContent = isInstalled ? "Installed" : `~${m.diskGb} GB — click to download`;

      info.appendChild(label);
      info.appendChild(sub);
      row.appendChild(dot);
      row.appendChild(info);

      if (isInstalled) {
        row.onclick = () => onSelect(m.name);
      } else {
        // Pull the model then select it
        row.onclick = async () => {
          sub.textContent = "Downloading\u2026";
          dot.style.background = "#7a8a9c";
          row.style.cursor = "default";
          row.onclick = null;
          try {
            const pullResp = await fetch("/epe/ollama/pull", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ modelName: m.name, ollamaUrl: this._ollamaUrl }),
            });
            const reader = pullResp.body.getReader();
            const dec = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const lines = dec.decode(value).split("\n").filter(Boolean);
              for (const line of lines) {
                try {
                  const d = JSON.parse(line);
                  if (d.status) {
                    const pct = d.total ? Math.round((d.completed||0)/d.total*100)+"%" : "";
                    sub.textContent = d.status + (pct ? " " + pct : "");
                  }
                  if (d.error) { sub.textContent = "Error: " + d.error; return; }
                } catch(e) {}
              }
            }
            dot.style.background = "#4c8";
            sub.textContent = "Downloaded — starting\u2026";
            row.style.cursor = "pointer";
            row.onclick = () => onSelect(m.name);
            onSelect(m.name);
          } catch(e) {
            sub.textContent = "Download failed: " + e.message;
          }
        };
      }

      wrap.appendChild(row);
    });

    // ── AI Setup option ──────────────────────────────────────────────────────
    const divider = document.createElement("div");
    divider.style.cssText = "border-top:1px solid #161d28;margin:4px 0;";
    wrap.appendChild(divider);

    const aiSetupRow = document.createElement("div");
    aiSetupRow.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:7px 10px;" +
      "background:#121821;border:1px solid #1c2431;border-radius:4px;cursor:pointer;";
    aiSetupRow.onmouseenter = () => { aiSetupRow.style.borderColor = "#4e5c6e"; };
    aiSetupRow.onmouseleave = () => { aiSetupRow.style.borderColor = "#1c2431"; };

    const aiSetupDot = document.createElement("span");
    const aiSetupModel = _epeOllama.getSettings().model || "";
    aiSetupDot.style.cssText = `width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${aiSetupModel ? "#7a8a9c" : "#4e5c6e"};`;

    const aiSetupInfo = document.createElement("div");
    aiSetupInfo.style.cssText = "flex:1;";
    const aiSetupLabel = document.createElement("div");
    aiSetupLabel.style.cssText = "color:#c2cddb;font-size:10px;font-weight:600;";
    aiSetupLabel.textContent = "\u2699 Use Model in AI Setup";
    const aiSetupSub = document.createElement("div");
    aiSetupSub.style.cssText = "color:#4e5c6e;font-size:9px;margin-top:1px;";
    aiSetupSub.textContent = aiSetupModel ? `Currently: ${aiSetupModel}` : "No model configured \u2014 open AI Setup to set one";
    aiSetupInfo.appendChild(aiSetupLabel);
    aiSetupInfo.appendChild(aiSetupSub);
    aiSetupRow.appendChild(aiSetupDot);
    aiSetupRow.appendChild(aiSetupInfo);

    aiSetupRow.onclick = () => {
      if (!aiSetupModel) {
        // Show message directing to AI Setup
        const errWrap = document.createElement("div");
        errWrap.style.cssText = "padding:14px 16px;display:flex;flex-direction:column;gap:10px;";
        const errTitle = document.createElement("div");
        errTitle.style.cssText = "color:#c2cddb;font-size:11px;font-weight:600;";
        errTitle.textContent = "No Vision Model Configured";
        const errMsg = document.createElement("div");
        errMsg.style.cssText = "color:#8a9aac;font-size:10px;line-height:1.6;";
        errMsg.textContent = "No model is set in AI Setup. Open AI Setup from the EPE toolbar, choose a vision-capable model (such as llava or moondream), then try again.";
        const dismissBtn = document.createElement("button");
        dismissBtn.textContent = "Dismiss";
        dismissBtn.style.cssText =
          "align-self:flex-end;background:#1c2431;border:1px solid rgba(255,255,255,0.08);" +
          "border-radius:4px;color:#9aaaba;padding:4px 14px;cursor:pointer;font-size:11px;";
        dismissBtn.onclick = () => hideAiPanel();
        errWrap.appendChild(errTitle);
        errWrap.appendChild(errMsg);
        errWrap.appendChild(dismissBtn);
        showAiPanel(errWrap);
        return;
      }
      onSelect(aiSetupModel);
    };
    wrap.appendChild(aiSetupRow);

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText =
      "align-self:flex-end;background:#1c2431;border:1px solid rgba(255,255,255,0.08);" +
      "border-radius:4px;color:#9aaaba;padding:3px 12px;cursor:pointer;font-size:11px;";
    cancelBtn.onclick = () => hideAiPanel();
    wrap.appendChild(cancelBtn);

    showAiPanel(wrap);
    if (showAiPanel.setTitle) showAiPanel.setTitle("Pick a vision model to generate a prompt");
  },

  // Run image-to-prompt via backend. imageUrl = CDN URL string.
  // onStart() called before request, onDone(prompt) on success, onError(msg) on fail.
  async generateImage(imageUrl, modelName, showAiPanel, hideAiPanel, onDone) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:12px 14px;display:flex;flex-direction:column;gap:8px;";

    const hdr = document.createElement("div");
    hdr.style.cssText = "color:#6db8e8;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;";
    hdr.textContent = "\uD83D\uDDBC Analyzing image\u2026";

    const status = document.createElement("div");
    status.style.cssText = "color:#8a9aac;font-size:10px;";
    status.textContent = "Sending to " + modelName + "\u2026";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText =
      "align-self:flex-end;background:#1c2431;border:1px solid rgba(255,255,255,0.08);" +
      "border-radius:4px;color:#9aaaba;padding:3px 12px;cursor:pointer;font-size:11px;";

    let cancelled = false;
    cancelBtn.onclick = () => { cancelled = true; hideAiPanel(); };

    wrap.appendChild(hdr);
    wrap.appendChild(status);
    wrap.appendChild(cancelBtn);
    showAiPanel(wrap);

    try {
      const signal = this._abortPrevious();
      const resp = await fetch("/epe/ollama/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl, ollamaModel: modelName, ollamaUrl: this._ollamaUrl, ...this._styleBridge }),
        signal,
      });
      if (cancelled) return;
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      onDone(data.prompt);
    } catch(e) {
      if (!cancelled && e.name !== "AbortError") {
        status.style.color = "#c88";
        status.textContent = e.message === "Failed to fetch"
          ? "Connection lost — Ollama may still be processing a previous request. Please wait a moment and try again."
          : e.message === "Ollama returned empty response"
          ? "The model returned an empty response. If you used AI Setup, make sure a vision-capable model is selected (e.g. llava, moondream, qwen-vl)."
          : "Error: " + e.message;
        cancelBtn.textContent = "Dismiss";
      }
    }
  },

  // Run image-to-prompt from a local File object (for EPE toolbar).
  async generateImageFromFile(file, modelName, showAiPanel, hideAiPanel, onDone) {
    // Accept either a real File object or a synthetic {name, _dataUrl} from video frame extraction
    const base64Full = file._dataUrl
      ? file._dataUrl
      : await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.onerror = () => rej(new Error("Read failed"));
          r.readAsDataURL(file);
        });

    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:12px 14px;display:flex;flex-direction:column;gap:8px;";

    const thumbRow = document.createElement("div");
    thumbRow.style.cssText = "display:flex;align-items:center;gap:8px;";
    const thumb = document.createElement("img");
    thumb.src = base64Full;
    thumb.style.cssText = "width:44px;height:44px;border-radius:3px;object-fit:cover;border:1px solid #24303f;flex-shrink:0;";
    const thumbInfo = document.createElement("div");
    thumbInfo.style.cssText = "flex:1;";
    const hdr = document.createElement("div");
    hdr.style.cssText = "color:#6db8e8;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;";
    hdr.textContent = "\uD83D\uDDBC Analyzing image\u2026";
    const status = document.createElement("div");
    status.style.cssText = "color:#8a9aac;font-size:10px;margin-top:2px;";
    status.textContent = "Sending to " + modelName + "\u2026";
    thumbInfo.appendChild(hdr);
    thumbInfo.appendChild(status);
    thumbRow.appendChild(thumb);
    thumbRow.appendChild(thumbInfo);

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText =
      "align-self:flex-end;background:#1c2431;border:1px solid rgba(255,255,255,0.08);" +
      "border-radius:4px;color:#9aaaba;padding:3px 12px;cursor:pointer;font-size:11px;";

    let cancelled = false;
    cancelBtn.onclick = () => { cancelled = true; hideAiPanel(); };

    wrap.appendChild(thumbRow);
    wrap.appendChild(cancelBtn);
    showAiPanel(wrap);

    try {
      const signal = this._abortPrevious();
      const resp = await fetch("/epe/ollama/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: base64Full, ollamaModel: modelName, ollamaUrl: this._ollamaUrl, ...this._styleBridge }),
        signal,
      });
      if (cancelled) return;
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      onDone(data.prompt);
    } catch(e) {
      if (!cancelled && e.name !== "AbortError") {
        status.style.color = "#c88";
        status.textContent = e.message === "Failed to fetch"
          ? "Connection lost — Ollama may still be processing a previous request. Please wait a moment and try again."
          : e.message === "Ollama returned empty response"
          ? "The model returned an empty response. If you used AI Setup, make sure a vision-capable model is selected (e.g. llava, moondream, qwen-vl)."
          : "Error: " + e.message;
        cancelBtn.textContent = "Dismiss";
      }
    }
  },

  // Run video-to-prompt via backend. videoUrl = CDN URL string.
  async generateVideo(videoUrl, modelName, showAiPanel, hideAiPanel, onDone) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:12px 14px;display:flex;flex-direction:column;gap:8px;";

    const hdr = document.createElement("div");
    hdr.style.cssText = "color:#6db8e8;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;";
    hdr.textContent = "\uD83C\uDFAC Analyzing video\u2026";

    const status = document.createElement("div");
    status.style.cssText = "color:#8a9aac;font-size:10px;";
    status.textContent = "downloading and processing video";

    const note = document.createElement("div");
    note.style.cssText = "color:#4e5c6e;font-size:9px;";
    note.textContent = "Processing time varies depending on your VRAM, RAM, CPU, and the model you choose.";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText =
      "align-self:flex-end;background:#1c2431;border:1px solid rgba(255,255,255,0.08);" +
      "border-radius:4px;color:#9aaaba;padding:3px 12px;cursor:pointer;font-size:11px;";

    let cancelled = false;
    cancelBtn.onclick = () => { cancelled = true; hideAiPanel(); };

    wrap.appendChild(hdr);
    wrap.appendChild(status);
    wrap.appendChild(note);
    wrap.appendChild(cancelBtn);
    showAiPanel(wrap);

    try {
      const signal = this._abortPrevious();
      const resp = await fetch("/epe/ollama/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl, ollamaModel: modelName, ollamaUrl: this._ollamaUrl, ...this._styleBridge }),
        signal,
      });
      if (cancelled) return;
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      onDone(data.prompt);
    } catch(e) {
      if (!cancelled && e.name !== "AbortError") {
        status.style.color = "#c88";
        status.textContent = e.message === "Failed to fetch"
          ? "Connection lost — Ollama may still be processing a previous request. Please wait a moment and try again."
          : e.message === "Ollama returned empty response"
          ? "The model returned an empty response. If you used AI Setup, make sure a vision-capable model is selected (e.g. llava, moondream, qwen-vl)."
          : "Error: " + e.message;
        cancelBtn.textContent = "Dismiss";
      }
    }
  },

  // Show result panel. Optional callbacks: { onFavorites, onSnippets, onEnhance, onVariation }
  showResult(prompt, showAiPanel, hideAiPanel, onReplace, actions) {
    // Delegate to unified showAiResult helper (defined in _epeOpenEPEStandalone)
    if (showAiPanel._showAiResult) {
      showAiPanel._showAiResult({
        text: prompt,
        label: "Generated Prompt",
        onAppend:    (t) => onReplace((prompt + "\n" + t).trim()),
        onUsePrompt: onReplace,
        onFavorites: actions?.onFavorites,
        onSnippets:  actions?.onSnippets,
        onEnhance:   actions?.onEnhance,
        onVariation: actions?.onVariation,
      });
    }
  },

  // Main entry point — check Ollama, show model picker, then run generation.
  // mode: "image-url" | "image-file" | "video"
  // source: imageUrl string | File object | videoUrl string
  // actions: optional { onFavorites, onSnippets, onEnhance, onVariation }
  async run(mode, source, showAiPanel, hideAiPanel, onResult, actions) {
    const check = await this.check();
    if (!check || !check.running) {
      this.showNotRunning(showAiPanel, hideAiPanel);
      return;
    }

    this.showModelPicker(check.knownModels, check.installedModels, showAiPanel, hideAiPanel, async (modelName) => {
      if (mode === "image-url") {
        await this.generateImage(source, modelName, showAiPanel, hideAiPanel, (prompt) => {
          this.showResult(prompt, showAiPanel, hideAiPanel, onResult, actions);
        });
      } else if (mode === "image-file") {
        await this.generateImageFromFile(source, modelName, showAiPanel, hideAiPanel, (prompt) => {
          this.showResult(prompt, showAiPanel, hideAiPanel, onResult, actions);
        });
      } else if (mode === "video-frame") {
        // Extract first frame from video, then run image-to-prompt on it
        const status = showAiPanel && (() => {
          const wrap = document.createElement("div");
          wrap.style.cssText = "padding:12px 14px;display:flex;flex-direction:column;gap:8px;";
          const hdr = document.createElement("div");
          hdr.style.cssText = "color:#6db8e8;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;";
          hdr.textContent = "\uD83D\uDDBC Extracting frame\u2026";
          const st = document.createElement("div");
          st.style.cssText = "color:#8a9aac;font-size:10px;";
          st.textContent = "downloading and processing video\u2026";
          wrap.appendChild(hdr);
          wrap.appendChild(st);
          showAiPanel(wrap);
          return st;
        })();
        try {
          const signal = this._abortPrevious();
          const frameResp = await fetch("/epe/ollama/extract-frame", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoUrl: source }),
            signal,
          });
          const frameData = await frameResp.json();
          if (frameData.error) throw new Error(frameData.error);
          const dataUrl = "data:image/jpeg;base64," + frameData.frameB64;
          await this.generateImageFromFile(
            { name: "frame.jpg", _dataUrl: dataUrl },
            modelName, showAiPanel, hideAiPanel,
            (prompt) => { this.showResult(prompt, showAiPanel, hideAiPanel, onResult, actions); }
          );
        } catch(e) {
          if (e.name !== "AbortError") {
            if (status) { status.style.color = "#c88"; status.textContent = "Error: " + e.message; }
          }
        }
      } else if (mode === "video-file") {
        // Local video file — read as base64 and send to generate-video-file endpoint
        const status = (() => {
          const wrap = document.createElement("div");
          wrap.style.cssText = "padding:12px 14px;display:flex;flex-direction:column;gap:8px;";
          const hdr = document.createElement("div");
          hdr.style.cssText = "color:#6db8e8;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;";
          hdr.textContent = "\uD83C\uDFAC Analyzing video\u2026";
          const st = document.createElement("div");
          st.style.cssText = "color:#8a9aac;font-size:10px;";
          st.textContent = "downloading and processing video\u2026";
          const note = document.createElement("div");
          note.style.cssText = "color:#4e5c6e;font-size:9px;";
          note.textContent = "Processing time varies depending on your VRAM, RAM, CPU, and the model you choose.";
          const cancelBtn = document.createElement("button");
          cancelBtn.textContent = "Cancel";
          cancelBtn.style.cssText = "align-self:flex-end;background:#1c2431;border:1px solid rgba(255,255,255,0.08);border-radius:4px;color:#9aaaba;padding:3px 12px;cursor:pointer;font-size:11px;";
          let cancelled = false;
          cancelBtn.onclick = () => { cancelled = true; hideAiPanel(); };
          wrap.appendChild(hdr); wrap.appendChild(st); wrap.appendChild(note); wrap.appendChild(cancelBtn);
          showAiPanel(wrap);
          return { st, cancelled: () => cancelled };
        })();
        try {
          const base64Full = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = () => rej(new Error("Read failed"));
            r.readAsDataURL(source);
          });
          if (status.cancelled()) return;
          const signal = this._abortPrevious();
          const resp = await fetch("/epe/ollama/generate-video-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoData: base64Full, ollamaModel: modelName, ollamaUrl: this._ollamaUrl, ...this._styleBridge }),
            signal,
          });
          if (status.cancelled()) return;
          const data = await resp.json();
          if (data.error) throw new Error(data.error);
          this.showResult(data.prompt, showAiPanel, hideAiPanel, onResult, actions);
        } catch(e) {
          if (e.name !== "AbortError" && !status.cancelled()) {
            status.st.style.color = "#c88";
            status.st.textContent = e.message === "Failed to fetch"
              ? "Connection lost — Ollama may still be processing a previous request. Please wait a moment and try again."
              : "Error: " + e.message;
          }
        }
      } else if (mode === "video") {
        await this.generateVideo(source, modelName, showAiPanel, hideAiPanel, (prompt) => {
          this.showResult(prompt, showAiPanel, hideAiPanel, onResult, actions);
        });
      }
    });
  },
};

// ── EPE Standalone Function ───────────────────────────────────────────────────
// Persists workflow search state across node re-creations (tab switches).
const _epeWfPersist = { query: "", source: "all" };

// ─────────────────────────────────────────────────────────────────────────────
// Subgraph traversal helpers (saved-JSON side)
// ─────────────────────────────────────────────────────────────────────────────
// ComfyUI's subgraph workflows store the inner content under
// `workflow.definitions.subgraphs[]`. Each subgraph has its own `id` (a UUID),
// its own `nodes` array, and its own `links` array. A node at any level that
// references a subgraph has its `type` set to that subgraph's UUID — that's
// how the inner graph is identified.
//
// Subgraphs can nest arbitrarily deep. Node IDs and link IDs are globally
// unique within a single saved workflow (the top-level `last_node_id` /
// `last_link_id` counters are shared), so flattening across all nesting
// levels by concatenating nodes/links arrays is safe — no ID collisions.

const _epeUuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ComfyUI workflows store links in two different shapes depending on level:
//   • Top-level workflow links: arrays — [id, origin_id, origin_slot, target_id, target_slot, type]
//   • Subgraph definition links: objects — { id, origin_id, origin_slot, target_id, target_slot, type }
// The typed-link graph walk in _epeParsePromptData expects the array form. This
// helper coerces either shape into the array form (or null if unrecognizable),
// so flattening mixed top-level + subgraph links stays homogeneous.
function _epeNormalizeLink(l) {
  if (Array.isArray(l)) return l;
  if (l && typeof l === "object" && ("origin_id" in l || "target_id" in l)) {
    return [l.id, l.origin_id, l.origin_slot, l.target_id, l.target_slot, l.type];
  }
  return null;
}

// Return the inner subgraph definition for a node, or null if the node isn't
// a subgraph reference. Mirrors WCP's _epeGetInnerGraph() in spirit but
// operates on parsed JSON rather than live LiteGraph runtime objects.
function _epeGetInnerSubgraph(node, workflowRoot) {
  const defs = workflowRoot && workflowRoot.definitions && workflowRoot.definitions.subgraphs;
  if (!Array.isArray(defs)) return null;
  const t = node && node.type;
  if (!t || typeof t !== "string") return null;
  if (!_epeUuidRe.test(t)) return null;
  return defs.find(d => d && d.id === t) || null;
}

// Walk every subgraph definition reachable from the workflow root, including
// nested subgraphs. Returns a flat list of {chain, inner} where `chain` is the
// path of containing node IDs ([] for top level, [88] for first-level, etc.).
// Useful for diagnostics; the flatten helper below is what the parser actually
// consumes.
function _epeCollectAllSubgraphs(workflowRoot) {
  const out = [];
  const visit = (graph, chain) => {
    if (!graph || !Array.isArray(graph.nodes)) return;
    for (const n of graph.nodes) {
      if (!n) continue;
      const inner = _epeGetInnerSubgraph(n, workflowRoot);
      if (!inner) continue;
      const myChain = chain.concat([n.id]);
      out.push({ chain: myChain, inner });
      visit(inner, myChain);
    }
  };
  visit(workflowRoot, []);
  return out;
}

// Produce a flattened { nodes, links } structure containing every node and
// every link from the top level plus all subgraph definitions (recursively).
// The existing typed-link graph walk in _epeParsePromptData works unchanged
// on this flattened structure because IDs don't collide.
//
// Returns the original workflowRoot unchanged if there are no subgraph
// definitions, so flat (non-subgraph) workflows still take the cheap path.
function _epeFlattenWorkflow(workflowRoot) {
  if (!workflowRoot || !workflowRoot.definitions || !Array.isArray(workflowRoot.definitions.subgraphs)) {
    return workflowRoot;
  }
  const allNodes = Array.isArray(workflowRoot.nodes) ? workflowRoot.nodes.slice() : [];
  const allLinks = [];
  // Normalize top-level links too — defensive in case newer ComfyUI versions
  // start writing object-form links at the top level.
  if (Array.isArray(workflowRoot.links)) {
    for (const ll of workflowRoot.links) {
      const norm = _epeNormalizeLink(ll);
      if (norm) allLinks.push(norm);
    }
  }
  const visit = (graph) => {
    if (!graph || !Array.isArray(graph.nodes)) return;
    for (const n of graph.nodes) {
      const inner = _epeGetInnerSubgraph(n, workflowRoot);
      if (!inner) continue;
      if (Array.isArray(inner.nodes)) for (const nn of inner.nodes) allNodes.push(nn);
      if (Array.isArray(inner.links)) {
        for (const ll of inner.links) {
          const norm = _epeNormalizeLink(ll);
          if (norm) allLinks.push(norm);
        }
      }
      visit(inner);
    }
  };
  visit(workflowRoot);
  // Return a shallow-merged copy so the caller (and existing graph-walk code)
  // can treat it identically to a flat workflow. Original is untouched.
  return Object.assign({}, workflowRoot, { nodes: allNodes, links: allLinks });
}
// ─────────────────────────────────────────────────────────────────────────────

function _epeParsePromptData(promptData, workflowData) {
  // Handle string inputs (JSON.parse may have failed in metadata extraction due to null bytes, BOM, etc.)
  if (typeof promptData === "string") {
    try { 
      // Strip null bytes, BOM, and sanitize NaN/Infinity (ComfyUI quirk)
      const cleaned = promptData.replace(/^\uFEFF/, "").replace(/\0/g, "").replace(/\bNaN\b/g, "null").replace(/\b-?Infinity\b/g, "null").trim();
      promptData = JSON.parse(cleaned); 
    } catch(e) { 
    }
  }
  if (typeof workflowData === "string") {
    try { 
      const cleaned = workflowData.replace(/^\uFEFF/, "").replace(/\0/g, "").replace(/\bNaN\b/g, "null").replace(/\b-?Infinity\b/g, "null").trim();
      workflowData = JSON.parse(cleaned); 
    } catch(e) { workflowData = null; }
  }
  // Allow workflow-only input. Some save nodes (e.g. WCP router) write only
  // the workflow tEXt chunk and skip the prompt chunk entirely — graph-walking
  // the workflow still recovers the prompt text from CLIPTextEncode widgets.
  const hasPrompt   = promptData   && typeof promptData   === "object";
  const hasWorkflow = workflowData && typeof workflowData === "object";
  if (!hasPrompt && !hasWorkflow) return null;
  if (!hasPrompt) promptData = {}; // stub so downstream prompt-keyed code is safe

  // Flatten subgraph definitions (if any) into the workflow's top-level
  // nodes/links so the typed-link graph walk below sees the full graph.
  // No-op for flat (non-subgraph) workflows.
  if (hasWorkflow) workflowData = _epeFlattenWorkflow(workflowData);
  
  const result = {
    positivePrompts: [],
    negativePrompts: [],
    samplers: [],
    models: [],
    loras: [],
    vaes: [],
    clipSettings: [],
  };
  
  // --- PROMPT EXTRACTION via typed-link graph walk ---
  // Uses the workflow JSON's `links` array (typed edges) to structurally trace
  // from CONDITIONING-producing nodes back through STRING chains to find prompts.
  // No class_type matching. No content heuristics. Pure graph structure.
  //
  // Algorithm:
  // 1. Build link graph from workflow links (each link has a data type)
  // 2. Pair Set/Get bus nodes by title
  // 3. Find nodes that output CONDITIONING to sampler-like inputs
  // 4. Walk backward through STRING inputs → find original prompts (user-typed text)
  // 5. Walk forward through STRING outputs → find enhanced/resolved prompts (cached in display nodes)
  // 6. Fall back to prompt JSON direct text for simple workflows without workflow data
  
  const seenText = new Set();
  
  if (workflowData && Array.isArray(workflowData.links) && Array.isArray(workflowData.nodes)) {
    const wfNodesById = {};
    for (const n of workflowData.nodes) wfNodesById[n.id] = n;
    
    // Build incoming/outgoing link maps
    const inLinks = {};   // nodeId → { inputSlot: linkArray }
    const outLinks = {};  // nodeId → { outputSlot: [linkArrays] }
    for (const l of workflowData.links) {
      const [lid, srcId, srcOut, dstId, dstIn, ltype] = l;
      if (!inLinks[dstId]) inLinks[dstId] = {};
      inLinks[dstId][dstIn] = l;
      if (!outLinks[srcId]) outLinks[srcId] = {};
      if (!outLinks[srcId][srcOut]) outLinks[srcId][srcOut] = [];
      outLinks[srcId][srcOut].push(l);
    }
    
    // Pair Set/Get "wireless" bus nodes by normalized title
    // These are custom linkless bridge nodes — the links array has NO link between Set→Get pairs.
    // We pair them by name so walks can bridge the gap. They are purely transparent bridges.
    const normBus = (title, prefix) => title.replace(prefix, "").replace(/^[>\-\s]+/, "").replace(/[>\-\s]+$/, "").trim().toLowerCase();
    const setBus = {};
    const getBus = {};
    for (const n of workflowData.nodes) {
      if (n.type === "SetNode") {
        const name = normBus(n.title || "", "Set_");
        if (name) { setBus[name] = n; }
      } else if (n.type === "GetNode") {
        const name = normBus(n.title || "", "Get_");
        if (name) {
          if (!getBus[name]) getBus[name] = [];
          getBus[name].push(n);
        }
      }
    }
    
    // Walk backward through STRING/wildcard links to find terminal text nodes
    const walkBackString = (nodeId, visited) => {
      if (!visited) visited = new Set();
      if (visited.has(nodeId)) return [];
      visited.add(nodeId);
      if (visited.size > 50) return [];
      const node = wfNodesById[nodeId];
      if (!node) return [];
      const results = [];
      const title = node.title || node.type || ("node_" + nodeId);
      
      // GetNode: jump to matching SetNode's source
      if (node.type === "GetNode") {
        const name = normBus(node.title || "", "Get_");
        const setNode = setBus[name];
        if (setNode && inLinks[setNode.id]) {
          for (const slot of Object.keys(inLinks[setNode.id])) {
            results.push(...walkBackString(inLinks[setNode.id][slot][1], visited));
          }
        }
        return results;
      }
      
      // Check for incoming STRING links
      let hasStringInput = false;
      if (inLinks[nodeId]) {
        for (const slot of Object.keys(inLinks[nodeId])) {
          const link = inLinks[nodeId][slot];
          const ltype = link[5] || "?";
          if (ltype === "STRING" || ltype === "*") {
            hasStringInput = true;
            results.push(...walkBackString(link[1], visited));
          }
        }
      }
      
      // Terminal node: no incoming STRING links → check widgets_values for text
      // Also treat as terminal if the only incoming links are non-STRING (CLIP, MODEL, etc.)
      if (!hasStringInput) {
        const wv = node.widgets_values;
        if (Array.isArray(wv)) {
          for (const v of wv) {
            if (typeof v === "string" && v.trim().length > 10) {
              results.push({ nodeId, title, text: v.trim() });
            }
          }
        }
        // Also check node.inputs for widget definitions with default text values
        // (some nodes store text in input definitions rather than widgets_values)
        if (Array.isArray(node.inputs)) {
          for (const inp of node.inputs) {
            if (inp.widget && typeof inp.widget.config === "object") continue; // skip widget configs
            // Unlinked text inputs may have values stored differently
          }
        }
      }
      return results;
    };
    
    // Walk forward through STRING links to find display/cache nodes with resolved text
    const walkForwardString = (nodeId, visited) => {
      if (!visited) visited = new Set();
      if (visited.has(nodeId)) return [];
      visited.add(nodeId);
      if (visited.size > 50) return [];
      const node = wfNodesById[nodeId];
      if (!node) return [];
      const results = [];
      const title = node.title || node.type || ("node_" + nodeId);
      
      // SetNode: jump to matching GetNodes (don't collect SetNode widgets_values — they're bus labels)
      if (node.type === "SetNode") {
        const name = normBus(node.title || "", "Set_");
        for (const getNode of (getBus[name] || [])) {
          results.push(...walkForwardString(getNode.id, visited));
        }
        return results;
      }
      
      // GetNode: don't collect widgets_values (they're bus labels), just follow outgoing links
      if (node.type === "GetNode") {
        if (outLinks[nodeId]) {
          for (const slot of Object.keys(outLinks[nodeId])) {
            for (const link of outLinks[nodeId][slot]) {
              const ltype = link[5] || "?";
              if (ltype === "STRING" || ltype === "*") {
                results.push(...walkForwardString(link[3], visited));
              }
            }
          }
        }
        return results;
      }
      
      // Check widgets_values for cached text (skip short bus-label-like strings)
      const wv = node.widgets_values;
      if (Array.isArray(wv)) {
        for (const v of wv) {
          if (typeof v === "string" && v.trim().length > 10) {
            results.push({ nodeId, title, text: v.trim() });
          }
        }
      }
      
      // Follow outgoing STRING links only (not * — those are often CONDITIONING/MODEL going to bus)
      if (outLinks[nodeId]) {
        for (const slot of Object.keys(outLinks[nodeId])) {
          for (const link of outLinks[nodeId][slot]) {
            if (link[5] === "STRING") {
              results.push(...walkForwardString(link[3], visited));
            }
          }
        }
      }
      return results;
    };
    
    // Find ALL nodes that output CONDITIONING — these are text encoders, conditioning combiners, etc.
    // We want the ones that also take STRING input (text encoders).
    // But also include nodes that output CONDITIONING and have no CONDITIONING input 
    // (they originate conditioning, not just pass it through).
    const condSourceIds = new Set();
    
    // Method 1: Any node with outgoing CONDITIONING links
    for (const l of workflowData.links) {
      const ltype = l[5] || "?";
      if (ltype === "CONDITIONING") {
        condSourceIds.add(l[1]);
      }
    }
    
    // Method 2: SetNodes receiving CONDITIONING (bus pattern)
    for (const n of workflowData.nodes) {
      if (n.type !== "SetNode") continue;
      const setIn = inLinks[n.id];
      if (!setIn) continue;
      for (const slot of Object.keys(setIn)) {
        const link = setIn[slot];
        if (link[5] === "CONDITIONING" || link[5] === "*") {
          condSourceIds.add(link[1]);
        }
      }
    }
    
    // Method 3: Nodes that output * type but are known to be conditioning from context
    // (subgraphs often use * for their outputs)
    for (const l of workflowData.links) {
      if (l[5] !== "*") continue;
      const dstNode = wfNodesById[l[3]];
      if (!dstNode) continue;
      // Check if destination is a SetNode with conditioning-like title
      if (dstNode.type === "SetNode" && /cond/i.test(dstNode.title || "")) {
        condSourceIds.add(l[1]);
      }
      // Check if destination input is named positive/negative/conditioning
      for (const inp of (dstNode.inputs || [])) {
        if (inp.link === l[0] && /positive|negative|conditioning/i.test(inp.name || "")) {
          condSourceIds.add(l[1]);
          break;
        }
      }
    }
    
    // Filter: keep nodes that are likely text encoders
    // A text encoder takes STRING input and produces CONDITIONING output
    // Also include nodes with no inputs (terminal CONDITIONING sources) if they have text in widgets_values
    // Exclude: pass-through nodes (CONDITIONING in AND out, no STRING), 
    //          model loaders, GetNodes (handled via bus pairing)
    const textEncoderIds = new Set();
    for (const srcId of condSourceIds) {
      const node = wfNodesById[srcId];
      if (!node) continue;
      // Skip GetNodes — they're bus endpoints, handled via Set/Get pairing
      if (node.type === "GetNode") continue;
      
      const nodeIn = inLinks[srcId];
      let hasStringIn = false;
      let hasCondIn = false;
      let hasModelIn = false;
      if (nodeIn) {
        for (const slot of Object.keys(nodeIn)) {
          const lt = nodeIn[slot][5] || "?";
          if (lt === "STRING") hasStringIn = true;
          if (lt === "CONDITIONING") hasCondIn = true;
          if (lt === "MODEL") hasModelIn = true;
        }
      }
      
      // Case 1: Has STRING input → likely a text encoder or text-processing node
      if (hasStringIn) {
        textEncoderIds.add(srcId);
        continue;
      }
      
      // Case 2: No CONDITIONING input AND no MODEL-only input → originates conditioning
      // Check if it has text in widgets_values (simple CLIP encode with typed text)
      if (!hasCondIn && !hasModelIn) {
        const wv = node.widgets_values;
        if (Array.isArray(wv)) {
          for (const v of wv) {
            if (typeof v === "string" && v.trim().length > 10) {
              textEncoderIds.add(srcId);
              break;
            }
          }
        }
      }
    }
    
    for (const srcId of textEncoderIds) {
      const srcNode = wfNodesById[srcId];
      if (!srcNode) continue;
      
      // Determine positive vs negative
      let isNeg = false;
      const srcTitle = (srcNode.title || "").toLowerCase();
      if (srcTitle.includes("neg") || srcTitle.includes("uncond")) isNeg = true;
      // Also check destination input name or Set node title
      for (const l of workflowData.links) {
        if (l[1] !== srcId) continue;
        if (l[5] !== "CONDITIONING" && l[5] !== "*") continue;
        const dstNode = wfNodesById[l[3]];
        if (!dstNode) continue;
        // Check input name on destination
        for (const inp of (dstNode.inputs || [])) {
          if (inp.link === l[0] && /negative/i.test(inp.name || "")) isNeg = true;
        }
        // Check Set node title
        if (dstNode.type === "SetNode" && /neg|uncond/i.test(dstNode.title || "")) isNeg = true;
      }
      
      // Walk backward: find original input prompts
      const backResults = walkBackString(srcId, new Set());
      for (const r of backResults) {
        if (!seenText.has(r.text)) {
          seenText.add(r.text);
          (isNeg ? result.negativePrompts : result.positivePrompts).push(r);
        }
      }
      
      // Walk forward through STRING outputs: find enhanced/resolved prompts
      if (outLinks[srcId]) {
        for (const slot of Object.keys(outLinks[srcId])) {
          for (const link of outLinks[srcId][slot]) {
            if (link[5] === "STRING") {
              const fwdResults = walkForwardString(link[3], new Set());
              for (const r of fwdResults) {
                if (!seenText.has(r.text)) {
                  seenText.add(r.text);
                  (isNeg ? result.negativePrompts : result.positivePrompts).push(r);
                }
              }
            }
          }
        }
      }
    }
  }
  
  // Fallback for simple workflows or missing workflow data:
  // Use prompt JSON directly — find nodes with text+clip inputs
  if (result.positivePrompts.length === 0 && result.negativePrompts.length === 0) {
    for (const [nodeId, node] of Object.entries(promptData)) {
      const inp = node.inputs || {};
      if (inp.clip === undefined || inp.text === undefined) continue;
      if (typeof inp.text === "string" && inp.text.trim().length > 5) {
        const title = node._meta?.title || "";
        const text = inp.text.trim();
        if (!seenText.has(text)) {
          seenText.add(text);
          const isNeg = title.toLowerCase().includes("neg") || title.toLowerCase().includes("uncond");
          (isNeg ? result.negativePrompts : result.positivePrompts).push({
            nodeId, text, className: node.class_type || "", title
          });
        }
      }
    }
  }

  // --- OTHER SETTINGS (data-pattern based) ---
  for (const [nodeId, node] of Object.entries(promptData)) {
    const cls = node.class_type || "";
    const inp = node.inputs || {};
    const title = node._meta?.title || "";
    if ((inp.steps !== undefined) && (inp.cfg !== undefined || inp.guidance !== undefined) && (inp.sampler_name !== undefined || inp.scheduler !== undefined)) {
      result.samplers.push({
        nodeId, className: cls, title,
        seed: inp.seed ?? inp.noise_seed ?? "N/A",
        steps: inp.steps ?? "N/A",
        cfg: inp.cfg ?? inp.guidance ?? "N/A",
        sampler_name: inp.sampler_name ?? inp.sampler ?? "N/A",
        scheduler: inp.scheduler ?? "N/A",
        denoise: inp.denoise ?? 1.0,
      });
    }
    
    // --- Model: any node with ckpt_name ---
    if (inp.ckpt_name) {
      result.models.push({ nodeId, className: cls, title, name: inp.ckpt_name });
    }
    // --- Model: any node with unet_name ---
    if (inp.unet_name) {
      result.models.push({ nodeId, className: cls, title: title || "Diffusion Model", name: inp.unet_name });
    }
    
    // --- LoRA: any node with lora_name ---
    if (inp.lora_name) {
      result.loras.push({ nodeId, className: cls, title, name: inp.lora_name, strength_model: inp.strength_model ?? 1.0, strength_clip: inp.strength_clip ?? 1.0 });
    }
    
    // --- LoRA from text syntax: scan all string inputs for <lora:name:weight> ---
    for (const v of Object.values(inp)) {
      if (typeof v === "string" && v.includes("<lora:")) {
        const loraRe = /<lora:([^:>]+):([^:>]+)(?::([^>]+))?>/g;
        let m;
        while ((m = loraRe.exec(v)) !== null) {
          const name = m[1];
          const w1 = parseFloat(m[2]) || 1.0;
          const w2 = m[3] !== undefined ? (parseFloat(m[3]) || 1.0) : w1;
          if (!result.loras.some(l => l.name === name)) {
            result.loras.push({ nodeId, className: cls, title, name, strength_model: w1, strength_clip: w2 });
          }
        }
      }
    }
    
    // --- CLIP: any node with clip_name ---
    if (inp.clip_name) {
      result.clipSettings.push({ nodeId, className: cls, title, name: inp.clip_name, type: inp.type || "" });
    }
    
    // --- VAE: any node with vae_name ---
    if (inp.vae_name) {
      result.vaes.push({ nodeId, className: cls, title, name: inp.vae_name });
    }
    
  }
  
  // Clean ComfyUI weight syntax from prompt text: (text:1.2) → text
  // Handles nested brackets, bare brackets (text), scheduling (text:1.2:0.8),
  // negative weights (text:-0.5), square brackets [text:0.8], curly braces {text:1.1},
  // lora tags <lora:name:weight>, and BREAK keywords
  const cleanWeights = (text) => {
    if (!text) return text;
    let cleaned = text;
    // Remove <lora:...> tags entirely
    cleaned = cleaned.replace(/<lora:[^>]*>/gi, "");
    // Remove embedding triggers: embedding:name or (embedding:name:weight)
    cleaned = cleaned.replace(/\(?\s*embedding\s*:\s*[^,)\s]+(?:\s*:\s*-?[\d.]+)?\s*\)?/gi, "");
    // Iteratively strip innermost (content:number) patterns to handle nesting
    // Supports negative weights, optional spaces, and scheduling (content:num:num)
    let prev;
    do {
      prev = cleaned;
      cleaned = cleaned.replace(/\(([^()]+?)\s*:\s*-?[\d.]+(?:\s*:\s*-?[\d.]+)?\s*\)/g, "$1");
    } while (cleaned !== prev);
    // Square brackets [content:number] (A1111 style)
    do {
      prev = cleaned;
      cleaned = cleaned.replace(/\[([^\[\]]+?)\s*:\s*-?[\d.]+(?:\s*:\s*-?[\d.]+)?\s*\]/g, "$1");
    } while (cleaned !== prev);
    // Curly braces {content:number}
    do {
      prev = cleaned;
      cleaned = cleaned.replace(/\{([^{}]+?)\s*:\s*-?[\d.]+(?:\s*:\s*-?[\d.]+)?\s*\}/g, "$1");
    } while (cleaned !== prev);
    // Strip remaining bare emphasis brackets: (text) → text, [text] → text, {text} → text
    do {
      prev = cleaned;
      cleaned = cleaned.replace(/\(([^()]+)\)/g, "$1");
      cleaned = cleaned.replace(/\[([^\[\]]+)\]/g, "$1");
      cleaned = cleaned.replace(/\{([^{}]+)\}/g, "$1");
    } while (cleaned !== prev);
    // Remove BREAK keywords (ComfyUI prompt section separators)
    cleaned = cleaned.replace(/\bBREAK\b/g, " ");
    // Clean up stray colons followed by numbers (leftover fragments)
    cleaned = cleaned.replace(/\s*:\s*-?[\d.]+/g, "");
    // Clean up weight numbers directly attached to words (no colon): "sprites1.3" → "sprites"
    // Matches a letter followed by a decimal number (digit.digit pattern) at word boundary
    cleaned = cleaned.replace(/([a-zA-Z])-?\d+\.\d+/g, "$1");
    // Collapse multiple commas, spaces, and newlines
    cleaned = cleaned.replace(/,\s*,+/g, ",").replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
    // Remove leading/trailing commas
    cleaned = cleaned.replace(/^[,\s]+|[,\s]+$/g, "").trim();
    return cleaned;
  };
  
  for (const p of result.positivePrompts) { p.text = cleanWeights(p.text); }
  for (const p of result.negativePrompts) { p.text = cleanWeights(p.text); }
  
  // Deduplicate prompts with identical text
  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter(p => { if (seen.has(p.text)) return false; seen.add(p.text); return true; });
  };
  result.positivePrompts = dedup(result.positivePrompts);
  result.negativePrompts = dedup(result.negativePrompts);
  
  return result;
}

async function _epeExtractPngMetadata(file) {
  const buf = await file.arrayBuffer();
  const view = new DataView(buf);
  const dec = new TextDecoder();
  const result = {};
  const bytes = new Uint8Array(buf);
  
  // Detect format
  const isPNG = view.getUint32(0) === 0x89504E47 && view.getUint32(4) === 0x0D0A1A0A;
  const isJPEG = bytes[0] === 0xFF && bytes[1] === 0xD8;
  const isWebP = dec.decode(bytes.slice(0, 4)) === "RIFF" && dec.decode(bytes.slice(8, 12)) === "WEBP";
  
  if (isPNG) {
    // Parse PNG tEXt/iTXt chunks
    let offset = 8;
    while (offset < buf.byteLength) {
      const length = view.getUint32(offset);
      const typeBytes = new Uint8Array(buf, offset + 4, 4);
      const type = dec.decode(typeBytes);
      
      if (type === "tEXt" || type === "iTXt") {
        const data = new Uint8Array(buf, offset + 8, length);
        let nullIdx = data.indexOf(0);
        if (nullIdx !== -1) {
          const keyword = dec.decode(data.slice(0, nullIdx));
          let valueStart = nullIdx + 1;
          if (type === "iTXt" && valueStart < data.length) {
            valueStart += 2;
            const langEnd = data.indexOf(0, valueStart);
            if (langEnd !== -1) valueStart = langEnd + 1;
            const transEnd = data.indexOf(0, valueStart);
            if (transEnd !== -1) valueStart = transEnd + 1;
          }
          const value = dec.decode(data.slice(valueStart));
          if (keyword === "prompt" || keyword === "workflow") {
            try { 
              // ComfyUI can serialize NaN/Infinity which aren't valid JSON
              const sanitized = value.replace(/\bNaN\b/g, "null").replace(/\b-?Infinity\b/g, "null");
              result[keyword] = JSON.parse(sanitized); 
            } catch(e) { 
              result[keyword] = value; 
            }
          }
        }
      }
      if (type === "IEND") break;
      offset += 12 + length;
    }
  } else if (isJPEG || isWebP) {
    // For JPEG and WebP, search the entire file for JSON-like prompt data
    // ComfyUI stores metadata in EXIF (IFD 270/271) or as text segments
    // Strategy: scan for known JSON patterns that indicate ComfyUI metadata
    
    const fullText = dec.decode(bytes);
    
    // Look for prompt JSON — typically starts with {"1": or {"2": etc (node IDs as keys)
    // Also check for "prompt" and "workflow" as EXIF text keys
    const patterns = [
      // Direct JSON prompt data (keyed by node IDs with class_type)
      /\{"[\d]+":\s*\{[^}]*"class_type"/,
      // Prompt key in EXIF
      /"prompt":\s*\{/,
    ];
    
    // Helper to extract balanced JSON starting at a position
    const extractJSON = (str, startIdx) => {
      if (str[startIdx] !== '{') return null;
      let depth = 0;
      for (let i = startIdx; i < str.length; i++) {
        if (str[i] === '{') depth++;
        else if (str[i] === '}') {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(str.slice(startIdx, i + 1));
            } catch(e) {
              return null;
            }
          }
        }
      }
      return null;
    };
    
    // Search for EXIF-embedded prompt/workflow text
    // Many save nodes put the data as plain text in EXIF tags
    // Search for the characteristic patterns
    
    // Method 1: Look for "prompt" as an EXIF text field key followed by JSON
    let promptIdx = fullText.indexOf('"prompt"');
    if (promptIdx === -1) promptIdx = fullText.indexOf("prompt\0");
    
    // Method 2: Scan for the node-keyed JSON pattern directly 
    // This is the most reliable for standard ComfyUI saves
    if (!result.prompt) {
      // Find something like {"1": {"inputs": ... "class_type": ...
      for (let i = 0; i < bytes.length - 20; i++) {
        if (bytes[i] === 0x7B) { // '{'
          // Quick check: is this followed by "number": {"  pattern?
          const snippet = dec.decode(bytes.slice(i, Math.min(i + 50, bytes.length)));
          if (/^\{"[\d]+":\s*\{/.test(snippet)) {
            // Looks like prompt data — try to extract it
            // First extract as string from this position
            const remaining = dec.decode(bytes.slice(i));
            const obj = extractJSON(remaining, 0);
            if (obj) {
              // Verify it has class_type entries (ComfyUI prompt signature)
              const firstVal = Object.values(obj)[0];
              if (firstVal && firstVal.class_type) {
                result.prompt = obj;
                break;
              }
            }
          }
        }
      }
    }
    
    // Method 3: Look for "prompt" key in a wrapper object
    if (!result.prompt) {
      for (let i = 0; i < bytes.length - 10; i++) {
        if (bytes[i] === 0x7B) { // '{'
          const snippet = dec.decode(bytes.slice(i, Math.min(i + 30, bytes.length)));
          if (/^\{\s*"prompt"\s*:/.test(snippet)) {
            const remaining = dec.decode(bytes.slice(i));
            const obj = extractJSON(remaining, 0);
            if (obj && obj.prompt) {
              result.prompt = typeof obj.prompt === "string" ? JSON.parse(obj.prompt) : obj.prompt;
              if (obj.workflow) {
                result.workflow = typeof obj.workflow === "string" ? JSON.parse(obj.workflow) : obj.workflow;
              }
              break;
            }
          }
        }
      }
    }
    
    // Method 4: Look for tEXt-like null-separated key-value pairs (WebP EXIF)
    if (!result.prompt) {
      const promptKey = new TextEncoder().encode("prompt");
      for (let i = 0; i < bytes.length - promptKey.length - 2; i++) {
        let match = true;
        for (let j = 0; j < promptKey.length; j++) {
          if (bytes[i + j] !== promptKey[j]) { match = false; break; }
        }
        if (match && bytes[i + promptKey.length] === 0) {
          // Found "prompt\0" — value follows
          const valueStart = i + promptKey.length + 1;
          // Find the start of JSON
          for (let k = valueStart; k < Math.min(valueStart + 10, bytes.length); k++) {
            if (bytes[k] === 0x7B) {
              const remaining = dec.decode(bytes.slice(k));
              const obj = extractJSON(remaining, 0);
              if (obj) {
                result.prompt = obj;
                break;
              }
            }
          }
          if (result.prompt) break;
        }
      }
    }
  }
  
  if (!isPNG && !isJPEG && !isWebP) {
    throw new Error("Unsupported image format. Please use PNG, WebP, or JPEG files.");
  }
  
  // Read image dimensions from file header (not from nodes — workflows vary too much)
  try {
    if (isPNG && buf.byteLength > 24) {
      result.imageWidth = view.getUint32(16);
      result.imageHeight = view.getUint32(20);
    } else if (isJPEG) {
      let j = 2;
      while (j + 9 < bytes.length) {
        if (bytes[j] !== 0xFF) { j++; continue; }
        const mk = bytes[j + 1];
        if (mk === 0xC0 || mk === 0xC2) {
          result.imageHeight = (bytes[j + 5] << 8) | bytes[j + 6];
          result.imageWidth = (bytes[j + 7] << 8) | bytes[j + 8];
          break;
        }
        if (mk === 0xD9 || mk === 0xDA) break;
        j += 2 + ((bytes[j + 2] << 8) | bytes[j + 3]);
      }
    } else if (isWebP && bytes.length > 30) {
      const vp8 = dec.decode(bytes.slice(12, 16));
      if (vp8 === "VP8 ") {
        result.imageWidth = ((bytes[26] | (bytes[27] << 8)) & 0x3FFF);
        result.imageHeight = ((bytes[28] | (bytes[29] << 8)) & 0x3FFF);
      } else if (vp8 === "VP8L") {
        const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
        result.imageWidth = (bits & 0x3FFF) + 1;
        result.imageHeight = ((bits >> 14) & 0x3FFF) + 1;
      } else if (vp8 === "VP8X" && bytes.length > 30) {
        result.imageWidth = ((bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1);
        result.imageHeight = ((bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1);
      }
    }
  } catch(e) { /* dimension read is best-effort */ }
  
  return result;
}

function _epeOpenEPEStandalone(_epeOwnerNode) {
  // Each node instance needs a unique window id. node.id can be unassigned
  // (-1/undefined) at creation time, so two fresh nodes would collide on the
  // same WIN_ID and the second would bail. Stamp a stable per-instance uid.
  if (_epeOwnerNode && !_epeOwnerNode._epeUid) {
    _epeOwnerNode._epeUid = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  const WIN_ID = 'epe-epe-node-' + (_epeOwnerNode?._epeUid ?? _epeOwnerNode?.id ?? 'solo');
  const existing = document.getElementById(WIN_ID);
  if (existing) {
    const ta = existing.querySelector('textarea'); if (ta) ta.focus();
    return existing;
  }

  // Initialize from the persisted prompt on the node. node.properties serializes
  // into the workflow JSON (and ComfyUI's autosave), so the prompt survives
  // refresh and restart exactly like native widget values.
  let currentValue = "";
  try {
    if (_epeOwnerNode && _epeOwnerNode.properties && typeof _epeOwnerNode.properties.epe_prompt === "string") {
      currentValue = _epeOwnerNode.properties.epe_prompt;
    }
  } catch (_e) {}

  if (!document.getElementById("epe-design-system")) {
    const _ds = document.createElement("style");
    _ds.id = "epe-design-system";
    _ds.textContent = `
      .epe-panel { background:#0f141c; color:#c2cddb; }
      .epe-titlebar {
        display:flex; align-items:center; gap:8px; padding:7px 12px;
        background:#10151d; border-bottom:1px solid rgba(109,184,232,0.16);
        flex-shrink:0;
      }
      .epe-title {
        flex:1; font-size:13px; font-weight:600; color:#c2e2f8;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .epe-close {
        background:none; border:none; color:#8a9aac; font-size:14px;
        cursor:pointer; padding:2px 6px; border-radius:4px; line-height:1;
      }
      .epe-close:hover { color:#dce6f2; background:rgba(109,184,232,0.12); }
      .epe-toolbar { display:flex; gap:6px; align-items:center; }
    `;
    document.head.appendChild(_ds);
  }

  const floatingWin = document.createElement("div");
  floatingWin.id = WIN_ID;
  floatingWin.className = 'epe-panel';
  floatingWin.style.cssText = `
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-sizing: border-box;
    position: relative;
  `;

  // --- Title bar ---
  const titleBar = document.createElement("div");
  titleBar.className = 'epe-titlebar';

  const titleText = document.createElement("span");
  titleText.className = 'epe-title';
  titleText.innerHTML = `Enhanced Prompt Editor`;

  const titleRight = document.createElement("div");
  titleRight.style.cssText = `display: flex; align-items: center; gap: 8px;`;

  const countTokens = (text) => text.trim() ? text.trim().split(/[\s,]+/).filter(t => t.length > 0).length : 0;
  const tokenBadge = document.createElement("span");
  const updateTokenBadge = (text) => {
    const tkns = countTokens(text);
    tokenBadge.textContent = `${tkns} tokens`;
    tokenBadge.style.color = "#667";
    // Persist on every text change (programmatic or typed) so the prompt
    // survives refresh/restart via node.properties → workflow JSON.
    if (_epeOwnerNode) {
      if (!_epeOwnerNode.properties) _epeOwnerNode.properties = {};
      try { _epeOwnerNode.properties.epe_prompt = (typeof text === "string") ? text : ""; } catch (_e) {}
    }
  };
  tokenBadge.style.cssText = `font-size:12px; color:#4e5c6e; padding:1px 5px; background:#141a24; border-radius:3px; border:1px solid #28364a; font-family:monospace;`;
  updateTokenBadge(currentValue);

  // Wireless count badge (⌁ N) — hidden when zero. The footer's renderWireless
  // calls _epeSetHeaderWirelessCount(n) to keep this in sync.
  const wlHeaderBadge = document.createElement("span");
  wlHeaderBadge.style.cssText = `display:none; align-items:center; gap:3px; font-size:11px; color:#6ea6ff; background:#243245; border:1px solid #2a5570; padding:1px 7px; border-radius:9px;`;
  const _epeSetHeaderWirelessCount = (n) => {
    if (!n) { wlHeaderBadge.style.display = "none"; return; }
    wlHeaderBadge.style.display = "inline-flex";
    wlHeaderBadge.textContent = String(n);
  };

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.className = 'epe-close';


  titleRight.appendChild(wlHeaderBadge);
  titleRight.appendChild(tokenBadge);
  // Only show close button when EPE is a floating window, not when embedded in a node
  if (!_epeOwnerNode) titleRight.appendChild(closeBtn);
  titleBar.appendChild(titleText);
  titleBar.appendChild(titleRight);

  // --- Toolbar ---
  const toolbar = document.createElement("div");
  toolbar.className = 'epe-toolbar';

  const toolBtnStyle = `
    background: #1c2431; border: 1px solid #28364a; border-radius: 4px;
    color: #8a9aac; padding: 3px 8px; cursor: pointer; font-size: 13px;
    white-space: nowrap; transition: background 0.12s, color 0.12s, border-color 0.12s;
  `;

  const _epeTip = document.createElement("div");
  _epeTip.style.cssText = `
    position: fixed; z-index: 999999; pointer-events: none; display: none;
    background: #121821; border: 1px solid #31415a; border-radius: 4px;
    color: #c2cddb; font-size: 11px; padding: 4px 8px;
    white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,0.5);
  `;
  document.body.appendChild(_epeTip);
  let _epeTipTimer = null;
  const _showEpeTip = (btn, text) => {
    clearTimeout(_epeTipTimer);
    _epeTipTimer = setTimeout(() => {
      const r = btn.getBoundingClientRect();
      _epeTip.textContent = text;
      _epeTip.style.display = "block";
      _epeTip.style.left = r.left + "px";
      _epeTip.style.top = (r.bottom + 4) + "px";
    }, 300);
  };
  const _hideEpeTip = () => { clearTimeout(_epeTipTimer); _epeTip.style.display = "none"; };

  const toolBtnHover = (btn) => {
    btn.onmouseenter = () => {
      if (btn._active) return;
      btn.style.background = "#28364a"; btn.style.borderColor = "#4e5c6e"; btn.style.color = "#dde6f0";
      if (btn.title) { btn._tipText = btn.title; btn.title = ""; }
      if (btn._tipText) _showEpeTip(btn, btn._tipText);
    };
    btn.onmouseleave = () => {
      if (btn._active) return;
      btn.style.background = "#1c2431"; btn.style.borderColor = "#28364a"; btn.style.color = "#8a9aac";
      if (btn._tipText) { btn.title = btn._tipText; }
      _hideEpeTip();
    };
  };
  const setToolBtnOn = (btn, on) => {
    btn._active = on;
    if (on) { btn.style.background = "rgba(100,160,230,0.15)"; btn.style.borderColor = "rgba(100,160,230,0.3)"; btn.style.color = "rgba(100,160,230,0.9)"; }
    else { btn.style.background = "#1c2431"; btn.style.borderColor = "#28364a"; btn.style.color = "#8a9aac"; }
  };



        const saveAsBtn = document.createElement("button");
        saveAsBtn.textContent = "Save As";
        saveAsBtn.title = "Save current prompt to a named file";
        saveAsBtn.style.cssText = toolBtnStyle;
        toolBtnHover(saveAsBtn);

        const loadBtn = document.createElement("button");
        loadBtn.textContent = "Load";
        loadBtn.title = "Load a previously saved prompt file";
        loadBtn.style.cssText = toolBtnStyle;
        toolBtnHover(loadBtn);

        const clearBtn = document.createElement("button");
        clearBtn.textContent = "Clear";
        clearBtn.title = "Clear the prompt text area";
        clearBtn.style.cssText = toolBtnStyle;
        toolBtnHover(clearBtn);

        const aiExpandBtn = document.createElement("button");
        aiExpandBtn.textContent = "Expand";
        aiExpandBtn.title = "Use Ollama to expand and enrich the current prompt";
        aiExpandBtn.style.cssText = toolBtnStyle;
        toolBtnHover(aiExpandBtn);

        const aiVariBtn = document.createElement("button");
        aiVariBtn.textContent = "Variations";
        aiVariBtn.title = "Generate 3 alternative versions of the current prompt";
        aiVariBtn.style.cssText = toolBtnStyle;
        toolBtnHover(aiVariBtn);

        const aiInvertBtn = document.createElement("button");
        aiInvertBtn.textContent = "Aesthetic Inverter";
        aiInvertBtn.title = "Shift this prompt to its aesthetic counterpart — same quality, contrasting energy";
        aiInvertBtn.style.cssText = toolBtnStyle;
        toolBtnHover(aiInvertBtn);

        const aiSettingsBtn = document.createElement("button");
        aiSettingsBtn.textContent = "AI Setup";
        aiSettingsBtn.title = "Configure Ollama URL, model, and system prompts";
        aiSettingsBtn.style.cssText = toolBtnStyle;
        aiSettingsBtn._active = false;
        toolBtnHover(aiSettingsBtn);

        const extractBtn = document.createElement("button");
        extractBtn.textContent = "Extract";
        extractBtn.title = "Extract prompt metadata from a ComfyUI-generated PNG, JPEG, or WebP";
        extractBtn.style.cssText = toolBtnStyle;
        toolBtnHover(extractBtn);

        const extractFileInput = document.createElement("input");
        extractFileInput.type = "file";
        extractFileInput.accept = ".png,.webp,.jpg,.jpeg";
        extractFileInput.style.display = "none";
        extractBtn.onclick = () => { extractFileInput.click(); };

        const img2imgBtn = document.createElement("button");
        img2imgBtn.textContent = "Img2Img";
        img2imgBtn.title = "Load an image and generate a prompt from it using Ollama (qwen3-vl)";
        img2imgBtn.style.cssText = toolBtnStyle;
        toolBtnHover(img2imgBtn);

        const img2imgFileInput = document.createElement("input");
        img2imgFileInput.type = "file";
        img2imgFileInput.accept = ".png,.webp,.jpg,.jpeg";
        img2imgFileInput.style.display = "none";
        img2imgBtn.onclick = () => { img2imgFileInput.click(); };

        img2imgFileInput.onchange = async () => {
          const file = img2imgFileInput.files?.[0];
          if (!file) return;
          img2imgFileInput.value = "";
          await _epeOllamaVision.run("image-file", file, showAiPanel, hideAiPanel, (prompt) => {
            textEl.value = prompt;
            updateTokenBadge(textEl.value);
            textEl.dispatchEvent(new Event("input"));
          }, {
            onFavorites: (t) => { _libAddEntry("favorites", t); },
            onSnippets:  (t) => { _libAddEntry("snippets", t); },
            onEnhance:   (t) => { textEl.value = t; updateTokenBadge(t); runAiAction("expand"); },
            onVariation: (t) => { textEl.value = t; updateTokenBadge(t); runAiAction("variations"); },
          });
        };
        
        extractFileInput.onchange = async () => {
          const file = extractFileInput.files?.[0];
          if (!file) return;
          extractFileInput.value = ""; // Reset for re-use
          
          try {
            // Parse PNG metadata
            const metadata = await _epeExtractPngMetadata(file);
            
            if (!metadata.prompt && !metadata.workflow) {
              showAiPanel((() => {
                const wrap = document.createElement("div");
                wrap.style.cssText = "padding: 14px 16px; display: flex; flex-direction: column; gap: 8px;";
                const msg = document.createElement("div");
                msg.style.cssText = "color: #6db8e8; font-size: 12px;";
                msg.textContent = "No ComfyUI metadata found in this image. The image may not have been generated by ComfyUI, or its metadata was stripped.";
                const dismissBtn = document.createElement("button");
                dismissBtn.textContent = "Dismiss";
                dismissBtn.style.cssText = "align-self: flex-end; background: #1c2431; border: 1px solid rgba(255,255,255,0.06); border-radius: 4px; color: #9aaaba; padding: 3px 12px; cursor: pointer; font-size: 11px;";
                dismissBtn.onclick = hideAiPanel;
                wrap.appendChild(msg);
                wrap.appendChild(dismissBtn);
                return wrap;
              })());
              return;
            }
            
            const parsed = _epeParsePromptData(metadata.prompt, metadata.workflow);
            if (!parsed) {
              showAiError("Could not parse prompt data from this image.");
              return;
            }
            
            // Build the results panel
            const wrap = document.createElement("div");
            wrap.style.cssText = "padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 12px;";
            
            // Header
            const header = document.createElement("div");
            header.style.cssText = "color: rgba(100, 200, 180, 0.9); font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;";
            header.textContent = "📋 Extracted from: " + file.name;
            wrap.appendChild(header);
            
            // Helper: create a prompt section with copy + use buttons
            const makePromptSection = (label, text, labelColor) => {
              const section = document.createElement("div");
              section.style.cssText = "display: flex; flex-direction: column; gap: 4px;";
              
              const titleRow = document.createElement("div");
              titleRow.style.cssText = "display: flex; align-items: center; justify-content: space-between;";
              
              const titleEl = document.createElement("span");
              titleEl.style.cssText = `color: ${labelColor || "#9aaaba"}; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;`;
              titleEl.textContent = label;
              
              const btnGroup = document.createElement("div");
              btnGroup.style.cssText = "display: flex; gap: 4px;";
              
              const copyBtn = document.createElement("button");
              copyBtn.textContent = "Copy";
              copyBtn.style.cssText = "background: #1c2431; border: 1px solid rgba(255,255,255,0.06); border-radius: 3px; color: #9aaaba; padding: 2px 8px; cursor: pointer; font-size: 10px;";
              copyBtn.onclick = () => {
                navigator.clipboard.writeText(text).then(() => {
                  copyBtn.textContent = "Copied!";
                  setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
                });
              };
              
              const useBtn = document.createElement("button");
              useBtn.textContent = "Use Prompt";
              useBtn.style.cssText = "background: rgba(100, 130, 230, 0.3); border: 1px solid rgba(100, 130, 230, 0.5); border-radius: 3px; color: #a0c0ff; padding: 2px 8px; cursor: pointer; font-size: 10px;";
              useBtn.onclick = () => {
                textEl.value = text;
                updateTokenBadge(textEl.value);
                textEl.dispatchEvent(new Event("input"));
                hideAiPanel();
              };
              
              btnGroup.appendChild(copyBtn);
              btnGroup.appendChild(useBtn);
              titleRow.appendChild(titleEl);
              titleRow.appendChild(btnGroup);
              
              const textBox = document.createElement("div");
              textBox.style.cssText = "color: #d4dfea; font-size: 11px; line-height: 1.5; background: #141a24; padding: 8px 10px; border-radius: 4px; border: 1px solid #2b3849; white-space: pre-wrap; word-wrap: break-word; max-height: 120px; overflow-y: auto;";
              textBox.textContent = text;
              
              section.appendChild(titleRow);
              section.appendChild(textBox);
              return section;
            };
            
            // Helper: create a collapsible settings section
            const makeCollapsible = (label, contentHtml) => {
              const section = document.createElement("div");
              section.style.cssText = "border: 1px solid #2b3849; border-radius: 4px; overflow: hidden;";
              
              const headerEl = document.createElement("div");
              headerEl.style.cssText = "display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: #141a24; cursor: pointer; user-select: none;";
              
              const chevron = document.createElement("span");
              chevron.textContent = "▶";
              chevron.style.cssText = "color: #6a7a8d; font-size: 8px; transition: transform 0.15s;";
              
              const labelEl = document.createElement("span");
              labelEl.style.cssText = "color: #8a9aac; font-size: 11px; font-weight: 600;";
              labelEl.textContent = label;
              
              headerEl.appendChild(chevron);
              headerEl.appendChild(labelEl);
              
              const body = document.createElement("div");
              body.style.cssText = "display: none; padding: 8px 10px; font-size: 11px; color: #9aaaba; line-height: 1.6; border-top: 1px solid #2a3850;";
              body.innerHTML = contentHtml;
              
              headerEl.onclick = () => {
                const isOpen = body.style.display !== "none";
                body.style.display = isOpen ? "none" : "block";
                chevron.style.transform = isOpen ? "" : "rotate(90deg)";
              };
              
              section.appendChild(headerEl);
              section.appendChild(body);
              return section;
            };
            
            // Helper: escape HTML
            const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            
            // Positive prompts
            if (parsed.positivePrompts.length > 0) {
              for (const p of parsed.positivePrompts) {
                const label = p.title || p.className || "Prompt";
                wrap.appendChild(makePromptSection(label, p.text, "rgba(100, 200, 150, 0.9)"));
              }
            }
            
            // Negative prompts
            if (parsed.negativePrompts.length > 0) {
              for (const p of parsed.negativePrompts) {
                const label = p.title || p.className || "Negative Prompt";
                wrap.appendChild(makePromptSection(label, p.text, "rgba(230, 120, 120, 0.9)"));
              }
            }
            
            // No prompts found
            if (parsed.positivePrompts.length === 0 && parsed.negativePrompts.length === 0) {
              const nope = document.createElement("div");
              nope.style.cssText = "color: #8a9aac; font-size: 11px; padding: 4px 0;";
              nope.textContent = "No text prompts found in the metadata.";
              wrap.appendChild(nope);
            }
            
            // --- Collapsible settings sections ---
            
            // Model
            if (parsed.models.length > 0) {
              const html = parsed.models.map(m => 
                `<div><span style="color:#8ab;">Model:</span> ${esc(m.name)}</div>`
              ).join("");
              wrap.appendChild(makeCollapsible(`Model (${parsed.models.length})`, html));
            }
            
            // KSampler
            if (parsed.samplers.length > 0) {
              const html = parsed.samplers.map((s, i) => `
                <div style="margin-bottom: 6px;">
                  ${parsed.samplers.length > 1 ? `<div style="color:#8ab; margin-bottom:2px;">KSampler ${i + 1} (${esc(s.className)})</div>` : ""}
                  <div><span style="color:#8a9aac;">Steps:</span> ${esc(s.steps)} &nbsp; <span style="color:#8a9aac;">CFG:</span> ${esc(s.cfg)} &nbsp; <span style="color:#8a9aac;">Denoise:</span> ${esc(s.denoise)}</div>
                  <div><span style="color:#8a9aac;">Sampler:</span> ${esc(s.sampler_name)} &nbsp; <span style="color:#8a9aac;">Scheduler:</span> ${esc(s.scheduler)}</div>
                  <div><span style="color:#8a9aac;">Seed:</span> <span style="color:#b8a0e0; user-select: all;">${esc(s.seed)}</span></div>
                </div>
              `).join("");
              wrap.appendChild(makeCollapsible(`KSampler (${parsed.samplers.length})`, html));
            }
            
            // LoRAs
            if (parsed.loras.length > 0) {
              const html = parsed.loras.map(l => `
                <div style="margin-bottom: 4px;">
                  <div><span style="color:#8ab;">LoRA:</span> ${esc(l.name)}</div>
                  <div style="padding-left: 12px;"><span style="color:#8a9aac;">Model strength:</span> ${esc(l.strength_model)} &nbsp; <span style="color:#8a9aac;">CLIP strength:</span> ${esc(l.strength_clip)}</div>
                </div>
              `).join("");
              wrap.appendChild(makeCollapsible(`LoRAs (${parsed.loras.length})`, html));
            }
            
            // VAE
            if (parsed.vaes.length > 0) {
              const html = parsed.vaes.map(v => 
                `<div><span style="color:#8ab;">VAE:</span> ${esc(v.name)}</div>`
              ).join("");
              wrap.appendChild(makeCollapsible(`VAE (${parsed.vaes.length})`, html));
            }
            
            // CLIP
            if (parsed.clipSettings.length > 0) {
              const html = parsed.clipSettings.map(c => 
                `<div><span style="color:#8ab;">CLIP:</span> ${esc(c.name)}${c.type ? ` <span style="color:#8a9aac;">(${esc(c.type)})</span>` : ""}</div>`
              ).join("");
              wrap.appendChild(makeCollapsible(`CLIP (${parsed.clipSettings.length})`, html));
            }
            
            // Image Size (from file header)
            if (metadata.imageWidth && metadata.imageHeight) {
              const html = `<div><span style="color:#8a9aac;">Width:</span> ${esc(metadata.imageWidth)} &nbsp; <span style="color:#8a9aac;">Height:</span> ${esc(metadata.imageHeight)}</div>`;
              wrap.appendChild(makeCollapsible("Image Size", html));
            }
            
            // Dismiss button
            const dismissRow = document.createElement("div");
            dismissRow.style.cssText = "display: flex; justify-content: flex-end; padding-top: 4px;";
            const dismissBtn = document.createElement("button");
            dismissBtn.textContent = "Dismiss";
            dismissBtn.style.cssText = "background: #1c2431; border: 1px solid rgba(255,255,255,0.06); border-radius: 4px; color: #9aaaba; padding: 3px 12px; cursor: pointer; font-size: 11px;";
            dismissBtn.onclick = hideAiPanel;
            dismissRow.appendChild(dismissBtn);
            wrap.appendChild(dismissRow);
            
            showAiPanel(wrap);
            
          } catch (err) {
            showAiError("Failed to read PNG metadata: " + (err.message || err));
          }
        };
        
        // ── Export button logic (was inline, now kept as named handler) ──
        const _doExport = async () => {
          const text = textEl.value;
          if(!text.trim()){ alert("Nothing to export — prompt is empty."); return; }
          const safeName = lbl.replace(/[^a-zA-Z0-9_-]/g,"_").substring(0,30) || "prompt";
          const filename = safeName + ".txt";
          try {
            if(window.showSaveFilePicker){
              const handle = await window.showSaveFilePicker({
                suggestedName: filename,
                types:[{description:"Text file",accept:{"text/plain":[".txt"]}}]
              });
              const writable = await handle.createWritable();
              await writable.write(text);
              await writable.close();
            } else {
              const blob = new Blob([text],{type:"text/plain"});
              const url  = URL.createObjectURL(blob);
              const a    = document.createElement("a");
              a.href=url; a.download=filename;
              document.body.appendChild(a); a.click();
              document.body.removeChild(a); URL.revokeObjectURL(url);
            }
          } catch(err){
            if(err.name !== "AbortError") console.warn("[EPE] Export error:", err);
          }
        };

        // ── Dropdown menu factory ──
        // Each menu is position:absolute inside a position:relative wrapper div,
        // which lives in the toolbar. floatingWin uses overflow:visible so the
        // dropdown paints outside the window bounds without clipping.
        const _activeMenus = { current: null };
        const _menuBtnOn = (btn, on) => {
          btn._on = on;
          btn.style.color = on ? "#c2e2f8" : "#8ba5be";
          btn.style.background = on ? "rgba(109,184,232,0.14)" : "none";
        };
        const _closeAllMenus = () => {
          if (_activeMenus.current) {
            _activeMenus.current._menu.style.display = "none";
            _menuBtnOn(_activeMenus.current._btn, false);
            _activeMenus.current = null;
          }
        };
        // Click anywhere off an open menu closes it.
        const _epeMenuOutside = (ev) => {
          if (_activeMenus.current && !_activeMenus.current.contains(ev.target)) _closeAllMenus();
        };
        document.addEventListener("mousedown", _epeMenuOutside, true);
        if (_epeOwnerNode) {
          const _pd = _epeOwnerNode._epeDispose;
          _epeOwnerNode._epeDispose = () => {
            try { _pd && _pd(); } catch (_e) {}
            try { document.removeEventListener("mousedown", _epeMenuOutside, true); } catch (_e) {}
          };
        }
        const makeMenuBtn = (label, items) => {
          // Wrapper is the positioned ancestor for the absolute menu
          const wrap = document.createElement("div");
          wrap.style.cssText = "position:relative;display:inline-flex;flex-shrink:0;";

          const btn = document.createElement("button");
          btn.textContent = label + " ▾";
          btn.style.cssText =
            "background:none;border:none;color:#8ba5be;cursor:pointer;" +
            "font-size:11px;padding:3px 6px;border-radius:5px;line-height:1;" +
            "transition:color .12s,background .12s;";
          btn.onmouseenter = () => { if (!btn._on) { btn.style.color = "#c2e2f8"; btn.style.background = "rgba(109,184,232,0.1)"; } };
          btn.onmouseleave = () => { if (!btn._on) { btn.style.color = "#8ba5be"; btn.style.background = "none"; } };

          const menu = document.createElement("div");
          menu.style.cssText =
            "position:absolute;top:calc(100% + 2px);left:0;" +
            "z-index:200000;background:#141a24;border:1px solid #28364a;" +
            "border-radius:4px;box-shadow:0 4px 16px rgba(0,0,0,.8);" +
            "display:none;flex-direction:column;min-width:165px;padding:3px 0;";

          items.forEach(item => {
            if (item === "sep") {
              const sep = document.createElement("div");
              sep.style.cssText = "height:1px;background:#202a38;margin:3px 0;";
              menu.appendChild(sep);
              return;
            }
            const mi = document.createElement("button");
            mi.textContent = item.label;
            if (item.title) mi.title = item.title;
            mi.style.cssText =
              "background:none;border:none;color:#9fb4c8;font-size:12px;padding:5px 8px;line-height:1.4;" +
              "text-align:left;cursor:pointer;font-family:inherit;white-space:nowrap;" +
              "width:100%;box-sizing:border-box;display:block;";
            mi.onmouseenter = () => { mi.style.background="#1c2431"; mi.style.color="#dde6f0"; };
            mi.onmouseleave = () => { mi.style.background="none";    mi.style.color="#9aaaba"; };
            mi.onclick = (ev) => { ev.stopPropagation(); _closeAllMenus(); item.onclick(ev); };
            menu.appendChild(mi);
          });

          wrap.appendChild(btn);
          wrap.appendChild(menu);
          // Store refs for _closeAllMenus
          wrap._btn  = btn;
          wrap._menu = menu;
          btn._menu  = menu;
          btn._wrap  = wrap;

          btn.onclick = (ev) => {
            ev.stopPropagation();
            const isOpen = menu.style.display === "flex";
            _closeAllMenus();
            if (!isOpen) {
              menu.style.display = "flex";
              _menuBtnOn(btn, true);
              _activeMenus.current = wrap;
            }
          };
          return wrap;
        };

        // Save Snippet — declared here so it exists before menu wiring
        const saveSnippetBtn = document.createElement("button");
        saveSnippetBtn.textContent = "Save Snippet";
        saveSnippetBtn.title = "Save selected text (or full prompt) as a reusable snippet";
        saveSnippetBtn.style.cssText = toolBtnStyle;
        toolBtnHover(saveSnippetBtn);
        saveSnippetBtn.style.display = "";

        // ── FILE menu ──
        const fileMenuBtn = makeMenuBtn("File", [
          { label: "Save Favorite",  title: "Save current prompt to Favorites",      onclick: () => { const _sel = textEl.value.slice(textEl.selectionStart, textEl.selectionEnd).trim(); _libAddEntry("favorites", _sel || textEl.value); } },
          { label: "Save Snippet",   title: "Save selected text (or full prompt) as a reusable snippet", onclick: () => { saveSnippetBtn.onclick && saveSnippetBtn.onclick(); } },
          { label: "Clear Prompt",   title: "Clear the editor",                      onclick: () => { clearPromptBtn.onclick && clearPromptBtn.onclick(); } },
          { label: "Export Text",    title: "Export current prompt to a .txt file",  onclick: () => { _doExport(); } },
          { label: "Import Text",    title: "Import a .txt file into the editor",    onclick: () => { loadBtn.onclick && loadBtn.onclick(); } },
        ]);

        // ── Toolbar assembly ──
        // Save Favorite toolbar button
        const saveFavBtn = document.createElement("button");
        saveFavBtn.textContent = "Save Favorite";
        saveFavBtn.title = "Save current prompt to Favorites";
        saveFavBtn.style.cssText = toolBtnStyle;
        toolBtnHover(saveFavBtn);
        saveFavBtn.onclick = () => { const _sel = textEl.value.slice(textEl.selectionStart, textEl.selectionEnd).trim(); _libAddEntry("favorites", _sel || textEl.value); };

        const enhancePromptBtn = document.createElement("button");
        enhancePromptBtn.textContent = "Enhance Prompt";
        enhancePromptBtn.title = "Use Ollama to enhance and enrich the current prompt";
        enhancePromptBtn.style.cssText = toolBtnStyle;
        toolBtnHover(enhancePromptBtn);
        enhancePromptBtn.onclick = () => { aiExpandBtn.onclick && aiExpandBtn.onclick(); };

        const promptVariBtn = document.createElement("button");
        promptVariBtn.textContent = "Prompt Variations";
        promptVariBtn.title = "Generate 3 alternative versions of the current prompt";
        promptVariBtn.style.cssText = toolBtnStyle;
        toolBtnHover(promptVariBtn);
        promptVariBtn.onclick = () => { aiVariBtn.onclick && aiVariBtn.onclick(); };

        const extractImgBtn = document.createElement("button");
        extractImgBtn.textContent = "Extract from Image";
        extractImgBtn.title = "Extract prompt metadata from a ComfyUI-generated PNG";
        extractImgBtn.style.cssText = toolBtnStyle;
        toolBtnHover(extractImgBtn);
        extractImgBtn.onclick = () => { extractBtn.onclick && extractBtn.onclick(); };

        const img2imgRowBtn = document.createElement("button");
        img2imgRowBtn.textContent = "Image to Prompt";
        img2imgRowBtn.title = "Generate a prompt from an image using a vision model";
        img2imgRowBtn.style.cssText = toolBtnStyle;
        toolBtnHover(img2imgRowBtn);
        img2imgRowBtn.onclick = () => { img2imgBtn.onclick && img2imgBtn.onclick(); };

        const vid2promptRowBtn = document.createElement("button");
        vid2promptRowBtn.textContent = "Video to Prompt";
        vid2promptRowBtn.title = "Load a video and generate a prompt from it using Ollama (qwen3-vl)";
        vid2promptRowBtn.style.cssText = toolBtnStyle;
        toolBtnHover(vid2promptRowBtn);

        const vid2promptFileInput = document.createElement("input");
        vid2promptFileInput.type = "file";
        vid2promptFileInput.accept = ".mp4,.mov,.webm,.avi";
        vid2promptFileInput.style.display = "none";
        vid2promptRowBtn.onclick = () => { vid2promptFileInput.click(); };

        vid2promptFileInput.onchange = async () => {
          const file = vid2promptFileInput.files?.[0];
          if (!file) return;
          vid2promptFileInput.value = "";
          const MAX_BYTES = 500 * 1024 * 1024; // 500MB
          if (file.size > MAX_BYTES) {
            const wrap = document.createElement("div");
            wrap.style.cssText = "padding:14px 16px;display:flex;flex-direction:column;gap:10px;";
            const title = document.createElement("div");
            title.style.cssText = "color:#6db8e8;font-size:11px;font-weight:600;";
            title.textContent = "Video Too Large";
            const msg = document.createElement("div");
            msg.style.cssText = "color:#8a9aac;font-size:10px;line-height:1.6;";
            msg.textContent = `This video is ${(file.size / 1024 / 1024).toFixed(0)}MB. Maximum size is 500MB.`;
            const dismissBtn = document.createElement("button");
            dismissBtn.textContent = "Dismiss";
            dismissBtn.style.cssText = "align-self:flex-end;background:#1c2431;border:1px solid rgba(255,255,255,0.08);border-radius:4px;color:#9aaaba;padding:4px 14px;cursor:pointer;font-size:11px;";
            dismissBtn.onclick = () => hideAiPanel();
            wrap.appendChild(title); wrap.appendChild(msg); wrap.appendChild(dismissBtn);
            showAiPanel(wrap);
            return;
          }
          await _epeOllamaVision.run("video-file", file, showAiPanel, hideAiPanel, (prompt) => {
            textEl.value = prompt;
            updateTokenBadge(textEl.value);
            textEl.dispatchEvent(new Event("input"));
          }, {
            onFavorites: (t) => { _libAddEntry("favorites", t); },
            onSnippets:  (t) => { _libAddEntry("snippets", t); },
            onEnhance:   (t) => { textEl.value = t; updateTokenBadge(t); runAiAction("expand"); },
            onVariation: (t) => { textEl.value = t; updateTokenBadge(t); runAiAction("variations"); },
          });
        };

        const promptInvertBtn = document.createElement("button");
        promptInvertBtn.textContent = "Aesthetic Inverter";
        promptInvertBtn.title = "Shift this prompt to its aesthetic counterpart — same quality, contrasting energy";
        promptInvertBtn.style.cssText = toolBtnStyle;
        toolBtnHover(promptInvertBtn);
        promptInvertBtn.onclick = () => { aiInvertBtn.onclick && aiInvertBtn.onclick(); };

        // L2 layout — actions live in a left rail grouped by
        // intent (Transform / From media). The old horizontal toolbar row is
        // retired; hidden file inputs stay parked on it (never displayed).
        toolbar.style.display = "none";
        toolbar.appendChild(extractFileInput);
        toolbar.appendChild(img2imgFileInput);
        toolbar.appendChild(vid2promptFileInput);

        const actionRail = document.createElement("div");
        actionRail.style.cssText =
          "width:118px;flex-shrink:0;display:flex;flex-direction:column;gap:6px;" +
          "padding:10px 8px;background:rgba(109,184,232,0.04);" +
          "border-right:1px solid rgba(109,184,232,0.14);overflow-y:auto;";
        const _railLabel = (t, topPad) => {
          const s = document.createElement("div");
          s.textContent = t;
          s.style.cssText = "font-size:10px;color:#6d849a;padding:" + (topPad ? "8px" : "0") + " 2px 0;user-select:none;";
          return s;
        };
        const _railBtnCss =
          "display:block;width:100%;box-sizing:border-box;background:rgba(109,184,232,0.05);" +
          "border:1px solid rgba(109,184,232,0.15);border-radius:6px;color:#8ba5be;" +
          "padding:6px 4px;text-align:center;font-size:11px;line-height:1.35;cursor:pointer;" +
          "white-space:normal;transition:background .12s,color .12s,border-color .12s;";
        const _railPrimaryCss =
          _railBtnCss.replace("rgba(109,184,232,0.05)", "rgba(109,184,232,0.22)")
                     .replace("rgba(109,184,232,0.15)", "rgba(140,200,240,0.65)")
                     .replace("color:#8ba5be", "color:#c2e2f8;font-weight:500");
        // Relabel for the rail (full-name policy, groups carry context)
        enhancePromptBtn.textContent = "Enhance";
        promptVariBtn.textContent    = "Variations";
        promptInvertBtn.textContent  = "Inverter";
        enhancePromptBtn.style.cssText = _railPrimaryCss;
        [promptVariBtn, promptInvertBtn, extractImgBtn, img2imgRowBtn, vid2promptRowBtn].forEach(b => {
          b.style.cssText = _railBtnCss;
          b.onmouseenter = () => { b.style.background = "rgba(109,184,232,0.12)"; b.style.color = "#a8c6de"; };
          b.onmouseleave = () => { b.style.background = "rgba(109,184,232,0.05)"; b.style.color = "#8ba5be"; };
        });
        enhancePromptBtn.onmouseenter = () => { enhancePromptBtn.style.background = "rgba(109,184,232,0.3)"; };
        enhancePromptBtn.onmouseleave = () => { enhancePromptBtn.style.background = "rgba(109,184,232,0.22)"; };
        actionRail.appendChild(_railLabel("Transform", false));
        actionRail.appendChild(enhancePromptBtn);
        actionRail.appendChild(promptVariBtn);
        actionRail.appendChild(promptInvertBtn);
        actionRail.appendChild(_railLabel("From media", true));
        actionRail.appendChild(img2imgRowBtn);
        actionRail.appendChild(vid2promptRowBtn);
        actionRail.appendChild(extractImgBtn);
        
        // --- AI Results Floating Panel ---
        // Injected into floatingWin as an overlay; not part of leftPane layout.
        let _aiFloatPanel = null;

        const _createAiFloatPanel = () => {
          if (_aiFloatPanel) { _aiFloatPanel.remove(); _aiFloatPanel = null; }
          const fp = document.createElement("div");
          fp.style.cssText = [
            "position:fixed;z-index:99999;",
            "top:120px;right:40px;",
            "width:460px;min-width:260px;min-height:180px;",
            "background:#141a24;border:1px solid #28364a;border-radius:6px;",
            "display:flex;flex-direction:column;",
            "box-shadow:0 12px 40px rgba(0,0,0,0.7);",
          ].join("");

          // Title bar — drag handle
          const fpBar = document.createElement("div");
          fpBar.style.cssText = "display:flex;align-items:center;gap:6px;padding:6px 10px;background:#1f2835;border-bottom:1px solid #28364a;flex-shrink:0;cursor:move;user-select:none;";
          const fpTitle = document.createElement("span");
          fpTitle.textContent = ""; // default empty; callers set via showAiPanel.setTitle()
          fpTitle.style.cssText = "font-size:11px;font-weight:600;color:#dde6f0;flex:1;";
          fp._setTitle = (text) => { fpTitle.textContent = text || ""; };
          const fpClose = document.createElement("button");
          fpClose.textContent = "✕";
          fpClose.title = "Close";
          fpClose.style.cssText = "background:none;border:none;color:#5b6b7e;font-size:12px;cursor:pointer;padding:0 2px;line-height:1;";
          fpClose.onmouseenter = () => { fpClose.style.color="#c2cddb"; };
          fpClose.onmouseleave = () => { fpClose.style.color="#5b6b7e"; };
          fpClose.onclick = () => { if (fp._destroy) fp._destroy(); fp.remove(); _aiFloatPanel = null; _epeOllama.unloadModel(); };
          fpBar.appendChild(fpTitle);
          fpBar.appendChild(fpClose);
          fp.appendChild(fpBar);

          // Drag logic — viewport relative since position:fixed
          let _dx=0,_dy=0,_dragging=false;
          fpBar.addEventListener("mousedown", (ev) => {
            if (ev.target === fpClose) return;
            _dragging = true;
            const rect = fp.getBoundingClientRect();
            _dx = ev.clientX - rect.left;
            _dy = ev.clientY - rect.top;
            ev.preventDefault();
          });
          const _onMove = (ev) => {
            if (!_dragging) return;
            const x = Math.max(0, Math.min(ev.clientX - _dx, window.innerWidth - 60));
            const y = Math.max(0, Math.min(ev.clientY - _dy, window.innerHeight - 40));
            fp.style.left = x + "px";
            fp.style.top = y + "px";
            fp.style.right = "auto";
          };
          const _onUp = () => { _dragging = false; };
          document.addEventListener("mousemove", _onMove);
          document.addEventListener("mouseup", _onUp);
          // Clean up listeners when panel is removed
          fp._destroy = () => {
            document.removeEventListener("mousemove", _onMove);
            document.removeEventListener("mouseup", _onUp);
          };

          // Scrollable content area — uses position:absolute inner pattern
          // Content area — flex column so textarea can stretch to fill available space
          const fpBody = document.createElement("div");
          fpBody.style.cssText = "flex:1 1 0;min-height:0;display:flex;flex-direction:column;overflow:hidden;";
          fp.appendChild(fpBody);
          fp._body = fpBody;

          // Detect manual resize (corner drag) so we stop auto-sizing after that
          fp._userResized = false;
          fp._isAutoSizing = false;
          let _roInitDone = false;
          const _ro = new ResizeObserver(() => {
            if (!_roInitDone) { _roInitDone = true; return; } // ignore first fire on create
            if (fp._isAutoSizing) return;                     // ignore programmatic resizes
            fp._userResized = true;
          });
          _ro.observe(fp);
          const _origDestroy = fp._destroy || (() => {});
          fp._destroy = () => { _ro.disconnect(); _origDestroy(); };
          // Note: custom resize handles add their own chained _destroy below

          // Visible resize grip at bottom-right corner
          const fpGrip = document.createElement("div");
          fpGrip.title = "Drag to resize";
          fpGrip.style.cssText = [
            "position:absolute;bottom:1px;right:1px;",
            "width:16px;height:16px;pointer-events:none;z-index:6;",
            "background:linear-gradient(135deg,",
            "transparent 25%,rgba(109,184,232,0.75) 25%,rgba(109,184,232,0.75) 38%,",
            "transparent 38%,transparent 52%,rgba(109,184,232,0.75) 52%,rgba(109,184,232,0.75) 65%,",
            "transparent 65%,transparent 79%,rgba(109,184,232,0.75) 79%,rgba(109,184,232,0.75) 92%,",
            "transparent 92%);",
          ].join("");
          fp.appendChild(fpGrip);

          // Edge-detection resize — detects when mouse is near bottom/right edge of panel
          // No child elements needed, works regardless of overflow/flex settings
          const EDGE = 8; // px from edge to trigger resize
          let _resizing = false, _resizeEdge = "", _rsStartX = 0, _rsStartY = 0, _rsStartW = 0, _rsStartH = 0;

          fp.addEventListener("mousemove", (ev) => {
            if (_resizing) return;
            const r = fp.getBoundingClientRect();
            const nearB = ev.clientY >= r.bottom - EDGE;
            const nearR = ev.clientX >= r.right  - EDGE;
            if      (nearB && nearR) fp.style.cursor = "nwse-resize";
            else if (nearB)          fp.style.cursor = "ns-resize";
            else if (nearR)          fp.style.cursor = "ew-resize";
            else                     fp.style.cursor = "";
          });

          fp.addEventListener("mousedown", (ev) => {
            const r = fp.getBoundingClientRect();
            const nearB = ev.clientY >= r.bottom - EDGE;
            const nearR = ev.clientX >= r.right  - EDGE;
            if (!nearB && !nearR) return;
            _resizing   = true;
            _resizeEdge = (nearB && nearR) ? "both" : nearB ? "bottom" : "right";
            _rsStartX   = ev.clientX;
            _rsStartY   = ev.clientY;
            _rsStartW   = fp.offsetWidth;
            _rsStartH   = fp.offsetHeight;
            fp._userResized = true;
            ev.preventDefault();
            ev.stopPropagation();
          });

          const _onResizeMove = (ev) => {
            if (!_resizing) return;
            if (_resizeEdge === "both" || _resizeEdge === "right") {
              fp.style.width  = Math.max(260, _rsStartW + (ev.clientX - _rsStartX)) + "px";
            }
            if (_resizeEdge === "both" || _resizeEdge === "bottom") {
              fp.style.height = Math.max(180, _rsStartH + (ev.clientY - _rsStartY)) + "px";
            }
          };
          const _onResizeUp = () => {
            if (_resizing) { _resizing = false; fp.style.cursor = ""; }
          };
          document.addEventListener("mousemove", _onResizeMove);
          document.addEventListener("mouseup",   _onResizeUp);

          // Clean up resize listeners on destroy
          const _origDestroy2 = fp._destroy || (() => {});
          fp._destroy = () => {
            document.removeEventListener("mousemove", _onResizeMove);
            document.removeEventListener("mouseup",   _onResizeUp);
            _origDestroy2();
          };


          // Pinned footer for action buttons
          const fpFooter = document.createElement("div");
          fpFooter.style.cssText = "display:none;flex-direction:column;gap:5px;padding:6px 10px;background:#121821;border-top:1px solid #28364a;flex-shrink:0;";
          fp.appendChild(fpFooter);
          fp._footer = fpFooter;
          fp._setFooter = (children) => {
            fpFooter.innerHTML = "";
            const items = Array.isArray(children) ? children : [children];
            items.forEach(el => fpFooter.appendChild(el));
            fpFooter.style.display = "flex";
            fp._userResized = false;
            requestAnimationFrame(() => { fp._userResized = false; _aiFloatAutoSize(); });
          };
          fp._clearFooter = () => { fpFooter.innerHTML = ""; fpFooter.style.display = "none"; };

          // Position to the left of the EPE window
          (() => {
            const panelW = 420;
            const margin = 10;
            const epeRect = floatingWin.getBoundingClientRect();
            const leftPos = epeRect.left - panelW - margin;
            if (leftPos >= 10) {
              fp.style.left = leftPos + "px";
            } else if (epeRect.right + panelW + margin < window.innerWidth) {
              fp.style.left = (epeRect.right + margin) + "px";
            } else {
              fp.style.left = "40px";
            }
            fp.style.top = Math.max(10, epeRect.top + 40) + "px";
          })();
          document.body.appendChild(fp);
          _aiFloatPanel = fp;
          return fp;
        };
        
        // --- AI Settings Panel (hidden by default, shown below toolbar) ---
        const aiSettingsPanel = document.createElement("div");
        aiSettingsPanel.style.cssText = `
          display: none;
          flex-direction: column;
          gap: 8px;
          padding: 10px 12px;
          margin: 6px 0;
          background: #22304a;
          border: 1px solid rgba(140,200,240,0.5);
          border-radius: 10px;
          flex-shrink: 0;
          overflow-y: auto;
        `;
        
        // Build settings panel content
        const buildSettingsPanel = () => {
          const s = _epeOllama.getSettings();
          aiSettingsPanel.innerHTML = "";
          
          const fieldStyle = `background: #141a24; border: 1px solid #31415a; border-radius: 4px; color: #d4dfea; padding: 4px 8px; font-size: 11px; font-family: inherit; width: 100%; box-sizing: border-box; cursor: text;`;
          const labelStyle = `color: #7a8a9c; font-size: 10px; margin-bottom: 2px; display: block;`;
          
          // URL row
          const urlRow = document.createElement("div");
          urlRow.style.cssText = "display: flex; align-items: center; gap: 6px;";
          const urlLabel = document.createElement("label");
          urlLabel.textContent = "Ollama URL";
          urlLabel.style.cssText = labelStyle + "margin: 0; white-space: nowrap; min-width: 70px;";
          const urlInput = document.createElement("input");
          urlInput.type = "text";
          urlInput.value = s.url;
          urlInput.placeholder = "http://localhost:11434";
          urlInput.style.cssText = fieldStyle + "flex: 1;";
          const testBtn = document.createElement("button");
          testBtn.textContent = "Test";
          testBtn.style.cssText = toolBtnStyle + "padding: 4px 10px;";
          toolBtnHover(testBtn);
          const statusDot = document.createElement("span");
          statusDot.style.cssText = "width: 8px; height: 8px; border-radius: 50%; background: #4e5c6e; display: inline-block; flex-shrink: 0;";
          
          urlRow.appendChild(urlLabel);
          urlRow.appendChild(urlInput);
          urlRow.appendChild(testBtn);
          urlRow.appendChild(statusDot);
          aiSettingsPanel.appendChild(urlRow);
          
          // Model row
          const modelRow = document.createElement("div");
          modelRow.style.cssText = "display: flex; align-items: center; gap: 6px;";
          const modelLabel = document.createElement("label");
          modelLabel.textContent = "Model";
          modelLabel.style.cssText = labelStyle + "margin: 0; white-space: nowrap; min-width: 70px;";
          const modelSelect = document.createElement("select");
          modelSelect.style.cssText = fieldStyle + "flex: 1; cursor: pointer;";
          const defaultOpt = document.createElement("option");
          defaultOpt.value = "";
          defaultOpt.textContent = "— Click Test to load models —";
          modelSelect.appendChild(defaultOpt);
          if (s.model) {
            const savedOpt = document.createElement("option");
            savedOpt.value = s.model;
            savedOpt.textContent = s.model;
            savedOpt.selected = true;
            modelSelect.appendChild(savedOpt);
          }
          const refreshModelsBtn = document.createElement("button");
          refreshModelsBtn.textContent = "↻";
          refreshModelsBtn.title = "Refresh model list";
          refreshModelsBtn.style.cssText = toolBtnStyle + "font-size: 13px; padding: 2px 8px;";
          toolBtnHover(refreshModelsBtn);
          
          modelRow.appendChild(modelLabel);
          modelRow.appendChild(modelSelect);
          modelRow.appendChild(refreshModelsBtn);
          aiSettingsPanel.appendChild(modelRow);
          
          // Helper to create collapsible section
          const makeCollapsible = (title, textareaValue, defaultValue) => {
            const section = document.createElement("div");
            section.style.cssText = "border: 1px solid #2b3849; border-radius: 4px; overflow: hidden;";
            
            const header = document.createElement("div");
            header.style.cssText = "display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: #141a24; cursor: pointer; user-select: none;";
            header.onmouseenter = () => { header.style.background = "#222222"; };
            header.onmouseleave = () => { header.style.background = "#141a24"; };
            
            const arrow = document.createElement("span");
            arrow.textContent = "\u25B6";
            arrow.style.cssText = "color: #8a9aac; font-size: 9px; transition: transform 0.15s; flex-shrink: 0;";
            
            const label = document.createElement("span");
            label.textContent = title;
            label.style.cssText = "color: #9aaaba; font-size: 11px; flex: 1;";
            
            const hint = document.createElement("span");
            hint.textContent = "click to edit";
            hint.style.cssText = "color: #4e5c6e; font-size: 9px; font-style: italic;";

            const resetToDefaultBtn = document.createElement("button");
            resetToDefaultBtn.textContent = "\u21BA Default";
            resetToDefaultBtn.title = "Reset this prompt to its built-in default";
            resetToDefaultBtn.style.cssText = "background:none;border:1px solid #28364a;border-radius:3px;color:#5b6b7e;font-size:9px;padding:1px 6px;cursor:pointer;font-family:inherit;white-space:nowrap;transition:color .12s,border-color .12s;flex-shrink:0;";
            resetToDefaultBtn.onmouseenter = () => { resetToDefaultBtn.style.color = "#aab8c8"; resetToDefaultBtn.style.borderColor = "#5b6b7e"; };
            resetToDefaultBtn.onmouseleave = () => { resetToDefaultBtn.style.color = "#5b6b7e"; resetToDefaultBtn.style.borderColor = "#28364a"; };
            resetToDefaultBtn.onclick = (ev) => {
              ev.stopPropagation();
              if (defaultValue != null) { ta.value = defaultValue; ta.style.display = "block"; arrow.style.transform = "rotate(90deg)"; hint.textContent = "click to collapse"; }
            };
            
            header.appendChild(arrow);
            header.appendChild(label);
            header.appendChild(hint);
            header.appendChild(resetToDefaultBtn);
            
            const ta = document.createElement("textarea");
            ta.value = textareaValue;
            ta.style.cssText = fieldStyle + "display: none; height: 140px; min-height: 60px; resize: vertical; line-height: 1.4; border: none; border-top: 1px solid #2a3850; border-radius: 0;";
            
            header.onclick = (ev) => {
              ev.stopPropagation();
              const isOpen = ta.style.display !== "none";
              ta.style.display = isOpen ? "none" : "block";
              arrow.style.transform = isOpen ? "" : "rotate(90deg)";
              hint.textContent = isOpen ? "click to edit" : "click to collapse";
            };
            
            // Prevent drag when interacting with textarea
            ta.onmousedown = (ev) => ev.stopPropagation();
            
            section.appendChild(header);
            section.appendChild(ta);
            return { section, ta };
          };
          
          // ── Advanced: system-prompt editing (collapsed, discouraged) ──────
          const advWrap = document.createElement("div");
          advWrap.style.cssText = "margin-top: 4px;";
          const advHdr = document.createElement("div");
          advHdr.style.cssText =
            "display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" +
            "font-size:11px;color:#c2a878;padding:5px 8px;border:1px solid #4a3f2a;" +
            "background:rgba(200,160,90,0.06);border-radius:4px;";
          const advChev = document.createElement("span");
          advChev.textContent = "▶";
          advChev.style.cssText = "font-size:8px;transition:transform .12s;";
          const advTitle = document.createElement("span");
          advTitle.textContent = "Advanced — edit system prompts (not recommended)";
          advHdr.appendChild(advChev); advHdr.appendChild(advTitle);

          const advBody = document.createElement("div");
          advBody.style.cssText = "display:none;margin-top:6px;";

          const advNote = document.createElement("div");
          advNote.style.cssText =
            "font-size:10px;line-height:1.6;color:#a89272;background:rgba(200,160,90,0.06);" +
            "border:1px solid #4a3f2a;border-radius:4px;padding:7px 9px;margin-bottom:8px;";
          advNote.innerHTML =
            '<b style="color:#d4b784;">Editing not recommended.</b> These prompts work together with ' +
            'hidden instructions that apply your Style Tuning at generation time: your selected style and ' +
            'slider settings are appended to what you write here. Custom edits that conflict with your style ' +
            'or sliders can produce inconsistent or unexpected results. Use <b>Reset Defaults</b> to restore ' +
            'stable behavior.';
          advBody.appendChild(advNote);

          let _advOpen = false;
          advHdr.onclick = () => {
            _advOpen = !_advOpen;
            advBody.style.display = _advOpen ? "block" : "none";
            advChev.style.transform = _advOpen ? "rotate(90deg)" : "";
          };
          advWrap.appendChild(advHdr);
          advWrap.appendChild(advBody);
          aiSettingsPanel.appendChild(advWrap);

          const { section: expandSection, ta: expandTA } = makeCollapsible("Expand System Prompt", s.expandPrompt, _epeOllama._defaults.expandPrompt);
          advBody.appendChild(expandSection);
          
          const { section: variSection, ta: variTA } = makeCollapsible("Variations System Prompt", s.variationsPrompt, _epeOllama._defaults.variationsPrompt);
          advBody.appendChild(variSection);
          
          const { section: img2imgSection, ta: img2imgTA } = makeCollapsible("Img2Img System Prompt", s.img2imgPrompt || _epeOllama._defaults.img2imgPrompt, _epeOllama._defaults.img2imgPrompt);
          advBody.appendChild(img2imgSection);

          const { section: invertSection, ta: invertTA } = makeCollapsible("Aesthetic Inverter Prompt", s.invertPrompt || _epeOllama._defaults.invertPrompt, _epeOllama._defaults.invertPrompt);
          advBody.appendChild(invertSection);
          
          // Save / Reset row
          const saveRow = document.createElement("div");
          saveRow.style.cssText = "display: flex; gap: 6px; justify-content: flex-end;";
          const resetBtn = document.createElement("button");
          resetBtn.textContent = "Reset Defaults";
          resetBtn.style.cssText = toolBtnStyle + "padding: 4px 10px; color: #a88;";
          toolBtnHover(resetBtn);
          const saveSettingsBtn = document.createElement("button");
          saveSettingsBtn.textContent = "Save Settings";
          saveSettingsBtn.style.cssText = toolBtnStyle + "padding: 4px 10px; color: rgba(100, 200, 120, 0.9);";
          toolBtnHover(saveSettingsBtn);
          saveRow.appendChild(resetBtn);
          saveRow.appendChild(saveSettingsBtn);
          aiSettingsPanel.appendChild(saveRow);
          
          // --- Event handlers ---
          const populateModels = async (url) => {
            statusDot.style.background = "#ca0";
            testBtn.textContent = "...";
            // Ask the backend to ensure Ollama is up first — it will auto-start
            // a local Ollama if it isn't running. Returns { running, autoStart }.
            let ensured = null;
            try {
              const r = await fetch("/epe/ollama/check", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ollamaUrl: url }),
              });
              if (r.ok) ensured = await r.json();
            } catch (e) {}
            const connected = (ensured && ensured.running) || await _epeOllama.checkConnection(url);
            if (connected) {
              statusDot.style.background = "#4c4";
              testBtn.textContent = "Test";
              const models = await _epeOllama.fetchModels(url);
              const savedModel = _epeOllama.getSettings().model; // Re-read latest
              modelSelect.innerHTML = "";
              if (models.length === 0) {
                const noOpt = document.createElement("option");
                noOpt.value = "";
                noOpt.textContent = "— No models found —";
                modelSelect.appendChild(noOpt);
              } else {
                let foundSaved = false;
                for (const m of models) {
                  const opt = document.createElement("option");
                  opt.value = m;
                  opt.textContent = m;
                  if (m === savedModel) { opt.selected = true; foundSaved = true; }
                  modelSelect.appendChild(opt);
                }
                if (!foundSaved) {
                  if (savedModel) {
                    // The saved model isn't in the fetched list. Do NOT overwrite
                    // the user's choice — a slow/partial Ollama response would
                    // otherwise silently reassign their model. Surface it instead.
                    const missing = document.createElement("option");
                    missing.value = savedModel;
                    missing.textContent = savedModel + " (not found)";
                    missing.selected = true;
                    modelSelect.insertBefore(missing, modelSelect.firstChild);
                  } else if (models.length > 0) {
                    // No saved model at all — first run. Pick one and persist it.
                    modelSelect.value = models[0];
                    const cur = _epeOllama.getSettings();
                    cur.model = models[0];
                    _epeOllama.saveSettings(cur);
                  }
                }
              }
            } else {
              statusDot.style.background = "#c44";
              testBtn.textContent = "Test";
              modelSelect.innerHTML = "";
              const failOpt = document.createElement("option");
              failOpt.value = "";
              // Auto-start couldn't help — tell the user exactly why.
              const reason = ensured && ensured.autoStart;
              if (reason === "not_on_path") {
                failOpt.textContent = "— Ollama not found on PATH —";
                modelSelect.title = "Ollama isn't on this machine's PATH. Install it, or start it manually with: ollama serve";
              } else if (reason === "remote") {
                failOpt.textContent = "— Can't reach Ollama at that URL —";
                modelSelect.title = "Couldn't reach Ollama at that address. Make sure it's running on that machine and reachable from here.";
              } else {
                failOpt.textContent = "— Ollama not running (run: ollama serve) —";
                modelSelect.title = "Ollama isn't running. Start it with: ollama serve  —  or on Linux, run: sudo systemctl enable --now ollama  to start it at boot.";
              }
              modelSelect.appendChild(failOpt);
            }
          };
          
          testBtn.onclick = () => populateModels(urlInput.value.trim());
          refreshModelsBtn.onclick = () => populateModels(urlInput.value.trim());
          
          // Auto-save on any change
          modelSelect.onchange = () => {
            const cur = _epeOllama.getSettings();
            cur.model = modelSelect.value;
            _epeOllama.saveSettings(cur);
          };
          
          urlInput.onchange = () => {
            const cur = _epeOllama.getSettings();
            cur.url = urlInput.value.trim() || _epeOllama._defaults.url;
            _epeOllama.saveSettings(cur);
          };
          
          saveSettingsBtn.onclick = () => {
            const toSave = {
              url: urlInput.value.trim() || _epeOllama._defaults.url,
              model: modelSelect.value,
            };
            // Only persist prompts if user has customized them (differ from defaults)
            if (expandTA.value !== _epeOllama._defaults.expandPrompt) {
              toSave.expandPrompt = expandTA.value;
            }
            if (variTA.value !== _epeOllama._defaults.variationsPrompt) {
              toSave.variationsPrompt = variTA.value;
            }
            if (img2imgTA.value !== _epeOllama._defaults.img2imgPrompt) {
              toSave.img2imgPrompt = img2imgTA.value;
            }
            if (invertTA.value !== _epeOllama._defaults.invertPrompt) {
              toSave.invertPrompt = invertTA.value;
            }
            _epeOllama.saveSettings(toSave);
            aiSettingsPanel.style.display = "none";
          };
          
          resetBtn.onclick = () => {
            expandTA.value = _epeOllama._defaults.expandPrompt;
            variTA.value = _epeOllama._defaults.variationsPrompt;
            img2imgTA.value = _epeOllama._defaults.img2imgPrompt;
            urlInput.value = _epeOllama._defaults.url;
            invertTA.value = _epeOllama._defaults.invertPrompt;
          };
          
          // Auto-test on open
          populateModels(urlInput.value.trim());
        };
        
        // Settings toggle
        aiSettingsBtn.onclick = () => {
          if (aiSettingsPanel.style.display === "none") {
            buildSettingsPanel();
            // Header: title + ✕ (prepended after rebuild)
            const hdr = document.createElement("div");
            hdr.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:2px;";
            const hTitle = document.createElement("span");
            hTitle.textContent = "⚙ AI Setup";
            hTitle.style.cssText = "font-size:12px;font-weight:600;color:#c2e2f8;flex:1;";
            const hClose = document.createElement("span");
            hClose.textContent = "✕";
            hClose.style.cssText = "color:#8ba5be;cursor:pointer;font-size:12px;padding:0 4px;";
            hClose.onclick = () => { aiSettingsPanel.style.display = "none"; setToolBtnOn(aiSettingsBtn, false); };
            hdr.appendChild(hTitle); hdr.appendChild(hClose);
            aiSettingsPanel.insertBefore(hdr, aiSettingsPanel.firstChild);
            aiSettingsPanel.style.display = "flex";
            setToolBtnOn(aiSettingsBtn, true);
            // Scroll into view + brief glow pulse so it can't be missed
            try { aiSettingsPanel.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (_e) {}
            aiSettingsPanel.style.transition = "box-shadow .3s";
            aiSettingsPanel.style.boxShadow = "0 0 0 3px rgba(140,200,240,0.45)";
            setTimeout(() => { aiSettingsPanel.style.boxShadow = "none"; }, 900);
          } else {
            aiSettingsPanel.style.display = "none";
            setToolBtnOn(aiSettingsBtn, false);
          }
        };
        
        // --- AI action helpers ---
        const showAiPanel = (content) => {
          const fp = _aiFloatPanel || _createAiFloatPanel();
          fp._body.innerHTML = "";
          if (fp._clearFooter) fp._clearFooter();
          if (fp._setTitle) fp._setTitle(""); // reset title; callers set via showAiPanel.setTitle()
          fp._userResized = false; // reset so panel auto-sizes to new content
          if (typeof content === "string") {
            fp._body.innerHTML = content;
          } else {
            fp._body.appendChild(content);
          }
          // Auto-size after DOM renders
          requestAnimationFrame(_aiFloatAutoSize);
        };
        // Attach _setFooter to showAiPanel so methods outside this closure can use it
        showAiPanel._setFooter = (items) => { if (_aiFloatPanel && _aiFloatPanel._setFooter) _aiFloatPanel._setFooter(items); };
        // Set the floating-panel title bar text. Called by showModelPicker etc.
        // before/after showAiPanel(content) — must be called AFTER because
        // showAiPanel resets the title each time.
        showAiPanel.setTitle = (text) => { if (_aiFloatPanel && _aiFloatPanel._setTitle) _aiFloatPanel._setTitle(text); };
        // Expose showAiResult for use by _epeOllama.showResult (outside this closure)
        showAiPanel._showAiResult = (opts) => showAiResult(opts);
        
        const hideAiPanel = () => {
          if (_aiFloatPanel) {
            if (_aiFloatPanel._destroy) _aiFloatPanel._destroy();
            _aiFloatPanel.remove();
            _aiFloatPanel = null;
          }
        };

        // Auto-size panel: vision-flow panels (model picker, progress, errors)
        // size to their content. The legacy result-panel branch (82vh height)
        // was removed in Phase 5 — results now render in-editor.
        const _aiFloatAutoSize = () => {
          const fp = _aiFloatPanel;
          if (!fp || fp._userResized) return;
          fp._isAutoSizing = true;
          const barH = fp.children[0] ? fp.children[0].offsetHeight : 32;
          const footerH = (fp._footer && fp._footer.style.display !== "none") ? fp._footer.offsetHeight : 0;
          const bodyH = fp._body.scrollHeight;
          const maxH = Math.round(window.innerHeight * 0.8);
          fp.style.height = Math.min(barH + footerH + bodyH + 16, maxH) + "px";
          requestAnimationFrame(() => { if (fp) fp._isAutoSizing = false; });
        };
        
        const showAiNotConnected = () => {
          const msg = document.createElement("div");
          msg.style.cssText = "padding: 14px 16px; color: #9aaaba; font-size: 12px; line-height: 1.6;";
          msg.innerHTML = `
            <div style="color: #6db8e8; font-weight: 600; margin-bottom: 8px;">Ollama not detected</div>
            <div>This feature uses <b>Ollama</b> to run a local AI model for prompt assistance.</div>
            <div style="margin-top: 8px; color: #8a9aac;">
              1. Install Ollama from <span style="color: #8af;">ollama.com</span><br>
              2. Run <code style="background:#24303f; padding: 1px 4px; border-radius: 3px; color: #d4dfea;">ollama pull qwen3.5:4b</code> to download a model (example)<br>
              3. Make sure Ollama is running
            </div>
            <div style="margin-top: 8px; color: #6a7a8d;">If Ollama is running on a different port, click <b>⚙</b> to set the URL.</div>
            <div style="margin-top: 8px; text-align: right;">
              <button id="epe-ai-dismiss" style="background: #1c2431; border: 1px solid rgba(255,255,255,0.06); border-radius: 4px; color: #9aaaba; padding: 3px 12px; cursor: pointer; font-size: 11px;">Dismiss</button>
            </div>
          `;
          showAiPanel(msg);
          msg.querySelector("#epe-ai-dismiss").onclick = hideAiPanel;
        };
        
        const showAiLoading = (mode) => {
          const wrap = document.createElement("div");
          wrap.style.cssText = "padding: 14px 16px; color: #b8a0e0; font-size: 12px; display: flex; flex-direction: column; gap: 8px;";
          // Add spinner CSS if needed
          if (!document.getElementById("epe-ai-spinner-css")) {
            const st = document.createElement("style");
            st.id = "epe-ai-spinner-css";
            st.textContent = `@keyframes epe-spin { to { transform: rotate(360deg); } } .epe-ai-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(140,200,240,0.3); border-top-color: rgba(140,200,240,0.9); border-radius: 50%; animation: epe-spin 0.8s linear infinite; flex-shrink: 0; }`;
            document.head.appendChild(st);
          }
          const topRow = document.createElement("div");
          topRow.style.cssText = "display: flex; align-items: center; gap: 8px;";
          const spinner = document.createElement("span");
          spinner.className = "epe-ai-spinner";
          const statusText = document.createElement("span");
          statusText.textContent = mode === "expand" ? "Expanding prompt..." : mode === "invert" ? "Inverting aesthetic..." : "Generating variations...";
          statusText.style.cssText = "flex: 1;";
          const cancelBtn = document.createElement("button");
          cancelBtn.textContent = "Cancel";
          cancelBtn.style.cssText = "background: #1c2431; border: 1px solid rgba(255,255,255,0.06); border-radius: 4px; color: #9aaaba; padding: 2px 10px; cursor: pointer; font-size: 10px;";
          cancelBtn.onclick = () => {
            if (_aiAbort) { _aiAbort.abort(); _aiAbort = null; }
            hideAiPanel();
            _epeOllama.unloadModel();
          };
          topRow.appendChild(spinner);
          topRow.appendChild(statusText);
          topRow.appendChild(cancelBtn);
          wrap.appendChild(topRow);
          
          // Streaming preview area
          const streamPreview = document.createElement("div");
          streamPreview.style.cssText = "color: #8a9aac; font-size: 11px; line-height: 1.4; max-height: 120px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; display: none;";
          wrap.appendChild(streamPreview);
          
          showAiPanel(wrap);
          wrap._streamPreview = streamPreview;
          wrap._statusText = statusText;
          return wrap;
        };
        
        const showAiError = (errMsg) => {
          const wrap = document.createElement("div");
          wrap.style.cssText = "padding: 12px 16px; display: flex; flex-direction: column; gap: 6px;";
          const msgDiv = document.createElement("div");
          msgDiv.style.cssText = "color: #e07070; font-size: 12px;";
          msgDiv.textContent = errMsg;
          const dismissRow = document.createElement("div");
          dismissRow.style.cssText = "text-align: right;";
          const dismissBtn = document.createElement("button");
          dismissBtn.className = "epe-ai-dismiss-btn";
          dismissBtn.style.cssText = "background: #1c2431; border: 1px solid rgba(255,255,255,0.06); border-radius: 4px; color: #9aaaba; padding: 3px 12px; cursor: pointer; font-size: 11px;";
          dismissBtn.textContent = "Dismiss";
          dismissRow.appendChild(dismissBtn);
          wrap.appendChild(msgDiv);
          wrap.appendChild(dismissRow);
          showAiPanel(wrap);
          wrap.querySelector(".epe-ai-dismiss-btn").onclick = hideAiPanel;
        };
        
        // ── Unified AI result panel ─────────────────────────────────────────────
        // Single helper for: Enhance Prompt, Image to Prompt, Video to Prompt,
        // Aesthetic Inverter, and any other single-prompt AI result.
        // Footer Row 1 (optional): Save to Favorites | Save Snippet | Enhance Again | Variations
        // Footer Row 2 (always):   Discard | Append | Use Prompt
        const showAiResult = ({ text, label, labelColor, onAppend, onUsePrompt, onFavorites, onSnippets, onEnhance, onVariation }) => {
          // in-editor review-mode flow. The legacy callback parameters
          // (onAppend, onUsePrompt, onFavorites, onSnippets, onEnhance, onVariation)
          // are intentionally accepted but unused — the singleActionRow buttons
          // operate directly on textEl.value and the review-mode state. The
          // signature stays backward-compatible for the vision-flow caller
          // (showAiPanel._showAiResult shim).
          if (!text) return;

          // The floating panel may be open from a vision-flow intermediate state
          // (model picker, generation progress) — close it before swapping the
          // result into the editor.
          try { hideAiPanel(); } catch (_e) {}

          // ORDER MATTERS: enter or transition to single-result review FIRST,
          // so _reviewEnter (on a fresh entry) captures the user's current
          // textEl.value as the original-prompt snapshot — BEFORE we overwrite
          // textEl with the result. _reviewEnter only snapshots if not already
          // in review (chained operations preserve the user's true starting
          // prompt across streaming → single transitions).
          if (_reviewMode) {
            _reviewSetMode("single");
          } else {
            _reviewEnter("single");
          }

          // Replace editor content with the final cleaned result.
          textEl.value = text;
          updateTokenBadge(textEl.value);
          textEl.dispatchEvent(new Event("input"));
          textEl.scrollTop = 0;

          // Customize the review-strip label using the action-specific label
          // (e.g. "✨ Enhanced Prompt" → "Reviewing — Enhanced Prompt"). Strip
          // leading non-word characters to drop the leading icon.
          if (label) {
            const cleanLabel = label.replace(/^[^\w]+/, "").trim();
            if (cleanLabel) reviewLabel.textContent = "Reviewing — " + cleanLabel;
          }

          // Show the action row.
          singleActionRow.style.display = "flex";
        };

        const showExpandResult = (text, label) => {
          showAiResult({
            text,
            label: label || "✨ Enhanced Prompt",
            labelColor: "#b8a0e0",
            onAppend:    (t) => { if (textEl._epePushUndo) textEl._epePushUndo(); textEl.value = textEl.value ? textEl.value + "\n\n" + t : t; updateTokenBadge(textEl.value); textEl.dispatchEvent(new Event("input")); _epeOllama.unloadModel(); },
            onUsePrompt: (t) => { if (textEl._epePushUndo) textEl._epePushUndo(); textEl.value = t; updateTokenBadge(t); textEl.dispatchEvent(new Event("input")); _epeOllama.unloadModel(); },
            onFavorites: (t) => _libAddEntry("favorites", t),
            onSnippets:  (t) => _libAddEntry("snippets", t),
            onEnhance:   (t) => { textEl.value = t; updateTokenBadge(t); runAiAction("expand"); },
            onVariation: (t) => { textEl.value = t; updateTokenBadge(t); runAiAction("variations"); },
          });
        };

        const showVariationsResult = (variations) => {
          // render variations as in-editor cards instead of a
          // floating panel. Legacy floating-panel branch removed entirely.
          if (!variations || variations.length === 0) return;

          // Defensively close any open floating panel — there may have been a
          // stale loading wrapper from the streaming phase if useReviewMode
          // somehow flipped (e.g. legacy fallback). Cheap defense.
          try { hideAiPanel(); } catch (_e) {}

          // Transition to variations mode. _reviewMode is currently "streaming"
          // (set by runAiAction); _reviewSetMode preserves _originalPrompt.
          // If for some reason we're not in review (defensive), enter fresh.
          if (_reviewMode) {
            _reviewSetMode("variations");
          } else {
            _reviewEnter("variations");
          }

          // Restore the editor placeholder now — textEl is hidden in cards
          // mode, but we still want the placeholder restored if the user
          // later commits a variation (which makes textEl visible again).
          if (textEl._savedPlaceholder != null) {
            textEl.placeholder = textEl._savedPlaceholder;
            textEl._savedPlaceholder = null;
          }

          // Render the card picker. _applyReviewModeUI("variations") has
          // already hidden textEl and shown the (empty) variationsContainer.
          _renderVariationsCards(variations);
        };

        // --- AI Button Handlers ---
        let _aiAbort = null;

        // --- Review Mode state (in-editor review, replaces floating panel) ---
        // _reviewMode: null | "single" | "variations" | "streaming"
        //   "single"     — single-result review (Expand/img2img/vid2prompt/Invert)
        //   "variations" — 3-card picker
        //   "streaming"  — AI request in flight, textEl is read-only
        // _originalPrompt: snapshot of textEl.value taken at AI action start;
        //   restored by Discard/Cancel; consumed and cleared on _reviewExit().
        let _reviewMode = null;
        let _originalPrompt = null;

        // --- Review-mode edge-case helpers ---
        //
        // _showReviewDiscardToast(reason): bottom-centre toast announcing that
        // an in-flight review was auto-discarded because the user took an
        // action incompatible with review mode (tab switch, library card load,
        // etc.). If the recall slot has a previous prompt, it offers a Recall
        // link inside the toast.
        const _showReviewDiscardToast = (reason) => {
          const toast = document.createElement("div");
          toast.style.cssText = `
            position: fixed;
            bottom: 30px;
            left: 50%;
            transform: translateX(-50%);
            background: #1c2431;
            border: 1px solid #4e5c6e;
            border-radius: 4px;
            color: #d4dfea;
            padding: 8px 14px;
            font-size: 12px;
            z-index: 999999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.6);
            opacity: 0;
            transition: opacity 0.2s;
            display: flex;
            align-items: center;
            gap: 10px;
          `;
          const msg = document.createElement("span");
          msg.textContent = reason || "Result discarded";
          toast.appendChild(msg);

          document.body.appendChild(toast);
          requestAnimationFrame(() => { toast.style.opacity = "1"; });
          setTimeout(() => {
            toast.style.opacity = "0";
            setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 250);
          }, 4000);
        };

        // _autoDiscardReview(reason): if currently in review mode, abort any
        // streaming, restore _originalPrompt, exit review, and show a toast.
        // Returns true if a discard happened (caller can use this to skip
        // duplicate cleanup), false otherwise. Safe to call when not in review.
        const _autoDiscardReview = (reason) => {
          if (!_reviewMode) return false;
          if (_reviewMode === "streaming" && _aiAbort) {
            try { _aiAbort.abort(); } catch (_e) {}
            _aiAbort = null;
          }
          if (_originalPrompt !== null) {
            textEl.value = _originalPrompt;
            updateTokenBadge(textEl.value);
          }
          _reviewExit();
          try { _epeOllama.unloadModel(); } catch (_e) {}
          _showReviewDiscardToast(reason);
          return true;
        };

        // Esc key → Discard, when in review mode. Listener is scoped to the
        // EPE's floatingWin so it doesn't fire from elsewhere on the page,
        // and it only acts on review states (single, variations, streaming).
        // Removed in closeEditor.
        const _onEpeKeyDown = (ev) => {
          if (ev.key !== "Escape") return;
          if (!_reviewMode) return;
          // Don't intercept Esc inside open dropdowns — they handle their own
          // dismissal via document-level mousedown. (Native textarea Esc is a
          // no-op in most browsers anyway.)
          ev.preventDefault();
          ev.stopPropagation();
          if (_reviewMode === "streaming" && _aiAbort) {
            try { _aiAbort.abort(); } catch (_e) {}
            _aiAbort = null;
          }
          if (_originalPrompt !== null) {
            textEl.value = _originalPrompt;
            updateTokenBadge(textEl.value);
          }
          _reviewExit();
          try { _epeOllama.unloadModel(); } catch (_e) {}
        };
        // Attach to floatingWin (scoped) — tabIndex=-1 so it can receive focus
        // and fire keyboard events even when no child is focused.
        floatingWin.tabIndex = -1;
        floatingWin.addEventListener("keydown", _onEpeKeyDown);
        
        const showAiWelcome = (thenMode) => {
          const wrap = document.createElement("div");
          wrap.style.cssText = "padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;";
          
          const title = document.createElement("div");
          title.style.cssText = "color: #b8a0e0; font-size: 13px; font-weight: 600;";
          title.textContent = "AI Prompt Assistant";
          
          const desc = document.createElement("div");
          desc.style.cssText = "color: #9aaaba; font-size: 12px; line-height: 1.6;";
          desc.textContent = "Use a local AI model to help write and refine your image generation prompts.";
          
          const features = document.createElement("div");
          features.style.cssText = "color: #8a9aac; font-size: 11px; line-height: 1.8; padding: 8px 12px; background: #141a24; border-radius: 4px; border: 1px solid #2b3849;";
          features.innerHTML = `
            <b style="color:#b8a0e0;">✨ Expand</b> <span style="color:#8a9aac;">— Turn a brief idea into a detailed image prompt</span><br>
            <b style="color:#b8a0e0;">✨ Vary</b> <span style="color:#8a9aac;">— Generate creative variations of your current prompt</span><br>
            <b style="color:#8a9aac;">⚙ AI Setup</b> <span style="color:#8a9aac;">— Configure connection, model, and system prompts</span>
          `;
          
          const powered = document.createElement("div");
          powered.style.cssText = "color: #6a7a8d; font-size: 11px; line-height: 1.5;";
          powered.innerHTML = `Powered by <b style="color:#9aaaba;">Ollama</b> — a free, local AI model runner.<br><br>` +
            `<b style="color:#9aaaba;">Getting started:</b><br>` +
            `1. Install Ollama and ensure it is running in the background.<br>` +
            `2. Choose a model to use at <a href="https://ollama.com/search" target="_blank" style="color:#8af;">ollama.com/search</a> — smaller models are faster, larger ones are smarter, models marked "vision" can also interpret images.<br>` +
            `3. Download from a terminal — example: <code style="background:#24303f; padding:1px 4px; border-radius:3px; color:#d4dfea;">ollama pull qwen3.5:4b</code><br>` +
            `4. Open <b style="color:#9aaaba;">AI Setup</b>, click refresh, and select your model`;
          
          const btnRow2 = document.createElement("div");
          btnRow2.style.cssText = "display: flex; gap: 8px; justify-content: flex-end; margin-top: 2px;";
          
          const setupBtn = document.createElement("button");
          setupBtn.textContent = "⚙ Set up Ollama";
          setupBtn.style.cssText = "background: rgba(100, 130, 230, 0.25); border: 1px solid rgba(100, 130, 230, 0.4); border-radius: 4px; color: #a0c0ff; padding: 5px 14px; cursor: pointer; font-size: 11px;";
          setupBtn.onclick = () => {
            localStorage.setItem("epe_ai_welcomed", "1");
            hideAiPanel();
            aiSettingsBtn.click();
          };
          
          btnRow2.appendChild(setupBtn);
          
          wrap.appendChild(title);
          wrap.appendChild(desc);
          wrap.appendChild(features);
          wrap.appendChild(powered);
          wrap.appendChild(btnRow2);
          showAiPanel(wrap);
        };
        
        
        const runAiAction = async (mode) => {
          const promptText = textEl.value.trim();
          if (!promptText) {
            showAiError("Please enter some text first — write a brief description to expand, or a full prompt to generate variations from.");
            return;
          }
          
          // Check connection
          const settings = _epeOllama.getSettings();
          const connected = await _epeOllama.checkConnection(settings.url);
          if (!connected) {
            showAiNotConnected();
            return;
          }
          
          // Check model — only auto-detect when the user has never chosen one.
          if (!settings.model) {
            const models = await _epeOllama.fetchModels(settings.url);
            if (models.length > 0) {
              settings.model = models[0];
              _epeOllama.saveSettings(settings);
            } else {
              showAiError("No models found in Ollama. Run <code style='background:#24303f; padding:1px 4px; border-radius:3px;'>ollama pull qwen3.5:4b</code> to download one (example).");
              return;
            }
          }

          // expand, invert, AND variations all use the in-editor review
          // flow. During streaming they share the textEl-stream UX; on
          // completion, expand/invert remain in single review while variations
          // transitions to the cards picker.
          const useReviewMode = (mode === "expand" || mode === "invert" || mode === "variations");
          let loadingWrap = null;

          if (useReviewMode) {
            // Defensively close any open floating panel (e.g. a stale variations
            // panel) before swapping into the editor — prevents brief overlap
            // during the streaming phase.
            try { hideAiPanel(); } catch (_e) {}
            // If we're already in single-result review (e.g. user clicked Options →
            // Enhance again on a previous result), preserve _originalPrompt by
            // calling _reviewSetMode instead of _reviewEnter. Otherwise, this is
            // a fresh entry — _reviewEnter will snapshot the current prompt.
            if (_reviewMode) _reviewSetMode("streaming");
            else _reviewEnter("streaming");
            singleActionRow.style.display = "none";
            // Save and swap the placeholder so the empty textarea doesn't show
            // "Enter your prompt..." between the click and the first token.
            // Restored when review mode exits (success, cancel, or error).
            if (textEl._savedPlaceholder == null) textEl._savedPlaceholder = textEl.placeholder;
            textEl.placeholder =
              mode === "expand"     ? "Generating enhanced prompt…" :
              mode === "invert"     ? "Generating inverted aesthetic…" :
              mode === "variations" ? "Generating variations…" :
              "Generating…";
            // Clear the editor so streamed tokens replace it from scratch.
            textEl.value = "";
            updateTokenBadge("");
            reviewLabel.textContent =
              mode === "expand"     ? "Expanding…" :
              mode === "invert"     ? "Inverting aesthetic…" :
              mode === "variations" ? "Generating variations…" :
              "Streaming…";
          } else {
            // (No legacy path remaining — kept for defense in depth.)
            loadingWrap = showAiLoading(mode);
          }

          // Abort previous if still running
          if (_aiAbort) _aiAbort.abort();
          _aiAbort = new AbortController();
          
          try {
            const rawSystemPrompt = mode === "expand" ? settings.expandPrompt : mode === "invert" ? (settings.invertPrompt || _epeOllama._defaults.invertPrompt) : settings.variationsPrompt;
            // Substitute aesthetic-pool placeholders ({{PHOTO_EXAMPLES}}, etc.) with
            // a fresh random subset per call. If the user's prompt has no placeholders,
            // this is a no-op — the prompt is sent exactly as they wrote it.
            const baseSystemPrompt = _epeApplyAestheticRotation(rawSystemPrompt, 4, _styleActive);
            // prepend the active style's addendum (if not Default)
            // and append slider-driven modifier text. Self-heals if the user's
            // base prompt already contains a stale or partial addendum block.
            const systemPrompt = _composeSystemPromptForStyle(baseSystemPrompt);
            // map current slider values to Ollama options
            // (temperature, top_p, top_k, num_predict, min_p, seed, presence_penalty).
            const sliderOpts = _composeOllamaOpts();
            let tokenCount = 0;
            const raw = await _epeOllama.generate(systemPrompt, promptText, {
              signal: _aiAbort.signal,
              options: sliderOpts,
              onRetry: () => {
                const msg = "Vision model thinking interference, generating retry…";
                textEl.placeholder = msg;
                reviewLabel.textContent = "Retrying…";
              },
              onToken: (partial) => {
                tokenCount++;
                if (useReviewMode) {
                  // Stream directly into textEl. Read-only flag set by _reviewEnter
                  // means user can't edit during stream, but cursor/scroll still work.
                  textEl.value = partial;
                  updateTokenBadge(partial);
                  textEl.scrollTop = textEl.scrollHeight;
                  reviewLabel.textContent =
                    (mode === "expand"     ? "Expanding"            :
                     mode === "invert"     ? "Inverting aesthetic"  :
                     mode === "variations" ? "Generating variations":
                     "Streaming") + `… ${tokenCount} tokens`;
                } else {
                  if (loadingWrap._streamPreview) {
                    loadingWrap._streamPreview.style.display = "block";
                    loadingWrap._streamPreview.textContent = partial;
                    loadingWrap._streamPreview.scrollTop = loadingWrap._streamPreview.scrollHeight;
                  }
                  if (loadingWrap._statusText) {
                    loadingWrap._statusText.textContent = (mode === "expand" ? "Expanding" : mode === "invert" ? "Inverting aesthetic" : "Generating") + `... ${tokenCount} tokens`;
                  }
                  _aiFloatAutoSize();
                }
              }
            });
            
            if (mode === "expand" || mode === "invert") {
              const cleaned = _epeOllama.cleanResponse(raw);
              if (!cleaned) {
                // Restore original prompt and exit review before surfacing the error.
                if (useReviewMode) {
                  const orig = _originalPrompt;
                  _reviewExit();
                  if (orig !== null) {
                    textEl.value = orig;
                    updateTokenBadge(textEl.value);
                  }
                }
                showAiError("The model returned an empty response. Try a different model or adjust the system prompt.");
              } else {
                showExpandResult(cleaned, mode === "invert" ? "🔄 Aesthetic Inversion" : undefined);
              }
            } else {
              const variations = _epeOllama.parseVariations(raw);
              if (variations.length === 0) {
                // Restore original prompt and exit review before surfacing the error.
                if (useReviewMode) {
                  const orig = _originalPrompt;
                  _reviewExit();
                  if (orig !== null) {
                    textEl.value = orig;
                    updateTokenBadge(textEl.value);
                  }
                }
                showAiError("Could not parse variations from the model response. Try a different model or adjust the system prompt.");
              } else {
                showVariationsResult(variations);
              }
            }
          } catch (err) {
            if (err.name === "AbortError") {
              // Discard/Cancel button has already restored original and exited review.
              _aiAbort = null;
              return;
            }
            // Network/other failure: restore original prompt and exit review (if active)
            // before surfacing the error in the floating panel.
            if (useReviewMode) {
              const orig = _originalPrompt;
              _reviewExit();
              singleActionRow.style.display = "none";
              if (orig !== null) {
                textEl.value = orig;
                updateTokenBadge(textEl.value);
              }
            }
            showAiError(/thinking/i.test(err.message || "") ? err.message : `Request failed: ${err.message}`);
          }
          _aiAbort = null;
        };
        
        // Shared Ollama connectivity check — shows a clear message if not configured
        const _checkOllamaOrWarn = async () => {
          const settings = _epeOllama.getSettings();
          const connected = await _epeOllama.checkConnection(settings.url).catch(() => false);
          if (!connected) {
            const msg = document.createElement("div");
            msg.style.cssText = "padding:14px 16px;font-size:12px;line-height:1.7;";
            msg.innerHTML = `
              <div style="color:#6db8e8;font-weight:600;font-size:13px;margin-bottom:8px;">⚠ Ollama not configured</div>
              <div style="color:#aab8c8;">AI Prompt Enhancements require <b>Ollama</b> running locally.</div>
              <div style="color:#8a9aac;margin-top:8px;">
                1. Install Ollama from <span style="color:#8af;">ollama.com</span><br>
                2. Run <code style="background:#24303f;padding:1px 5px;border-radius:3px;color:#d4dfea;">ollama pull qwen3.5:4b</code> or <code style="background:#24303f;padding:1px 5px;border-radius:3px;color:#d4dfea;">qwen3.5:9b</code><br>
                3. Make sure Ollama is running, then click <b>AI Setup</b> to set the URL.
              </div>
              <div style="margin-top:10px;text-align:right;">
                <button id="epe-ollama-warn-dismiss" style="background:#1c2431;border:1px solid rgba(255,255,255,0.08);border-radius:4px;color:#9aaaba;padding:3px 14px;cursor:pointer;font-size:11px;">Dismiss</button>
              </div>
            `;
            showAiPanel(msg);
            msg.querySelector("#epe-ollama-warn-dismiss").onclick = hideAiPanel;
            return false;
          }
          return true;
        };

        aiExpandBtn.onclick = async () => {
          if (!localStorage.getItem("epe_ai_welcomed")) { showAiWelcome("expand"); return; }
          if (!await _checkOllamaOrWarn()) return;
          runAiAction("expand");
        };
        aiVariBtn.onclick = async () => {
          if (!localStorage.getItem("epe_ai_welcomed")) { showAiWelcome("variations"); return; }
          if (!await _checkOllamaOrWarn()) return;
          runAiAction("variations");
        };
        aiInvertBtn.onclick = async () => {
          if (!localStorage.getItem("epe_ai_welcomed")) { showAiWelcome("invert"); return; }
          if (!await _checkOllamaOrWarn()) return;
          runAiAction("invert");
        };
        
        // --- Row 2 bar ---
        // File-menu helper buttons (kept for their onclick handlers; not shown).
        const clearPromptBtn = document.createElement("button");
        clearPromptBtn.onclick = () => { clearBtn.onclick && clearBtn.onclick(); };

        // --- Editor area (textarea + optional line numbers) ---
        const editorWrap = document.createElement("div");
        editorWrap.style.cssText = `
          display: flex;
          flex: 1 0 auto;
          min-height: 220px;
          overflow: hidden;
          position: relative;
          flex-direction: column;
        `;
        
        // Textarea
        const textEl = document.createElement("textarea");
        textEl.className = "epe-prompt";
        textEl.value = currentValue;
        // Persist the prompt onto the node so it survives refresh/restart (rides
        // node.properties → workflow JSON + ComfyUI autosave, like native widgets).
        const _epePersistPrompt = () => {
          if (!_epeOwnerNode) return;
          if (!_epeOwnerNode.properties) _epeOwnerNode.properties = {};
          try {
            _epeOwnerNode.properties.epe_prompt = textEl.value || "";
            // Mirror into the active tab slot (Phase 4). _epeTabs is set up later;
            // guard so early calls before tab init don't throw.
            if (_epeOwnerNode._epeTabSync) _epeOwnerNode._epeTabSync();
          } catch (_e) {}
        };
        // Expose the live prompt on the owner node for the graphToPrompt hook.
        // Falls back to the persisted property if the textarea is unavailable.
        if (_epeOwnerNode) {
          _epeOwnerNode._epeGetPrompt = () => {
            try { return textEl.value || ""; }
            catch (_e) { return (_epeOwnerNode.properties && _epeOwnerNode.properties.epe_prompt) || ""; }
          };
          // Persist the initial value so a never-edited node still has it stored.
          _epePersistPrompt();
        }
        textEl.style.cssText = `
          flex: 1;
          width: 100%;
          min-height: 0;
          background: #141a24;
          border: none;
          color: #c2cddb;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
          font-size: 12px;
          line-height: 1.65;
          padding: 12px 14px;
          resize: none;
          outline: none;
          box-sizing: border-box;
          overflow-y: auto;
          cursor: text;
        `;
        textEl.placeholder = "Enter your prompt...";
        textEl.spellcheck = true;

        // Live updates on input
        textEl.addEventListener("input", () => {
          updateTokenBadge(textEl.value);
          try { _updateSingleTokens(); } catch (_e) {}
          // Persist on every edit — this is what makes typing AND the various
          // "Use" paths (which dispatch an input event) survive a refresh.
          _epePersistPrompt();
        });

        // --- Font sizer (A / size / A) — always visible, centered above textarea ---
        // Faded by default; brightens on bar hover or textarea focus. Mirrors the
        // _mkFontSizerWrap helper (defined later in this function) but inlined here
        // because this block runs during synchronous setup, before the helper is
        // initialized.
        let _peFontSize = 12;
        const fontSizer = document.createElement("div");
        fontSizer.style.cssText =
          "display:flex;align-items:center;gap:5px;flex-shrink:0;" +
          "opacity:0.55;transition:opacity .15s ease;user-select:none;";
        fontSizer.title = "Adjust font size";

        // Brightness controller — 1.0 when bar is hovered OR textarea focused
        let _peHovering = false, _peFocused = false;
        const _peApplyOpacity = () => {
          fontSizer.style.opacity = (_peHovering || _peFocused) ? "1" : "0.35";
        };
        fontSizer.addEventListener("mouseenter", () => { _peHovering = true; _peApplyOpacity(); });
        fontSizer.addEventListener("mouseleave", () => { _peHovering = false; _peApplyOpacity(); });
        textEl.addEventListener("focus", () => { _peFocused = true; _peApplyOpacity(); });
        textEl.addEventListener("blur",  () => { _peFocused = false; _peApplyOpacity(); });

        const fsDown = document.createElement("button");
        fsDown.textContent = "A";
        fsDown.title = "Decrease font size";
        fsDown.style.cssText =
          "background:none;border:none;cursor:pointer;padding:0 3px;" +
          "color:#7a8a9c;font-size:9px;font-weight:600;line-height:1;";
        fsDown.onmouseenter = () => { fsDown.style.color = "#6db8e8"; };
        fsDown.onmouseleave = () => { fsDown.style.color = "#7a8a9c"; };

        const fsVal = document.createElement("span");
        fsVal.textContent = String(_peFontSize);
        fsVal.style.cssText =
          "font-size:9px;color:#6a7a8d;min-width:18px;text-align:center;" +
          "font-family:monospace;";

        const fsUp = document.createElement("button");
        fsUp.textContent = "A";
        fsUp.title = "Increase font size";
        fsUp.style.cssText =
          "background:none;border:none;cursor:pointer;padding:0 3px;" +
          "color:#7a8a9c;font-size:13px;font-weight:600;line-height:1;";
        fsUp.onmouseenter = () => { fsUp.style.color = "#6db8e8"; };
        fsUp.onmouseleave = () => { fsUp.style.color = "#7a8a9c"; };

        fsDown.onclick = (e) => { e.stopPropagation(); _peFontSize=Math.max(8,_peFontSize-1); textEl.style.fontSize=_peFontSize+"px"; fsVal.textContent=String(_peFontSize); };
        fsUp.onclick   = (e) => { e.stopPropagation(); _peFontSize=Math.min(22,_peFontSize+1); textEl.style.fontSize=_peFontSize+"px"; fsVal.textContent=String(_peFontSize); };
        fontSizer.appendChild(fsDown);
        fontSizer.appendChild(fsVal);
        fontSizer.appendChild(fsUp);

        // --- Review-mode UI (hidden by default; shown by _reviewEnter) ---
        // Two stacked strips that appear between fontSizer and textEl during AI
        // result review. Built once, hidden by default; _reviewEnter / _reviewExit
        // toggle visibility and populate content.

        // Top strip: "Reviewing X" / "Streaming…" + Save all (variations) + Discard/Cancel
        const reviewStrip = document.createElement("div");
        reviewStrip.style.cssText = `
          display: none;
          align-items: center;
          justify-content: space-between;
          padding: 7px 12px;
          background: #1f2835;
          border-bottom: 1px solid #28364a;
          flex-shrink: 0;
        `;

        const reviewLabel = document.createElement("span");
        reviewLabel.style.cssText = `font-size: 11px; font-weight: 500; color: #c2cddb;`;
        reviewLabel.textContent = "Reviewing";

        const reviewActions = document.createElement("div");
        reviewActions.style.cssText = `display: flex; gap: 6px;`;

        const reviewSaveAllBtn = document.createElement("button");
        reviewSaveAllBtn.textContent = "Save all";
        reviewSaveAllBtn.title = "Save all variations to Favorites";
        reviewSaveAllBtn.style.cssText = toolBtnStyle + "display:none;font-size:11px;padding:3px 10px;";
        toolBtnHover(reviewSaveAllBtn);
        // onclick wired in Phase 3 (variations rewire)

        const reviewDiscardBtn = document.createElement("button");
        reviewDiscardBtn.textContent = "Discard";
        reviewDiscardBtn.title = "Discard AI result and restore original prompt";
        reviewDiscardBtn.style.cssText = toolBtnStyle + "font-size:11px;padding:3px 10px;color:#7a8a9c;";
        toolBtnHover(reviewDiscardBtn);

        reviewActions.appendChild(reviewSaveAllBtn);
        reviewActions.appendChild(reviewDiscardBtn);
        reviewStrip.appendChild(reviewLabel);
        reviewStrip.appendChild(reviewActions);

        // Original-prompt strip: collapsed by default (chevron + label + ellipsised
        // preview). Click expands to a small read-only text block showing full original.
        const originalStrip = document.createElement("div");
        originalStrip.style.cssText = `
          display: none;
          flex-direction: column;
          background: #19212d;
          border-bottom: 1px solid #28364a;
          flex-shrink: 0;
        `;

        const originalHeader = document.createElement("div");
        originalHeader.style.cssText = `
          display: flex;
          align-items: center;
          padding: 6px 12px;
          cursor: pointer;
          user-select: none;
        `;

        const originalChevron = document.createElement("span");
        originalChevron.style.cssText = `
          display: inline-block;
          width: 0; height: 0;
          border-top: 4px solid transparent;
          border-bottom: 4px solid transparent;
          border-left: 5px solid #7a8a9c;
          margin-right: 8px;
          transition: transform 0.12s;
          flex-shrink: 0;
        `;

        const originalTitle = document.createElement("span");
        originalTitle.textContent = "Original prompt";
        originalTitle.style.cssText = `
          font-size: 11px;
          font-weight: 500;
          color: #9aaaba;
          margin-right: 10px;
          flex-shrink: 0;
        `;

        const originalPreview = document.createElement("span");
        originalPreview.style.cssText = `
          font-size: 11px;
          color: #6a7a8d;
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        `;

        originalHeader.appendChild(originalChevron);
        originalHeader.appendChild(originalTitle);
        originalHeader.appendChild(originalPreview);

        const originalFull = document.createElement("div");
        originalFull.style.cssText = `
          display: none;
          font-size: 12px;
          line-height: 1.5;
          color: #8a9aac;
          padding: 0 12px 10px 25px;
          max-height: 120px;
          overflow-y: auto;
          white-space: pre-wrap;
          word-break: break-word;
          user-select: text;
        `;

        let _originalExpanded = false;
        const _setOriginalExpanded = (expanded) => {
          _originalExpanded = expanded;
          originalChevron.style.transform = expanded ? "rotate(90deg)" : "rotate(0deg)";
          originalFull.style.display = expanded ? "block" : "none";
          originalPreview.style.display = expanded ? "none" : "inline";
        };
        originalHeader.onclick = () => _setOriginalExpanded(!_originalExpanded);

        originalStrip.appendChild(originalHeader);
        originalStrip.appendChild(originalFull);

        // --- Review-mode transitions ---
        // _reviewEnter(mode):  takes original-prompt snapshot, shows strips, sets label.
        // _reviewSetMode(mode): used to transition within an active review (e.g. streaming → single).
        // _reviewExit():       hides strips, clears state, re-enables textEl.
        const _reviewEnter = (mode) => {
          // Capture original on first entry only — chained operations preserve
          // the user's true starting prompt across streaming → single transitions.
          if (!_reviewMode) {
            _originalPrompt = textEl.value;
            // Push the pre-AI prompt onto the undo stack so ↶ / Ctrl+Z recalls
            // it after the result is accepted (replaces the old Recall button).
            if (textEl._epePushUndo) textEl._epePushUndo();
          }
          _reviewMode = mode;

          // Populate original-prompt strip from snapshot
          const orig = _originalPrompt || "";
          const oneLine = orig.replace(/\s+/g, " ").trim();
          originalPreview.textContent = oneLine || "(empty)";
          originalFull.textContent = orig || "(empty)";
          _setOriginalExpanded(false);

          _applyReviewModeUI(mode);
          reviewStrip.style.display = "flex";
          originalStrip.style.display = "flex";
        };

        const _reviewSetMode = (mode) => {
          if (!_reviewMode) return; // only valid mid-review
          _reviewMode = mode;
          _applyReviewModeUI(mode);
        };

        function _applyReviewModeUI(mode) {
          if (mode === "streaming") {
            reviewLabel.textContent = "Streaming…";
            reviewDiscardBtn.textContent = "Cancel";
            reviewDiscardBtn.title = "Cancel the AI request and restore original prompt";
            reviewSaveAllBtn.style.display = "none";
            // textEl visible (will be streamed into); cards hidden; action row hidden
            textEl.style.display = "";
            variationsContainer.style.display = "none";
            _clearVariationsCards();
            singleActionRow.style.display = "none";
            textEl.readOnly = true;
            textEl.style.opacity = "0.85";
          } else if (mode === "variations") {
            reviewLabel.textContent = "Reviewing 3 variations";
            reviewDiscardBtn.textContent = "Discard";
            reviewDiscardBtn.title = "Discard AI result and restore original prompt";
            reviewSaveAllBtn.style.display = "inline-block";
            // textEl hidden; cards visible (caller must call _renderVariationsCards)
            textEl.style.display = "none";
            variationsContainer.style.display = "flex";
            singleActionRow.style.display = "none";
            textEl.readOnly = false;
            textEl.style.opacity = "";
          } else { // "single"
            reviewLabel.textContent = "Reviewing enhanced prompt";
            reviewDiscardBtn.textContent = "Discard";
            reviewDiscardBtn.title = "Discard AI result and restore original prompt";
            reviewSaveAllBtn.style.display = "none";
            // textEl visible (holds result); cards hidden; action row visible
            textEl.style.display = "";
            variationsContainer.style.display = "none";
            _clearVariationsCards();
            singleActionRow.style.display = "flex";
            textEl.readOnly = false;
            textEl.style.opacity = "";
          }
        }

        const _reviewExit = () => {
          _reviewMode = null;
          _originalPrompt = null;
          reviewStrip.style.display = "none";
          originalStrip.style.display = "none";
          reviewSaveAllBtn.style.display = "none";
          // Reset all editor surfaces to their non-review state.
          textEl.style.display = "";
          textEl.readOnly = false;
          textEl.style.opacity = "";
          variationsContainer.style.display = "none";
          _clearVariationsCards();
          singleActionRow.style.display = "none";
          // Restore the editor placeholder if it was swapped during streaming.
          if (textEl._savedPlaceholder != null) {
            textEl.placeholder = textEl._savedPlaceholder;
            textEl._savedPlaceholder = null;
          }
        };

        // Discard / Cancel handler. During streaming this also aborts the in-flight
        // AI request. Always restores the original prompt and unloads the model.
        reviewDiscardBtn.onclick = () => {
          if (_reviewMode === "streaming" && _aiAbort) {
            try { _aiAbort.abort(); } catch (_e) {}
            _aiAbort = null;
          }
          if (_originalPrompt !== null) {
            textEl.value = _originalPrompt;
            updateTokenBadge(textEl.value);
          }
          _reviewExit();
          singleActionRow.style.display = "none";
          try { _epeOllama.unloadModel(); } catch (_e) {}
        };

        // --- Dropdown helper ---
        // Creates a labelled dropdown button (e.g. "Save ▾", "Options ▾"). Items
        // are { id, label }. Picking an item invokes onPick(id) and closes the menu.
        // Click-outside dismisses; the menu auto-flips upward if there isn't enough
        // room below the button.
        const _makeDropdownBtn = (label, items, onPick) => {
          const wrap = document.createElement("span");
          wrap.style.cssText = `position: relative; display: inline-flex;`;

          const btn = document.createElement("button");
          btn.style.cssText = toolBtnStyle + "font-size:11px;padding:4px 11px;display:inline-flex;align-items:center;gap:6px;";
          btn._labelText = label;
          const _renderBtn = () => {
            btn.innerHTML = "";
            const t = document.createElement("span");
            t.textContent = btn._labelText;
            const c = document.createElement("span");
            c.style.cssText = `display:inline-block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;`;
            btn.appendChild(t);
            btn.appendChild(c);
          };
          _renderBtn();
          toolBtnHover(btn);

          // Menu is mounted to document.body with position:fixed so it escapes
          // any overflow:hidden / clip-path / transform ancestors (editorWrap
          // and floatingWin both clip overflow). Position is computed each
          // time the menu opens.
          let menu = null;
          let _menuOpen = false;

          const _closeMenu = () => {
            if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
            menu = null;
            _menuOpen = false;
            document.removeEventListener("mousedown", _onDocClick, true);
          };

          const _onDocClick = (e) => {
            if (menu && menu.contains(e.target)) return;
            if (wrap.contains(e.target)) return;
            _closeMenu();
          };

          const _openMenu = () => {
            menu = document.createElement("div");
            menu.style.cssText = `
              position: fixed;
              background: #1c2431;
              border: 1px solid #31415a;
              border-radius: 4px;
              padding: 3px;
              min-width: 160px;
              z-index: 999999;
              box-shadow: 0 2px 8px rgba(0,0,0,0.6);
              visibility: hidden;
            `;
            items.forEach((it) => {
              const mi = document.createElement("div");
              mi.textContent = it.label;
              mi.style.cssText = `padding: 6px 10px; font-size: 12px; color: #c2cddb; cursor: pointer; border-radius: 3px; user-select: none;`;
              mi.onmouseenter = () => { mi.style.background = "#383838"; };
              mi.onmouseleave = () => { mi.style.background = "transparent"; };
              mi.onclick = (e) => {
                e.stopPropagation();
                _closeMenu();
                onPick(it.id);
              };
              menu.appendChild(mi);
            });

            // Append first (invisible) so we can measure its real size.
            document.body.appendChild(menu);
            const menuH = menu.offsetHeight;
            const menuW = menu.offsetWidth;
            const r = btn.getBoundingClientRect();
            const spaceBelow = window.innerHeight - r.bottom;
            const spaceAbove = r.top;

            // Drop up if there's not enough room below AND there's more room
            // above. Otherwise drop down.
            const dropUp = (spaceBelow < menuH + 6) && (spaceAbove > spaceBelow);
            const top = dropUp ? (r.top - menuH - 4) : (r.bottom + 4);

            // Keep menu within viewport horizontally.
            let left = r.left;
            if (left + menuW > window.innerWidth - 8) {
              left = Math.max(8, window.innerWidth - menuW - 8);
            }

            menu.style.top = top + "px";
            menu.style.left = left + "px";
            menu.style.visibility = "visible";

            _menuOpen = true;
            document.addEventListener("mousedown", _onDocClick, true);
          };

          btn.onclick = (e) => {
            e.stopPropagation();
            if (_menuOpen) _closeMenu();
            else _openMenu();
          };

          // If the wrap is removed from the DOM (e.g. EPE closed) while the
          // menu is open, leave the menu orphaned in body. Clean up defensively.
          // We detect via a MutationObserver on the wrap's parent chain on first
          // mount; simpler and equally effective is the manual close hooked
          // into the EPE close handler (added below alongside closeEditor).
          wrap._closeDropdown = _closeMenu;

          wrap.appendChild(btn);
          // Expose mutable label for caller (used to flash "✓ Saved" feedback)
          Object.defineProperty(wrap, "_labelText", {
            get() { return btn._labelText; },
            set(v) { btn._labelText = v; _renderBtn(); }
          });
          return wrap;
        };

        // --- Single-result action row ---
        // Bottom row shown during single-result review mode (Expand / img2img /
        // vid2prompt / Invert): [Use this] [Append] [Save ▾] [Options ▾]   N tokens
        const singleActionRow = document.createElement("div");
        singleActionRow.style.cssText = `
          display: none;
          align-items: center;
          justify-content: space-between;
          padding: 6px 10px;
          background: #1f2835;
          border-top: 1px solid #28364a;
          flex-shrink: 0;
          gap: 6px;
        `;

        const singleActionBtns = document.createElement("div");
        singleActionBtns.style.cssText = `display: flex; gap: 6px; align-items: center;`;

        // Use this — primary commit
        const useThisBtn = document.createElement("button");
        useThisBtn.textContent = "Use this";
        useThisBtn.title = "Commit this result and exit review";
        useThisBtn.style.cssText = toolBtnStyle + "font-size:11px;padding:4px 12px;font-weight:600;color:#d4dfea;border-color:#4e5c6e;";
        toolBtnHover(useThisBtn);
        useThisBtn.onclick = () => {
          // textEl.value is already what we want to commit. Capture pre-commit
          // value into the recall slot, then exit review.
          _reviewExit();
          singleActionRow.style.display = "none";
          try { _epeOllama.unloadModel(); } catch (_e) {}
          // Phase 4 will surface the Recall prompt button here.
        };

        // Append — combine with original
        const appendBtn = document.createElement("button");
        appendBtn.textContent = "Append";
        appendBtn.title = "Append result onto the original prompt";
        appendBtn.style.cssText = toolBtnStyle + "font-size:11px;padding:4px 11px;";
        toolBtnHover(appendBtn);
        appendBtn.onclick = () => {
          const cur = textEl.value;
          const orig = _originalPrompt || "";
          const combined = orig ? (orig.replace(/\s+$/, "") + "\n\n" + cur) : cur;
          textEl.value = combined;
          textEl.dispatchEvent(new Event("input"));
          updateTokenBadge(textEl.value);
          _reviewExit();
          singleActionRow.style.display = "none";
          try { _epeOllama.unloadModel(); } catch (_e) {}
        };

        // Save dropdown — Favorites / Snippets
        const saveDdBtn = _makeDropdownBtn("Save", [
          { id: "fav", label: "Favorites" },
          { id: "snip", label: "Snippets" },
        ], (id) => {
          const target = id === "fav" ? "favorites" : "snippets";
          _libAddEntry(target, textEl.value);
          const orig = saveDdBtn._labelText;
          saveDdBtn._labelText = "✓ Saved";
          setTimeout(() => { saveDdBtn._labelText = orig; }, 1200);
        });

        // Options dropdown — Enhance again / Variations of this
        const optionsDdBtn = _makeDropdownBtn("Options", [
          { id: "enhance", label: "Enhance again" },
          { id: "variations", label: "Variations of this" },
        ], (id) => {
          if (id === "enhance") {
            // Chained expand: runAiAction will _reviewSetMode("streaming")
            // (preserves _originalPrompt because _reviewMode is "single").
            runAiAction("expand");
          } else if (id === "variations") {
            // variations is now in-editor too. runAiAction will
            // _reviewSetMode("streaming") and preserve _originalPrompt across
            // the chain (single → streaming → variations), so no _reviewExit
            // here. textEl.value is already the result we want to iterate from.
            runAiAction("variations");
          }
        });

        singleActionBtns.appendChild(useThisBtn);
        singleActionBtns.appendChild(appendBtn);
        singleActionBtns.appendChild(saveDdBtn);
        singleActionBtns.appendChild(optionsDdBtn);

        const singleTokens = document.createElement("span");
        singleTokens.style.cssText = `font-size: 11px; color: #6a7a8d; flex-shrink: 0;`;
        singleTokens.textContent = "0 tokens";
        const _updateSingleTokens = () => {
          singleTokens.textContent = `${countTokens(textEl.value)} tokens`;
        };

        singleActionRow.appendChild(singleActionBtns);
        singleActionRow.appendChild(singleTokens);

        // --- Variations card picker ---
        // Container fills the same vertical slot textEl normally occupies.
        // _applyReviewModeUI toggles textEl ↔ variationsContainer visibility.
        // Card rendering happens in _renderVariationsCards (called after the
        // streaming phase parses a successful response).
        const variationsContainer = document.createElement("div");
        variationsContainer.style.cssText = `
          display: none;
          flex: 1;
          min-height: 0;
          flex-direction: column;
          gap: 8px;
          padding: 10px 12px;
          overflow-y: auto;
          background: #141a24;
        `;

        // Tracks the currently-edit-mode card body (for click-outside close).
        // Initialized at module scope so _applyReviewModeUI can reset it.
        let _openCardTA = null;
        let _cardOutsideListener = null;

        // Holds the original variation strings so chained operations can
        // recover them (Save All saves CURRENT card values, but if a card has
        // been used or discarded the array is the source of truth).
        let _currentVariations = [];

        const _clearVariationsCards = () => {
          variationsContainer.innerHTML = "";
          _openCardTA = null;
          if (_cardOutsideListener) {
            document.removeEventListener("mousedown", _cardOutsideListener, true);
            _cardOutsideListener = null;
          }
          _currentVariations = [];
        };

        const _cardReadonlyCSS = "width:100%;box-sizing:border-box;background:#121821;border:1px solid #24303f;border-radius:4px;color:#aab8c8;font-size:11px;line-height:1.55;padding:7px 9px;resize:none;overflow-y:auto;max-height:200px;font-family:inherit;outline:none;cursor:pointer;display:block;";
        const _cardEditCSS     = "width:100%;box-sizing:border-box;background:#121821;border:1px solid #4e5c6e;border-radius:4px;color:#d4dfea;font-size:11px;line-height:1.55;padding:7px 9px;resize:none;overflow-y:auto;max-height:200px;font-family:inherit;outline:none;cursor:text;display:block;";

        const _closeCardTA = (ta) => {
          ta.style.cssText = _cardReadonlyCSS;
          ta.readOnly = true;
          ta.style.height = "auto";
          ta.style.height = ta.scrollHeight + "px";
          if (_openCardTA === ta) _openCardTA = null;
        };

        const _renderVariationsCards = (variations) => {
          _clearVariationsCards();
          _currentVariations = variations.slice();

          // Click-outside listener — closes any open editable card.
          _cardOutsideListener = (ev) => {
            if (!_openCardTA) return;
            const cardEl = _openCardTA.closest(".epe-variation-card");
            if (cardEl && !cardEl.contains(ev.target)) {
              _closeCardTA(_openCardTA);
            }
          };
          document.addEventListener("mousedown", _cardOutsideListener, true);

          variations.forEach((vText, i) => {
            const card = document.createElement("div");
            card.className = "epe-variation-card";
            card.style.cssText = `
              display: flex;
              flex-direction: column;
              background: #232323;
              border: 1px solid #28364a;
              border-radius: 5px;
              overflow: hidden;
              flex-shrink: 0;
              transition: border-color 0.12s;
            `;
            card.onmouseenter = () => { card.style.borderColor = "#4e5c6e"; };
            card.onmouseleave = () => {
              card.style.borderColor = (_openCardTA && card.contains(_openCardTA)) ? "#4e5c6e" : "#28364a";
            };

            // Header
            const cardHeader = document.createElement("div");
            cardHeader.style.cssText = `
              padding: 6px 10px;
              background: #1f2835;
              border-bottom: 1px solid #28364a;
              font-size: 11px;
              color: #9aaaba;
              font-weight: 500;
              flex-shrink: 0;
            `;
            cardHeader.textContent = "Variation " + (i + 1);

            // Body — readonly textarea, click to edit
            const cardBody = document.createElement("textarea");
            cardBody.style.cssText = _cardReadonlyCSS;
            cardBody.value = vText;
            cardBody.readOnly = true;
            // Auto-size to content (subject to max-height in CSS)
            setTimeout(() => {
              cardBody.style.height = "auto";
              cardBody.style.height = cardBody.scrollHeight + "px";
            }, 0);

            cardBody.onclick = (ev) => {
              ev.stopPropagation();
              if (!cardBody.readOnly) return;
              if (_openCardTA && _openCardTA !== cardBody) _closeCardTA(_openCardTA);
              cardBody.style.cssText = _cardEditCSS;
              cardBody.readOnly = false;
              cardBody.style.height = "auto";
              cardBody.style.height = cardBody.scrollHeight + "px";
              _openCardTA = cardBody;
            };
            cardBody.oninput = () => {
              cardBody.style.height = "auto";
              cardBody.style.height = cardBody.scrollHeight + "px";
              _updateCardTokens();
            };

            // Footer: [Use this] [Save ▾] [Options ▾]   N tokens
            const cardFooter = document.createElement("div");
            cardFooter.style.cssText = `
              display: flex;
              align-items: center;
              justify-content: space-between;
              padding: 7px 10px;
              border-top: 1px solid #28364a;
              gap: 6px;
              flex-shrink: 0;
            `;

            const cardBtns = document.createElement("div");
            cardBtns.style.cssText = `display: flex; gap: 6px; align-items: center;`;

            // Use this
            const cardUseBtn = document.createElement("button");
            cardUseBtn.textContent = "Use this";
            cardUseBtn.title = "Commit this variation and exit review";
            cardUseBtn.style.cssText = toolBtnStyle + "font-size:11px;padding:4px 12px;font-weight:600;color:#d4dfea;border-color:#4e5c6e;";
            toolBtnHover(cardUseBtn);
            cardUseBtn.onclick = (ev) => {
              ev.stopPropagation();
              const txt = cardBody.value;
              if (textEl._epePushUndo) textEl._epePushUndo();
              textEl.value = txt;
              updateTokenBadge(txt);
              textEl.dispatchEvent(new Event("input"));
              _reviewExit();
              try { _epeOllama.unloadModel(); } catch (_e) {}
            };

            // Save ▾
            const cardSaveDd = _makeDropdownBtn("Save", [
              { id: "fav", label: "Favorites" },
              { id: "snip", label: "Snippets" },
            ], (id) => {
              const target = id === "fav" ? "favorites" : "snippets";
              _libAddEntry(target, cardBody.value);
              const orig = cardSaveDd._labelText;
              cardSaveDd._labelText = "✓ Saved";
              setTimeout(() => { cardSaveDd._labelText = orig; }, 1200);
            });

            // Options ▾
            const cardOptDd = _makeDropdownBtn("Options", [
              { id: "enhance", label: "Enhance again" },
              { id: "variations", label: "Variations of this" },
            ], (id) => {
              // Chain into a new AI action with this card's text as input.
              // runAiAction reads textEl.value as the prompt source, so we
              // copy the card text in first. _reviewMode is currently
              // "variations"; runAiAction will _reviewSetMode("streaming"),
              // which preserves _originalPrompt across the chain.
              textEl.value = cardBody.value;
              if (id === "enhance") runAiAction("expand");
              else if (id === "variations") runAiAction("variations");
            });

            cardBtns.appendChild(cardUseBtn);
            cardBtns.appendChild(cardSaveDd);
            cardBtns.appendChild(cardOptDd);

            const cardTokens = document.createElement("span");
            cardTokens.style.cssText = `font-size: 11px; color: #6a7a8d; flex-shrink: 0;`;
            const _updateCardTokens = () => {
              cardTokens.textContent = `${countTokens(cardBody.value)} tokens`;
            };
            _updateCardTokens();

            cardFooter.appendChild(cardBtns);
            cardFooter.appendChild(cardTokens);

            card.appendChild(cardHeader);
            card.appendChild(cardBody);
            card.appendChild(cardFooter);
            variationsContainer.appendChild(card);
          });
        };

        // Save all current card values (which may have been edited) to Favorites.
        // Wired up here so the button defined in Phase 1 has its handler.
        reviewSaveAllBtn.onclick = () => {
          const cards = variationsContainer.querySelectorAll(".epe-variation-card textarea");
          if (!cards.length) return;
          cards.forEach((ta) => {
            const v = ta.value;
            const items = _libLoad("favorites");
            const def = v.slice(0, 48).replace(/\s+/g, " ").trim() + (v.length > 48 ? "\u2026" : "");
            items.push({ id: _libNewId(), name: def, text: v.trim(), date: new Date().toISOString() });
            _libSaveItems("favorites", items);
          });
          const orig = reviewSaveAllBtn.textContent;
          reviewSaveAllBtn.textContent = "✓ Saved";
          setTimeout(() => { reviewSaveAllBtn.textContent = orig; }, 1200);
          if (_rpActive === "favorites") _renderRpBody();
        };

        editorWrap.appendChild(reviewStrip);
        editorWrap.appendChild(originalStrip);
        editorWrap.appendChild(textEl);
        editorWrap.appendChild(variationsContainer);
        editorWrap.appendChild(singleActionRow);

        // --- Footer: Wireless targets ---
        // Wireless targets live in node.properties so they persist in the
        // workflow JSON. The prompt is injected into each target at run time
        // (see the graphToPrompt hook). EPE stays autonomous — no WCP needed.
        const _epeNode = _epeOwnerNode;
        const _epeTargets = () => {
          if (!_epeNode) return [];
          if (!_epeNode.properties) _epeNode.properties = {};
          if (!Array.isArray(_epeNode.properties.epe_wireless_targets)) _epeNode.properties.epe_wireless_targets = [];
          return _epeNode.properties.epe_wireless_targets;
        };

        const footer = document.createElement("div");
        footer.style.cssText = `display:flex;flex-direction:column;gap:6px;padding:6px 8px;background:#161d28;border-top:1px solid #28364a;flex-shrink:0;`;

        // Wireless section
        const wlBox = document.createElement("div");
        wlBox.style.cssText = `background:#1f2630;border:1px solid #2a3a55;border-radius:4px;padding:6px 8px;`;

        const wlHead = document.createElement("div");
        wlHead.style.cssText = `display:flex;align-items:center;gap:6px;margin-bottom:6px;`;
        const wlTitle = document.createElement("span");
        wlTitle.textContent = "Wireless targets";
        wlTitle.style.cssText = `color:#c2cddb;font-size:11px;font-weight:600;`;
        const wlCount = document.createElement("span");
        wlCount.style.cssText = `color:#6ea6ff;background:#243245;border:1px solid #2a5570;padding:1px 7px;border-radius:9px;font-size:10px;`;
        const wlNote = document.createElement("span");
        wlNote.textContent = "prompt injected into targets at runtime";
        wlNote.style.cssText = `margin-left:auto;color:#5b6b7e;font-size:10px;font-style:italic;`;
        wlHead.appendChild(wlTitle);
        wlHead.appendChild(wlCount);
        wlHead.appendChild(wlNote);
        wlBox.appendChild(wlHead);

        const wlPills = document.createElement("div");
        wlPills.style.cssText = `display:flex;flex-wrap:wrap;gap:4px;`;
        wlBox.appendChild(wlPills);

        // Update the canvas-node badge (⌁ N) without depending on WCP.
        const _epeUpdateBadge = () => {
          if (!_epeNode) return;
          const n = _epeTargets().length;
          _epeNode._epeWirelessCount = n;
          try { app.graph.setDirtyCanvas(true, true); } catch (_e) {}
        };

        const renderWireless = () => {
          const targets = _epeTargets();
          wlCount.textContent = String(targets.length);
          try { _epeSetHeaderWirelessCount(targets.length); } catch (_e) {}
          wlPills.innerHTML = "";

          targets.forEach((t, idx) => {
            // Resolve to confirm the target still exists; refresh label if needed.
            const resolved = _epeResolveTargetWidget(t);
            if (resolved && (!t.bindLabel)) _epeRebuildTargetLabel(t);
            const pill = document.createElement("div");
            pill.style.cssText = `display:flex;align-items:center;gap:5px;background:#2f3a4a;border:1px solid #3b4a5e;border-radius:3px;padding:4px 7px;font-size:12px;width:140px;box-sizing:border-box;cursor:pointer;`;
            pill.title = "Click to repick this target";
            const dot = document.createElement("span");
            dot.style.cssText = `width:5px;height:5px;border-radius:50%;flex-shrink:0;background:${resolved ? "#6a9955" : "#a05050"};`;
            pill.appendChild(dot);
            const leafId = t.bind ? String(t.bind).slice(0, String(t.bind).lastIndexOf("|")).split(":").pop() : "";
            const label = document.createElement("span");
            // Title truncates in the middle; the ID sits in a fixed badge (below)
            // so it stays visible regardless of how long the title is.
            const shortName = (t.bindNodeTitle || "node")
              + (t.bindWidgetLabel ? " · " + t.bindWidgetLabel : "");
            label.textContent = shortName;
            label.title = (t.bindLabel || shortName) + (leafId ? "  (id " + leafId + ")" : "") + (resolved ? "" : "  (not found)");
            label.style.cssText = `color:#d4dfea;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
            pill.appendChild(label);
            if (leafId) {
              const idBadge = document.createElement("span");
              idBadge.textContent = leafId;
              idBadge.title = "Node ID " + leafId;
              idBadge.style.cssText = `color:#8aa;font-size:10px;flex-shrink:0;`;
              pill.appendChild(idBadge);
            }
            const rm = document.createElement("span");
            rm.textContent = "\u2715"; // ✕
            rm.title = "Remove target";
            rm.style.cssText = `color:#6a7a8d;cursor:pointer;flex-shrink:0;`;
            rm.onmouseenter = () => { rm.style.color = "#d88"; };
            rm.onmouseleave = () => { rm.style.color = "#6a7a8d"; };
            rm.onclick = (ev) => {
              ev.stopPropagation(); // don't trigger pill repick
              targets.splice(idx, 1);
              renderWireless();
              _epeUpdateBadge();
            };
            // Click the pill body → reopen picker with this target highlighted,
            // then re-bind this same target in place (mirrors WCP wireless).
            pill.onclick = () => {
              _epeShowTargetPicker(t.bind || null, (sel) => {
                const targets2 = _epeTargets();
                if (targets2.some((x, i) => i !== idx && x.bind === sel.bindKey)) { renderWireless(); return; }
                _epeSetTargetBind(t, sel);
                renderWireless();
                _epeUpdateBadge();
              });
            };
            pill.appendChild(rm);
            wlPills.appendChild(pill);
          });

          // ＋ Add target slot (uniform width)
          const add = document.createElement("div");
          add.style.cssText = `display:flex;align-items:center;justify-content:center;gap:5px;background:transparent;border:1px dashed #3b4a5e;border-radius:3px;padding:4px 7px;font-size:12px;color:#6ea6ff;cursor:pointer;width:140px;box-sizing:border-box;`;
          const addIcon = document.createElement("span");
          addIcon.textContent = "\uFF0B"; // ＋
          addIcon.style.cssText = "line-height:1;";
          const addLbl = document.createElement("span");
          addLbl.textContent = "Add target";
          add.appendChild(addIcon);
          add.appendChild(addLbl);
          add.onmouseenter = () => { add.style.background = "rgba(110,166,255,0.08)"; };
          add.onmouseleave = () => { add.style.background = "transparent"; };
          add.onclick = () => {
            _epeShowTargetPicker(null, (sel) => {
              const targets2 = _epeTargets();
              // Avoid duplicate binds
              if (targets2.some(x => x.bind === sel.bindKey)) { renderWireless(); return; }
              const t = {};
              _epeSetTargetBind(t, sel);
              targets2.push(t);
              renderWireless();
              _epeUpdateBadge();
            });
          };
          wlPills.appendChild(add);
        };

        footer.appendChild(wlBox);
        renderWireless();
        _epeUpdateBadge();

        // Expose a refresh hook so the node's onConfigure can re-sync the editor
        // after ComfyUI restores serialized `properties` (which happens AFTER the
        // editor is built in onNodeCreated). Without this, restored wireless
        // targets and the restored prompt don't paint until the next manual edit.
        if (_epeOwnerNode) {
          _epeOwnerNode._epeRefreshFromProps = () => {
            try {
              const p = _epeOwnerNode.properties || {};
              if (typeof p.epe_prompt === "string" && p.epe_prompt !== textEl.value) {
                textEl.value = p.epe_prompt;
                updateTokenBadge(textEl.value);
              }
              renderWireless();
              _epeUpdateBadge();
              if (_epeOwnerNode._epeTabRestore) _epeOwnerNode._epeTabRestore();
              if (_epeOwnerNode._epeStyleRestore) _epeOwnerNode._epeStyleRestore();
              if (_epeOwnerNode._epeUiRestore) _epeOwnerNode._epeUiRestore();
            } catch (_e) {}
          };
        }

        // Back-compat alias: some code below references `btnRow` as the footer row.
        const btnRow = footer;

        // --- Actions ---
        const closeEditor = () => {
          // dropdown menus are mounted to document.body, close any open
          // ones before the EPE goes away so they don't orphan in the DOM.
          try {
            if (saveDdBtn && saveDdBtn._closeDropdown) saveDdBtn._closeDropdown();
            if (optionsDdBtn && optionsDdBtn._closeDropdown) optionsDdBtn._closeDropdown();
          } catch (_e) {}
          _epeTip.remove();
          floatingWin.remove();
        };

        closeBtn.onclick = closeEditor;
        saveAsBtn.onclick = () => _libAddEntry("favorites", textEl.value);

        loadBtn.onclick = () => {
          const _fileInput = document.createElement("input");
          _fileInput.type = "file"; _fileInput.accept = ".txt"; _fileInput.style.display = "none";
          document.body.appendChild(_fileInput);
          _fileInput.onchange = () => {
            const file = _fileInput.files && _fileInput.files[0];
            document.body.removeChild(_fileInput);
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
              const txt = (e.target.result || "").trim();
              if (!txt) return;
              if (textEl._epePushUndo) textEl._epePushUndo();
              textEl.value = txt;
              updateTokenBadge(txt);
              textEl.dispatchEvent(new Event("input"));
              textEl.focus();
            };
            reader.readAsText(file);
          };
          _fileInput.click();
        };

        clearBtn.onclick = () => {
          if(textEl.value.trim() && !window.confirm("Clear all text?")) return;
          textEl.value=""; updateTokenBadge(""); textEl.focus();
        };

        textEl.onkeydown = (ev) => {
          if (ev.key === "Escape") {
            // when in review mode, Esc means "discard this result", not
            // "close the EPE". Don't preventDefault or stopPropagation — let
            // the event bubble to floatingWin's keydown handler, which exits
            // review and restores the original prompt.
            if (_reviewMode) {
              return; // bubble up to floatingWin handler
            }
            ev.preventDefault(); ev.stopPropagation(); closeEditor();
            return;
          }
          // Non-Esc keys: stop bubbling so the textarea's own handling (typing,
          // navigation, etc.) doesn't trigger graph-level shortcuts behind us.
          ev.stopPropagation();
        };


        function setEditorMode(mode) {
          // Only "full" mode remains — minimize has been removed.
          // Ensure all panels are visible and floatingWin stays fluid (100%).
          titleBar.style.display="flex"; toolbar.style.display="flex";
          bodyWrap.style.display="flex";
          floatingWin.style.width="100%"; floatingWin.style.height="100%";
          requestAnimationFrame(()=>textEl.focus());
        }

        // ── Right panel — Phase 2 Local Library ─────────────────────────────────

        // ── localStorage helpers ────────────────────────────────────────
        const _libKey       = (t) => t==="snippets" ? "epe_library_snippets" : "epe_library_favorites";
        const _libLoad      = (t) => { try{return JSON.parse(localStorage.getItem(_libKey(t))||"[]");}catch(e){return[];} };
        const _libSaveItems = (t,items) => { try{localStorage.setItem(_libKey(t),JSON.stringify(items));}catch(e){} };
        const _libNewId     = () => Date.now().toString(36)+Math.random().toString(36).slice(2,6);

        // ── Card base styles ─────────────────────────────────────────────
        const _cardBase = `background:#141a24;border:1px solid #1c2431;border-radius:4px;` +
                          `padding:7px 9px;cursor:pointer;transition:border-color .12s,background .12s;position:relative;`;
        const _cardIn   = (el) => { el.style.background="#242424"; el.style.borderColor="#28364a"; };
        const _cardOut  = (el) => { el.style.background="#141a24"; el.style.borderColor="#1c2431"; };

        // ── Right panel shell ────────────────────────────────────────────
        const rightPanel = document.createElement("div");
        rightPanel.style.cssText =
          "width:300px;flex-shrink:0;display:flex;flex-direction:column;" +
          "border-left:1px solid #1c2431;background:#12171f;overflow:hidden;";

        // ── Tab bar ──────────────────────────────────────────────────────
        const rpTabs = document.createElement("div");
        rpTabs.style.cssText = "display:flex;flex-direction:column;gap:6px;flex-shrink:0;background:#12171f;padding:8px 8px 6px;";
        const _rpTabBase =
          "flex:1;white-space:nowrap;padding:5px 4px;text-align:center;font-size:10px;font-weight:500;" +
          "color:#8ba5be;cursor:pointer;background:rgba(109,184,232,0.05);" +
          "border:1px solid rgba(109,184,232,0.15);user-select:none;transition:color .12s,background .12s,border-color .12s;";
        const rpTabEls = {};

        const rpTabRow1 = document.createElement("div");
        rpTabRow1.style.cssText = "display:flex;";
        const rpTabRow2 = document.createElement("div");
        rpTabRow2.style.cssText = "display:flex;";

        [
          ["civitai",   "Civitai",   "Browse Civitai image/video prompts",        rpTabRow1],
          ["genur",     "Genur.art", "Browse Genur.art image prompts",             rpTabRow1],
          ["seaart",    "SEA.ART",   "Browse SeaArt image/video prompts",          rpTabRow1],
          ["workflows", "Workflows", "Search and load ComfyUI workflows",          rpTabRow2],
          ["favorites", "Favorites", "Saved prompts \u2014 click a card to load into editor", rpTabRow2],
          ["snippets",  "Snippets",  "Reusable fragments \u2014 click a card to insert at cursor", rpTabRow2]
        ].forEach(([id, label, title, row]) => {
          const tab = document.createElement("div");
          tab.textContent=label; tab.title=title;
          tab.style.cssText=_rpTabBase; tab._id=id;
          tab.onmouseenter = () => { if(!tab._active) { tab.style.color="#a8c6de"; tab.style.background="rgba(109,184,232,0.1)"; } };
          tab.onmouseleave = () => { if(!tab._active) { tab.style.color="#8ba5be"; tab.style.background="rgba(109,184,232,0.05)"; } };
          rpTabEls[id]=tab; row.appendChild(tab);
        });

        // Segmented-bar shaping: round outer corners; overlap by 1px so shared
        // edges don't double but every tab keeps a full 4-sided border.
        [rpTabRow1, rpTabRow2].forEach(row => {
          const kids = Array.from(row.children);
          kids.forEach((t, i) => {
            if (i === 0) t.style.borderRadius = "8px 0 0 8px";
            else if (i === kids.length - 1) t.style.borderRadius = "0 8px 8px 0";
            if (i > 0) t.style.marginLeft = "-1px";
          });
        });

        rpTabs.appendChild(rpTabRow1);
        rpTabs.appendChild(rpTabRow2);

        // ── Body container ───────────────────────────────────────────────
        const rpBody = document.createElement("div");
        rpBody.style.cssText = "flex:1;display:flex;flex-direction:column;overflow-y:auto;min-height:300px;";

        // ── Search bar ───────────────────────────────────────────────────
        const rpSearchWrap = document.createElement("div");
        rpSearchWrap.style.cssText = "padding:5px 6px;flex-shrink:0;border-bottom:1px solid #1c2431;background:#12171f;";
        const rpSearchRow = document.createElement("div");
        rpSearchRow.style.cssText = "display:flex;gap:4px;";
        const rpSearch = document.createElement("input");
        rpSearch.type="text"; rpSearch.placeholder="Search\u2026";
        rpSearch.style.cssText =
          "flex:1;background:#0b0f15;border:1px solid #1c2431;border-radius:3px;" +
          "color:#c2cddb;font-size:10px;padding:3px 7px;outline:none;font-family:inherit;";
        rpSearch.onfocus = () => { rpSearch.style.borderColor="#28364a"; };
        rpSearch.onblur  = () => { rpSearch.style.borderColor="#1c2431"; };
        rpSearch.oninput = () => _renderRpBody();
        const rpSearchBtn = document.createElement("button");
        rpSearchBtn.textContent = "Search";
        rpSearchBtn.style.cssText =
          "background:#161d28;border:1px solid #202a38;border-radius:3px;" +
          "color:#7a8a9c;font-size:9px;padding:2px 8px;cursor:pointer;font-family:inherit;" +
          "white-space:nowrap;transition:color .1s,background .1s;";
        rpSearchBtn.onmouseenter = () => { rpSearchBtn.style.background="#202a38"; rpSearchBtn.style.color="#c2cddb"; };
        rpSearchBtn.onmouseleave = () => { rpSearchBtn.style.background="#161d28"; rpSearchBtn.style.color="#7a8a9c"; };
        rpSearchBtn.onclick = () => _renderRpBody();
        rpSearchRow.appendChild(rpSearch);
        rpSearchRow.appendChild(rpSearchBtn);
        rpSearchWrap.appendChild(rpSearchRow);

        // ── Card list ────────────────────────────────────────────────────
        const rpList = document.createElement("div");
        rpList.style.cssText =
          "flex:1;overflow-y:auto;padding:5px 6px;" +
          "display:flex;flex-direction:column;gap:6px;min-height:0;";

        // ── Media type state (shared across tabs that support it) ────────
        let _rpMediaType = "image"; // "image" | "video"

        // ── Media bar (Image / Video / Get Workflow) ─────────────────────
        // Shown below the tab bar only on tabs that support media switching.
        // Tabs that support Image/Video: civitai, seaart
        // Tabs that support Get Workflow button: civitai, genur (PNG metadata)
        const _MEDIA_TABS     = new Set(["civitai", "seaart"]);
        const _WORKFLOW_TABS  = new Set(["civitai", "genur"]);

        const rpMediaBar = document.createElement("div");
        rpMediaBar.style.cssText =
          "display:none;flex-shrink:0;padding:4px 6px;gap:4px;" +
          "border-bottom:1px solid #1c2431;background:#12171f;align-items:center;";

        const _mkMediaBtn = (label, title) => {
          const b = document.createElement("button");
          b.textContent = label; b.title = title;
          b.style.cssText =
            "background:#161d28;border:1px solid #202a38;border-radius:3px;" +
            "color:#5b6b7e;font-size:10px;font-weight:600;padding:2px 9px;" +
            "cursor:pointer;font-family:inherit;transition:color .1s,border-color .1s,background .1s;";
          b.onmouseenter = () => { if (!b._active) { b.style.background="#202a38"; b.style.color="#aab8c8"; } };
          b.onmouseleave = () => { if (!b._active) { b.style.background="#161d28"; b.style.color=b._disabled?"#24303f":"#5b6b7e"; } };
          return b;
        };

        const rpMediaImgBtn  = _mkMediaBtn("Image",  "Show images");
        const rpMediaVidBtn  = _mkMediaBtn("Video",  "Show videos");
        const rpGetWfBtn     = _mkMediaBtn("\u21af Workflow", "No workflow detected in this image");
        rpGetWfBtn.style.marginLeft = "auto";
        rpGetWfBtn.style.display    = "none";
        rpGetWfBtn._disabled        = true;
        rpGetWfBtn.style.color      = "#24303f";
        rpGetWfBtn.style.cursor     = "default";
        rpGetWfBtn.onmouseenter = () => {
          if (!rpGetWfBtn._disabled) { rpGetWfBtn.style.background="#1a3d2b"; rpGetWfBtn.style.borderColor="rgba(109,184,232,0.9)"; }
        };
        rpGetWfBtn.onmouseleave = () => {
          if (!rpGetWfBtn._disabled) { rpGetWfBtn.style.background="rgba(109,184,232,0.18)"; rpGetWfBtn.style.borderColor="rgba(109,184,232,0.6)"; }
          else { rpGetWfBtn.style.background="#161d28"; rpGetWfBtn.style.borderColor="#202a38"; }
        };

        // Cache: imageUrl -> { hasWorkflow, workflow } so repeated opens don't re-probe
        const _wfProbeCache = new Map();

        const _setMediaBtn = (type) => {
          _rpMediaType = type;
          [rpMediaImgBtn, rpMediaVidBtn].forEach(b => {
            b._active = (b === (type === "image" ? rpMediaImgBtn : rpMediaVidBtn));
            b.style.background   = b._active ? "#1c2431" : "#161d28";
            b.style.color        = b._active ? "rgba(109,184,232,0.85)" : "#5b6b7e";
            b.style.borderColor  = b._active ? "rgba(109,184,232,0.3)" : "#202a38";
          });
        };
        _setMediaBtn("image");

        rpMediaImgBtn.onclick = () => { if (_rpMediaType === "image") return; _setMediaBtn("image"); _resetActiveTab(); };
        rpMediaVidBtn.onclick = () => { if (_rpMediaType === "video") return; _setMediaBtn("video"); _resetActiveTab(); };

        // _resetActiveTab: clears and re-triggers a fresh search on the current tab
        const _resetActiveTab = () => {
          if (_rpActive === "civitai") {
            _civState.query = ""; _civState.page = 1;
            _civState.loading = false; _civState.exhausted = false; _civState.results = [];
            while (civList.lastChild) civList.removeChild(civList.lastChild);
            civList.appendChild(civStatus);
            civList.appendChild(civSentinel);
            civStatus.style.display = "none";
            const q = civSearchInput.value.trim();
            if (q) { _civState.query = q; requestAnimationFrame(() => _civLoadMore()); }
          } else if (_rpActive === "seaart") {
            _seaartState.query = ""; _seaartState.page = 1;
            _seaartState.loading = false; _seaartState.exhausted = false; _seaartState.results = [];
            while (seaartList.lastChild) seaartList.removeChild(seaartList.lastChild);
            seaartList.appendChild(seaartStatus);
            seaartList.appendChild(seaartSentinel);
            seaartStatus.style.display = "none";
            const q = seaartSearchInput.value.trim();
            if (q) { _seaartState.query = q; requestAnimationFrame(() => _seaartLoadMore()); }
          }
        };

        // Get Workflow button state — called from detail panels when image loads
        const _setGetWfBtn = (enabled, imageUrl) => {
          rpGetWfBtn._pendingImageUrl = enabled ? imageUrl : null;
          rpGetWfBtn._disabled = !enabled;
          if (enabled) {
            rpGetWfBtn.textContent       = "\u2b07 Load Workflow";
            rpGetWfBtn.title             = "ComfyUI workflow found \u2014 click to open in a new canvas tab";
            rpGetWfBtn.style.color       = "#b8f0d8";
            rpGetWfBtn.style.cursor      = "pointer";
            rpGetWfBtn.style.borderColor = "rgba(109,184,232,0.6)";
            rpGetWfBtn.style.background  = "rgba(109,184,232,0.18)";
            rpGetWfBtn.style.fontWeight  = "700";
            rpGetWfBtn.style.fontSize    = "10px";
          } else {
            rpGetWfBtn.textContent       = "\u21af Workflow";
            rpGetWfBtn.title             = "No workflow detected in this image";
            rpGetWfBtn.style.color       = "#24303f";
            rpGetWfBtn.style.cursor      = "default";
            rpGetWfBtn.style.borderColor = "#202a38";
            rpGetWfBtn.style.background  = "#161d28";
            rpGetWfBtn.style.fontWeight  = "600";
            rpGetWfBtn.style.fontSize    = "10px";
          }
        };
        _setGetWfBtn(false, null);

        rpGetWfBtn.onclick = async () => {
          if (rpGetWfBtn._disabled || !rpGetWfBtn._pendingImageUrl) return;
          rpGetWfBtn.textContent = "Fetching\u2026";
          rpGetWfBtn.style.cursor = "default";
          try {
            const resp = await fetch("/epe/prompts/extract-workflow", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ imageUrl: rpGetWfBtn._pendingImageUrl }),
            });
            const data = await resp.json();
            if (resp.status === 403) throw new Error("\u26a0 Login required on Civitai to download this workflow");
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            if (data.error) throw new Error(data.error);
            if (!data.hasWorkflow || !data.workflow) {
              rpGetWfBtn.textContent = "No workflow";
              setTimeout(() => { rpGetWfBtn.textContent = "\u21af Workflow"; _setGetWfBtn(false, null); }, 2000);
              return;
            }
            rpGetWfBtn.textContent = "Loading\u2026";
            await _epeOpenTemplate(data.workflow, data.workflowFormat || "graph");
            rpGetWfBtn.textContent = "\u21af Workflow";
            _setGetWfBtn(false, null);
          } catch(e) {
            rpGetWfBtn.textContent = "Error";
            setTimeout(() => { rpGetWfBtn.textContent = "\u21af Workflow"; _setGetWfBtn(rpGetWfBtn._pendingImageUrl ? true : false, rpGetWfBtn._pendingImageUrl); }, 2000);
          }
        };

        rpMediaBar.appendChild(rpMediaImgBtn);
        rpMediaBar.appendChild(rpMediaVidBtn);
        rpMediaBar.appendChild(rpGetWfBtn);

        // ── Workflow panel state ─────────────────────────────────────────
        let _wfState = { query: "", page: 1, loading: false, exhausted: false, results: [] };

        // ── Civitai placeholder ──────────────────────────────────────────
        // ══════════════════════════════════════════════════════════════════
        // PHASE 3 — CIVITAI BROWSER
        // ══════════════════════════════════════════════════════════════════

        // ── Prompt cleaner ───────────────────────────────────────────────
        const _civCleanPrompt = (raw) => {
          if (!raw) return "";
          let s = raw;
          // Strip LoRA tags: <lora:name:weight>
          s = s.replace(/<lora:[^>]*>/gi, "");
          // Strip embedding tags: <embedding:name>
          s = s.replace(/<embedding:[^>]*>/gi, "");
          // Strip weighted parens: (word:1.2) or (word word:0.8) -> word word
          s = s.replace(/\(([^)]+):\d+(\.\d+)?\)/g, (_, inner) => inner.trim());
          // Strip weighted brackets: [word] or [word:1.2] -> word
          s = s.replace(/\[([^\]]+?)(?::\d+(?:\.\d+)?)?\]/g, (_, inner) => inner.trim());
          // Strip remaining bare :number patterns left over (e.g. ":0.8")
          s = s.replace(/:\d+(\.\d+)?/g, "");
          // Collapse multiple commas/spaces
          s = s.replace(/,\s*,+/g, ",");
          s = s.replace(/\s{2,}/g, " ");
          // Clean leading/trailing commas and spaces per segment
          s = s.split(",").map(t => t.trim()).filter(t => t.length > 0).join(", ");
          return s.trim();
        };

        // ── Civitai API state ─────────────────────────────────────────────
        const _civState = {
          query:    "",
          sort:     "Most Reactions",  // "Most Reactions" | "Newest"
          period:   "",               // "" | "Week" | "Month" | "6Month" | "Year"
          baseModel:"",               // "" = any, or "Flux.1 D", "SD 1.5", "SDXL 1.0" etc
          page:     1,
          loading:  false,
          exhausted:false,
          results:  [],
        };

        // ── Civitai panel DOM ────────────────────────────────────────────
        const rpCivPanel = document.createElement("div");
        rpCivPanel.style.cssText = "flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;";

        // ── Filter bar ───────────────────────────────────────────────────
        const civFilterBar = document.createElement("div");
        civFilterBar.style.cssText =
          "flex-shrink:0;padding:5px 6px;border-bottom:1px solid #1c2431;" +
          "display:flex;flex-direction:column;gap:4px;background:#12171f;";

        // Callout banner
        const civCallout = document.createElement("div");
        civCallout.style.cssText =
          "display:flex;align-items:center;gap:5px;padding:4px 6px;" +
          "background:rgba(100,160,255,0.07);border:1px solid rgba(100,160,255,0.15);" +
          "border-radius:3px;margin-bottom:1px;";
        const civCalloutIcon = document.createElement("span");
        civCalloutIcon.textContent = "\uD83D\uDD0D";
        civCalloutIcon.style.cssText = "font-size:10px;flex-shrink:0;";
        const civCalloutText = document.createElement("span");
        civCalloutText.textContent = "Search Civitai for images \u2014 browse image prompts to use as inspiration";
        civCalloutText.style.cssText = "font-size:9px;color:rgba(100,160,255,0.7);line-height:1.4;";
        civCallout.appendChild(civCalloutIcon);
        civCallout.appendChild(civCalloutText);
        civFilterBar.appendChild(civCallout);

        // Search row
        const civSearchRow = document.createElement("div");
        civSearchRow.style.cssText = "display:flex;gap:4px;";
        const civSearchInput = document.createElement("input");
        civSearchInput.type = "text";
        civSearchInput.placeholder = "fantasy portrait\u2026";
        civSearchInput.value = "fantasy portrait";
        civSearchInput.style.cssText =
          "flex:1;background:#0b0f15;border:1px solid #1c2431;border-radius:3px;" +
          "color:#c2cddb;font-size:10px;padding:3px 7px;outline:none;font-family:inherit;";
        civSearchInput.onfocus = () => { civSearchInput.style.borderColor="#28364a"; };
        civSearchInput.onblur  = () => { civSearchInput.style.borderColor="#1c2431"; };
        const civSearchBtn = document.createElement("button");
        civSearchBtn.textContent = "Search";
        civSearchBtn.style.cssText =
          "background:#161d28;border:1px solid #202a38;border-radius:3px;" +
          "color:#7a8a9c;font-size:9px;padding:2px 8px;cursor:pointer;font-family:inherit;" +
          "white-space:nowrap;transition:color .1s,background .1s;";
        civSearchBtn.onmouseenter = () => { civSearchBtn.style.background="#202a38"; civSearchBtn.style.color="#c2cddb"; };
        civSearchBtn.onmouseleave = () => { civSearchBtn.style.background="#161d28"; civSearchBtn.style.color="#7a8a9c"; };
        civSearchRow.appendChild(civSearchInput);
        civSearchRow.appendChild(civSearchBtn);

        // Sort + Period row
        const civSortRow = document.createElement("div");
        civSortRow.style.cssText = "display:flex;gap:3px;flex-wrap:wrap;";

        const _mkChip = (label, groupKey, value, isActive) => {
          const c = document.createElement("button");
          c.textContent = label;
          c._groupKey = groupKey;
          c._value = value;
          c._on = isActive;
          const _applyChipStyle = () => {
            c.style.cssText =
              "font-size:11px;padding:2px 7px;border-radius:2px;cursor:pointer;" +
              "font-family:inherit;transition:color .1s,background .1s,border-color .1s;" +
              (c._on
                ? "background:#202a38;border:1px solid #4e5c6e;color:#c2cddb;"
                : "background:#12171f;border:1px solid #1c2431;color:#4e5c6e;");
          };
          _applyChipStyle();
          c.onmouseenter = () => { if(!c._on) { c.style.color="#7a8a9c"; c.style.borderColor="#28364a"; } };
          c.onmouseleave = () => { if(!c._on) { c.style.color="#4e5c6e"; c.style.borderColor="#1c2431"; } };
          c._setOn = (on) => { c._on = on; _applyChipStyle(); };
          c.onclick = () => {
            // Deactivate siblings in same group
            civFilterBar.querySelectorAll("button[data-civ-group='"+groupKey+"']").forEach(b => b._setOn && b._setOn(false));
            c._setOn(true);
            _civState[groupKey] = value;
            _civDoSearch();
          };
          c.dataset.civGroup = groupKey;
          return c;
        };

        // Sort chips
        [["Most Reactions","Most Reactions"],["Most Collected","Most Collected"],["Newest","Newest"]].forEach(([label,val]) => {
          civSortRow.appendChild(_mkChip(label,"sort",val, _civState.sort===val));
        });

        const civPeriodRow = document.createElement("div");
        civPeriodRow.style.cssText = "display:flex;gap:3px;flex-wrap:wrap;";
        [["All Time",""],["Week","Week"],["Month","Month"],["6 Months","6Month"],["Year","Year"]].forEach(([label,val]) => {
          civPeriodRow.appendChild(_mkChip(label,"period",val, _civState.period===val));
        });

        civFilterBar.appendChild(civSearchRow);
        civFilterBar.appendChild(civSortRow);
        civFilterBar.appendChild(civPeriodRow);

        // ── Card list (scrollable, infinite) ────────────────────────────
        const civList = document.createElement("div");
        civList.style.cssText =
          "flex:1;overflow-y:auto;padding:5px 6px 5px 6px;min-height:0;box-sizing:border-box;" +
          "overflow-x:hidden;";

        // ── Status / empty state ─────────────────────────────────────────
        const civStatus = document.createElement("div");
        civStatus.style.cssText = "color:#31415a;font-size:10px;text-align:center;padding:16px 10px;line-height:1.8;";
        civStatus.innerHTML = "Enter a search term and press<br><em>Enter</em> or <em>Search</em>.";
        civList.appendChild(civStatus);

        // ── Spinner ──────────────────────────────────────────────────────
        const civSpinner = document.createElement("div");
        civSpinner.style.cssText =
          "color:#31415a;font-size:9px;text-align:center;padding:10px;display:none;flex-shrink:0;";
        civSpinner.textContent = "Loading\u2026";

        // ── Assemble panel ───────────────────────────────────────────────
        rpCivPanel.appendChild(civFilterBar);
        rpCivPanel.appendChild(civList);
        rpCivPanel.appendChild(civSpinner);

        // ── Detail panel (hidden, slides over list) ───────────────────────
        const civDetail = document.createElement("div");
        civDetail.style.cssText = "display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0;";
        rpCivPanel.appendChild(civDetail);

        const _showCivDetail = (item) => {
          if (civDetail._cleanup) { civDetail._cleanup(); civDetail._cleanup = null; }
          civDetail.innerHTML = "";
          civList.style.display = "none";
          civSpinner.style.display = "none";
          civDetail.style.display = "flex";

          const cleaned = _civCleanPrompt(item.prompt);

          // ── Back header ──────────────────────────────────────────────────
          const dHdr = document.createElement("div");
          dHdr.style.cssText =
            "display:flex;align-items:center;gap:6px;padding:6px 8px;" +
            "border-bottom:1px solid #1c2431;background:#12171f;flex-shrink:0;";
          const backBtn = document.createElement("button");
          backBtn.textContent = "\u2190 Back to results";
          backBtn.style.cssText =
            "background:#19212d;border:1px solid #31415a;border-radius:3px;" +
            "color:#aab8c8;font-size:9px;padding:2px 7px;" +
            "cursor:pointer;font-family:inherit;flex-shrink:0;";
          backBtn.onmouseenter = () => { backBtn.style.background="#202a38"; backBtn.style.borderColor="#4e5c6e"; backBtn.style.color="#dde6f0"; };
          backBtn.onmouseleave = () => { backBtn.style.background="#19212d"; backBtn.style.borderColor="#31415a"; backBtn.style.color="#aab8c8"; };
          backBtn.onclick = () => {
            if (civDetail._cleanup) { civDetail._cleanup(); civDetail._cleanup = null; }
            if (civDetail._activeVid) { civDetail._activeVid.pause(); civDetail._activeVid = null; }
            civDetail.style.display = "none";
            civList.style.display = "";
          };
          const dName = document.createElement("span");
          dName.textContent = item.name || "Untitled";
          dName.style.cssText = "font-size:9px;color:#4e5c6e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;";
          dHdr.appendChild(backBtn);
          dHdr.appendChild(dName);
          civDetail.appendChild(dHdr);

          // ── Scrollable body ──────────────────────────────────────────────
          const dBody = document.createElement("div");
          dBody.style.cssText = "flex:1;min-height:0;overflow-y:auto;padding:7px 8px;display:flex;flex-direction:column;gap:6px;";

          // Full image or video
          if (item.mediaType === "video" && item.videoUrl) {
            const dVidWrap = document.createElement("div");
            dVidWrap.style.cssText = "width:100%;background:#0b0f15;border-radius:3px;overflow:hidden;flex-shrink:0;";
            const dVid = document.createElement("video");
            dVid.src = item.videoUrl;
            dVid.controls = true;
            dVid.muted = true;
            dVid.loop  = true;
            dVid.playsInline = true;
            dVid.style.cssText = "width:100%;display:block;max-height:240px;object-fit:contain;";
            dVid.onerror = () => { dVidWrap.style.display="none"; };
            dVidWrap.appendChild(dVid);
            dBody.appendChild(dVidWrap);
            civDetail._activeVid = dVid;
            // Videos don't carry PNG metadata — disable workflow button
            _setGetWfBtn(false, null);
          } else if (item.imageUrl) {
            const dImgWrap = document.createElement("div");
            dImgWrap.style.cssText = "width:100%;background:#0b0f15;border-radius:3px;overflow:hidden;flex-shrink:0;";
            const dImg = document.createElement("img");
            dImg.src = item.imageUrl;
            dImg.style.cssText = "width:100%;display:block;max-height:240px;object-fit:contain;";
            dImg.onerror = () => { dImgWrap.style.display="none"; };
            dImgWrap.appendChild(dImg);
            dBody.appendChild(dImgWrap);
            // Only probe PNGs — JPEGs never carry workflow metadata
            rpGetWfBtn.style.display = "block";
            _setGetWfBtn(false, null);
            if (!item.isPng) {
              // Not a PNG — no probe needed, leave button dim
            } else if (_wfProbeCache.has(item.imageUrl)) {
              // Use cached result instantly
              const cached = _wfProbeCache.get(item.imageUrl);
              if (cached.hasWorkflow) _setGetWfBtn(true, item.imageUrl);
            } else {
              rpGetWfBtn.textContent = "\u21af Checking\u2026";
              rpGetWfBtn.style.color = "#4e5c6e";
              fetch("/epe/prompts/extract-workflow", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ imageUrl: item.imageUrl }),
              }).then(r => r.json()).then(d => {
                _wfProbeCache.set(item.imageUrl, d);
                if (d.hasWorkflow) {
                  _setGetWfBtn(true, item.imageUrl);
                } else {
                  _setGetWfBtn(false, null);
                }
              }).catch(() => { _setGetWfBtn(false, null); });
            }
          } else {
            _setGetWfBtn(false, null);
          }

          // Metadata chips
          const metaFields = [
            item.steps   ? "Steps: "+item.steps   : null,
            item.cfg     ? "CFG: "+item.cfg        : null,
            item.sampler ? item.sampler            : null,
            item.seed    ? "Seed: "+item.seed      : null,
          ].filter(Boolean);
          if (metaFields.length) {
            const metaRow = document.createElement("div");
            metaRow.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;";
            metaFields.forEach(label => {
              const chip = document.createElement("span");
              chip.textContent = label;
              chip.style.cssText =
                "font-size:8px;color:#4e5c6e;background:#10151d;border:1px solid #1c2431;" +
                "border-radius:2px;padding:2px 5px;white-space:nowrap;";
              metaRow.appendChild(chip);
            });
            dBody.appendChild(metaRow);
          }

          // Prompt label
          const pLabel = document.createElement("div");
          pLabel.style.cssText = "font-size:9px;color:#31415a;font-weight:600;text-transform:uppercase;letter-spacing:.4px;";
          pLabel.textContent = "Prompt";
          dBody.appendChild(pLabel);

          // Prompt textarea — collapsed read-only, click to expand+edit
          const LINE_H = 10 * 1.5;
          const PADDING_V = 10;
          const COLLAPSED_H = Math.round(LINE_H * 3 + PADDING_V) + "px";
          const _taROCSS =
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #24303f;" +
            "border-radius:3px;color:#aab8c8;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:none;height:"+COLLAPSED_H+";overflow:hidden;font-family:inherit;outline:none;cursor:pointer;";
          const _taEditCSS =
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #4e5c6e;" +
            "border-radius:3px;color:#d4dfea;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:vertical;min-height:144px;max-height:300px;overflow-y:auto;font-family:inherit;outline:none;cursor:text;padding-bottom:12px;margin-bottom:8px;";

          const civTA = document.createElement("textarea");
          civTA.style.cssText = _taROCSS;
          civTA.value = cleaned;
          civTA.readOnly = true;

          const _civCollapseTA = () => { civTA.style.cssText=_taROCSS; civTA.readOnly=true; };
          const _civExpandTA   = () => { civTA.style.cssText=_taEditCSS; civTA.readOnly=false; civTA.focus(); };
          civTA.onclick = (ev) => { ev.stopPropagation(); if(civTA.readOnly) _civExpandTA(); };
          const _civOutside = (ev) => { if(!dBody.contains(ev.target)) _civCollapseTA(); };
          document.addEventListener("mousedown", _civOutside, true);
          civDetail._cleanup = () => document.removeEventListener("mousedown", _civOutside, true);

          dBody.appendChild(_mkFontSizerWrap(civTA, 10));

          // Token count span
          const civCharSpan = document.createElement("span");
          civCharSpan.style.cssText = "font-size:9px;color:#4e5c6e;flex-shrink:0;";
          civCharSpan.textContent = countTokens(cleaned) + " tokens";

          // Row 1: Save as New | Snippets | Enhance
          const civRow1 = document.createElement("div");
          civRow1.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";

          const civSaveNewBtn = _mkBtn("Save as New", "Save to Favorites", "rgba(109,184,232,0.8)");
          civSaveNewBtn.onclick = (ev) => { ev.stopPropagation(); const _civSel = civTA.value.slice(civTA.selectionStart, civTA.selectionEnd).trim(); _libAddEntry("favorites", _civSel || civTA.value.trim() || cleaned); };

          const civSnipBtn = _mkBtn("Snippets", "Save to Snippets");
          civSnipBtn.onclick = (ev) => { ev.stopPropagation(); const _civSel = civTA.value.slice(civTA.selectionStart, civTA.selectionEnd).trim(); _libAddEntry("snippets", _civSel || civTA.value.trim() || cleaned); };

          const civEnhBtn = _mkBtn("Enhance", "Run AI enhance on this prompt", "rgba(100,160,255,0.7)");
          civEnhBtn.onclick = (ev) => {
            ev.stopPropagation();
            textEl.value = civTA.value.trim()||cleaned; updateTokenBadge(textEl.value);
            runAiAction("expand");
          };

          civRow1.appendChild(civSaveNewBtn);
          civRow1.appendChild(civSnipBtn);
          civRow1.appendChild(civEnhBtn);

          // Row 2: Variations | Use + token count right
          const civRow2 = document.createElement("div");
          civRow2.style.cssText = "display:flex;align-items:center;gap:4px;";

          const civVarBtn = _mkBtn("Variations", "Run AI variations on this prompt", "rgba(140,200,240,0.7)");
          civVarBtn.onclick = (ev) => {
            ev.stopPropagation();
            textEl.value = civTA.value.trim()||cleaned; updateTokenBadge(textEl.value);
            runAiAction("variations");
          };

          const civUseBtn = _mkBtn("Use", "Send to main prompt editor", "rgba(109,184,232,0.8)");
          civUseBtn.onclick = (ev) => {
            ev.stopPropagation();
            const t = civTA.value.trim()||cleaned;
            if (textEl._epePushUndo) textEl._epePushUndo();
            textEl.value = t; updateTokenBadge(t);
            textEl.dispatchEvent(new Event("input"));
            hideAiPanel();
          };

          civRow2.appendChild(civVarBtn);
          civRow2.appendChild(civUseBtn);
          civRow2.appendChild(civCharSpan);

          dBody.appendChild(civRow1);
          dBody.appendChild(civRow2);

          // ── New Prompt from Image ────────────────────────────────────────
          const civDivider = document.createElement("div");
          civDivider.style.cssText = "border-top:1px solid #161d28;margin:2px 0;";
          dBody.appendChild(civDivider);

          const civImgPromptBtn = _mkBtn("\uD83D\uDDBC Image to Prompt",
            "Send this image to Ollama (qwen3.5 vision model) to generate a prompt",
            "rgba(109,184,232,0.8)");
          civImgPromptBtn.style.width = "100%";
          civImgPromptBtn.onclick = async (ev) => {
            ev.stopPropagation();
            const isVideo = item.mediaType === "video" && item.videoUrl;
            if (!isVideo && !item.imageUrl) return;
            await _epeOllamaVision.run(
              isVideo ? "video-frame" : "image-url",
              isVideo ? item.videoUrl : item.imageUrl,
              showAiPanel, hideAiPanel,
              (prompt) => { if (textEl) { textEl.value = prompt; updateTokenBadge(prompt); } },
              {
                onFavorites: (t) => { _libAddEntry("favorites", t); },
                onSnippets:  (t) => { _libAddEntry("snippets", t); },
              }
            );
          };
          dBody.appendChild(civImgPromptBtn);

          if (item.mediaType === "video" && item.videoUrl) {
            const civVidPromptBtn = _mkBtn("\uD83C\uDFAC Video to Prompt",
              "Send this video to Ollama (qwen3.5 vision model) to generate a prompt",
              "rgba(160,120,232,0.8)");
            civVidPromptBtn.style.width = "100%";
            civVidPromptBtn.onclick = async (ev) => {
              ev.stopPropagation();
              await _epeOllamaVision.run("video", item.videoUrl, showAiPanel, hideAiPanel, (prompt) => {
                if (textEl) { textEl.value = prompt; updateTokenBadge(prompt); }
              }, {
                onFavorites: (t) => { _libAddEntry("favorites", t); },
                onSnippets:  (t) => { _libAddEntry("snippets", t); },
              });
            };
            dBody.appendChild(civVidPromptBtn);
          }

          civDetail.appendChild(dBody);
        };

        // ── Detail panel (hidden, slides over list) ──────────────────────


        // ── Build a Civitai card ─────────────────────────────────────────
        // Shared booru result-card builder. cfg carries per-source behavior:
        //   video   : allow <video> thumbnails (civ/seaart yes, genur no)
        //   preview : (item, cleaned) => string  — the two-line preview text
        //   previewStyle : extra css appended to the preview element
        //   requireClean : if true, return null when clean() yields nothing
        //   onClick : (item) => void
        const _mkBooruCard = (item, cfg) => {
          const cleaned = cfg.clean ? cfg.clean(item.prompt || "") : (item.prompt || "");
          if (cfg.requireClean && !cleaned) return null;
          const card = document.createElement("div");
          card.style.cssText =
            "background:#141a24;border:1px solid #1c2431;border-radius:5px;" +
            "overflow:hidden;cursor:pointer;transition:border-color .15s,transform .1s;" +
            "display:flex;flex-direction:column;flex-shrink:0;margin-bottom:6px;";
          card.onmouseenter = () => { card.style.borderColor = "rgba(140,200,240,0.45)"; card.style.transform = "translateY(-1px)"; };
          card.onmouseleave = () => { card.style.borderColor = "#1c2431"; card.style.transform = ""; };

          if (cfg.video && item.mediaType === "video" && item.videoUrl) {
            const vidWrap = document.createElement("div");
            vidWrap.style.cssText = "width:100%;height:130px;background:#0b0f15;overflow:hidden;flex-shrink:0;position:relative;";
            const vid = document.createElement("video");
            vid.src = item.videoUrl; vid.muted = true; vid.loop = true; vid.playsInline = true;
            vid.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
            vid.onerror = () => { vidWrap.style.height = "32px"; vidWrap.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:9px;color:#24303f;">No preview</div>'; };
            vidWrap.onmouseenter = () => vid.play().catch(() => {});
            vidWrap.onmouseleave = () => { vid.pause(); vid.currentTime = 0; };
            const badge = document.createElement("div");
            badge.style.cssText = "position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,0.65);color:#6db8e8;font-size:8px;font-weight:600;padding:1px 5px;border-radius:2px;pointer-events:none;";
            badge.textContent = "VIDEO";
            vidWrap.appendChild(vid); vidWrap.appendChild(badge);
            card.appendChild(vidWrap);
          } else if (item.imageUrl) {
            const imgWrap = document.createElement("div");
            imgWrap.style.cssText = "width:100%;height:130px;background:#0b0f15;overflow:hidden;flex-shrink:0;";
            const img = document.createElement("img");
            img.src = item.imageUrl;
            img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
            img.onerror = () => { imgWrap.style.height = "32px"; imgWrap.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:9px;color:#24303f;">No image</div>'; };
            imgWrap.appendChild(img);
            card.appendChild(imgWrap);
          }

          const info = document.createElement("div");
          info.style.cssText = "padding:5px 8px 6px;";
          const nameEl = document.createElement("div");
          nameEl.style.cssText = "font-size:9px;color:#6a7a8d;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px;";
          nameEl.textContent = item.name || "Untitled";
          nameEl.title = item.name || "";
          const previewEl = document.createElement("div");
          previewEl.style.cssText =
            "font-size:9px;color:#4e5c6e;line-height:1.45;" + (cfg.previewStyle || "") +
            "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;";
          previewEl.textContent = cfg.preview ? cfg.preview(item, cleaned) : cleaned;
          info.appendChild(nameEl); info.appendChild(previewEl);
          card.appendChild(info);
          card.onclick = () => cfg.onClick(item);
          return card;
        };

        const _mkCivCard = (item) => _mkBooruCard(item, {
          video: true, requireClean: true,
          clean: _civCleanPrompt,
          onClick: _showCivDetail,
        });

        // ══ Shared booru search engine ══════════════════════════════════════
        // One implementation of the search/paginate/infinite-scroll machinery
        // used by all three prompt browsers. Per-source specifics arrive via cfg:
        //   state       : { query, page, loading, exhausted, results, ... }
        //   list/status/spinner/searchInput/searchBtn : DOM handles
        //   endpoint    : API route          errLabel : error message prefix
        //   body(q,page): request payload    filter(items): pre-append filter
        //   mapItem(raw): normalize an API item for the card builder
        //   mkCard(item): card builder (from _mkBooruCard wrappers)
        // Returns { doSearch, loadMore, sentinel, observer } — aliased per
        // source so existing references (filter chips, media-type resets,
        // dispose) keep working unchanged.
        const _mkBooruEngine = (cfg) => {
          const sentinel = document.createElement("div");
          sentinel.style.cssText = "height:1px;flex-shrink:0;";
          cfg.list.appendChild(sentinel);

          const fetchPage = async (page) => {
            const q = cfg.state.query.trim();
            if (!q) return null;
            const resp = await fetch(cfg.endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(cfg.body(q, page)),
            });
            if (!resp.ok) throw new Error(cfg.errLabel + " " + resp.status);
            return resp.json();
          };

          const appendItems = (items) => {
            items.forEach(raw => {
              const card = cfg.mkCard(cfg.mapItem(raw));
              if (card) cfg.list.insertBefore(card, sentinel);
            });
          };

          const loadMore = async () => {
            if (cfg.state.loading || cfg.state.exhausted) return;
            cfg.state.loading = true;
            cfg.spinner.style.display = "block";
            try {
              const data = await fetchPage(cfg.state.page);
              if (!data || data.error) {
                cfg.state.exhausted = true;
                if (cfg.state.results.length === 0) {
                  cfg.status.textContent = data?.error || "No results found.";
                  cfg.status.style.display = "block";
                }
              } else {
                const hasMore = data.metadata?.hasMore ?? false;
                const usable = cfg.filter(data.items || []);
                if (usable.length > 0) {
                  cfg.state.results.push(...usable);
                  appendItems(usable);
                }
                cfg.state.page++;
                if (!hasMore) {
                  cfg.state.exhausted = true;
                  if (cfg.state.results.length === 0) {
                    cfg.status.textContent = "No results found.";
                    cfg.status.style.display = "block";
                  } else {
                    const endMsg = document.createElement("div");
                    endMsg.style.cssText = "color:#24303f;font-size:9px;text-align:center;padding:8px;";
                    endMsg.textContent = "\u2014 end of results \u2014";
                    cfg.list.appendChild(endMsg);
                  }
                }
                // If a page was fully filtered out but more remain, the observer
                // triggers the next page naturally on the next scroll tick.
              }
            } catch(err) {
              const errEl = document.createElement("div");
              errEl.style.cssText = "color:#744;font-size:9px;text-align:center;padding:8px;";
              errEl.textContent = "Error: " + (err.message || "Failed to fetch");
              cfg.list.appendChild(errEl);
              cfg.state.exhausted = true;
            } finally {
              cfg.state.loading = false;
              cfg.spinner.style.display = "none";
            }
          };

          const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !cfg.state.loading && !cfg.state.exhausted) {
              loadMore();
            }
          }, { root: cfg.list, threshold: 0.1 });
          observer.observe(sentinel);

          const doSearch = () => {
            const q = cfg.searchInput.value.trim();
            if (!q) return;
            // A new search always exits the detail view back to results.
            if (cfg.detail) {
              try { cfg.detail._cleanup && cfg.detail._cleanup(); cfg.detail._cleanup = null; } catch (_e) {}
              try { if (cfg.detail._activeVid) { cfg.detail._activeVid.pause(); cfg.detail._activeVid = null; } } catch (_e) {}
              cfg.detail.style.display = "none";
            }
            if (cfg.list) cfg.list.style.display = "";
            cfg.state.query    = q;
            cfg.state.page     = 1;
            cfg.state.loading  = false;
            cfg.state.exhausted= false;
            cfg.state.results  = [];
            while (cfg.list.lastChild) cfg.list.removeChild(cfg.list.lastChild);
            cfg.list.appendChild(cfg.status);
            cfg.list.appendChild(sentinel);
            cfg.status.style.display = "none";
            // Defer so the IntersectionObserver doesn't fire a duplicate load
            // while the sentinel is momentarily visible at top of an empty list
            requestAnimationFrame(() => loadMore());
          };
          cfg.searchBtn.onclick = doSearch;
          cfg.searchInput.onkeydown = (ev) => { if (ev.key === "Enter") doSearch(); };

          return { doSearch, loadMore, sentinel, observer };
        };

        const _civEngine = _mkBooruEngine({
          state: _civState, list: civList, status: civStatus, spinner: civSpinner, detail: civDetail,
          searchInput: civSearchInput, searchBtn: civSearchBtn,
          endpoint: "/epe/prompts/search", errLabel: "Prompt search error",
          body: (q, page) => ({
            query: q, sort: _civState.sort, period: _civState.period,
            nsfw: false, page, mediaType: _rpMediaType,
          }),
          filter: (items) => items.filter(i => i.prompt),
          mapItem: (item) => ({
            id:        item.id,
            name:      item.name      || "",
            prompt:    item.prompt    || "",
            imageUrl:  item.imageUrl  || "",
            videoUrl:  item.videoUrl  || "",
            mediaType: item.mediaType || "image",
            isPng:     item.isPng     || false,
            steps:     item.steps     || "",
            cfg:       item.cfg       || "",
            sampler:   item.sampler   || "",
            seed:      item.seed      || "",
          }),
          mkCard: _mkCivCard,
        });
        const _civDoSearch  = _civEngine.doSearch;
        const _civLoadMore  = _civEngine.loadMore;
        const civSentinel   = _civEngine.sentinel;
        const _civScrollObs = _civEngine.observer;

        // ══════════════════════════════════════════════════════════════════
        // GENUR.ART BROWSER
        // ══════════════════════════════════════════════════════════════════

        const _genurState = { query:"", page:1, loading:false, exhausted:false, results:[], sort:"popular" };

        const rpGenurPanel = document.createElement("div");
        rpGenurPanel.style.cssText = "flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;";

        const genurFilterBar = document.createElement("div");
        genurFilterBar.style.cssText =
          "flex-shrink:0;padding:5px 6px;border-bottom:1px solid #1c2431;" +
          "display:flex;flex-direction:column;gap:4px;background:#12171f;";

        const genurCallout = document.createElement("div");
        genurCallout.style.cssText =
          "display:flex;align-items:center;gap:5px;padding:4px 6px;" +
          "background:rgba(100,160,255,0.07);border:1px solid rgba(100,160,255,0.15);" +
          "border-radius:3px;margin-bottom:1px;";
        const genurCalloutIcon = document.createElement("span");
        genurCalloutIcon.textContent = "\uD83D\uDD0D";
        genurCalloutIcon.style.cssText = "font-size:10px;flex-shrink:0;";
        const genurCalloutText = document.createElement("span");
        genurCalloutText.textContent = "Search Genur.art for images \u2014 browse AI-generated image prompts";
        genurCalloutText.style.cssText = "font-size:9px;color:rgba(100,160,255,0.7);line-height:1.4;";
        genurCallout.appendChild(genurCalloutIcon);
        genurCallout.appendChild(genurCalloutText);
        genurFilterBar.appendChild(genurCallout);

        const genurSearchRow = document.createElement("div");
        genurSearchRow.style.cssText = "display:flex;gap:4px;";
        const genurSearchInput = document.createElement("input");
        genurSearchInput.type = "text";
        genurSearchInput.placeholder = "fantasy portrait\u2026";
        genurSearchInput.value = "fantasy portrait";
        genurSearchInput.style.cssText =
          "flex:1;background:#0b0f15;border:1px solid #1c2431;border-radius:3px;" +
          "color:#c2cddb;font-size:10px;padding:3px 7px;outline:none;font-family:inherit;";
        genurSearchInput.onfocus = () => { genurSearchInput.style.borderColor="#28364a"; };
        genurSearchInput.onblur  = () => { genurSearchInput.style.borderColor="#1c2431"; };
        const genurSearchBtn = document.createElement("button");
        genurSearchBtn.textContent = "Search";
        genurSearchBtn.style.cssText =
          "background:#161d28;border:1px solid #202a38;border-radius:3px;" +
          "color:#7a8a9c;font-size:9px;padding:2px 8px;cursor:pointer;font-family:inherit;" +
          "white-space:nowrap;transition:color .1s,background .1s;";
        genurSearchBtn.onmouseenter = () => { genurSearchBtn.style.background="#202a38"; genurSearchBtn.style.color="#c2cddb"; };
        genurSearchBtn.onmouseleave = () => { genurSearchBtn.style.background="#161d28"; genurSearchBtn.style.color="#7a8a9c"; };
        genurSearchRow.appendChild(genurSearchInput);
        genurSearchRow.appendChild(genurSearchBtn);
        genurFilterBar.appendChild(genurSearchRow);

        // Sort chips
        const genurSortRow = document.createElement("div");
        genurSortRow.style.cssText = "display:flex;gap:3px;flex-wrap:wrap;";
        const _mkGenurSortChip = (label, value) => {
          const c = document.createElement("button");
          c.textContent = label;
          c._on = (_genurState.sort === value);
          const _applyStyle = () => {
            c.style.cssText =
              "font-size:11px;padding:2px 7px;border-radius:2px;cursor:pointer;" +
              "font-family:inherit;transition:color .1s,background .1s,border-color .1s;" +
              (c._on
                ? "background:#202a38;border:1px solid #4e5c6e;color:#c2cddb;"
                : "background:#12171f;border:1px solid #1c2431;color:#4e5c6e;");
          };
          _applyStyle();
          c.onmouseenter = () => { if(!c._on) { c.style.color="#7a8a9c"; c.style.borderColor="#28364a"; } };
          c.onmouseleave = () => { if(!c._on) { c.style.color="#4e5c6e"; c.style.borderColor="#1c2431"; } };
          c._setOn = (on) => { c._on = on; _applyStyle(); };
          c.onclick = () => {
            genurSortRow.querySelectorAll("button").forEach(b => b._setOn && b._setOn(false));
            c._setOn(true);
            _genurState.sort = value;
            _genurDoSearch();
          };
          return c;
        };
        [["Most Popular","popular"],["Newest","newest"],["Oldest","oldest"],["Most Relevant","relevant"]].forEach(([label,val]) => {
          genurSortRow.appendChild(_mkGenurSortChip(label, val));
        });
        genurFilterBar.appendChild(genurSortRow);

        const genurList = document.createElement("div");
        genurList.style.cssText =
          "flex:1;overflow-y:auto;padding:5px 6px 5px 6px;min-height:0;box-sizing:border-box;" +
          "overflow-x:hidden;";

        const genurStatus = document.createElement("div");
        genurStatus.style.cssText = "color:#31415a;font-size:10px;text-align:center;padding:16px 10px;line-height:1.8;";
        genurStatus.innerHTML = "Enter a search term and press<br><em>Enter</em> or <em>Search</em>.";
        genurList.appendChild(genurStatus);

        const genurSpinner = document.createElement("div");
        genurSpinner.style.cssText =
          "color:#31415a;font-size:9px;text-align:center;padding:10px;display:none;flex-shrink:0;";
        genurSpinner.textContent = "Loading\u2026";

        rpGenurPanel.appendChild(genurFilterBar);
        rpGenurPanel.appendChild(genurList);
        rpGenurPanel.appendChild(genurSpinner);

        const genurDetail = document.createElement("div");
        genurDetail.style.cssText = "display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0;";
        rpGenurPanel.appendChild(genurDetail);

        const _showGenurDetail = (item) => {
          if (genurDetail._cleanup) { genurDetail._cleanup(); genurDetail._cleanup = null; }
          genurDetail.innerHTML = "";
          genurList.style.display = "none";
          genurSpinner.style.display = "none";
          genurDetail.style.display = "flex";

          const cleaned = _civCleanPrompt(item.prompt);

          const dHdr = document.createElement("div");
          dHdr.style.cssText =
            "display:flex;align-items:center;gap:6px;padding:6px 8px;" +
            "border-bottom:1px solid #1c2431;background:#12171f;flex-shrink:0;";
          const backBtn = document.createElement("button");
          backBtn.textContent = "\u2190 Back to results";
          backBtn.style.cssText =
            "background:#19212d;border:1px solid #31415a;border-radius:3px;" +
            "color:#aab8c8;font-size:9px;padding:2px 7px;" +
            "cursor:pointer;font-family:inherit;flex-shrink:0;";
          backBtn.onmouseenter = () => { backBtn.style.background="#202a38"; backBtn.style.borderColor="#4e5c6e"; backBtn.style.color="#dde6f0"; };
          backBtn.onmouseleave = () => { backBtn.style.background="#19212d"; backBtn.style.borderColor="#31415a"; backBtn.style.color="#aab8c8"; };
          backBtn.onclick = () => {
            if (genurDetail._cleanup) { genurDetail._cleanup(); genurDetail._cleanup = null; }
            genurDetail.style.display = "none";
            genurList.style.display = "";
          };
          const dName = document.createElement("span");
          dName.textContent = item.name || "Untitled";
          dName.style.cssText = "font-size:9px;color:#4e5c6e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;";
          dHdr.appendChild(backBtn);
          dHdr.appendChild(dName);
          genurDetail.appendChild(dHdr);

          const dBody = document.createElement("div");
          dBody.style.cssText = "flex:1;min-height:0;overflow-y:auto;padding:7px 8px;display:flex;flex-direction:column;gap:6px;";

          if (item.imageUrl) {
            const dImgWrap = document.createElement("div");
            dImgWrap.style.cssText = "width:100%;background:#0b0f15;border-radius:3px;overflow:hidden;flex-shrink:0;";
            const dImg = document.createElement("img");
            dImg.src = item.imageUrl;
            dImg.style.cssText = "width:100%;display:block;max-height:240px;object-fit:contain;";
            dImg.onerror = () => { dImgWrap.style.display="none"; };
            dImgWrap.appendChild(dImg);
            dBody.appendChild(dImgWrap);
            rpGetWfBtn.style.display = "block";
            _setGetWfBtn(false, null);
            if (!item.isPng) {
              // Not a PNG — skip probe
            } else if (_wfProbeCache.has(item.imageUrl)) {
              const cached = _wfProbeCache.get(item.imageUrl);
              if (cached.hasWorkflow) _setGetWfBtn(true, item.imageUrl);
            } else {
              rpGetWfBtn.textContent = "\u21af Checking\u2026";
              rpGetWfBtn.style.color = "#4e5c6e";
              fetch("/epe/prompts/extract-workflow", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ imageUrl: item.imageUrl }),
              }).then(r => r.json()).then(d => {
                _wfProbeCache.set(item.imageUrl, d);
                if (d.hasWorkflow) _setGetWfBtn(true, item.imageUrl);
                else _setGetWfBtn(false, null);
              }).catch(() => { _setGetWfBtn(false, null); });
            }
          } else {
            _setGetWfBtn(false, null);
          }

          const metaFields = [
            item.model   ? "Model: "+item.model : null,
          ].filter(Boolean);
          if (metaFields.length) {
            const metaRow = document.createElement("div");
            metaRow.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;";
            metaFields.forEach(label => {
              const chip = document.createElement("span");
              chip.textContent = label;
              chip.style.cssText =
                "font-size:8px;color:#4e5c6e;background:#10151d;border:1px solid #1c2431;" +
                "border-radius:2px;padding:2px 5px;white-space:nowrap;";
              metaRow.appendChild(chip);
            });
            dBody.appendChild(metaRow);
          }

          const pLabel = document.createElement("div");
          pLabel.style.cssText = "font-size:9px;color:#31415a;font-weight:600;text-transform:uppercase;letter-spacing:.4px;";
          pLabel.textContent = "Prompt";
          dBody.appendChild(pLabel);

          const LINE_H_G = 10 * 1.5;
          const PADDING_V_G = 10;
          const COLLAPSED_H_G = Math.round(LINE_H_G * 3 + PADDING_V_G) + "px";
          const _taROCSS_G =
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #24303f;" +
            "border-radius:3px;color:#aab8c8;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:none;height:"+COLLAPSED_H_G+";overflow:hidden;font-family:inherit;outline:none;cursor:pointer;";
          const _taEditCSS_G =
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #4e5c6e;" +
            "border-radius:3px;color:#d4dfea;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:vertical;min-height:144px;max-height:300px;overflow-y:auto;font-family:inherit;outline:none;cursor:text;padding-bottom:12px;margin-bottom:8px;";

          const genurTA = document.createElement("textarea");
          genurTA.style.cssText = _taROCSS_G;
          genurTA.value = cleaned;
          genurTA.readOnly = true;

          const _genurCollapseTA = () => { genurTA.style.cssText=_taROCSS_G; genurTA.readOnly=true; };
          const _genurExpandTA   = () => { genurTA.style.cssText=_taEditCSS_G; genurTA.readOnly=false; genurTA.focus(); };
          genurTA.onclick = (ev) => { ev.stopPropagation(); if(genurTA.readOnly) _genurExpandTA(); };
          const _genurOutside = (ev) => { if(!dBody.contains(ev.target)) _genurCollapseTA(); };
          document.addEventListener("mousedown", _genurOutside, true);
          genurDetail._cleanup = () => document.removeEventListener("mousedown", _genurOutside, true);

          dBody.appendChild(_mkFontSizerWrap(genurTA, 10));

          const genurCharSpan = document.createElement("span");
          genurCharSpan.style.cssText = "font-size:9px;color:#4e5c6e;flex-shrink:0;";
          genurCharSpan.textContent = countTokens(cleaned) + " tokens";

          const genurRow1 = document.createElement("div");
          genurRow1.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";

          const genurSaveNewBtn = _mkBtn("Save as New", "Save to Favorites", "rgba(109,184,232,0.8)");
          genurSaveNewBtn.onclick = (ev) => { ev.stopPropagation(); const _sel = genurTA.value.slice(genurTA.selectionStart, genurTA.selectionEnd).trim(); _libAddEntry("favorites", _sel || genurTA.value.trim() || cleaned); };

          const genurSnipBtn = _mkBtn("Snippets", "Save to Snippets");
          genurSnipBtn.onclick = (ev) => { ev.stopPropagation(); const _sel = genurTA.value.slice(genurTA.selectionStart, genurTA.selectionEnd).trim(); _libAddEntry("snippets", _sel || genurTA.value.trim() || cleaned); };

          const genurEnhBtn = _mkBtn("Enhance", "Run AI enhance on this prompt", "rgba(100,160,255,0.7)");
          genurEnhBtn.onclick = (ev) => {
            ev.stopPropagation();
            textEl.value = genurTA.value.trim()||cleaned; updateTokenBadge(textEl.value);
            runAiAction("expand");
          };

          genurRow1.appendChild(genurSaveNewBtn);
          genurRow1.appendChild(genurSnipBtn);
          genurRow1.appendChild(genurEnhBtn);

          const genurRow2 = document.createElement("div");
          genurRow2.style.cssText = "display:flex;align-items:center;gap:4px;";

          const genurVarBtn = _mkBtn("Variations", "Run AI variations on this prompt", "rgba(140,200,240,0.7)");
          genurVarBtn.onclick = (ev) => {
            ev.stopPropagation();
            textEl.value = genurTA.value.trim()||cleaned; updateTokenBadge(textEl.value);
            runAiAction("variations");
          };

          const genurUseBtn = _mkBtn("Use", "Send to main prompt editor", "rgba(109,184,232,0.8)");
          genurUseBtn.onclick = (ev) => {
            ev.stopPropagation();
            const t = genurTA.value.trim()||cleaned;
            if (textEl._epePushUndo) textEl._epePushUndo();
            textEl.value = t; updateTokenBadge(t);
            textEl.dispatchEvent(new Event("input"));
            hideAiPanel();
          };

          genurRow2.appendChild(genurVarBtn);
          genurRow2.appendChild(genurUseBtn);
          genurRow2.appendChild(genurCharSpan);

          dBody.appendChild(genurRow1);
          dBody.appendChild(genurRow2);

          const genurDivider = document.createElement("div");
          genurDivider.style.cssText = "border-top:1px solid #161d28;margin:2px 0;";
          dBody.appendChild(genurDivider);

          const genurImgPromptBtn = _mkBtn("\uD83D\uDDBC Image to Prompt",
            "Send this image to Ollama (qwen3.5 vision model) to generate a prompt",
            "rgba(109,184,232,0.8)");
          genurImgPromptBtn.style.width = "100%";
          genurImgPromptBtn.onclick = async (ev) => {
            ev.stopPropagation();
            if (!item.imageUrl) return;
            await _epeOllamaVision.run("image-url", item.imageUrl, showAiPanel, hideAiPanel, (prompt) => {
              if (textEl) { textEl.value = prompt; updateTokenBadge(prompt); }
            }, {
              onFavorites: (t) => { _libAddEntry("favorites", t); },
              onSnippets:  (t) => { _libAddEntry("snippets", t); },
            });
          };
          dBody.appendChild(genurImgPromptBtn);

          genurDetail.appendChild(dBody);
        };

        const _mkGenurCard = (item) => _mkBooruCard(item, {
          video: false,
          clean: (p) => _civCleanPrompt(p || ""),
          preview: (it, cleaned) => cleaned || it.prompt || "",
          onClick: _showGenurDetail,
        });

        const _genurEngine = _mkBooruEngine({
          state: _genurState, list: genurList, status: genurStatus, spinner: genurSpinner, detail: genurDetail,
          searchInput: genurSearchInput, searchBtn: genurSearchBtn,
          endpoint: "/epe/prompts/search-genur", errLabel: "Genur.art search error",
          body: (q, page) => ({ query: q, page, sort: _genurState.sort }),
          filter: (items) => items.filter(i => i.prompt),
          mapItem: (item) => ({
            id:       item.id,
            name:     item.name     || "",
            prompt:   item.prompt   || "",
            imageUrl: item.imageUrl || "",
            isPng:    item.isPng    || false,
            model:    item.model    || "",
          }),
          mkCard: _mkGenurCard,
        });
        const _genurDoSearch  = _genurEngine.doSearch;
        const _genurLoadMore  = _genurEngine.loadMore;
        const genurSentinel   = _genurEngine.sentinel;
        const _genurScrollObs = _genurEngine.observer;

        // ══════════════════════════════════════════════════════════════════
        // SEAART BROWSER
        // ══════════════════════════════════════════════════════════════════

        const _seaartState = { query:"", page:1, loading:false, exhausted:false, results:[], sort:"hot" };

        const rpSeaartPanel = document.createElement("div");
        rpSeaartPanel.style.cssText = "flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;";

        const seaartFilterBar = document.createElement("div");
        seaartFilterBar.style.cssText =
          "flex-shrink:0;padding:5px 6px;border-bottom:1px solid #1c2431;" +
          "display:flex;flex-direction:column;gap:4px;background:#12171f;";

        const seaartCallout = document.createElement("div");
        seaartCallout.style.cssText =
          "display:flex;align-items:center;gap:5px;padding:4px 6px;" +
          "background:rgba(100,160,255,0.07);border:1px solid rgba(100,160,255,0.15);" +
          "border-radius:3px;margin-bottom:1px;";
        const seaartCalloutIcon = document.createElement("span");
        seaartCalloutIcon.textContent = "\uD83D\uDD0D";
        seaartCalloutIcon.style.cssText = "font-size:10px;flex-shrink:0;";
        const seaartCalloutText = document.createElement("span");
        seaartCalloutText.textContent = "Search SeaArt for images \u2014 browse AI-generated image prompts";
        seaartCalloutText.style.cssText = "font-size:9px;color:rgba(100,160,255,0.7);line-height:1.4;";
        seaartCallout.appendChild(seaartCalloutIcon);
        seaartCallout.appendChild(seaartCalloutText);
        seaartFilterBar.appendChild(seaartCallout);

        const seaartSearchRow = document.createElement("div");
        seaartSearchRow.style.cssText = "display:flex;gap:4px;";
        const seaartSearchInput = document.createElement("input");
        seaartSearchInput.type = "text";
        seaartSearchInput.placeholder = "fantasy portrait\u2026";
        seaartSearchInput.value = "fantasy portrait";
        seaartSearchInput.style.cssText =
          "flex:1;background:#0b0f15;border:1px solid #1c2431;border-radius:3px;" +
          "color:#c2cddb;font-size:10px;padding:3px 7px;outline:none;font-family:inherit;";
        seaartSearchInput.onfocus = () => { seaartSearchInput.style.borderColor="#28364a"; };
        seaartSearchInput.onblur  = () => { seaartSearchInput.style.borderColor="#1c2431"; };
        const seaartSearchBtn = document.createElement("button");
        seaartSearchBtn.textContent = "Search";
        seaartSearchBtn.style.cssText =
          "background:#161d28;border:1px solid #202a38;border-radius:3px;" +
          "color:#7a8a9c;font-size:9px;padding:2px 8px;cursor:pointer;font-family:inherit;" +
          "white-space:nowrap;transition:color .1s,background .1s;";
        seaartSearchBtn.onmouseenter = () => { seaartSearchBtn.style.background="#202a38"; seaartSearchBtn.style.color="#c2cddb"; };
        seaartSearchBtn.onmouseleave = () => { seaartSearchBtn.style.background="#161d28"; seaartSearchBtn.style.color="#7a8a9c"; };
        seaartSearchRow.appendChild(seaartSearchInput);
        seaartSearchRow.appendChild(seaartSearchBtn);
        seaartFilterBar.appendChild(seaartSearchRow);

        // Sort chips
        const seaartSortRow = document.createElement("div");
        seaartSortRow.style.cssText = "display:flex;gap:3px;flex-wrap:wrap;";
        const _mkSeaartSortChip = (label, value) => {
          const c = document.createElement("button");
          c.textContent = label;
          c._on = (_seaartState.sort === value);
          const _applySeaartChipStyle = () => {
            c.style.cssText =
              "font-size:11px;padding:2px 7px;border-radius:2px;cursor:pointer;" +
              "font-family:inherit;transition:color .1s,background .1s,border-color .1s;" +
              (c._on
                ? "background:#202a38;border:1px solid #4e5c6e;color:#c2cddb;"
                : "background:#12171f;border:1px solid #1c2431;color:#4e5c6e;");
          };
          _applySeaartChipStyle();
          c.onmouseenter = () => { if(!c._on) { c.style.color="#7a8a9c"; c.style.borderColor="#28364a"; } };
          c.onmouseleave = () => { if(!c._on) { c.style.color="#4e5c6e"; c.style.borderColor="#1c2431"; } };
          c._setOn = (on) => { c._on = on; _applySeaartChipStyle(); };
          c.onclick = () => {
            seaartSortRow.querySelectorAll("button").forEach(b => b._setOn && b._setOn(false));
            c._setOn(true);
            _seaartState.sort = value;
            _seaartDoSearch();
          };
          return c;
        };
        [["Hot","hot"],["New","new"]].forEach(([label,val]) => {
          seaartSortRow.appendChild(_mkSeaartSortChip(label, val));
        });
        seaartFilterBar.appendChild(seaartSortRow);

        const seaartList = document.createElement("div");
        seaartList.style.cssText =
          "flex:1;overflow-y:auto;padding:5px 6px 5px 6px;min-height:0;box-sizing:border-box;" +
          "overflow-x:hidden;";

        const seaartStatus = document.createElement("div");
        seaartStatus.style.cssText = "color:#31415a;font-size:10px;text-align:center;padding:16px 10px;line-height:1.8;";
        seaartStatus.innerHTML = "Enter a search term and press<br><em>Enter</em> or <em>Search</em>.";
        seaartList.appendChild(seaartStatus);

        const seaartSpinner = document.createElement("div");
        seaartSpinner.style.cssText =
          "color:#31415a;font-size:9px;text-align:center;padding:10px;display:none;flex-shrink:0;";
        seaartSpinner.textContent = "Loading\u2026";

        rpSeaartPanel.appendChild(seaartFilterBar);
        rpSeaartPanel.appendChild(seaartList);
        rpSeaartPanel.appendChild(seaartSpinner);

        const seaartDetail = document.createElement("div");
        seaartDetail.style.cssText = "display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0;";
        rpSeaartPanel.appendChild(seaartDetail);

        const _showSeaartDetail = async (item) => {
          if (seaartDetail._cleanup) { seaartDetail._cleanup(); seaartDetail._cleanup = null; }
          seaartDetail.innerHTML = "";
          seaartList.style.display = "none";
          seaartSpinner.style.display = "none";
          seaartDetail.style.display = "flex";

          const dHdr = document.createElement("div");
          dHdr.style.cssText =
            "display:flex;align-items:center;gap:6px;padding:6px 8px;" +
            "border-bottom:1px solid #1c2431;background:#12171f;flex-shrink:0;";
          const backBtn = document.createElement("button");
          backBtn.textContent = "\u2190 Back to results";
          backBtn.style.cssText =
            "background:#19212d;border:1px solid #31415a;border-radius:3px;" +
            "color:#aab8c8;font-size:9px;padding:2px 7px;" +
            "cursor:pointer;font-family:inherit;flex-shrink:0;";
          backBtn.onmouseenter = () => { backBtn.style.background="#202a38"; backBtn.style.borderColor="#4e5c6e"; backBtn.style.color="#dde6f0"; };
          backBtn.onmouseleave = () => { backBtn.style.background="#19212d"; backBtn.style.borderColor="#31415a"; backBtn.style.color="#aab8c8"; };
          backBtn.onclick = () => {
            if (seaartDetail._cleanup) { seaartDetail._cleanup(); seaartDetail._cleanup = null; }
            if (seaartDetail._activeVid) { seaartDetail._activeVid.pause(); seaartDetail._activeVid = null; }
            seaartDetail.style.display = "none";
            seaartList.style.display = "";
          };
          const dName = document.createElement("span");
          dName.textContent = item.name || "Untitled";
          dName.style.cssText = "font-size:9px;color:#4e5c6e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;";
          dHdr.appendChild(backBtn);
          dHdr.appendChild(dName);
          seaartDetail.appendChild(dHdr);

          const dBody = document.createElement("div");
          dBody.style.cssText = "flex:1;min-height:0;overflow-y:auto;padding:7px 8px;display:flex;flex-direction:column;gap:6px;";

          // Loading state while we fetch the prompt
          let resolvedItem = item;
          if (item.prompt === null || item.prompt === undefined) {
            const loadMsg = document.createElement("div");
            loadMsg.style.cssText = "font-size:9px;color:#4e5c6e;text-align:center;padding:16px 10px;";
            loadMsg.textContent = "Loading prompt\u2026";
            dBody.appendChild(loadMsg);
            seaartDetail.appendChild(dBody);
            try {
              const detailResp = await fetch("/epe/prompts/seaart-detail", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: item.id, artworkId: item.artworkId || item.id, mediaType: item.mediaType || "image" }),
              });
              if (!detailResp.ok) throw new Error(`Detail fetch error ${detailResp.status}`);
              const detailData = await detailResp.json();
              if (detailData.error) throw new Error(detailData.error);
              // Merge: prefer non-empty videoUrl from detail response
              resolvedItem = Object.assign({}, item, detailData);
              if (!resolvedItem.videoUrl && detailData.videoUrl) resolvedItem.videoUrl = detailData.videoUrl;
              if (!resolvedItem.mediaType) resolvedItem.mediaType = item.mediaType || "image";
              // Update the cached item in results so repeated clicks don't re-fetch
              const idx = _seaartState.results.findIndex(r => r.id === item.id);
              if (idx !== -1) _seaartState.results[idx] = resolvedItem;
              dBody.removeChild(loadMsg);
            } catch(err) {
              loadMsg.style.color = "#744";
              loadMsg.textContent = err.message === "This post is private or restricted on SeaArt"
                ? "⚠ This post is private or restricted on SeaArt."
                : "Failed to load prompt: " + (err.message || err);
              return;
            }
          }

          const cleaned = _civCleanPrompt(resolvedItem.prompt || "");

          if (resolvedItem.mediaType === "video" && resolvedItem.videoUrl) {
            const dVidWrap = document.createElement("div");
            dVidWrap.style.cssText = "width:100%;background:#0b0f15;border-radius:3px;overflow:hidden;flex-shrink:0;";
            const dVid = document.createElement("video");
            dVid.src = resolvedItem.videoUrl;
            dVid.controls = true; dVid.muted = true; dVid.loop = true; dVid.playsInline = true;
            dVid.style.cssText = "width:100%;display:block;max-height:240px;object-fit:contain;";
            dVid.onerror = () => { dVidWrap.style.display="none"; };
            dVidWrap.appendChild(dVid);
            dBody.appendChild(dVidWrap);
            seaartDetail._activeVid = dVid;
            // SeaArt videos: no PNG metadata, hide workflow button
            rpGetWfBtn.style.display = "none";
            _setGetWfBtn(false, null);
          } else if (resolvedItem.imageUrl) {
            const dImgWrap = document.createElement("div");
            dImgWrap.style.cssText = "width:100%;background:#0b0f15;border-radius:3px;overflow:hidden;flex-shrink:0;";
            const dImg = document.createElement("img");
            dImg.src = resolvedItem.imageUrl;
            dImg.style.cssText = "width:100%;display:block;max-height:240px;object-fit:contain;";
            dImg.onerror = () => { dImgWrap.style.display="none"; };
            dImgWrap.appendChild(dImg);
            dBody.appendChild(dImgWrap);
            // SeaArt images: CDN-locked, can't extract PNG metadata
            rpGetWfBtn.style.display = "none";
            _setGetWfBtn(false, null);
          }

          const metaFields = [
            resolvedItem.steps  ? "Steps: "+resolvedItem.steps  : null,
            resolvedItem.cfg    ? "CFG: "+resolvedItem.cfg      : null,
            resolvedItem.seed   ? "Seed: "+resolvedItem.seed    : null,
            resolvedItem.model  ? "Model: "+resolvedItem.model  : null,
          ].filter(Boolean);
          if (metaFields.length) {
            const metaRow = document.createElement("div");
            metaRow.style.cssText = "display:flex;flex-wrap:wrap;gap:3px;";
            metaFields.forEach(label => {
              const chip = document.createElement("span");
              chip.textContent = label;
              chip.style.cssText =
                "font-size:8px;color:#4e5c6e;background:#10151d;border:1px solid #1c2431;" +
                "border-radius:2px;padding:2px 5px;white-space:nowrap;";
              metaRow.appendChild(chip);
            });
            dBody.appendChild(metaRow);
          }

          const pLabel = document.createElement("div");
          pLabel.style.cssText = "font-size:9px;color:#31415a;font-weight:600;text-transform:uppercase;letter-spacing:.4px;";
          pLabel.textContent = "Prompt";
          dBody.appendChild(pLabel);

          const LINE_H_S = 10 * 1.5;
          const PADDING_V_S = 10;
          const COLLAPSED_H_S = Math.round(LINE_H_S * 3 + PADDING_V_S) + "px";
          const _taROCSS_S =
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #24303f;" +
            "border-radius:3px;color:#aab8c8;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:none;height:"+COLLAPSED_H_S+";overflow:hidden;font-family:inherit;outline:none;cursor:pointer;";
          const _taEditCSS_S =
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #4e5c6e;" +
            "border-radius:3px;color:#d4dfea;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:vertical;min-height:144px;max-height:300px;overflow-y:auto;font-family:inherit;outline:none;cursor:text;padding-bottom:12px;margin-bottom:8px;";

          const seaartTA = document.createElement("textarea");
          seaartTA.style.cssText = _taROCSS_S;
          seaartTA.value = cleaned;
          seaartTA.readOnly = true;

          const _seaartCollapseTA = () => { seaartTA.style.cssText=_taROCSS_S; seaartTA.readOnly=true; };
          const _seaartExpandTA   = () => { seaartTA.style.cssText=_taEditCSS_S; seaartTA.readOnly=false; seaartTA.focus(); };
          seaartTA.onclick = (ev) => { ev.stopPropagation(); if(seaartTA.readOnly) _seaartExpandTA(); };
          const _seaartOutside = (ev) => { if(!dBody.contains(ev.target)) _seaartCollapseTA(); };
          document.addEventListener("mousedown", _seaartOutside, true);
          seaartDetail._cleanup = () => document.removeEventListener("mousedown", _seaartOutside, true);

          dBody.appendChild(_mkFontSizerWrap(seaartTA, 10));

          const seaartCharSpan = document.createElement("span");
          seaartCharSpan.style.cssText = "font-size:9px;color:#4e5c6e;flex-shrink:0;";
          seaartCharSpan.textContent = countTokens(cleaned) + " tokens";

          const seaartRow1 = document.createElement("div");
          seaartRow1.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;";

          const seaartSaveNewBtn = _mkBtn("Save as New", "Save to Favorites", "rgba(109,184,232,0.8)");
          seaartSaveNewBtn.onclick = (ev) => { ev.stopPropagation(); const _sel = seaartTA.value.slice(seaartTA.selectionStart, seaartTA.selectionEnd).trim(); _libAddEntry("favorites", _sel || seaartTA.value.trim() || cleaned); };

          const seaartSnipBtn = _mkBtn("Snippets", "Save to Snippets");
          seaartSnipBtn.onclick = (ev) => { ev.stopPropagation(); const _sel = seaartTA.value.slice(seaartTA.selectionStart, seaartTA.selectionEnd).trim(); _libAddEntry("snippets", _sel || seaartTA.value.trim() || cleaned); };

          const seaartEnhBtn = _mkBtn("Enhance", "Run AI enhance on this prompt", "rgba(100,160,255,0.7)");
          seaartEnhBtn.onclick = (ev) => {
            ev.stopPropagation();
            textEl.value = seaartTA.value.trim()||cleaned; updateTokenBadge(textEl.value);
            runAiAction("expand");
          };

          seaartRow1.appendChild(seaartSaveNewBtn);
          seaartRow1.appendChild(seaartSnipBtn);
          seaartRow1.appendChild(seaartEnhBtn);

          const seaartRow2 = document.createElement("div");
          seaartRow2.style.cssText = "display:flex;align-items:center;gap:4px;";

          const seaartVarBtn = _mkBtn("Variations", "Run AI variations on this prompt", "rgba(140,200,240,0.7)");
          seaartVarBtn.onclick = (ev) => {
            ev.stopPropagation();
            textEl.value = seaartTA.value.trim()||cleaned; updateTokenBadge(textEl.value);
            runAiAction("variations");
          };

          const seaartUseBtn = _mkBtn("Use", "Send to main prompt editor", "rgba(109,184,232,0.8)");
          seaartUseBtn.onclick = (ev) => {
            ev.stopPropagation();
            const t = seaartTA.value.trim()||cleaned;
            if (textEl._epePushUndo) textEl._epePushUndo();
            textEl.value = t; updateTokenBadge(t);
            textEl.dispatchEvent(new Event("input"));
            hideAiPanel();
          };

          seaartRow2.appendChild(seaartVarBtn);
          seaartRow2.appendChild(seaartUseBtn);
          seaartRow2.appendChild(seaartCharSpan);

          dBody.appendChild(seaartRow1);
          dBody.appendChild(seaartRow2);

          const seaartDivider = document.createElement("div");
          seaartDivider.style.cssText = "border-top:1px solid #161d28;margin:2px 0;";
          dBody.appendChild(seaartDivider);

          const seaartImgPromptBtn = _mkBtn("\uD83D\uDDBC Image to Prompt",
            "Send this image to Ollama (qwen3.5 vision model) to generate a prompt",
            "rgba(109,184,232,0.8)");
          seaartImgPromptBtn.style.width = "100%";
          seaartImgPromptBtn.onclick = async (ev) => {
            ev.stopPropagation();
            const isVideo = resolvedItem.mediaType === "video" && resolvedItem.videoUrl;
            const imgSrc = resolvedItem.imageUrl;
            if (!isVideo && !imgSrc) return;
            await _epeOllamaVision.run(
              isVideo ? "video-frame" : "image-url",
              isVideo ? resolvedItem.videoUrl : imgSrc,
              showAiPanel, hideAiPanel,
              (prompt) => { if (textEl) { textEl.value = prompt; updateTokenBadge(prompt); } },
              {
                onFavorites: (t) => { _libAddEntry("favorites", t); },
                onSnippets:  (t) => { _libAddEntry("snippets", t); },
              }
            );
          };
          dBody.appendChild(seaartImgPromptBtn);

          if (resolvedItem.mediaType === "video" && resolvedItem.videoUrl) {
            const seaartVidPromptBtn = _mkBtn("\uD83C\uDFAC Video to Prompt",
              "Send this video to Ollama (qwen3.5 vision model) to generate a prompt",
              "rgba(160,120,232,0.8)");
            seaartVidPromptBtn.style.width = "100%";
            seaartVidPromptBtn.onclick = async (ev) => {
              ev.stopPropagation();
              await _epeOllamaVision.run("video", resolvedItem.videoUrl, showAiPanel, hideAiPanel, (prompt) => {
                if (textEl) { textEl.value = prompt; updateTokenBadge(prompt); }
              }, {
                onFavorites: (t) => { _libAddEntry("favorites", t); },
                onSnippets:  (t) => { _libAddEntry("snippets", t); },
              });
            };
            dBody.appendChild(seaartVidPromptBtn);
          }

          seaartDetail.appendChild(dBody);
        };

        const _mkSeaartCard = (item) => _mkBooruCard(item, {
          video: true,
          clean: () => "",
          preview: (it) => it.mediaType === "video" ? "Click to view prompt" : "Click to load prompt",
          previewStyle: "color:#31415a;font-style:italic;",
          onClick: _showSeaartDetail,
        });

        const _seaartEngine = _mkBooruEngine({
          state: _seaartState, list: seaartList, status: seaartStatus, spinner: seaartSpinner, detail: seaartDetail,
          searchInput: seaartSearchInput, searchBtn: seaartSearchBtn,
          endpoint: "/epe/prompts/search-seaart", errLabel: "SeaArt search error",
          body: (q, page) => ({ query: q, page, sort: _seaartState.sort, mediaType: _rpMediaType }),
          filter: (items) => items,
          mapItem: (item) => ({
            id:        item.id,
            name:      item.name      || "",
            prompt:    item.prompt,
            imageUrl:  item.imageUrl  || "",
            videoUrl:  item.videoUrl  || "",
            mediaType: item.mediaType || "image",
          }),
          mkCard: _mkSeaartCard,
        });
        const _seaartDoSearch  = _seaartEngine.doSearch;
        const _seaartLoadMore  = _seaartEngine.loadMore;
        const seaartSentinel   = _seaartEngine.sentinel;
        const _seaartScrollObs = _seaartEngine.observer;

        // ── Micro action button ──────────────────────────────────────────
        // ── Font sizer helper — wraps any textarea with an always-visible ──
        // ── centered A/size/A bar above it. Faded by default; brightens on ──
        // ── bar hover or textarea focus.                                   ──
        const _mkFontSizerWrap = (ta, defaultSize) => {
          let _fs = defaultSize || 10;
          ta.style.fontSize = _fs + "px";

          // Re-apply font size whenever the textarea cssText is reset by result panels
          let _fsApplying = false;
          const _fsObs = new MutationObserver(() => {
            if (!ta.isConnected) { _fsObs.disconnect(); return; }
            if (_fsApplying) return;
            if (ta.style.fontSize !== _fs + "px") {
              _fsApplying = true;
              ta.style.fontSize = _fs + "px";
              _fsApplying = false;
            }
          });
          _fsObs.observe(ta, { attributes: true, attributeFilter: ["style"] });

          // Outer wrap — column so bar sits above textarea; preserves flex:1 behavior
          // by forwarding the textarea's grow to itself via display:flex.
          const wrap = document.createElement("div");
          wrap.style.cssText = "display:flex;flex-direction:column;min-height:0;flex:1 1 auto;";

          // Font-size bar — always visible, centered, faded by default
          const bar = document.createElement("div");
          bar.style.cssText =
            "display:flex;align-items:center;justify-content:center;gap:6px;" +
            "padding:2px 0 3px 0;flex-shrink:0;" +
            "opacity:0.35;transition:opacity .15s ease;" +
            "user-select:none;";

          // Brightness controller — 1.0 when bar is hovered OR textarea focused
          let _hovering = false, _focused = false;
          const _applyOpacity = () => {
            bar.style.opacity = (_hovering || _focused) ? "1" : "0.35";
          };
          bar.addEventListener("mouseenter", () => { _hovering = true; _applyOpacity(); });
          bar.addEventListener("mouseleave", () => { _hovering = false; _applyOpacity(); });
          ta.addEventListener("focus", () => { _focused = true; _applyOpacity(); });
          ta.addEventListener("blur",  () => { _focused = false; _applyOpacity(); });

          // Decrease button — small A
          const fsDown = document.createElement("button");
          fsDown.textContent = "A";
          fsDown.title = "Decrease font size";
          fsDown.style.cssText =
            "background:none;border:none;cursor:pointer;padding:0 3px;" +
            "color:#7a8a9c;font-size:9px;font-weight:600;line-height:1;";
          fsDown.onmouseenter = () => { fsDown.style.color = "#6db8e8"; };
          fsDown.onmouseleave = () => { fsDown.style.color = "#7a8a9c"; };

          // Current size readout
          const fsVal = document.createElement("span");
          fsVal.textContent = String(_fs);
          fsVal.style.cssText =
            "font-size:9px;color:#6a7a8d;min-width:18px;text-align:center;" +
            "font-family:monospace;";

          // Increase button — larger A
          const fsUp = document.createElement("button");
          fsUp.textContent = "A";
          fsUp.title = "Increase font size";
          fsUp.style.cssText =
            "background:none;border:none;cursor:pointer;padding:0 3px;" +
            "color:#7a8a9c;font-size:13px;font-weight:600;line-height:1;";
          fsUp.onmouseenter = () => { fsUp.style.color = "#6db8e8"; };
          fsUp.onmouseleave = () => { fsUp.style.color = "#7a8a9c"; };

          fsDown.onclick = (e) => {
            e.stopPropagation();
            _fs = Math.max(8, _fs - 1);
            ta.style.fontSize = _fs + "px";
            fsVal.textContent = String(_fs);
            if (ta._autoSize) ta._autoSize();
          };
          fsUp.onclick = (e) => {
            e.stopPropagation();
            _fs = Math.min(22, _fs + 1);
            ta.style.fontSize = _fs + "px";
            fsVal.textContent = String(_fs);
            if (ta._autoSize) ta._autoSize();
          };

          bar.appendChild(fsDown);
          bar.appendChild(fsVal);
          bar.appendChild(fsUp);

          // Assembly: bar above textarea
          wrap.appendChild(bar);
          wrap.appendChild(ta);
          return wrap;
        };

        // ══════════════════════════════════════════════════════════════════
        // WORKFLOW BROWSER PANEL
        // ══════════════════════════════════════════════════════════════════
        const rpWorkflowPanel = document.createElement("div");
        rpWorkflowPanel.style.cssText = "flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;";

        // ── Filter bar ───────────────────────────────────────────────────
        const wfFilterBar = document.createElement("div");
        wfFilterBar.style.cssText =
          "flex-shrink:0;border-bottom:1px solid #1c2431;padding:6px 7px;display:flex;flex-direction:column;gap:5px;";

        const wfCallout = document.createElement("div");
        wfCallout.style.cssText =
          "font-size:8px;color:#484848;line-height:1.5;padding:3px 4px;background:#10151d;" +
          "border:1px solid #161d28;border-radius:3px;";
        wfCallout.textContent =
          "Search Civitai & SeaArt ComfyUI workflows. Click Load to open in a new canvas tab.";

        const wfSearchRow = document.createElement("div");
        wfSearchRow.style.cssText = "display:flex;gap:4px;";
        const wfSearchInput = document.createElement("input");
        wfSearchInput.type = "text"; wfSearchInput.placeholder = "Search workflows\u2026";
        wfSearchInput.style.cssText =
          "flex:1;background:#0b0f15;border:1px solid #1c2431;border-radius:3px;" +
          "color:#c2cddb;font-size:10px;padding:3px 7px;outline:none;font-family:inherit;";
        wfSearchInput.onfocus = () => { wfSearchInput.style.borderColor="#28364a"; };
        wfSearchInput.onblur  = () => { wfSearchInput.style.borderColor="#1c2431"; };
        const wfSearchBtn = document.createElement("button");
        wfSearchBtn.textContent = "Search";
        wfSearchBtn.style.cssText =
          "background:#161d28;border:1px solid #202a38;border-radius:3px;" +
          "color:#7a8a9c;font-size:9px;padding:2px 8px;cursor:pointer;font-family:inherit;" +
          "white-space:nowrap;transition:color .1s,background .1s;";
        wfSearchBtn.onmouseenter = () => { wfSearchBtn.style.background="#202a38"; wfSearchBtn.style.color="#c2cddb"; };
        wfSearchBtn.onmouseleave = () => { wfSearchBtn.style.background="#161d28"; wfSearchBtn.style.color="#7a8a9c"; };
        wfSearchRow.appendChild(wfSearchInput);
        wfSearchRow.appendChild(wfSearchBtn);

        // Source chips
        const wfSourceRow = document.createElement("div");
        wfSourceRow.style.cssText = "display:flex;gap:3px;";
        const _mkWfChip = (label, val) => {
          const c = document.createElement("button");
          c.textContent = label; c._val = val; c._on = (val === "all");
          const _applyWfChip = () => {
            c.style.cssText =
              "font-size:10px;padding:2px 7px;border-radius:2px;cursor:pointer;" +
              "font-family:inherit;transition:color .1s,background .1s,border-color .1s;" +
              (c._on
                ? "background:#202a38;border:1px solid #4e5c6e;color:#c2cddb;"
                : "background:#12171f;border:1px solid #1c2431;color:#4e5c6e;");
          };
          _applyWfChip();
          c.onmouseenter = () => { if (!c._on) { c.style.background="#161d28"; c.style.color="#7a8a9c"; } };
          c.onmouseleave = () => { _applyWfChip(); };
          c.onclick = () => {
            wfSourceChips.forEach(x => { x._on = (x === c); _applyWfChip.call(x); });
            wfSourceChips.forEach(x => x.style.cssText = x.style.cssText); // force re-apply
            // Re-apply each chip's own style
            wfSourceChips.forEach(x => {
              x.style.cssText =
                "font-size:10px;padding:2px 7px;border-radius:2px;cursor:pointer;" +
                "font-family:inherit;transition:color .1s,background .1s,border-color .1s;" +
                (x._on
                  ? "background:#202a38;border:1px solid #4e5c6e;color:#c2cddb;"
                  : "background:#12171f;border:1px solid #1c2431;color:#4e5c6e;");
            });
            _wfState.query = ""; _wfState.page = 1;
            _wfState.loading = false; _wfState.exhausted = false; _wfState.results = [];
            wfList.innerHTML = ""; wfStatus.style.display = "none";
            const q = wfSearchInput.value.trim();
            if (q) { _wfState.query = q; _wfLoadMore(); }
          };
          return c;
        };
        const wfSourceChips = [
          _mkWfChip("All",     "all"),
          _mkWfChip("Civitai", "civitai"),
          _mkWfChip("SeaArt",  "seaart"),
        ];
        wfSourceChips.forEach(c => wfSourceRow.appendChild(c));

        wfFilterBar.appendChild(wfCallout);
        wfFilterBar.appendChild(wfSearchRow);
        wfFilterBar.appendChild(wfSourceRow);

        // ── Status / spinner ─────────────────────────────────────────────
        const wfStatus = document.createElement("div");
        wfStatus.style.cssText = "font-size:9px;color:#31415a;text-align:center;padding:8px 6px;display:none;";
        const wfSpinner = document.createElement("div");
        wfSpinner.style.cssText = "font-size:9px;color:#31415a;text-align:center;padding:8px 6px;display:none;";
        wfSpinner.textContent = "Searching\u2026";

        // ── List with sentinel ────────────────────────────────────────────
        const wfList = document.createElement("div");
        wfList.style.cssText =
          "flex:1;overflow-y:auto;padding:5px 6px;" +
          "display:flex;flex-direction:column;gap:6px;min-height:0;";
        const wfSentinel = document.createElement("div");
        wfSentinel.style.cssText = "height:1px;flex-shrink:0;";
        wfList.appendChild(wfSentinel);

        const _mkWfCard = (item) => {
          const card = document.createElement("div");
          card.style.cssText =
            "background:#141a24;border:1px solid #1c2431;border-radius:4px;" +
            "overflow:hidden;display:flex;flex-direction:column;flex-shrink:0;margin-bottom:6px;" +
            "transition:border-color .15s;cursor:pointer;";
          card.onmouseenter = () => card.style.borderColor="rgba(109,184,232,0.45)";
          card.onmouseleave = () => card.style.borderColor="#1c2431";
          card.onclick = (ev) => { if (ev.target.tagName === "BUTTON") return; _showWfDetail(item); };

          // Cover image
          if (item.coverUrl) {
            const imgWrap = document.createElement("div");
            imgWrap.style.cssText = "width:100%;height:110px;background:#0b0f15;overflow:hidden;flex-shrink:0;";
            const img = document.createElement("img");
            img.src = item.coverUrl;
            img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;";
            img.onerror = () => { imgWrap.style.display="none"; };
            imgWrap.appendChild(img);
            card.appendChild(imgWrap);
          }

          const info = document.createElement("div");
          info.style.cssText = "padding:5px 8px 6px;";

          // Source badge + title row
          const titleRow = document.createElement("div");
          titleRow.style.cssText = "display:flex;align-items:center;gap:4px;margin-bottom:3px;";
          const sourceBadge = document.createElement("span");
          sourceBadge.textContent = item.source === "civitai" ? "CIV" : "SEA";
          sourceBadge.style.cssText =
            "font-size:7px;font-weight:700;padding:1px 4px;border-radius:2px;flex-shrink:0;" +
            (item.source === "civitai"
              ? "background:rgba(100,160,255,0.15);color:#6490cc;border:1px solid rgba(100,160,255,0.2);"
              : "background:rgba(180,100,255,0.15);color:#b464cc;border:1px solid rgba(180,100,255,0.2);");
          const titleEl = document.createElement("div");
          titleEl.style.cssText =
            "font-size:9px;color:#8a9aac;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;";
          titleEl.textContent = item.title || "Untitled";
          titleEl.title = item.title || "";
          titleRow.appendChild(sourceBadge);
          titleRow.appendChild(titleEl);
          info.appendChild(titleRow);

          // Stats row
          const statsRow = document.createElement("div");
          statsRow.style.cssText = "display:flex;gap:6px;margin-bottom:5px;";
          const _mkStat = (label) => {
            const s = document.createElement("span");
            s.style.cssText = "font-size:8px;color:#31415a;";
            s.textContent = label;
            return s;
          };
          if (item.runCount)  statsRow.appendChild(_mkStat("\u25b6 " + item.runCount.toLocaleString()));
          if (item.downloads) statsRow.appendChild(_mkStat("\u2193 " + item.downloads.toLocaleString()));
          if (statsRow.children.length) info.appendChild(statsRow);

          // Description
          if (item.description) {
            const descEl = document.createElement("div");
            descEl.style.cssText =
              "font-size:8px;color:#31415a;line-height:1.4;margin-bottom:5px;" +
              "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;";
            descEl.textContent = item.description;
            info.appendChild(descEl);
          }

          // Load button
          const loadBtn = document.createElement("button");
          loadBtn.textContent = "Load Workflow";
          loadBtn.style.cssText =
            "width:100%;background:#1a2a22;border:1px solid rgba(109,184,232,0.3);border-radius:3px;" +
            "color:rgba(109,184,232,0.85);font-size:10px;font-weight:600;padding:4px 0;cursor:pointer;" +
            "font-family:inherit;transition:background .1s,border-color .1s;";
          loadBtn.onmouseenter = () => { loadBtn.style.background="#1e3328"; loadBtn.style.borderColor="rgba(109,184,232,0.5)"; };
          loadBtn.onmouseleave = () => { loadBtn.style.background="#1a2a22"; loadBtn.style.borderColor="rgba(109,184,232,0.3)"; };
          // Disable if there is genuinely nothing to fetch
          if (item.source === "civitai" && !item.downloadUrl && !item.versionId && !item.id) {
            loadBtn.disabled = true;
            loadBtn.style.opacity = "0.4";
            loadBtn.style.cursor = "default";
            loadBtn.title = "No workflow file available";
          }
          loadBtn.onclick = async (ev) => {
            ev.stopPropagation();
            loadBtn.textContent = "Fetching\u2026";
            loadBtn.disabled = true;
            try {
              const resp = await fetch("/epe/prompts/workflow-detail", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  id:          item.id,
                  source:      item.source,
                  downloadUrl: item.downloadUrl || "",
                  versionId:   item.versionId   || "",
                }),
              });
              const data = await resp.json();
              if (resp.status === 403) throw new Error("\u26a0 Login required on Civitai to download this workflow");
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              if (data.error) throw new Error(data.error);
              if (!data.workflow) throw new Error("No workflow returned");
              loadBtn.textContent = "Loading\u2026";
              await _epeOpenTemplate(data.workflow);
              loadBtn.textContent = "Loaded \u2713";
              setTimeout(() => { loadBtn.textContent = "Load Workflow"; loadBtn.disabled = false; }, 2000);
            } catch(e) {
              loadBtn.textContent = "Error: " + (e.message || "failed");
              loadBtn.style.color = "#c66";
              loadBtn.disabled = false;
              setTimeout(() => {
                loadBtn.textContent = "Load Workflow";
                loadBtn.style.color = "rgba(109,184,232,0.85)";
              }, 3000);
            }
          };
          info.appendChild(loadBtn);
          card.appendChild(info);
          return card;
        };

        // ── Fetch + load logic ────────────────────────────────────────────
        const _wfActiveSource = () => (wfSourceChips.find(c => c._on) || wfSourceChips[0])._val;

        const _wfFetchPage = async (page) => {
          const q = _wfState.query.trim();
          const resp = await fetch("/epe/prompts/search-workflows", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: q, page, source: _wfActiveSource() }),
          });
          if (!resp.ok) throw new Error(`Workflow search error ${resp.status}`);
          return resp.json();
        };

        const _wfLoadMore = async () => {
          if (_wfState.loading || _wfState.exhausted) return;
          _wfState.loading = true;
          wfSpinner.style.display = "block";
          try {
            const data = await _wfFetchPage(_wfState.page);
            if (!data || data.error || !data.items || data.items.length === 0) {
              _wfState.exhausted = true;
              if (_wfState.results.length === 0) {
                wfStatus.textContent = "No workflows found.";
                wfStatus.style.display = "block";
              } else {
                const endMsg = document.createElement("div");
                endMsg.style.cssText = "color:#24303f;font-size:9px;text-align:center;padding:8px;";
                endMsg.textContent = "\u2014 end of results \u2014";
                wfList.appendChild(endMsg);
              }
            } else {
              _wfState.results.push(...data.items);
              data.items.forEach(item => {
                const card = _mkWfCard(item);
                if (card) wfList.insertBefore(card, wfSentinel);
              });
              _wfState.page++;
              if (!data.metadata?.hasMore) _wfState.exhausted = true;
            }
          } catch(e) {
            wfStatus.textContent = "Search error: " + (e.message || e);
            wfStatus.style.display = "block";
          } finally {
            _wfState.loading = false;
            wfSpinner.style.display = "none";
          }
        };

        const _wfDoSearch = () => {
          const q = wfSearchInput.value.trim();
          _epeWfPersist.query = q;
          _wfState.query = q; _wfState.page = 1;
          _wfState.loading = false; _wfState.exhausted = false; _wfState.results = [];
          wfList.innerHTML = ""; wfList.appendChild(wfSentinel);
          wfStatus.style.display = "none";
          if (!q) { wfStatus.textContent = "Enter a search term above."; wfStatus.style.display = "block"; return; }
          _wfLoadMore();
        };
        wfSearchBtn.onclick  = _wfDoSearch;
        wfSearchInput.onkeydown = (ev) => { if (ev.key === "Enter") _wfDoSearch(); };

        // Restore last search query if EPE was re-created (e.g. after loading a workflow)
        if (_epeWfPersist.query) {
          wfSearchInput.value = _epeWfPersist.query;
          requestAnimationFrame(() => _wfDoSearch());
        }

        // Infinite scroll
        const _wfObserver = new IntersectionObserver(entries => {
          if (entries[0].isIntersecting) _wfLoadMore();
        }, { threshold: 0.1 });
        _wfObserver.observe(wfSentinel);

        wfList.appendChild(wfStatus);

        // ── Workflow detail panel ─────────────────────────────────────────
        const wfDetail = document.createElement("div");
        wfDetail.style.cssText = "display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0;";

        const _showWfDetail = (item) => {
          wfDetail.innerHTML = "";
          wfList.style.display = "none";
          wfSpinner.style.display = "none";
          wfFilterBar.style.display = "none";
          wfDetail.style.display = "flex";

          // Back header
          const dHdr = document.createElement("div");
          dHdr.style.cssText =
            "display:flex;align-items:center;gap:6px;padding:6px 8px;" +
            "border-bottom:1px solid #1c2431;background:#12171f;flex-shrink:0;";
          const backBtn = document.createElement("button");
          backBtn.textContent = "\u2190 Back to results";
          backBtn.style.cssText =
            "background:#19212d;border:1px solid #31415a;border-radius:3px;" +
            "color:#aab8c8;font-size:9px;padding:2px 7px;cursor:pointer;font-family:inherit;flex-shrink:0;";
          backBtn.onmouseenter = () => { backBtn.style.background="#202a38"; backBtn.style.borderColor="#4e5c6e"; backBtn.style.color="#dde6f0"; };
          backBtn.onmouseleave = () => { backBtn.style.background="#19212d"; backBtn.style.borderColor="#31415a"; backBtn.style.color="#aab8c8"; };
          backBtn.onclick = () => {
            wfDetail.style.display = "none";
            wfFilterBar.style.display = "";
            wfList.style.display = "";
          };
          const dTitle = document.createElement("span");
          dTitle.textContent = item.title || "Untitled";
          dTitle.style.cssText = "font-size:9px;color:#4e5c6e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;";
          dHdr.appendChild(backBtn);
          dHdr.appendChild(dTitle);
          wfDetail.appendChild(dHdr);

          // Scrollable body
          const dBody = document.createElement("div");
          dBody.style.cssText = "flex:1;min-height:0;overflow-y:auto;padding:7px 8px;display:flex;flex-direction:column;gap:6px;";

          // Cover image
          if (item.coverUrl) {
            const dImgWrap = document.createElement("div");
            dImgWrap.style.cssText = "width:100%;background:#0b0f15;border-radius:3px;overflow:hidden;flex-shrink:0;";
            const dImg = document.createElement("img");
            dImg.src = item.coverUrl;
            dImg.style.cssText = "width:100%;display:block;max-height:220px;object-fit:contain;";
            dImg.onerror = () => { dImgWrap.style.display="none"; };
            dImgWrap.appendChild(dImg);
            dBody.appendChild(dImgWrap);
          }

          // Source badge + title
          const dTitleRow = document.createElement("div");
          dTitleRow.style.cssText = "display:flex;align-items:center;gap:5px;";
          const dBadge = document.createElement("span");
          dBadge.textContent = item.source === "civitai" ? "CIVITAI" : "SEAART";
          dBadge.style.cssText =
            "font-size:7px;font-weight:700;padding:1px 5px;border-radius:2px;flex-shrink:0;" +
            (item.source === "civitai"
              ? "background:rgba(100,160,255,0.15);color:#6490cc;border:1px solid rgba(100,160,255,0.2);"
              : "background:rgba(180,100,255,0.15);color:#b464cc;border:1px solid rgba(180,100,255,0.2);");
          const dTitleEl = document.createElement("div");
          dTitleEl.textContent = item.title || "Untitled";
          dTitleEl.style.cssText = "font-size:10px;color:#aab8c8;font-weight:600;line-height:1.3;";
          dTitleRow.appendChild(dBadge);
          dTitleRow.appendChild(dTitleEl);
          dBody.appendChild(dTitleRow);

          // Stats
          if (item.runCount || item.downloads) {
            const dStats = document.createElement("div");
            dStats.style.cssText = "display:flex;gap:8px;";
            const _mkStat = (label) => {
              const s = document.createElement("span");
              s.style.cssText = "font-size:8px;color:#31415a;";
              s.textContent = label;
              return s;
            };
            if (item.runCount)  dStats.appendChild(_mkStat("\u25b6 " + item.runCount.toLocaleString() + " runs"));
            if (item.downloads) dStats.appendChild(_mkStat("\u2193 " + item.downloads.toLocaleString() + " downloads"));
            dBody.appendChild(dStats);
          }

          // Description — full, scrollable read-only textarea
          const dDescLabel = document.createElement("div");
          dDescLabel.style.cssText = "font-size:9px;color:#31415a;font-weight:600;text-transform:uppercase;letter-spacing:.4px;";
          dDescLabel.textContent = "Description";
          dBody.appendChild(dDescLabel);

          // Description textarea — plain scrollable read-only, no expand/collapse
          const wfTA = document.createElement("textarea");
          wfTA.style.cssText =
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #24303f;" +
            "border-radius:3px;color:#aab8c8;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:vertical;min-height:100px;max-height:400px;overflow-y:auto;font-family:inherit;" +
            "outline:none;cursor:default;padding-bottom:12px;margin-bottom:8px;";
          wfTA.value = item.description || "No description available.";
          wfTA.readOnly = true;
          dBody.appendChild(wfTA);

          // Node info section — fetched lazily from workflow-detail
          const dInfoSection = document.createElement("div");
          dInfoSection.style.cssText = "display:flex;flex-direction:column;gap:4px;";
          dBody.appendChild(dInfoSection);

          // Only fetch if there is something to fetch:
          // SeaArt always has an id; Civitai needs downloadUrl or versionId
          // SeaArt: always has id. Civitai: needs downloadUrl, versionId, or at minimum item.id (backend will resolve)
          const _canFetchWf = item.source === "seaart" || !!(item.downloadUrl || item.versionId || item.id);

          if (_canFetchWf) {
            const dInfoStatus = document.createElement("div");
            dInfoStatus.style.cssText = "font-size:9px;color:#31415a;font-style:italic;";
            dInfoStatus.textContent = "Fetching workflow info…";
            dInfoSection.appendChild(dInfoStatus);

            fetch("/epe/prompts/workflow-detail", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id:          item.id,
                source:      item.source,
                downloadUrl: item.downloadUrl || "",
                versionId:   item.versionId   || "",
              }),
            }).then(r => { return r.json().then(data => ({ status: r.status, data })); })
            .then(({ status, data }) => {
              dInfoSection.innerHTML = "";
              if (data.error) {
                // Even on error, populate description if the backend returned one
                if (data.description && wfTA.value === "No description available.") {
                  wfTA.value = data.description;
                }
                const errEl = document.createElement("div");
                errEl.style.cssText = "font-size:9px;font-style:italic;" + (status === 403 ? "color:#a07830;" : "color:#744;");
                errEl.textContent = status === 403
                  ? "⚠ Login required on Civitai to download this workflow."
                  : "Could not load workflow info.";
                dInfoSection.appendChild(errEl);
                // Disable load button on auth failure
                dLoadBtn.disabled = true;
                dLoadBtn.style.opacity = "0.4";
                dLoadBtn.style.cursor = "default";
                return;
              }
              // Node count chip
              if (data.nodeCount) {
                const nodeChip = document.createElement("span");
                nodeChip.textContent = "\u25a6 " + data.nodeCount + " nodes";
                nodeChip.style.cssText =
                  "font-size:8px;color:#4e5c6e;background:#10151d;border:1px solid #1c2431;" +
                  "border-radius:2px;padding:2px 6px;display:inline-block;width:fit-content;";
                dInfoSection.appendChild(nodeChip);
              }
              // Custom nodes list
              if (data.customNodes && data.customNodes.length > 0) {
                const cnLabel = document.createElement("div");
                cnLabel.style.cssText = "font-size:9px;color:#31415a;font-weight:600;text-transform:uppercase;letter-spacing:.4px;margin-top:2px;";
                cnLabel.textContent = "Custom Nodes";
                dInfoSection.appendChild(cnLabel);
                data.customNodes.forEach(cn => {
                  const cnEl = document.createElement("div");
                  cnEl.style.cssText = "font-size:9px;color:#4e5c6e;padding:2px 0;";
                  cnEl.textContent = "\u2022 " + cn.package;
                  dInfoSection.appendChild(cnEl);
                });
              } else if (data.nodeCount) {
                const cnEl = document.createElement("div");
                cnEl.style.cssText = "font-size:9px;color:#31415a;font-style:italic;";
                cnEl.textContent = "No custom nodes required.";
                dInfoSection.appendChild(cnEl);
              }
              // Update description textarea with the richer version from the detail fetch
              if (data.description && data.description.length > wfTA.value.length) {
                wfTA.value = data.description;
              }
              // Cache the workflow for the Load button
              dLoadBtn._cachedWorkflow = data.workflow || null;
            }).catch(() => {
              dInfoSection.innerHTML = "";
              const errEl = document.createElement("div");
              errEl.style.cssText = "font-size:9px;color:#744;font-style:italic;";
              errEl.textContent = "Could not load workflow info.";
              dInfoSection.appendChild(errEl);
            });
          } else {
            // No download source — show message and disable Load button
            const naEl = document.createElement("div");
            naEl.style.cssText = "font-size:9px;color:#31415a;font-style:italic;";
            naEl.textContent = "No workflow file available for this item.";
            dInfoSection.appendChild(naEl);
            setTimeout(() => {
              dLoadBtn.disabled = true;
              dLoadBtn.style.opacity = "0.4";
              dLoadBtn.style.cursor = "default";
              dLoadBtn.title = "No workflow file available";
            }, 0);
          }

          // Load Workflow button
          const dLoadBtn = document.createElement("button");
          dLoadBtn._cachedWorkflow = null;
          dLoadBtn.textContent = "Load Workflow";
          dLoadBtn.style.cssText =
            "width:100%;background:#1a2a22;border:1px solid rgba(109,184,232,0.3);border-radius:3px;" +
            "color:rgba(109,184,232,0.85);font-size:10px;font-weight:600;padding:5px 0;cursor:pointer;" +
            "font-family:inherit;transition:background .1s,border-color .1s;margin-top:4px;";
          dLoadBtn.onmouseenter = () => { dLoadBtn.style.background="#1e3328"; dLoadBtn.style.borderColor="rgba(109,184,232,0.5)"; };
          dLoadBtn.onmouseleave = () => { dLoadBtn.style.background="#1a2a22"; dLoadBtn.style.borderColor="rgba(109,184,232,0.3)"; };
          dLoadBtn.onclick = async (ev) => {
            ev.stopPropagation();
            if (dLoadBtn._cachedWorkflow) {
              dLoadBtn.textContent = "Loading\u2026";
              dLoadBtn.disabled = true;
              try {
                await _epeOpenTemplate(dLoadBtn._cachedWorkflow);
                dLoadBtn.textContent = "Loaded \u2713";
                setTimeout(() => { dLoadBtn.textContent = "Load Workflow"; dLoadBtn.disabled = false; }, 2000);
              } catch(e) {
                dLoadBtn.textContent = "Error: " + (e.message || "failed");
                dLoadBtn.style.color = "#c66";
                dLoadBtn.disabled = false;
                setTimeout(() => { dLoadBtn.textContent = "Load Workflow"; dLoadBtn.style.color = "rgba(109,184,232,0.85)"; }, 3000);
              }
            } else {
              // Workflow not yet cached — fetch now
              dLoadBtn.textContent = "Fetching\u2026";
              dLoadBtn.disabled = true;
              try {
                const resp = await fetch("/epe/prompts/workflow-detail", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    id:          item.id,
                    source:      item.source,
                    downloadUrl: item.downloadUrl || "",
                    versionId:   item.versionId   || "",
                  }),
                });
                const data = await resp.json();
                if (resp.status === 403) throw new Error("\u26a0 Login required on Civitai to download this workflow");
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                if (data.error) throw new Error(data.error);
                if (!data.workflow) throw new Error("No workflow returned");
                dLoadBtn.textContent = "Loading\u2026";
                await _epeOpenTemplate(data.workflow);
                dLoadBtn.textContent = "Loaded \u2713";
                setTimeout(() => { dLoadBtn.textContent = "Load Workflow"; dLoadBtn.disabled = false; }, 2000);
              } catch(e) {
                dLoadBtn.textContent = "Error: " + (e.message || "failed");
                dLoadBtn.style.color = "#c66";
                dLoadBtn.disabled = false;
                setTimeout(() => { dLoadBtn.textContent = "Load Workflow"; dLoadBtn.style.color = "rgba(109,184,232,0.85)"; }, 3000);
              }
            }
          };
          dBody.appendChild(dLoadBtn);
          wfDetail.appendChild(dBody);
        };

        rpWorkflowPanel.appendChild(wfFilterBar);
        rpWorkflowPanel.appendChild(wfSpinner);
        rpWorkflowPanel.appendChild(wfList);
        rpWorkflowPanel.appendChild(wfDetail);

        // ═════════════════════════════════════════════════════════════════

        const _mkBtn = (label,title,col) => {
          const b=document.createElement("button");
          b.textContent=label; b.title=title;
          b.style.cssText =
            "background:#161d28;border:1px solid #202a38;border-radius:3px;" +
            "color:"+(col||"#6a7a8d")+";font-size:11px;padding:2px 6px;cursor:pointer;font-family:inherit;" +
            "transition:color .1s,border-color .1s,background .1s;";
          b.onmouseenter=()=>{b.style.background="#202a38";b.style.color="#c2cddb";b.style.borderColor="#31415a";};
          b.onmouseleave=()=>{b.style.background="#161d28";b.style.color=(col||"#6a7a8d");b.style.borderColor="#202a38";};
          return b;
        };

        // ── Item actions ─────────────────────────────────────────────────
        const _useItem = (item) => {
          // loading a library entry while a review is active
          // implicitly abandons the result. Auto-discard with toast.
          if (_reviewMode) _autoDiscardReview("Library load — result discarded");
          textEl.value=item.text; updateTokenBadge(item.text); textEl.focus();
        };
        const _insertItem = (item) => {
          // same guard — inserting into a hidden/streaming editor
          // would be confusing. Discard first, then insert into restored text.
          if (_reviewMode) _autoDiscardReview("Snippet insert — result discarded");
          const s=textEl.selectionStart, e2=textEl.selectionEnd;
          const before=textEl.value.slice(0,s), after=textEl.value.slice(e2);
          const sep=(before.length>0 && !/,\s*$/.test(before)) ? ", " : "";
          textEl.value=before+sep+item.text+after;
          const pos=s+sep.length+item.text.length;
          textEl.setSelectionRange(pos,pos);
          updateTokenBadge(textEl.value); textEl.focus();
        };
        const _renameItem = (item,tabId) => {
          const n=window.prompt("Rename:",item.name);
          if(!n||!n.trim()) return;
          const arr=_libLoad(tabId);
          const i=arr.findIndex(x=>x.id===item.id);
          if(i>=0){arr[i].name=n.trim();_libSaveItems(tabId,arr);}
          _renderRpBody();
        };
        const _deleteItem = (item,tabId) => {
          if(!window.confirm('Delete "'+item.name+'"?')) return;
          _libSaveItems(tabId,_libLoad(tabId).filter(x=>x.id!==item.id));
          _renderRpBody();
        };

        // ── Build a card ─────────────────────────────────────────────────
        const _mkCard = (item,tabId) => {
          const card=document.createElement("div");
          card.style.cssText=_cardBase;

          // Name
          const nameEl=document.createElement("div");
          nameEl.style.cssText =
            "font-size:11px;font-weight:600;color:#9aaaba;margin-bottom:2px;" +
            "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
          nameEl.textContent=item.name; nameEl.title=item.name;

          // Date
          const dateEl=document.createElement("div");
          dateEl.style.cssText="font-size:9px;color:#24303f;margin-bottom:5px;";
          try{
            const d=new Date(item.date);
            dateEl.textContent=d.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"2-digit"});
          }catch(e){}

          // Textarea — collapsed (3 lines, readonly) by default, expands on click
          const LINE_H = 10 * 1.5; // font-size 10px * line-height 1.5
          const PADDING_V = 10;    // 5px top + 5px bottom
          const COLLAPSED_H = Math.round(LINE_H * 3 + PADDING_V) + "px"; // ~55px
          const EXPANDED_H  = "144px";

          const editTA=document.createElement("textarea");
          const _taCollapsedCSS=
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #24303f;" +
            "border-radius:3px;color:#aab8c8;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:none;height:"+COLLAPSED_H+";overflow:hidden;font-family:inherit;outline:none;" +
            "cursor:pointer;";
          const _taExpandedCSS=
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #4e5c6e;" +
            "border-radius:3px;color:#d4dfea;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:vertical;min-height:"+EXPANDED_H+";max-height:300px;overflow-y:auto;" +
            "font-family:inherit;outline:none;cursor:text;padding-bottom:12px;margin-bottom:8px;";
          editTA.style.cssText=_taCollapsedCSS;
          editTA.value=item.text;
          editTA.readOnly=true;

          const charSpan=document.createElement("span");
          charSpan.style.cssText="font-size:9px;color:#4e5c6e;flex-shrink:0;";
          const _upCardChar=()=>{ charSpan.textContent=countTokens(editTA.value)+" tokens"; };
          editTA.oninput=_upCardChar; _upCardChar();

          // Track open card across all cards in this render
          if(!rpList._openTA) rpList._openTA=null;

          const _collapseTA=()=>{
            editTA.style.cssText=_taCollapsedCSS;
            editTA.readOnly=true;
            if(rpList._openTA===editTA) rpList._openTA=null;
            try { document.removeEventListener("mousedown",_outsideHandler,true); } catch(_e){}
          };
          const _expandTA=()=>{
            // Close any other open card first
            if(rpList._openTA && rpList._openTA!==editTA){
              rpList._openTA.style.cssText=_taCollapsedCSS;
              rpList._openTA.readOnly=true;
            }
            editTA.style.cssText=_taExpandedCSS;
            editTA.readOnly=false;
            editTA.focus();
            rpList._openTA=editTA;
            // Listen for outside clicks only while expanded; _collapseTA removes it.
            document.addEventListener("mousedown",_outsideHandler,true);
          };

          editTA.onclick=(ev)=>{
            ev.stopPropagation();
            if(editTA.readOnly) _expandTA();
          };

          // Click outside anywhere collapses
          const _outsideHandler=(ev)=>{
            if(!card.contains(ev.target)) _collapseTA();
          };

          // Save row: Save, Save as New, Snippet/Fav, Enhance
          const saveRow=document.createElement("div");
          saveRow.style.cssText="display:flex;gap:4px;margin-top:5px;flex-wrap:wrap;";

          const saveBtn=_mkBtn("Save","Save edits to this entry","rgba(109,184,232,0.8)");
          saveBtn.onclick=(ev)=>{
            ev.stopPropagation();
            const newText=editTA.value.trim();
            if(!newText) return;
            const arr=_libLoad(tabId);
            const idx=arr.findIndex(x=>x.id===item.id);
            if(idx>=0){arr[idx].text=newText; item.text=newText; _libSaveItems(tabId,arr);}
            saveBtn.textContent="Saved!"; setTimeout(()=>saveBtn.textContent="Save",1200);
          };

          const saveNewBtn=_mkBtn("Save as New","Save edited text as a new entry","rgba(140,200,240,0.7)");
          saveNewBtn.onclick=(ev)=>{
            ev.stopPropagation();
            const newText=editTA.value.trim();
            if(!newText) return;
            _libAddEntry(tabId,newText);
          };

          const toSnipBtn=_mkBtn(tabId==="snippets"?"Save as Fav":"Snippet",
            tabId==="snippets"?"Save to Favorites":"Save to Snippets");
          toSnipBtn.onclick=(ev)=>{
            ev.stopPropagation();
            const dest=tabId==="snippets"?"favorites":"snippets";
            _libAddEntry(dest,editTA.value.trim()||item.text);
          };

          const toEnhBtn=_mkBtn("Enhance","Load into editor and run Enhance Prompt","rgba(100,160,255,0.7)");
          toEnhBtn.onclick=(ev)=>{
            ev.stopPropagation();
            textEl.value=editTA.value.trim()||item.text;
            updateTokenBadge(textEl.value);
            runAiAction("expand");
          };

          saveRow.appendChild(saveBtn);
          saveRow.appendChild(saveNewBtn);
          saveRow.appendChild(toSnipBtn);
          saveRow.appendChild(toEnhBtn);

          // Bottom action row: Variations | Use  Rename  ✕ — always visible
          const acts=document.createElement("div");
          acts.style.cssText="display:flex;align-items:center;margin-top:5px;gap:4px;flex-wrap:wrap;";

          if(tabId==="favorites"){
            const favVarBtn=_mkBtn("Variations","Load into editor and run Variations","rgba(140,200,240,0.7)");
            favVarBtn.onclick=(ev)=>{
              ev.stopPropagation();
              textEl.value=editTA.value.trim()||item.text; updateTokenBadge(textEl.value);
              runAiAction("variations");
            };
            const favUseBtn=_mkBtn("Use","Replace editor text with this prompt","rgba(109,184,232,0.7)");
            favUseBtn.onclick=(ev)=>{ev.stopPropagation();_useItem(item);};
            const favRenBtn=_mkBtn("Rename","Rename this entry");
            favRenBtn.onclick=(ev)=>{ev.stopPropagation();_renameItem(item,"favorites");};
            const favDelBtn=_mkBtn("\u2715","Delete this entry","#664");
            favDelBtn.onclick=(ev)=>{ev.stopPropagation();_deleteItem(item,"favorites");};
            acts.appendChild(favVarBtn); acts.appendChild(favUseBtn); acts.appendChild(favRenBtn); acts.appendChild(favDelBtn); acts.appendChild(charSpan);
          } else {
            const snpVarBtn=_mkBtn("Variations","Load into editor and run Variations","rgba(140,200,240,0.7)");
            snpVarBtn.onclick=(ev)=>{
              ev.stopPropagation();
              textEl.value=editTA.value.trim()||item.text; updateTokenBadge(textEl.value);
              runAiAction("variations");
            };
            const snpInsBtn=_mkBtn("Insert","Insert at cursor position","rgba(109,184,232,0.7)");
            snpInsBtn.onclick=(ev)=>{ev.stopPropagation();_insertItem(item);};
            const snpRenBtn=_mkBtn("Rename","Rename this snippet");
            snpRenBtn.onclick=(ev)=>{ev.stopPropagation();_renameItem(item,"snippets");};
            const snpDelBtn=_mkBtn("\u2715","Delete this snippet","#664");
            snpDelBtn.onclick=(ev)=>{ev.stopPropagation();_deleteItem(item,"snippets");};
            acts.appendChild(snpVarBtn); acts.appendChild(snpInsBtn); acts.appendChild(snpRenBtn); acts.appendChild(snpDelBtn); acts.appendChild(charSpan);
          }

          card.onmouseenter=()=>_cardIn(card);
          card.onmouseleave=()=>_cardOut(card);
          card.onclick=(ev)=>ev.stopPropagation();

          card.appendChild(nameEl);
          card.appendChild(dateEl);
          card.appendChild(_mkFontSizerWrap(editTA, 10));
          card.appendChild(saveRow);
          card.appendChild(acts);
          return card;
        };

        // ── Empty state ──────────────────────────────────────────────────
        const _mkEmpty = (tabId) => {
          const el=document.createElement("div");
          el.style.cssText="color:#24303f;font-size:10px;text-align:center;padding:24px 12px;line-height:1.9;";
          el.innerHTML = tabId==="favorites"
            ? "No saved prompts yet.<br>" +
              '<span style="font-size:9px;color:#202a38;">Use <em>Save As</em> in the toolbar.</span>'
            : "No snippets yet.<br>" +
              '<span style="font-size:9px;color:#202a38;">Use <em>Save Snippet</em> in the toolbar.</span>';
          return el;
        };

        // ── Tab switching ────────────────────────────────────────────────
        // Style-tuning + panel state. Declared early: both _epePersistUi and
        // _epePersistStyle read these, and a `let` read before its declaration
        // throws (temporal dead zone) — which silently broke persistence.
        let _styleActive   = "default";
        let _styleOverride = false;
        let _styleOpen     = true;
        let _rpActive      = "favorites";

        // Persist lightweight UI state (panel tab, style section open/closed).
        const _epePersistUi = () => {
          if (!_epeOwnerNode) return;
          if (!_epeOwnerNode.properties) _epeOwnerNode.properties = {};
          try {
            _epeOwnerNode.properties.epe_ui = {
              tab: _rpActive,
              styleOpen: _styleOpen,
            };
          } catch (_e) {}
        };

        const _setRpTab = (id) => {
          // switching library tabs while a review is active
          // implicitly abandons the result. Auto-discard with a toast that
          // surfaces the Recall option if the slot is non-empty.
          if (_reviewMode) {
            _autoDiscardReview("Tab switch — result discarded");
          }
          _rpActive=id;
          _epePersistUi();
          Object.values(rpTabEls).forEach(t => {
            t._active=(t._id===id);
            t.style.color       = t._active ? "#c2e2f8" : "#8ba5be";
            t.style.background  = t._active ? "rgba(109,184,232,0.22)" : "rgba(109,184,232,0.05)";
            t.style.borderColor = t._active ? "rgba(140,200,240,0.65)" : "rgba(109,184,232,0.15)";
            t.style.fontWeight  = t._active ? "500" : "400";
            t.style.position    = "relative";
            t.style.zIndex      = t._active ? "2" : "1";
          });
          // Media bar: show on tabs with image/video support; hide on others
          const showMediaToggle = _MEDIA_TABS.has(id);
          const showWfBtn       = _WORKFLOW_TABS.has(id);
          rpMediaBar.style.display = (showMediaToggle || showWfBtn) ? "flex" : "none";
          rpMediaImgBtn.style.display = showMediaToggle ? "" : "none";
          rpMediaVidBtn.style.display = showMediaToggle ? "" : "none";
          rpGetWfBtn.style.display    = showWfBtn ? "" : "none";
          // When switching away from a media tab reset Get Workflow button state
          if (!showWfBtn) _setGetWfBtn(false, null);
          _renderRpBody();
        };
        Object.values(rpTabEls).forEach(t => { t.onclick=()=>_setRpTab(t._id); });

        // ── Render body ──────────────────────────────────────────────────
        const _renderRpBody = () => {
          rpBody.innerHTML="";
          if(_rpActive==="civitai"){   rpBody.appendChild(rpCivPanel);      return; }
          if(_rpActive==="genur"){     rpBody.appendChild(rpGenurPanel);    return; }
          if(_rpActive==="seaart"){    rpBody.appendChild(rpSeaartPanel);   return; }
          if(_rpActive==="workflows"){ rpBody.appendChild(rpWorkflowPanel); return; }
          rpBody.appendChild(rpSearchWrap);
          rpBody.appendChild(rpList);
          rpList.innerHTML="";
          const q=rpSearch.value.trim().toLowerCase();
          const all=_libLoad(_rpActive);
          const filtered = q
            ? all.filter(x=>x.name.toLowerCase().includes(q)||x.text.toLowerCase().includes(q))
            : all;
          if(filtered.length===0){
            rpList.appendChild(_mkEmpty(_rpActive));
          } else {
            filtered.slice().reverse().forEach(item=>rpList.appendChild(_mkCard(item,_rpActive)));
          }
        };

        // ── Add entry to library ─────────────────────────────────────────
        const _libAddEntry = (tabId,text) => {
          if(!text.trim()){ alert("Nothing to save \u2014 prompt is empty."); return; }
          const def=text.slice(0,48).replace(/\s+/g," ").trim()+(text.length>48?"\u2026":"");
          const name=window.prompt(tabId==="snippets"?"Save snippet as:":"Save prompt as:",def);
          if(!name||!name.trim()) return;
          const items=_libLoad(tabId);
          items.push({id:_libNewId(),name:name.trim(),text:text.trim(),date:new Date().toISOString()});
          _libSaveItems(tabId,items);
          _setRpTab(tabId);
        };

        // ── Assemble right panel ─────────────────────────────────────────
        rightPanel.appendChild(rpTabs);
        rightPanel.appendChild(rpMediaBar);
        rightPanel.appendChild(rpBody);
        _setRpTab("favorites");

        // Wire Save Snippet toolbar button (declared above in toolbar)
        saveSnippetBtn.onclick = () => {
          const sel = textEl.value.slice(textEl.selectionStart, textEl.selectionEnd).trim();
          _libAddEntry("snippets", sel || textEl.value);
        };

        // ── Main body wrapper (left workspace + right panel) ──
        const bodyWrap = document.createElement("div");
        bodyWrap.style.cssText = `display:flex; flex:1; min-height:0; overflow:hidden;`;

        const leftPane = document.createElement("div");
        leftPane.style.cssText = `display:flex; flex-direction:column; flex:1; min-width:0; overflow-y:auto; overflow-x:hidden;`;
        leftPane.appendChild(editorWrap);
        leftPane.appendChild(aiSettingsPanel);
        leftPane.appendChild(btnRow);

        bodyWrap.appendChild(leftPane);
        bodyWrap.appendChild(rightPanel);

        // ─────────────────────────────────────────────────────────────────
        // Style strip — UI scaffolding only
        // ─────────────────────────────────────────────────────────────────
        // 8 style presets + 6 texture sliders + global Reset. Self-contained
        // local state; not persisted, not yet wired into runAiAction.
        // Wiring into AI generation comes in later phases.

        // Inject slider stylesheet once per page. ComfyUI's CSS resets the
        // native slider appearance, so `accent-color` alone doesn't draw a
        // visible thumb — we need explicit ::-webkit-slider-thumb /
        // ::-moz-range-thumb rules, which can't be done inline. The `.edited`
        // class darkens the thumb + track so off-middle sliders read at a
        // glance, matching the label and per-slider reset-icon treatment.
        if (!document.getElementById("epe-style-slider-css")) {
          const _epeSliderCss = document.createElement("style");
          _epeSliderCss.id = "epe-style-slider-css";
          _epeSliderCss.textContent = `
            /* Flag Words click-to-locate: make the textarea selection clearly
               visible against the dark theme (browser default is near-invisible). */
            textarea.epe-prompt::selection {
              background: rgba(226,168,75,0.45);
              color: #fff;
            }
            textarea.epe-prompt::-moz-selection {
              background: rgba(226,168,75,0.45);
              color: #fff;
            }
            input.epe-style-slider {
              flex: 1 !important; min-width: 24px !important;
              -webkit-appearance: none !important;
              -moz-appearance: none !important;
              appearance: none !important;
              background: transparent !important;
              height: 14px !important;
              cursor: pointer !important;
              margin: 0 !important;
              padding: 0 !important;
              outline: none !important;
              border: none !important;
              --fill: 50%;
            }
            input.epe-style-slider { -webkit-appearance: none !important; appearance: none !important; }
            input.epe-style-slider::-webkit-slider-runnable-track {
              height: 2px !important; border-radius: 1px !important; border: none !important;
              background: linear-gradient(to right, #6db8e8 var(--fill), rgba(109,184,232,0.15) var(--fill)) !important;
            }
            input.epe-style-slider::-moz-range-track {
              height: 2px !important; border-radius: 1px !important; border: none !important;
              background: rgba(109,184,232,0.15) !important;
            }
            input.epe-style-slider::-moz-range-progress {
              height: 2px !important; border-radius: 1px !important; background: #6db8e8 !important;
            }
            input.epe-style-slider::-webkit-slider-thumb {
              -webkit-appearance: none !important;
              appearance: none !important;
              width: 11px !important; height: 11px !important;
              border-radius: 50% !important;
              background: #0f141c !important;
              margin-top: -4.5px !important;
              cursor: pointer !important;
              border: 1.5px solid #8cc8f0 !important;
              transition: border-color 0.12s, transform 0.08s !important;
            }
            input.epe-style-slider::-webkit-slider-thumb:hover {
              border-color: #c2e2f8 !important; transform: scale(1.12) !important;
            }
            input.epe-style-slider::-moz-range-thumb {
              width: 11px !important; height: 11px !important;
              border-radius: 50% !important;
              background: #0f141c !important;
              cursor: pointer !important;
              border: 1.5px solid #8cc8f0 !important;
              transition: border-color 0.12s, transform 0.08s !important;
            }
            input.epe-style-slider::-moz-range-thumb:hover {
              border-color: #c2e2f8 !important; transform: scale(1.12) !important;
            }
            input.epe-style-slider.edited::-webkit-slider-thumb { border-color: #c2e2f8 !important; }
            input.epe-style-slider.edited::-moz-range-thumb     { border-color: #c2e2f8 !important; }
            input.epe-style-slider:focus { outline: none !important; }
          `;
          document.head.appendChild(_epeSliderCss);
        }

        const STYLE_OPTIONS = [
          { id: "default",        label: "Default" },
          { id: "midjourney",     label: "Midjourney" },
          { id: "dalle",          label: "DALL-E" },
          { id: "gemini",         label: "Gemini" },
          { id: "meta",           label: "Meta" },
          { id: "photorealistic", label: "Photorealistic" },
          { id: "cinematic",      label: "Cinematic" },
          { id: "anime",          label: "Anime" },
          { id: "conceptArt",     label: "Concept art" },
        ];

        const SLIDER_DEFS = [
          { id: "creativity",  label: "Creativity",       tooltip: "How wild the LLM's word choices are.\nLow: predictable, safe vocabulary.\nHigh: surprising, unexpected words." },
          { id: "length",      label: "Length / Density", tooltip: "How long and detailed the output prompt is.\nLow: terse, ~50\u2013100 words.\nHigh: expansive, ~280\u2013400 words." },
          { id: "focus",       label: "Focus",            tooltip: "How tightly the LLM sticks to your subject.\nLow: wanders into related ideas.\nHigh: stays strictly on subject, no tangents." },
          { id: "variability", label: "Variability",      tooltip: "How much the output changes between runs.\nLow (0\u201310): same result every time (fixed seed).\nHigh: fresh vocabulary on each call." },
          { id: "boldness",    label: "Boldness",         tooltip: "How dramatic the LLM's stylistic choices are.\nLow: gentle refinements, preserves tone.\nHigh: bold leaps, dramatic stylistic shifts." },
          { id: "subjectGrip", label: "Subject grip",     tooltip: "How literally the LLM preserves named subjects.\nLow: may metaphorize or transform subjects.\nHigh: keep all named entities exactly as written." },
        ];

        // ── style addendums + slider→Ollama mapping ───────
        // Distinctive markers around the prepended block let us self-heal
        // if the user's customised system prompt has a stale block embedded
        // or an orphaned start/end marker.
        const STYLE_ADDENDUM_START = "=====VISUAL STYLE TARGET=====";
        const STYLE_ADDENDUM_END   = "=====END STYLE TARGET=====";

        // Per-style addendum text. Prepended to the base system prompt to
        // bias the LLM toward each service's visual signature when generating
        // image prompts. Default = no addendum.
        const STYLE_ADDENDUMS = {
          midjourney:
"STYLE TARGET: Midjourney's signature look — painterly, atmospheric, dramatically lit, deeply saturated, more beautiful than reality. Favor fine-art and atmosphere vocabulary over clinical camera specs. Example opening: \"A luminous digital painting of <subject>, volumetric golden light breaking through mist...\"",

          dalle:
"STYLE TARGET: DALL-E 3's signature look — clean, friendly, illustration-leaning, softly lit, vibrant but harmonious, uncluttered staging. Example opening: \"A polished storybook illustration of <subject>, soft directional light and warm harmonious color...\"",

          gemini:
"STYLE TARGET: Imagen's signature look — clean photographic realism, natural plausible light, neutral color, sharp focus, literal framing. Example opening: \"A sharp documentary photograph of <subject> in natural daylight...\"",

          meta:
"STYLE TARGET: Meta Imagine's signature look — cinematic but grounded, warm golden-hour light, gentle bokeh, natural texture, softly dreamy. Example opening: \"A warm golden-hour photograph of <subject>, soft directional light and gentle background blur...\"",

          photorealistic:
"STYLE TARGET: strict photographic realism — a real photograph on real equipment. Lead with lens, aperture, film stock or sensor character, and lighting setup. Include skin texture, fabric grain, surface imperfections, real-world physics. Example opening: \"An 85mm f/1.8 portrait of <subject> on Kodak Portra 400, Rembrandt key light...\"",

          cinematic:
"STYLE TARGET: cinematic film grammar — anamorphic lens character, graded palettes, motivated lighting, intentional framing, film grain. Reference cinematographers where evocative. Example opening: \"An anamorphic film still of <subject>, teal-orange grade, motivated practicals in the background...\"",

          anime:
"STYLE TARGET: anime and stylized Japanese illustration — cel-shaded surfaces, clean line work, expressive character design. Reference studios where apt (Ghibli nature, KyoAni character detail, Madhouse action). Example opening: \"A cel-shaded anime key visual of <subject>, clean line art and gradient dusk sky...\"",

          conceptArt:
"STYLE TARGET: production concept art — loose exploratory painting, strong silhouette, mood-board energy, unfinished edges. Reference concept artists where helpful (Syd Mead tech, Frazetta power). Example opening: \"A loose digital concept painting of <subject>, strong silhouette against a glowing sky, visible brushwork...\"",
        };

        // Per-style recommended slider defaults (0-100). Picking a style snaps
        // all 6 sliders to these values, then user can tweak from there.
        const STYLE_SLIDER_DEFAULTS = {
          default:        { creativity: 50, length: 50, focus: 50, variability: 50, boldness: 50, subjectGrip: 50 },
          midjourney:     { creativity: 70, length: 70, focus: 40, variability: 60, boldness: 70, subjectGrip: 40 },
          dalle:          { creativity: 55, length: 55, focus: 60, variability: 50, boldness: 45, subjectGrip: 60 },
          gemini:         { creativity: 40, length: 50, focus: 70, variability: 45, boldness: 30, subjectGrip: 75 },
          meta:           { creativity: 50, length: 60, focus: 60, variability: 50, boldness: 45, subjectGrip: 60 },
          photorealistic: { creativity: 35, length: 65, focus: 75, variability: 40, boldness: 25, subjectGrip: 80 },
          cinematic:      { creativity: 65, length: 70, focus: 50, variability: 55, boldness: 65, subjectGrip: 55 },
          anime:          { creativity: 65, length: 55, focus: 60, variability: 60, boldness: 60, subjectGrip: 65 },
          conceptArt:     { creativity: 80, length: 70, focus: 40, variability: 70, boldness: 80, subjectGrip: 30 },
        };

        // Strip any existing style addendum block from a system prompt. Handles
        // four cases: both markers present, only start, only end (header
        // accidentally removed by user), or neither.
        const _stripStyleAddendum = (text) => {
          if (!text) return text;
          const startIdx = text.indexOf(STYLE_ADDENDUM_START);
          const endIdx   = text.indexOf(STYLE_ADDENDUM_END);
          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            return (text.substring(0, startIdx) + text.substring(endIdx + STYLE_ADDENDUM_END.length)).trim();
          } else if (startIdx !== -1) {
            return text.substring(0, startIdx).trim();
          } else if (endIdx !== -1) {
            return text.substring(endIdx + STYLE_ADDENDUM_END.length).trim();
          }
          return text;
        };

        // Build slider-driven modifier text. Only sliders away from their
        // neutral middle generate text; mid-range sliders contribute nothing.
        const _composeSliderModifiers = () => {
          const mods = [];
          const len = _sliderValues.length;
          if      (len <= 25) mods.push("WORD COUNT OVERRIDE — this replaces any word-count target above: keep the output terse, roughly 50\u2013100 words.");
          else if (len <= 49) mods.push("WORD COUNT OVERRIDE — this replaces any word-count target above: around 100\u2013160 words.");
          else if (len >= 76) mods.push("WORD COUNT OVERRIDE — this replaces any word-count target above: richly detailed, 260\u2013300 words.");
          else if (len >= 51) mods.push("WORD COUNT OVERRIDE — this replaces any word-count target above: expansive, around 200\u2013260 words.");

          const foc = _sliderValues.focus;
          if      (foc <= 30) mods.push("Feel free to explore tangential ideas related to the subject.");
          else if (foc >= 70) mods.push("Stay tightly focused on the subject as given. Do not wander into related ideas.");

          const bld = _sliderValues.boldness;
          if      (bld <= 25) mods.push("Make gentle, refined changes. Preserve the existing tone.");
          else if (bld >= 75) mods.push("Make bold, dramatic stylistic choices where they enhance the result.");

          const sg = _sliderValues.subjectGrip;
          if      (sg <= 30) mods.push("SUBJECT PRESERVATION OVERRIDE — this relaxes the hard rule above: preservation is loose; you may metaphorize or transform named subjects if the result is more evocative.");
          else if (sg >= 70) mods.push("Subject preservation is strict. Keep all named subjects, locations, and entities exactly as the user wrote them. No substitutions.");

          return mods.join("\n");
        };

        // Compose final system prompt:
        //   1. Strip any stale addendum block from the base prompt
        //   2. Prepend the active style's addendum (skipped for Default)
        //   3. Append slider-driven modifier text (skipped if none apply)
        const _composeSystemPromptForStyle = (basePrompt) => {
          const cleaned = _stripStyleAddendum(basePrompt) || "";
          let result = cleaned;
          if (_styleActive !== "default" && STYLE_ADDENDUMS[_styleActive]) {
            const block = STYLE_ADDENDUM_START + "\n" + STYLE_ADDENDUMS[_styleActive] + "\n" + STYLE_ADDENDUM_END;
            result = block + "\n\n" + cleaned;
          }
          if (_styleOverride && _styleActive !== "default") {
            result = result + "\n\nAESTHETIC OVERRIDE — the STYLE TARGET above REPLACES the source's aesthetic. This relaxes SUBJECT PRESERVATION for aesthetic language only: discard the source's rendering style, medium, lighting, and global color grade, and re-render the scene fully in the style target. PRESERVE unchanged: subjects, counts, poses, actions, scene layout, and named objects with their identity colors — a red bicycle stays red, expressed in the target style's idiom.";
          }
          const mods = _composeSliderModifiers();
          if (mods) result = result + "\n\n" + mods;
          return result;
        };

        // Map current slider values to an Ollama options object. Ranges chosen
        // to span "noticeably more conservative" to "noticeably more bold" at
        // the extremes without producing unhinged output. Phase 3 mapping:
        //   creativity → temperature (0.40–1.10), top_p (0.85–0.98)
        //   length     → num_predict (200–800)
        //   focus      → top_p min cap (0.95–0.75), top_k (60–20)
        //   variability→ seed (fixed 42 at <=10, else random), presence_penalty
        //   boldness   → min_p (0.15–0.02)
        //   subjectGrip→ system prompt modifier only (no sampling param)
        const _composeOllamaOpts = () => {
          const cr = _sliderValues.creativity;
          const ln = _sliderValues.length;
          const fc = _sliderValues.focus;
          const vb = _sliderValues.variability;
          const bd = _sliderValues.boldness;

          const temperature = +(0.40 + (cr / 100) * 0.70).toFixed(3);
          const creativityTopP = 0.85 + (cr / 100) * 0.13;
          const focusTopP = 0.95 - (fc / 100) * 0.20;
          const top_p = +Math.min(creativityTopP, focusTopP).toFixed(3);
          const top_k = Math.round(60 - (fc / 100) * 40);
          const num_predict = Math.round(200 + (ln / 100) * 600);
          const seed = (vb <= 10) ? 42 : -1;
          const presence_penalty = vb > 50 ? +(((vb - 50) / 100) * 0.5).toFixed(3) : 0;
          const min_p = +(0.15 - (bd / 100) * 0.13).toFixed(3);

          return { temperature, top_p, top_k, num_predict, min_p, seed, presence_penalty };
        };
        // ─────────────────────────────────────────────────────────────────

        // Phase 1 state — local only, not persisted.
        const _sliderValues = {};
        SLIDER_DEFS.forEach(d => { _sliderValues[d.id] = 50; });

        // Persist style tuning (style, override, sliders) into node.properties so
        // it survives refresh/restart like the prompt does.
        const _epePersistStyle = () => {
          if (!_epeOwnerNode) return;
          if (!_epeOwnerNode.properties) _epeOwnerNode.properties = {};
          try {
            _epeOwnerNode.properties.epe_style = {
              style: _styleActive,
              override: _styleOverride,
              sliders: { ..._sliderValues },
            };
          } catch (_e) {}
        };

        // Keep the vision backend informed of the active style + safe sliders
        // (length, focus). Creativity/boldness/subject-grip are intentionally
        // NOT sent — they invite hallucination in faithful captioning.
        const _syncVisionStyleBridge = () => {
          try {
            _epeOllamaVision._styleBridge = {
              style: _styleActive,
              lengthSlider: _sliderValues.length,
              focusSlider: _sliderValues.focus,
              styleOverride: (typeof _styleOverride !== "undefined") ? _styleOverride : false,
            };
          } catch (_e) {}
        };

        // Strip layout: dropdown | reset button | 2×3 slider grid.
        // The dashed border-bottom separates the strip (config) from
        // the toolbar (run) inside the aiZone.
        const styleStrip = document.createElement("div");
        styleStrip.style.cssText = `
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 10px 12px;
        `;
        const styleCtrlRow = document.createElement("div");
        styleCtrlRow.style.cssText = "display:flex;gap:10px;align-items:stretch;";

        // ── Style dropdown ──
        const styleDdWrap = document.createElement("div");
        styleDdWrap.style.cssText = `
          position: relative;
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 3px;
          padding: 8px 12px;
          min-width: 130px;
          background: #1c2431;
          border: 1px solid #31415a;
          border-radius: 4px;
          cursor: pointer;
          user-select: none;
          transition: border-color 0.12s;
        `;
        styleDdWrap.onmouseenter = () => { styleDdWrap.style.borderColor = "#5b6b7e"; };
        styleDdWrap.onmouseleave = () => { styleDdWrap.style.borderColor = "#31415a"; };

        const styleDdLabel = document.createElement("span");
        styleDdLabel.textContent = "Style";
        styleDdLabel.style.cssText = "font-size: 10px; color: #7a8a9c;";

        const styleDdValueRow = document.createElement("span");
        styleDdValueRow.style.cssText = "display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500;";

        const styleDdValueText = document.createElement("span");
        styleDdValueText.textContent = "Default";

        const styleDdChevron = document.createElement("span");
        styleDdChevron.style.cssText = "display: inline-block; width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid currentColor;";

        styleDdValueRow.appendChild(styleDdValueText);
        styleDdValueRow.appendChild(styleDdChevron);
        styleDdWrap.appendChild(styleDdLabel);
        styleDdWrap.appendChild(styleDdValueRow);

        const _updateStyleVisual = () => {
          const opt = STYLE_OPTIONS.find(o => o.id === _styleActive);
          styleDdValueText.textContent = opt ? opt.label : "Default";
          if (_styleActive === "default") {
            styleDdValueRow.style.color = "#7a8a9c";
            styleDdValueRow.style.fontStyle = "italic";
          } else {
            styleDdValueRow.style.color = "#d4dfea";
            styleDdValueRow.style.fontStyle = "normal";
          }
        };
        _updateStyleVisual();

        // Menu — mounted to document.body with position:fixed so it escapes
        // any overflow:hidden / clip-path ancestor.
        let _styleMenu = null;
        const _closeStyleMenu = () => {
          if (_styleMenu && _styleMenu.parentNode) _styleMenu.parentNode.removeChild(_styleMenu);
          _styleMenu = null;
          document.removeEventListener("mousedown", _onStyleDocClick, true);
        };
        const _onStyleDocClick = (e) => {
          if (_styleMenu && _styleMenu.contains(e.target)) return;
          if (styleDdWrap.contains(e.target)) return;
          _closeStyleMenu();
        };
        const _openStyleMenu = () => {
          _styleMenu = document.createElement("div");
          _styleMenu.style.cssText = `
            position: fixed;
            background: #1c2431;
            border: 1px solid #31415a;
            border-radius: 4px;
            padding: 3px;
            min-width: 180px;
            z-index: 999999;
            box-shadow: 0 2px 8px rgba(0,0,0,0.6);
          `;
          STYLE_OPTIONS.forEach(opt => {
            const item = document.createElement("div");
            item.textContent = opt.label;
            const isActive = (opt.id === _styleActive);
            item.style.cssText = `padding: 5px 9px; font-size: 12px; color: ${isActive ? "#d4dfea" : "#9aaaba"}; cursor: pointer; border-radius: 3px;`;
            if (isActive) item.style.background = "#353535";
            item.onmouseenter = () => { if (!isActive) item.style.background = "#24303f"; };
            item.onmouseleave = () => { if (!isActive) item.style.background = "transparent"; };
            item.onclick = () => {
              _styleActive = opt.id;
              _updateStyleVisual();
              // snap all 6 sliders to this style's recommended
              // defaults. Existing slider edits are overridden.
              _applyStylePresetToSliders(opt.id);
              try { _updateOvrVisual(); } catch (_e) {}
              _syncVisionStyleBridge();
              _epePersistStyle();
              _closeStyleMenu();
            };
            _styleMenu.appendChild(item);
          });
          document.body.appendChild(_styleMenu);
          const r = styleDdWrap.getBoundingClientRect();
          _styleMenu.style.left = r.left + "px";
          _styleMenu.style.top  = (r.bottom + 2) + "px";
          document.addEventListener("mousedown", _onStyleDocClick, true);
        };
        styleDdWrap.onclick = (ev) => {
          ev.stopPropagation();
          if (_styleMenu) _closeStyleMenu(); else _openStyleMenu();
        };

        // ── 6-slider grid ──
        const sliderGrid = document.createElement("div");
        sliderGrid.style.cssText = `display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 18px; width: 100%; box-sizing: border-box;`;

        const sliderEls = {}; // id -> { wrap, label, input, resetIcon, _applyEditedVisual }

        SLIDER_DEFS.forEach(def => {
          const wrap = document.createElement("div");
          wrap.style.cssText = "display: flex; flex-direction: column; gap: 3px; min-width: 0;";
          if (def.tooltip) wrap.title = def.tooltip;

          // Label row: label on left, value readout on right.
          // Tabular-nums prevents the value from jittering as digits change.
          const labelRow = document.createElement("div");
          labelRow.style.cssText = "display: flex; align-items: baseline; gap: 8px; min-width: 0;";

          const label = document.createElement("span");
          label.textContent = def.label;
          label.style.cssText = "font-size: 11px; color: #9aaaba; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; transition: color 0.12s;";

          const valueDisplay = document.createElement("span");
          valueDisplay.textContent = "50";
          valueDisplay.style.cssText = "font-size: 11px; color: #5b6b7e; flex-shrink: 0; min-width: 18px; text-align: right; font-variant-numeric: tabular-nums; transition: color 0.12s;";

          labelRow.appendChild(label);
          labelRow.appendChild(valueDisplay);

          const row = document.createElement("div");
          row.style.cssText = "display: flex; align-items: center; gap: 6px;";

          const input = document.createElement("input");
          input.type = "range";
          input.min = "0";
          input.max = "100";
          input.step = "1";
          input.value = "50";
          // class is styled by the injected stylesheet above; flex/min-width
          // here are layout-only so each slider stretches inside its grid column.
          input.className = "epe-style-slider";
          // layout handled by stylesheet rule (inline cssText would override appearance in Chrome)

          const resetIcon = document.createElement("span");
          resetIcon.textContent = "↻";
          resetIcon.title = "Reset " + def.label;
          resetIcon.style.cssText = "font-size: 11px; color: #4e5c6e; cursor: pointer; padding: 2px 4px; opacity: 0.25; transition: opacity 0.12s, color 0.12s; flex-shrink: 0; user-select: none; line-height: 1;";

          row.appendChild(input);
          row.appendChild(resetIcon);
          wrap.appendChild(labelRow);
          wrap.appendChild(row);
          sliderGrid.appendChild(wrap);

          const _applyEditedVisual = () => {
            const val = parseInt(input.value, 10);
            const isEdited = (val !== 50);
            // Keep the numeric readout in sync with the current value.
            valueDisplay.textContent = String(val);
            // Fill the track up to the thumb (webkit gradient var).
            {
              const _min = parseFloat(input.min || "0"), _max = parseFloat(input.max || "100");
              const _pct = (val - _min) / (_max - _min);
              // Thumb is 11px; usable track is inset by half a thumb each side.
              input.style.setProperty("--fill", "calc(" + (_pct*100) + "% + " + (5.5 - _pct*11) + "px)", "important");
            }
            if (isEdited) {
              label.style.color = "#d4dfea";
              label.style.fontWeight = "500";
              valueDisplay.style.color = "#d4dfea";
              input.classList.add("edited");
              resetIcon.style.opacity = "1";
              resetIcon.style.color = "#9aaaba";
            } else {
              label.style.color = "#9aaaba";
              label.style.fontWeight = "400";
              valueDisplay.style.color = "#5b6b7e";
              input.classList.remove("edited");
              resetIcon.style.opacity = "0.25";
              resetIcon.style.color = "#4e5c6e";
            }
          };

          input.oninput = () => {
            _sliderValues[def.id] = parseInt(input.value, 10);
            _syncVisionStyleBridge();
            _applyEditedVisual();
            _epePersistStyle();
          };

          resetIcon.onclick = () => {
            input.value = "50";
            _sliderValues[def.id] = 50;
            _syncVisionStyleBridge();
            _applyEditedVisual();
            _epePersistStyle();
          };

          sliderEls[def.id] = { wrap, label, input, resetIcon, _applyEditedVisual };
        });

        // shared helper for snapping sliders to a style's
        // recommended defaults. Used by both the dropdown-pick handler and
        // the main Reset button (Reset = snap to "default" preset).
        const _applyStylePresetToSliders = (styleId) => {
          const preset = STYLE_SLIDER_DEFAULTS[styleId] || STYLE_SLIDER_DEFAULTS.default;
          Object.keys(preset).forEach(sliderId => {
            const el = sliderEls[sliderId];
            if (!el) return;
            el.input.value = String(preset[sliderId]);
            _sliderValues[sliderId] = preset[sliderId];
            el._applyEditedVisual();
          });
        };

        // ── Aesthetic override toggle ──
        const styleOvrWrap = document.createElement("div");
        styleOvrWrap.title =
          "Override source aesthetic\n\n" +
          "OFF: aesthetics the prompt already describes (grayscale, airbrush, lighting, etc.) are preserved — the style only fills gaps.\n\n" +
          "ON: the selected style REPLACES the prompt's rendering style, medium, lighting, and color grade. Subjects, counts, poses, actions, scene layout, and named object colors (a red bicycle stays red) are kept.\n\n" +
          "Disabled when Style is Default.";
        styleOvrWrap.style.cssText = `
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 3px;
          padding: 8px 12px;
          background: #1c2431;
          border: 1px solid #31415a;
          border-radius: 4px;
          cursor: pointer;
          user-select: none;
          transition: border-color 0.12s, opacity 0.12s;
        `;
        const styleOvrLabel = document.createElement("span");
        styleOvrLabel.textContent = "Override";
        styleOvrLabel.style.cssText = "font-size: 10px; color: #7a8a9c;";
        const styleOvrState = document.createElement("span");
        styleOvrState.style.cssText = "font-size: 12px; font-weight: 500;";
        styleOvrWrap.appendChild(styleOvrLabel);
        styleOvrWrap.appendChild(styleOvrState);
        const _updateOvrVisual = () => {
          const enabled = _styleActive !== "default";
          styleOvrWrap.style.opacity = enabled ? "1" : "0.4";
          styleOvrWrap.style.cursor = enabled ? "pointer" : "not-allowed";
          styleOvrState.textContent = _styleOverride ? "On" : "Off";
          styleOvrState.style.color = (_styleOverride && enabled) ? "#6db8e8" : "#8a9aac";
          styleOvrWrap.style.borderColor = (_styleOverride && enabled) ? "#3a6a8e" : "#31415a";
        };
        styleOvrWrap.onmouseenter = () => { if (_styleActive !== "default") styleOvrWrap.style.borderColor = "#5b6b7e"; };
        styleOvrWrap.onmouseleave = () => { _updateOvrVisual(); };
        styleOvrWrap.onclick = () => {
          if (_styleActive === "default") return;
          _styleOverride = !_styleOverride;
          _updateOvrVisual();
          _syncVisionStyleBridge();
          _epePersistStyle();
        };
        _updateOvrVisual();

        // Restore hook — repaint style/override/sliders from saved properties.
        if (_epeOwnerNode) {
          // Restore panel tab + style section open/closed.
          _epeOwnerNode._epeUiRestore = () => {
            const ui = (_epeOwnerNode.properties || {}).epe_ui;
            if (!ui) return;
            if (ui.tab && rpTabEls[ui.tab]) _setRpTab(ui.tab);
            if (typeof ui.styleOpen === "boolean" && ui.styleOpen !== _styleOpen) {
              _styleOpen = ui.styleOpen;
              styleBody.style.display = _styleOpen ? "" : "none";
              styleChev.style.transform = _styleOpen ? "" : "rotate(-90deg)";
              _updateStyleHdrState();
            }
          };

          _epeOwnerNode._epeStyleRestore = () => {
            const st = (_epeOwnerNode.properties || {}).epe_style;
            if (!st) return;
            _styleActive = st.style || "default";
            _styleOverride = !!st.override;
            if (st.sliders) {
              Object.keys(st.sliders).forEach(id => {
                const el = sliderEls[id];
                if (!el) return;
                _sliderValues[id] = st.sliders[id];
                el.input.value = String(st.sliders[id]);
                el._applyEditedVisual();
              });
            }
            _updateStyleVisual();
            try { _updateOvrVisual(); } catch (_e) {}
            _syncVisionStyleBridge();
          };
        }

        styleCtrlRow.appendChild(styleDdWrap);
        styleCtrlRow.appendChild(styleOvrWrap);
        styleStrip.appendChild(styleCtrlRow);
        styleStrip.appendChild(sliderGrid);

        // ── collapsible Style tuning section under the editor ──
        const styleSection = document.createElement("div");
        styleSection.style.cssText =
          "flex-shrink:0;background:rgba(109,184,232,0.04);" +
          "border-top:1px solid rgba(109,184,232,0.14);";
        const styleHdr = document.createElement("div");
        styleHdr.title = "Click to show or hide Style tuning";
        styleHdr.style.cssText =
          "display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;user-select:none;" +
          "background:rgba(109,184,232,0.08);border:1px solid rgba(109,184,232,0.2);border-radius:8px;" +
          "transition:background .12s,border-color .12s;";
        styleHdr.onmouseenter = () => { styleHdr.style.background = "rgba(109,184,232,0.14)"; styleHdr.style.borderColor = "rgba(109,184,232,0.35)"; };
        styleHdr.onmouseleave = () => { styleHdr.style.background = "rgba(109,184,232,0.08)"; styleHdr.style.borderColor = "rgba(109,184,232,0.2)"; };
        const styleChev = document.createElement("span");
        styleChev.textContent = "\u25BC";
        styleChev.style.cssText = "font-size:11px;color:#8cc8f0;transition:transform .12s;display:inline-block;width:12px;text-align:center;";
        const styleHdrLabel = document.createElement("span");
        styleHdrLabel.textContent = "Style tuning";
        styleHdrLabel.style.cssText = "font-size:10px;color:#8ba5be;";
        const styleHdrState = document.createElement("span");
        styleHdrState.style.cssText = "font-size:10px;color:#6d849a;margin-left:auto;";
        const styleHdrToggle = document.createElement("span");
        styleHdrToggle.style.cssText = "font-size:9px;color:#5f7a92;";
        styleHdr.appendChild(styleChev);
        styleHdr.appendChild(styleHdrLabel);
        styleHdr.appendChild(styleHdrToggle);
        // Compact chips: restyle the Style dropdown / Override boxes into
        // single-line chips and pull them into the header row (mockup match).
        styleDdWrap.style.cssText =
          "position:relative;display:flex;align-items:center;gap:6px;padding:4px 12px;" +
          "background:rgba(109,184,232,0.08);border:1px solid rgba(109,184,232,0.25);" +
          "border-radius:6px;cursor:pointer;user-select:none;font-size:11px;color:#dcebf7;";
        styleDdLabel.style.display = "none";
        styleOvrWrap.style.cssText =
          "display:flex;align-items:center;gap:5px;padding:4px 12px;" +
          "background:rgba(109,184,232,0.08);border:1px solid rgba(109,184,232,0.25);" +
          "border-radius:6px;cursor:pointer;user-select:none;font-size:11px;";
        styleOvrLabel.style.cssText = "font-size:11px;color:#8ba5be;";
        styleOvrState.style.cssText = "font-size:11px;font-weight:500;";
        [styleDdWrap, styleOvrWrap].forEach(el =>
          el.addEventListener("click", (e) => e.stopPropagation()));
        styleHdr.appendChild(styleDdWrap);
        styleHdr.appendChild(styleOvrWrap);
        styleCtrlRow.style.display = "none";
        styleHdr.appendChild(styleHdrState);
        const styleHint = document.createElement("div");
        styleHint.textContent =
          "Override Off: the style only fills gaps your prompt leaves open.\n" +
          "Override On: the style replaces your prompt's look — subjects, poses, and scene stay.";
        styleHint.style.cssText = "font-size:10px;color:#6d849a;line-height:1.6;padding:0 12px 6px;white-space:pre-line;";
        const styleBody = document.createElement("div");
        styleBody.appendChild(styleHint);
        styleBody.appendChild(styleStrip);
        styleSection.appendChild(styleHdr);
        styleSection.appendChild(styleBody);
        const _updateStyleHdrState = () => {
          styleHdrToggle.textContent = _styleOpen ? "(click to hide)" : "(click to show)";
          styleHdrState.textContent = _styleOpen ? "" :
            (STYLE_OPTIONS.find(o => o.id === _styleActive)?.label || "Default") +
            (_styleOverride ? " · Override on" : "");
        };
        styleHdr.onclick = () => {
          _styleOpen = !_styleOpen;
          styleBody.style.display = _styleOpen ? "" : "none";
          styleChev.style.transform = _styleOpen ? "" : "rotate(-90deg)";
          _updateStyleHdrState();
          _epePersistUi();
        };
        _updateStyleHdrState();   // set the initial show/hide hint
        // ══ editor toolbar ═══════════════════════════════════
        // Shared popover helpers (scoped to this editor instance)
        let _epeOpenPop = null;
        // In-flight word-alternatives request (Synonyms / Flag words). When the
        // popover closes we wait a 3s grace period (in case of a stray click)
        // before aborting the request and unloading the model.
        let _wordAltAbort = null;
        let _wordAltGraceTimer = null;
        const _cancelWordAltGrace = () => { if (_wordAltGraceTimer) { clearTimeout(_wordAltGraceTimer); _wordAltGraceTimer = null; } };
        const _closePopovers = () => {
          if (_epeOpenPop) {
            if (_epeOpenPop._onDoc) document.removeEventListener("mousedown", _epeOpenPop._onDoc, true);
            _epeOpenPop.remove(); _epeOpenPop = null;
          }
          // Start the grace timer if a word-alternatives request is in flight.
          if (_wordAltAbort && !_wordAltGraceTimer) {
            _wordAltGraceTimer = setTimeout(() => {
              _wordAltGraceTimer = null;
              if (_wordAltAbort) { try { _wordAltAbort.abort(); } catch (_e) {} _wordAltAbort = null; try { _epeOllama.unloadModel(); } catch (_e) {} }
            }, 3000);
          }
        };
        // draggable: adds a grab bar so the user can move the popover off the
        // prompt text (Flag Words / Synonyms can otherwise cover the word).
        const _mkPopover = (draggable) => {
          const p = document.createElement("div");
          p.style.cssText =
            "position:absolute;z-index:10000;background:#141b26;" +
            "border:1px solid rgba(140,200,240,0.4);border-radius:8px;padding:8px 10px;" +
            "box-shadow:0 6px 20px rgba(0,0,0,0.5);min-width:170px;";
          if (draggable) {
            const grip = document.createElement("div");
            grip.title = "Drag to move";
            grip.style.cssText =
              "display:flex;align-items:center;justify-content:center;gap:6px;" +
              "height:18px;margin:-8px -10px 6px;border-radius:7px 7px 0 0;cursor:move;" +
              "background:rgba(109,184,232,0.10);border-bottom:1px solid rgba(140,200,240,0.20);" +
              "font-size:9px;color:#6d849a;letter-spacing:.4px;user-select:none;";
            const gripBars = document.createElement("span");
            gripBars.style.cssText =
              "width:26px;height:6px;border-radius:2px;" +
              "background:repeating-linear-gradient(0deg,rgba(140,200,240,0.55) 0 1px,transparent 1px 3px);";
            const gripText = document.createElement("span");
            gripText.textContent = "drag to move";
            grip.appendChild(gripBars);
            grip.appendChild(gripText);
            grip.onmouseenter = () => { grip.style.background = "rgba(109,184,232,0.18)"; gripText.style.color = "#a8d6f5"; };
            grip.onmouseleave = () => { grip.style.background = "rgba(109,184,232,0.10)"; gripText.style.color = "#6d849a"; };
            p.appendChild(grip);
            p._epeGrip = grip;
            p._epeDragged = false;

            let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
            const onMove = (e) => {
              if (!dragging) return;
              p.style.left = (ox + e.clientX - sx) + "px";
              p.style.top  = (oy + e.clientY - sy) + "px";
            };
            const onUp = () => {
              dragging = false;
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
            };
            grip.addEventListener("mousedown", (e) => {
              e.preventDefault(); e.stopPropagation();   // don't trigger outside-click close
              dragging = true; p._epeDragged = true;
              sx = e.clientX; sy = e.clientY;
              ox = parseFloat(p.style.left) || 0;
              oy = parseFloat(p.style.top) || 0;
              document.addEventListener("mousemove", onMove);
              document.addEventListener("mouseup", onUp);
            });
          }
          return p;
        };
        const _anchorPopover = (pop, btn) => {
          document.body.appendChild(pop);
          const r = btn.getBoundingClientRect();
          pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 12) + "px";
          pop.style.top = (r.bottom + 4) + "px";
          _epeOpenPop = pop;
          setTimeout(() => {
            const onDoc = (e) => { if (!pop.contains(e.target) && e.target !== btn) _closePopovers(); };
            pop._onDoc = onDoc;
            // Capture phase: LiteGraph's canvas calls stopPropagation() on
            // mousedown, so a bubble-phase listener never sees canvas clicks
            // and the popover would stay open over the graph.
            document.addEventListener("mousedown", onDoc, true);
          }, 0);
        };
        const _menuItem = (label, onclick, title) => {
          const d = document.createElement("div");
          d.textContent = label;
          if (title) d.title = title;
          d.style.cssText = "padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12px;color:#9fb4c8;transition:background .12s;";
          d.onmouseenter = () => d.style.background = "rgba(109,184,232,0.1)";
          d.onmouseleave = () => d.style.background = "none";
          d.onclick = onclick;
          return d;
        };
        const _toast = (msg) => {
          const t = document.createElement("div");
          t.textContent = msg;
          t.style.cssText =
            "position:absolute;z-index:10001;left:50%;bottom:16px;transform:translateX(-50%);" +
            "background:#141b26;border:1px solid rgba(109,184,232,0.3);border-radius:8px;" +
            "color:#a8c6de;font-size:11px;padding:6px 14px;box-shadow:0 4px 14px rgba(0,0,0,0.5);";
          floatingWin.appendChild(t);
          setTimeout(() => t.remove(), 2200);
        };
        // Undo toast: message + Undo link, auto-dismiss.
        const _toastUndo = (msg, onUndo) => {
          const t = document.createElement("div");
          t.style.cssText =
            "position:absolute;z-index:10001;left:50%;bottom:16px;transform:translateX(-50%);" +
            "display:flex;align-items:center;gap:10px;background:#141b26;" +
            "border:1px solid rgba(109,184,232,0.3);border-radius:8px;color:#a8c6de;" +
            "font-size:11px;padding:6px 12px;box-shadow:0 4px 14px rgba(0,0,0,0.5);";
          const m = document.createElement("span"); m.textContent = msg; t.appendChild(m);
          const u = document.createElement("span"); u.textContent = "Undo";
          u.style.cssText = "color:#a8d6f5;text-decoration:underline;cursor:pointer;";
          u.onclick = () => { t.remove(); onUndo && onUndo(); };
          t.appendChild(u);
          floatingWin.appendChild(t);
          setTimeout(() => t.remove(), 5000);
        };
        // Small indeterminate progress bar — a looping slide while working.
        const _mkProgress = () => {
          const track = document.createElement("div");
          track.style.cssText = "height:2px;background:rgba(109,184,232,0.12);border-radius:1px;overflow:hidden;margin:4px 0;position:relative;";
          const fill = document.createElement("div");
          fill.style.cssText = "position:absolute;height:100%;width:35%;background:#6db8e8;border-radius:1px;animation:epeSlide 1.1s ease-in-out infinite;";
          track.appendChild(fill);
          if (!document.getElementById("epe-progress-kf")) {
            const kf = document.createElement("style"); kf.id = "epe-progress-kf";
            kf.textContent = "@keyframes epeSlide{0%{left:-35%}100%{left:100%}}";
            document.head.appendChild(kf);
          }
          return {
            el: track,
            bump: () => {},
            done: () => { fill.style.animation = "none"; fill.style.left = "0"; fill.style.width = "100%"; },
          };
        };
        // Ollama call with a live streaming bar. onStream(partial) optional.
        const _epeStreamGenerate = async (sys, usr, opts, barHost, onStream) => {
          const prog = _mkProgress();
          if (barHost) barHost.appendChild(prog.el);
          try {
            const raw = await _epeOllama.generate(sys, usr, { ...(opts||{}), signal: (opts && opts.signal) || undefined, onToken: (p) => { prog.bump(p); if (onStream) onStream(p); } });
            prog.done(); setTimeout(() => prog.el.remove(), 200);
            return raw || "";
          } catch (_e) { prog.el.remove(); throw _e; }
        };

        // Ollama single-word alternatives, context-aware
        // Empty "quality" words that add nothing for image models. Shared by
        // Flag words (detection) and word-alternatives (excluded from suggestions).
        const _FLAG_WORDS = ["beautiful","detailed","intricate","stunning","masterpiece","gorgeous","amazing","awesome","perfect","best quality","high quality","4k","8k","hd","award-winning","breathtaking","epic","majestic"];

        // Shared "Thinking…" line for AI popovers (Synonyms, Flag words replace).
        const _epeThinkingLine = () => {
          const el = document.createElement("div");
          el.setAttribute("data-epe-thinking", "1");
          el.textContent = "Thinking…";
          el.style.cssText = "font-size:11px;color:#6d849a;padding:4px;";
          return el;
        };

        const _epeOllamaWordAlternatives = async (word, context, barHost, mode) => {
          // Model is resolved inside _epeOllama.generate() via settings.model.
          const settings = _epeOllama.getSettings ? _epeOllama.getSettings() : {};
          if (!settings.model) { _toast("No Ollama model selected (AI Setup)."); return []; }
          // New request cancels any pending grace-abort from a prior one.
          _cancelWordAltGrace();
          _wordAltAbort = new AbortController();
          const _sig = _wordAltAbort.signal;
          const sys = (mode === "synonym")
            ? "You are a thesaurus. Give 6 synonyms or near-synonyms for the given word that preserve its meaning. Reply with ONLY a comma-separated list of single words. No phrases, no numbering, no explanation, no quotes."
            : "You improve an image-generation prompt. The user marks one vague quality word (like 'beautiful' or 'detailed'). Look at what that word describes in the prompt and suggest 6 SINGLE words that concretely describe that specific thing — words a diffusion model can actually render. Each must be ONE word, visually meaningful, and fit the subject in context. Never suggest empty quality words such as: " + _FLAG_WORDS.join(", ") + ". Reply with ONLY a comma-separated list of single words. No numbering, no explanation, no quotes.";
          const usr = (mode === "synonym")
            ? ("Word: " + word)
            : ("PROMPT: " + (context || "").slice(0, 400) + "\n\nThe vague word to improve is: \"" + word + "\". Suggest concrete single words that describe what it modifies in this prompt.");
          // Shared parser: split on commas AND newlines, strip list markers and
          // quotes, keep single words only, drop the original + empty-quality words.
          const _flagSet = new Set(_FLAG_WORDS.map(w => w.toLowerCase()));
          const _parseWords = (text) => {
            const out = (text || "")
              .split(/[,\n]/)
              .map(x => x.replace(/^[\d.)\-•*\s]+/,"").replace(/["“”.]/g,"").trim())
              .filter(w => w && !/\s/.test(w) && w.length <= 20 &&
                           w.toLowerCase() !== word.toLowerCase() && !_flagSet.has(w.toLowerCase()));
            const seen = new Set();
            return out.filter(w => { const k = w.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
          };

          // A thinking model that never finishes still names its candidates inside
          // the reasoning text (often as a numbered or comma list). Salvage those
          // rather than showing the user nothing.
          const _salvageFromThinking = (thinking) => {
            if (!thinking) return [];
            const lines = thinking.split(/\n/);
            const picked = [];
            for (const ln of lines) {
              // numbered items: "1. manifestation"  /  bullets: "- display"
              const m = ln.match(/^\s*(?:\d+[.)]|[-•*])\s*([A-Za-z][A-Za-z'-]{2,19})\s*$/);
              if (m) picked.push(m[1]);
            }
            if (picked.length >= 3) return _parseWords(picked.join(","));
            // otherwise take the last comma list that looks word-like
            const commaLines = lines.filter(l => (l.match(/,/g) || []).length >= 2);
            if (commaLines.length) return _parseWords(commaLines[commaLines.length - 1]);
            return [];
          };

          const _opts = {
            keep_alive: 300,
            options: { temperature: (mode === "synonym") ? 0.5 : 0.6, num_predict: 48 },
            signal: _sig,
            onRetry: () => {
              if (barHost) {
                const n = barHost.querySelector("[data-epe-thinking]");
                if (n) n.textContent = "Model is thinking, retrying…";
              }
            },
          };

          try {
            const raw = await _epeStreamGenerate(sys, usr, _opts, barHost);
            const _uniq = _parseWords(raw);
            _wordAltAbort = null; _cancelWordAltGrace();
            if (!_uniq.length) _toast("No suggestions returned.");
            return _uniq.slice(0, 6);
          } catch (_e) {
            _wordAltAbort = null; _cancelWordAltGrace();
            if (_e && _e.name === "AbortError") return [];
            // Model burned its budget thinking — pull the candidates out of the
            // reasoning text instead of failing.
            if (_e && _e.thinking) {
              const salvaged = _salvageFromThinking(_e.thinking);
              if (salvaged.length) return salvaged.slice(0, 6);
            }
            if (_e && /thinking/i.test(_e.message || "")) {
              _toast("This model reasons before answering — a non-thinking model is much faster here.");
              return [];
            }
            _toast("Ollama request failed."); return [];
          }
        };

        (function _buildEditorToolbar() {
          const bar = document.createElement("div");
          bar.style.cssText =
            "display:flex;gap:4px;align-items:center;flex-wrap:wrap;" +
            "background:rgba(109,184,232,0.04);border:1px solid rgba(109,184,232,0.14);border-top:none;" +
            "border-radius:0 0 8px 8px;padding:5px 8px;margin:0 -1px 6px;flex-shrink:0;";
          const _mk = (label, title, wide) => {
            const b = document.createElement("button");
            b.textContent = label; b.title = title;
            b.style.cssText =
              "background:none;border:none;color:#8ba5be;cursor:pointer;" +
              "font-size:" + (wide ? "10px" : "11px") + ";padding:3px 6px;" +
              "border-radius:5px;line-height:1;transition:color .12s,background .12s;";
            b.onmouseenter = () => { b.style.color = "#c2e2f8"; b.style.background = "rgba(109,184,232,0.1)"; };
            b.onmouseleave = () => { b.style.color = "#8ba5be"; b.style.background = "none"; };
            return b;
          };
          const _sep = () => { const s = document.createElement("span"); s.style.cssText = "width:1px;height:14px;background:rgba(109,184,232,0.18);margin:0 3px;"; return s; };

          const _undo = [], _redo = []; let _lastPush = 0;
          const _pushUndo = (force) => {
            const now = Date.now();
            if (!force && now - _lastPush < 500) return;
            _lastPush = now; _undo.push(textEl.value);
            if (_undo.length > 100) _undo.shift(); _redo.length = 0;
          };
          textEl._epePushUndo = () => _pushUndo(true);
          textEl.addEventListener("input", () => _pushUndo(false));
          textEl.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
              if (_undo.length) { e.preventDefault(); _redo.push(textEl.value); textEl.value = _undo.pop(); textEl.dispatchEvent(new Event("input")); }
            } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
              if (_redo.length) { e.preventDefault(); _undo.push(textEl.value); textEl.value = _redo.pop(); textEl.dispatchEvent(new Event("input")); }
            }
          });
          const _setText = (v) => { _pushUndo(true); textEl.value = v; textEl.dispatchEvent(new Event("input")); };

          const undoBtn = _mk("↶", "Undo (Ctrl+Z)");
          undoBtn.onclick = () => { if (_undo.length) { _redo.push(textEl.value); textEl.value = _undo.pop(); textEl.dispatchEvent(new Event("input")); } };
          const redoBtn = _mk("↷", "Redo (Ctrl+Y)");
          redoBtn.onclick = () => { if (_redo.length) { _undo.push(textEl.value); textEl.value = _redo.pop(); textEl.dispatchEvent(new Event("input")); } };


          const findBtn = _mk("Find", "Find & replace");
          findBtn.onclick = () => {
            _closePopovers(); const pop = _mkPopover(); pop.style.width = "260px";
            const _inp = (ph) => { const i = document.createElement("input"); i.placeholder = ph; i.style.cssText = "width:100%;box-sizing:border-box;background:rgba(109,184,232,0.05);border:1px solid rgba(109,184,232,0.2);border-radius:6px;color:#dce6f2;font-size:11px;padding:6px 8px;margin-bottom:6px;outline:none;"; return i; };
            const findI = _inp("Find…"), replI = _inp("Replace with…");
            const row = document.createElement("div"); row.style.cssText = "display:flex;gap:6px;";
            const _act = (t) => { const b = document.createElement("button"); b.textContent = t; b.style.cssText = "flex:1;background:rgba(109,184,232,0.1);border:1px solid rgba(109,184,232,0.25);border-radius:6px;color:#a8d6f5;font-size:11px;padding:5px;cursor:pointer;"; return b; };
            const nextB = _act("Find next"), replB = _act("Replace"), allB = _act("All");
            let _pos = 0;
            nextB.onclick = () => { const q = findI.value; if (!q) return; const idx = textEl.value.indexOf(q, _pos); const at = idx>=0?idx:textEl.value.indexOf(q); if (at>=0){ textEl.focus(); textEl.setSelectionRange(at, at+q.length); _pos = at+q.length; } };
            replB.onclick = () => { const q = findI.value; if (!q) return; const s = textEl.selectionStart, e = textEl.selectionEnd; if (textEl.value.slice(s,e)===q){ _setText(textEl.value.slice(0,s)+replI.value+textEl.value.slice(e)); _pos = s+replI.value.length; } else nextB.onclick(); };
            allB.onclick = () => { const q = findI.value; if (!q) return; _setText(textEl.value.split(q).join(replI.value)); };
            row.appendChild(nextB); row.appendChild(replB); row.appendChild(allB);
            pop.appendChild(findI); pop.appendChild(replI); pop.appendChild(row);
            _anchorPopover(pop, findBtn); findI.focus();
          };

          const aaBtn = _mk("Aa ▾", "Case, sort, dedupe, trim", true);
          aaBtn.onclick = () => {
            _closePopovers(); const pop = _mkPopover();
            [["UPPERCASE", () => textEl.value.toUpperCase()],
             ["lowercase", () => textEl.value.toLowerCase()],
             ["Title Case", () => textEl.value.replace(/\w\S*/g, w => w[0].toUpperCase()+w.slice(1).toLowerCase())],
             ["Sentence case", () => textEl.value.toLowerCase().replace(/(^\s*\w|[.!?]\s+\w)/g, c => c.toUpperCase())],
             ["Sort lines A→Z", () => textEl.value.split("\n").sort((a,b)=>a.localeCompare(b)).join("\n")],
             ["Remove duplicate lines", () => { const seen=new Set(); return textEl.value.split("\n").filter(l=>{const k=l.trim(); if(seen.has(k))return false; seen.add(k); return true;}).join("\n"); }],
             ["Trim whitespace", () => textEl.value.split("\n").map(l=>l.trim()).join("\n").replace(/\n{3,}/g,"\n\n").trim()],
            ].forEach(([label, fn]) => pop.appendChild(_menuItem(label, () => { _setText(fn()); _closePopovers(); })));
            _anchorPopover(pop, aaBtn);
          };

          const cleanBtn = _mk("Clean ▾", "Strip markdown, weights, extra spaces", true);
          cleanBtn.onclick = () => {
            _closePopovers(); const pop = _mkPopover();
            [["Strip markdown", () => textEl.value.replace(/[*_`#>~]/g,"").replace(/\[(.*?)\]\(.*?\)/g,"$1")],
             ["Strip weights", () => {
                 let v = textEl.value, prev;
                 // (word:1.2) and (word:-1.4), innermost first for nesting
                 do { prev = v; v = v.replace(/\(([^()]*?):\s*-?\d*\.?\d+\s*\)/g, "$1"); } while (v !== prev);
                 // [word:0.25] prompt-editing / bracket weights
                 do { prev = v; v = v.replace(/\[([^\[\]]*?):\s*-?\d*\.?\d+\s*\]/g, "$1"); } while (v !== prev);
                 v = v.replace(/\(\s*-?\d*\.?\d+\s*\)/g, "");   // orphan (1.4)
                 v = v.replace(/::\s*-?\d*\.?\d+/g, "");           // Midjourney cat::2
                 // emphasis-only grouping: ((word)) [word] {word}
                 do { prev = v; v = v.replace(/\(([^()]*)\)/g, "$1"); } while (v !== prev);
                 do { prev = v; v = v.replace(/\[([^\[\]]*)\]/g, "$1"); } while (v !== prev);
                 do { prev = v; v = v.replace(/\{([^{}]*)\}/g, "$1"); } while (v !== prev);
                 v = v.replace(/([A-Za-z0-9])[+]{1,5}(?=[\s,]|$)/g, "$1");   // horse++
                 v = v.replace(/([A-Za-z0-9])[-]{2,5}(?=[\s,]|$)/g, "$1");   // dog--
                 // leftover " word -1.4" (sign or decimal required, so ISO 100 survives)
                 v = v.replace(/\s+-\d*\.?\d+(?=\s*,|\s*$)/g, "");
                 v = v.replace(/\s+\d+\.\d+(?=\s*,|\s*$)/g, "");
                 return v.replace(/[ \t]{2,}/g, " ").replace(/\s+,/g, ",")
                         .replace(/,\s*,+/g, ",").replace(/^\s*,+/, "").replace(/,\s*$/, "").trim();
               },
              "Removes (word:1.2), (word:-1.4), ((word)), [word], {word}, word++, cat::2 and orphan (1.4) — keeps ISO 100, f/1.4, 16:9"],
             ["Strip syntax", () => textEl.value
                 .replace(/[()\[\]{}<>|\\]/g,"")
                 .replace(/(?<!\d)[;:](?!\d)/g," ")
                 .replace(/(?<!\d)\.(?!\d)/g,"")
                 .replace(/[ \t]{2,}/g," ").replace(/ +([,.])/g,"$1").replace(/,{2,}/g,",").trim(),
              "Removes ( ) [ ] { } < > | \\ and stray : ; . — keeps numbers like 0.2 and 16:9"],
             ["Collapse extra spaces", () => textEl.value.replace(/[ \t]{2,}/g," ").replace(/ +([,.;:])/g,"$1")],
             ["Remove line breaks", () => textEl.value.replace(/\s*\n\s*/g," ").replace(/\s{2,}/g," ").trim()],
            ].forEach(([label, fn, tip]) => pop.appendChild(_menuItem(label, () => { _setText(fn()); _closePopovers(); }, tip)));
            _anchorPopover(pop, cleanBtn);
          };

          const synBtn = _mk("Synonyms", "Alternatives for the selected word (Ollama)", true);
          synBtn.onclick = async () => {
            const s = textEl.selectionStart, e = textEl.selectionEnd;
            const sel = textEl.value.slice(s, e).trim();
            if (!sel) { _toast("Select a word first."); return; }
            _closePopovers(); const pop = _mkPopover(true);
            const load = _epeThinkingLine(); pop.appendChild(load);
            _anchorPopover(pop, synBtn);

            // Keep the user's word highlighted while they pick a synonym. Opening
            // the popover moves focus, which drops the selection to the inactive
            // (near-invisible) colour, so re-apply it.
            const _swallowDown = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
            const _reselect = () => { textEl.setSelectionRange(s, e); textEl.focus(); textEl.setSelectionRange(s, e); };
            _reselect();

            const alts = await _epeOllamaWordAlternatives(sel, textEl.value, pop, "synonym");
            pop.innerHTML = "";
            if (pop._epeGrip) pop.appendChild(pop._epeGrip);   // wipe removed it
            if (!alts.length) { load.textContent = "No suggestions."; pop.appendChild(load); return; }
            _reselect();
            const head = document.createElement("div"); head.textContent = "Replace \"" + sel + "\" with:"; head.style.cssText = "font-size:10px;color:#6d849a;margin-bottom:6px;"; pop.appendChild(head);
            const wrap = document.createElement("div"); wrap.style.cssText = "display:flex;gap:5px;flex-wrap:wrap;";
            alts.forEach(a => { const chip = document.createElement("span"); chip.textContent = a; chip.style.cssText = "background:rgba(109,184,232,0.14);border:1px solid rgba(140,200,240,0.4);border-radius:5px;color:#a8d6f5;font-size:10px;padding:2px 9px;cursor:pointer;"; chip.addEventListener("mousedown", _swallowDown); chip.onclick = (ev) => { if (ev) ev.stopPropagation(); _setText(textEl.value.slice(0,s)+a+textEl.value.slice(e)); _closePopovers(); }; wrap.appendChild(chip); });
            pop.appendChild(wrap);
          };

          const flagBtn = _mk("Flag Words", "Highlight empty quality words", true);
          flagBtn.onclick = () => {
            const found = [];
            _FLAG_WORDS.forEach(w => { const re = new RegExp("\\b"+w.replace(/[-/\\^$*+?.()|[\]{}]/g,"\\$&")+"\\b","gi"); let m; while ((m = re.exec(textEl.value)) !== null) found.push({ word: m[0], at: m.index }); });
            if (!found.length) { _toast("No empty quality words found."); return; }
            _closePopovers(); const pop = _mkPopover(true); pop.style.width = "280px";
            const tip = document.createElement("div");
            tip.textContent = "Empty quality words (\"beautiful\", \"4k\"…) add nothing for image models. Click replace to pick a stronger word, or delete.";
            tip.style.cssText = "font-size:10px;color:#6d849a;line-height:1.5;margin-bottom:8px;";
            pop.appendChild(tip);
            const head = document.createElement("div"); head.textContent = found.length + " flagged:"; head.style.cssText = "font-size:10px;color:#8ba5be;margin-bottom:6px;"; pop.appendChild(head);
            found.slice(0, 12).forEach(f => {
              const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:8px;padding:3px 4px;font-size:11px;";
              const tag = document.createElement("span"); tag.textContent = f.word; tag.style.cssText = "color:#e8c88a;background:rgba(226,168,75,0.18);border-radius:4px;padding:1px 7px;cursor:pointer;"; tag.title = "Click to find this word in the prompt";
              // The document-level "mousedown" outside-click handler runs BEFORE
              // click and steals focus, wiping the selection. Swallow it here.
              // Highlight this exact occurrence in the prompt and scroll to it.
              // Called from both the word tag and the "replace" link so the user
              // always sees which word is about to change.
              const _revealWord = () => {
                const _before = textEl.value.slice(0, f.at);
                const _line = _before.split("\n").length - 1;
                const _lh = parseFloat(getComputedStyle(textEl).lineHeight) || 16;
                textEl.scrollTop = Math.max(0, _line * _lh - textEl.clientHeight / 2);
                textEl.setSelectionRange(f.at, f.at + f.word.length);
                textEl.focus();
                textEl.setSelectionRange(f.at, f.at + f.word.length);
              };
              // The document-level "mousedown" outside-click handler runs BEFORE
              // click and steals focus, wiping the selection. Swallow it on both.
              const _swallowDown = (ev) => { ev.preventDefault(); ev.stopPropagation(); };

              tag.addEventListener("mousedown", _swallowDown);
              tag.onclick = (ev) => { ev.stopPropagation(); _revealWord(); };
              const fixB = document.createElement("span"); fixB.textContent = "replace"; fixB.style.cssText = "color:#a8d6f5;cursor:pointer;font-size:10px;";
              fixB.addEventListener("mousedown", _swallowDown);
              const chipWrap = document.createElement("div"); chipWrap.style.cssText = "display:none;gap:5px;flex-wrap:wrap;width:100%;padding:2px 0 4px;";
              const _fixAt = () => f.at;
              fixB.onclick = async (ev) => {
                if (ev) ev.stopPropagation();
                if (chipWrap.style.display === "flex") { chipWrap.style.display = "none"; return; }
                _revealWord();   // show which occurrence is being replaced
                chipWrap.style.display = "flex"; chipWrap.innerHTML = "";
                const loading = _epeThinkingLine(); chipWrap.appendChild(loading);
                const alts = await _epeOllamaWordAlternatives(f.word, textEl.value, chipWrap);
                chipWrap.innerHTML = "";
                if (!alts.length) { const n = document.createElement("span"); n.textContent = "no suggestions"; n.style.cssText = "color:#6d849a;font-size:10px;"; chipWrap.appendChild(n); return; }
                alts.forEach(a => { const chip = document.createElement("span"); chip.textContent = a; chip.style.cssText = "background:rgba(109,184,232,0.14);border:1px solid rgba(140,200,240,0.4);border-radius:5px;color:#a8d6f5;font-size:10px;padding:2px 9px;cursor:pointer;"; chip.addEventListener("mousedown", _swallowDown); chip.onclick = (ev) => { if (ev) ev.stopPropagation(); const at = _fixAt(); if (at>=0) _setText(textEl.value.slice(0,at)+a+textEl.value.slice(at+f.word.length)); _closePopovers(); }; chipWrap.appendChild(chip); });
              };
              const delB = document.createElement("span"); delB.textContent = "delete"; delB.style.cssText = "color:#6d849a;cursor:pointer;font-size:10px;";
              delB.addEventListener("mousedown", _swallowDown);
              delB.onclick = (ev) => { if (ev) ev.stopPropagation(); const at = _fixAt(); if (at>=0) _setText((textEl.value.slice(0,at)+textEl.value.slice(at+f.word.length)).replace(/\s{2,}/g," ").replace(/\s+([,.])/g,"$1")); _closePopovers(); };
              row.appendChild(tag); row.appendChild(fixB); row.appendChild(delB); pop.appendChild(row); pop.appendChild(chipWrap);
            });
            _anchorPopover(pop, flagBtn);
          };

          const wrapBtn = _mk("Wrap ✓", "Toggle word wrap", true);
          let _wrapped = true;
          wrapBtn.onclick = () => { _wrapped = !_wrapped; textEl.wrap = _wrapped ? "soft" : "off"; textEl.style.whiteSpace = _wrapped ? "" : "pre"; textEl.style.overflowX = _wrapped ? "" : "auto"; wrapBtn.textContent = _wrapped ? "Wrap ✓" : "Wrap ✕"; };

          bar.appendChild(fileMenuBtn); bar.appendChild(_sep());
          bar.appendChild(undoBtn); bar.appendChild(redoBtn);
          bar.appendChild(_sep());
          bar.appendChild(findBtn); bar.appendChild(aaBtn); bar.appendChild(cleanBtn); bar.appendChild(synBtn); bar.appendChild(flagBtn);
          bar.appendChild(_sep()); bar.appendChild(fontSizer);
          const spacer = document.createElement("span"); spacer.style.flex = "1"; bar.appendChild(spacer); bar.appendChild(wrapBtn);
          leftPane.insertBefore(bar, editorWrap);

          // Small note: AI-backed tools may vary in speed.
          const aiNote = document.createElement("div");
          aiNote.textContent = "Synonyms and Flag words use AI — speed varies by model and hardware.";
          aiNote.style.cssText = "font-size:9px;color:#5b6b7e;margin:-2px 2px 6px;flex-shrink:0;";
          leftPane.insertBefore(aiNote, editorWrap);

          // ══ prompt tabs ═════════════════════════════════════
          (function _buildPromptTabs() {
            const MAX = 4;
            const props = (_epeOwnerNode && _epeOwnerNode.properties) || {};
            // Load or seed tab state. tabs = array of strings; active = index.
            let _tabs = Array.isArray(props.epe_tabs) && props.epe_tabs.length
              ? props.epe_tabs.slice(0, MAX)
              : [textEl.value || ""];
            let _active = Math.min(props.epe_tab_active || 0, _tabs.length - 1);
            let _lastClosed = null;

            const tabBar = document.createElement("div");
            tabBar.style.cssText = "display:flex;align-items:flex-end;gap:2px;flex-shrink:0;margin-left:-1px;";

            const _persistTabs = () => {
              if (!_epeOwnerNode) return;
              if (!_epeOwnerNode.properties) _epeOwnerNode.properties = {};
              _epeOwnerNode.properties.epe_tabs = _tabs.slice();
              _epeOwnerNode.properties.epe_tab_active = _active;
            };
            // Called by _epePersistPrompt: keep active slot in sync with textarea.
            _epeOwnerNode && (_epeOwnerNode._epeTabSync = () => { _tabs[_active] = textEl.value; _persistTabs(); });

            const _render = () => {
              tabBar.innerHTML = "";
              _tabs.forEach((_, i) => {
                const t = document.createElement("div");
                const on = i === _active;
                t.style.cssText =
                  "display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:10px;cursor:pointer;" +
                  "border:1px solid rgba(109,184,232,0.14);border-bottom:none;border-radius:8px 8px 0 0;" +
                  (on ? "background:#141a24;color:#c2e2f8;font-weight:500;"
                      : "background:#10151d;color:#8ba5be;");
                const lbl = document.createElement("span"); lbl.textContent = "Tab " + (i + 1);
                t.appendChild(lbl);
                if (_tabs.length > 1) {
                  const x = document.createElement("span"); x.textContent = "✕";
                  x.style.cssText = "color:" + (on ? "#7d9cb8" : "#5f748a") + ";font-size:9px;position:relative;";
                  x.onclick = (e) => {
                    e.stopPropagation();
                    _closePopovers();
                    const pop = _mkPopover();
                    pop.style.minWidth = "0";
                    const q = document.createElement("div");
                    q.textContent = "Close tab?";
                    q.style.cssText = "font-size:11px;color:#c2d4e6;margin-bottom:8px;text-align:center;";
                    const row = document.createElement("div");
                    row.style.cssText = "display:flex;gap:6px;";
                    const yes = document.createElement("span");
                    yes.textContent = "Yes";
                    yes.style.cssText = "flex:1;text-align:center;background:rgba(226,168,75,0.15);border:1px solid rgba(226,168,75,0.4);border-radius:5px;color:#e8c88a;font-size:10px;padding:4px 12px;cursor:pointer;";
                    yes.onclick = (ev) => { ev.stopPropagation(); _closePopovers(); _closeTab(i); };
                    const no = document.createElement("span");
                    no.textContent = "No";
                    no.style.cssText = "flex:1;text-align:center;background:rgba(109,184,232,0.1);border:1px solid rgba(109,184,232,0.25);border-radius:5px;color:#a8d6f5;font-size:10px;padding:4px 12px;cursor:pointer;";
                    no.onclick = (ev) => { ev.stopPropagation(); _closePopovers(); };
                    row.appendChild(yes); row.appendChild(no);
                    pop.appendChild(q); pop.appendChild(row);
                    _anchorPopover(pop, x);
                  };
                  t.appendChild(x);
                }
                t.onclick = () => _switchTo(i);
                tabBar.appendChild(t);
              });
              if (_tabs.length < MAX) {
                const add = document.createElement("div");
                add.textContent = "+";
                add.title = "New tab";
                add.style.cssText =
                  "padding:5px 11px;font-size:11px;cursor:pointer;color:#8ba5be;" +
                  "border:1px solid rgba(109,184,232,0.14);border-bottom:none;border-radius:8px 8px 0 0;background:#10151d;";
                add.onclick = () => { _tabs[_active] = textEl.value; _tabs.push(""); _switchTo(_tabs.length - 1); };
                tabBar.appendChild(add);
              }
            };
            const _switchTo = (i) => {
              _tabs[_active] = textEl.value;      // save current
              _active = i;
              textEl.value = _tabs[i] || "";
              textEl.dispatchEvent(new Event("input"));
              _persistTabs(); _render();
            };
            const _closeTab = (i) => {
              _lastClosed = { idx: i, text: _tabs[i] };
              _tabs.splice(i, 1);
              if (_active >= _tabs.length) _active = _tabs.length - 1;
              else if (i < _active) _active--;
              textEl.value = _tabs[_active] || "";
              textEl.dispatchEvent(new Event("input"));
              _persistTabs(); _render();
              _toastUndo("Tab closed.", () => {
                if (!_lastClosed || _tabs.length >= MAX) return;
                _tabs.splice(_lastClosed.idx, 0, _lastClosed.text);
                _active = _lastClosed.idx; _lastClosed = null;
                textEl.value = _tabs[_active] || "";
                textEl.dispatchEvent(new Event("input"));
                _persistTabs(); _render();
              });
            };

            _persistTabs();
            _render();
            editorWrap.insertBefore(tabBar, reviewStrip);
            // Ensure editor shows the active tab on open.
            if ((textEl.value || "") !== (_tabs[_active] || "")) {
              textEl.value = _tabs[_active] || ""; textEl.dispatchEvent(new Event("input"));
            }
            // Master dispose — called by onRemoved when the node is deleted.
            // Releases document-level listeners and observers so the editor DOM
            // isn't retained by closures after removal.
            if (_epeOwnerNode) {
              const _priorDispose = _epeOwnerNode._epeDispose;
              _epeOwnerNode._epeDispose = () => {
                try { _priorDispose && _priorDispose(); } catch (_e) {}
                try { _closePopovers(); } catch (_e) {}
                try { civDetail && civDetail._cleanup && civDetail._cleanup(); } catch (_e) {}
                try { genurDetail && genurDetail._cleanup && genurDetail._cleanup(); } catch (_e) {}
                try { seaartDetail && seaartDetail._cleanup && seaartDetail._cleanup(); } catch (_e) {}
                try { _civScrollObs.disconnect(); } catch (_e) {}
                try { _genurScrollObs.disconnect(); } catch (_e) {}
                try { _seaartScrollObs.disconnect(); } catch (_e) {}
                try { _wfObserver.disconnect(); } catch (_e) {}
                try { typeof _closeStyleMenu === "function" && _closeStyleMenu(); } catch (_e) {}
                try { _epeTip.remove(); } catch (_e) {}
              };
            }
            // Restore hook — ComfyUI restores properties AFTER this builds, so
            // onConfigure calls this to reload saved tabs and repaint.
            if (_epeOwnerNode) {
              _epeOwnerNode._epeTabRestore = () => {
                const pp = _epeOwnerNode.properties || {};
                if (Array.isArray(pp.epe_tabs) && pp.epe_tabs.length) {
                  _tabs = pp.epe_tabs.slice(0, MAX);
                  _active = Math.min(pp.epe_tab_active || 0, _tabs.length - 1);
                  textEl.value = _tabs[_active] || "";
                  textEl.dispatchEvent(new Event("input"));
                  _render();
                }
              };
            }
          })();
          // ═══════════════════════════════════════════════════════════════════

          // ── Instruct-edit row (natural-language targeted edits, neutral) ──
          const ieRow = document.createElement("div");
          ieRow.style.cssText =
            "display:flex;gap:6px;align-items:center;flex-shrink:0;margin:-1px -1px 0;" +
            "background:rgba(109,184,232,0.07);border:1px solid rgba(109,184,232,0.14);" +
            "border-radius:8px 8px 0 0;padding:5px 6px 5px 10px;";
          const iePen = document.createElement("span");
          iePen.textContent = "✎"; iePen.style.cssText = "color:#6db8e8;font-size:11px;";
          const ieInput = document.createElement("input");
          ieInput.placeholder = 'Describe an edit — "change colors to blues and greens", "change her eye color to", "change the lighting to"…';
          ieInput.style.cssText =
            "flex:1;background:none;border:none;outline:none;color:#dce6f2;font-size:11px;";
          const ieBtn = document.createElement("button");
          ieBtn.textContent = "Apply Edit";
          ieBtn.style.cssText =
            "background:rgba(109,184,232,0.2);border:1px solid rgba(140,200,240,0.5);" +
            "border-radius:6px;color:#c2e2f8;font-size:11px;padding:4px 12px;cursor:pointer;";
          let _iePrev = null;
          const _ieReview = document.createElement("div");
          _ieReview.style.cssText = "display:none;gap:6px;margin:0 0 6px;flex-shrink:0;";
          const _ieApply = document.createElement("span");
          _ieApply.textContent = "Apply";
          _ieApply.style.cssText = "background:rgba(93,208,181,0.18);border:1px solid rgba(93,208,181,0.5);border-radius:6px;color:#8fe0cc;font-size:10px;padding:3px 14px;cursor:pointer;";
          const _ieUndo = document.createElement("span");
          _ieUndo.textContent = "Undo";
          _ieUndo.style.cssText = "color:#8ba5be;font-size:10px;padding:3px 10px;cursor:pointer;";
          _ieReview.appendChild(_ieApply); _ieReview.appendChild(_ieUndo);
          _ieApply.onclick = () => { _iePrev = null; _ieReview.style.display = "none"; };
          _ieUndo.onclick = () => { if (_iePrev !== null) { textEl.value = _iePrev; textEl.dispatchEvent(new Event("input")); _iePrev = null; } _ieReview.style.display = "none"; };
          const _runInstructEdit = async () => {
            const instr = ieInput.value.trim();
            if (!instr) return;
            const settings = _epeOllama.getSettings ? _epeOllama.getSettings() : {};
            if (!settings.model) { _toast("No Ollama model selected (AI Setup)."); return; }
            ieBtn.textContent = "…"; ieBtn.disabled = true;
            const sys = "You edit an image-generation prompt by applying the user's instruction. Apply the requested change AND any dependent details that must change with it for the image to stay coherent, but keep everything unrelated identical. Examples of ripple effects: changing gender also updates pronouns, clothing, hairstyle, body description, and gendered words; changing age updates skin, hair, posture, and age-appropriate clothing; changing species swaps human features for that creature's anatomy; changing material updates texture, transparency, and reflections; changing time of day, season, or weather updates lighting, shadows, sky, and environment. Do not change anything the instruction does not imply. Reply with ONLY the full edited prompt, no preamble, no quotes, no explanation.";
            const usr = "PROMPT:\n" + textEl.value + "\n\nINSTRUCTION: " + instr;
            try {
              if (textEl._epePushUndo) textEl._epePushUndo();
              _iePrev = textEl.value;
              const raw = await _epeStreamGenerate(sys, usr, { options: { temperature: 0.4 } }, ieRow,
                (partial) => { textEl.value = partial; textEl.dispatchEvent(new Event("input")); });
              const out = (raw || "").trim();
              if (out) {
                textEl.value = out; textEl.dispatchEvent(new Event("input"));
                _ieReview.style.display = "flex";
                ieInput.value = "";
              } else { if (_iePrev !== null) { textEl.value = _iePrev; textEl.dispatchEvent(new Event("input")); } _toast("No edit returned."); }
            } catch (_e) { if (_iePrev !== null) { textEl.value = _iePrev; textEl.dispatchEvent(new Event("input")); } _toast("Ollama request failed."); }
            ieBtn.textContent = "Apply Edit"; ieBtn.disabled = false;
          };
          ieBtn.onclick = _runInstructEdit;
          ieInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); _runInstructEdit(); } });
          ieRow.appendChild(iePen); ieRow.appendChild(ieInput); ieRow.appendChild(ieBtn);
          leftPane.insertBefore(ieRow, bar);
          leftPane.insertBefore(_ieReview, bar);
        })();
        // ════════════════════════════════════════════════════════════════════

        leftPane.insertBefore(styleSection, aiSettingsPanel);

        // Action rail joins the body row, left of the workspace.
        bodyWrap.insertBefore(actionRail, leftPane);

        // AI Setup becomes a gear in the title bar.
        aiSettingsBtn.textContent = "⚙ AI Setup";
        aiSettingsBtn.title = "AI Setup — Ollama URL, model, and system prompts";
        aiSettingsBtn.style.cssText =
          "background:none;border:none;color:#ffffff;font-size:13px;cursor:pointer;" +
          "padding:0 4px;line-height:1;";
        aiSettingsBtn.style.marginLeft = "0";
        aiSettingsBtn.onmouseenter = () => { aiSettingsBtn.style.color = "#a8d6f5"; };
        aiSettingsBtn.onmouseleave = () => { aiSettingsBtn.style.color = "#ffffff"; };
        try { titleRight.insertBefore(aiSettingsBtn, titleRight.firstChild); } catch (_e) {}

        // ── In-app help panel (? in title bar) ──
        // Overlay covering the body area: topic list left, content right.
        // Topics are plain data — extend _EPE_HELP_TOPICS to add more.
        const _EPE_HELP_TOPICS = [
          {
            id: "quickstart",
            label: "Quick start",
            html:
              '<div style="line-height:1.8;">' +
              '<b style="color:#a8d6f5;">1.</b> Open <b>⚙ AI Setup</b> (title bar) and pick your Ollama model.<br>' +
              '<b style="color:#a8d6f5;">2.</b> Under <b>Wireless targets</b>, click <b>+ Add target</b> and select your CLIP Text Encode node(s).<br>' +
              '<b style="color:#a8d6f5;">3.</b> Write a rough idea in the editor.<br>' +
              '<b style="color:#a8d6f5;">4.</b> Press <b>Enhance</b> — the AI expands it into a full, diffusion-ready prompt.<br>' +
              '<b style="color:#a8d6f5;">5.</b> Queue your workflow — the prompt is injected into your targets automatically.' +
              '</div>' +
              '<div style="margin-top:10px;padding:8px 10px;background:rgba(109,184,232,0.06);border:1px solid rgba(109,184,232,0.15);border-radius:7px;color:#8ba5be;font-size:10px;">' +
              'Tip: pick a Style in <b>Style tuning</b> before enhancing to aim the result at a specific look — toggle <b>Override</b> to restyle an already art-directed prompt.' +
              '</div>',
          },
          {
            id: "wireless",
            label: "Wireless targets",
            html:
              '<div style="line-height:1.8;">' +
              'Wireless targets send your prompt into text widgets elsewhere in the workflow — no wires needed.' +
              '<ul style="margin:6px 0 0;padding-left:18px;line-height:1.7;">' +
              '<li>Click <b>+ Add target</b> and pick a node (e.g. CLIP Text Encode, Text Widget). On every queue, the current prompt is injected into all targets automatically based on the selected tab.</li>' +
              '<li>The badge by the title shows how many targets are active.</li>' +
              '<li>Prefer to wire it yourself? Use EPE as a prompt editor only — skip targets, then copy the prompt and paste it into your node manually.</li>' +
              '</ul>' +
              '</div>',
          },
          {
            id: "transform",
            label: "Transform",
            html:
              '<div style="line-height:1.8;">' +
              '<b>Enhance</b> — expands a short idea into a full, diffusion-ready prompt.<br>' +
              '<b>Variations</b> — generates 3 alternative takes on your prompt to pick from.<br>' +
              '<b>Inverter</b> — rewrites your prompt into a contrasting aesthetic.' +
              '</div>' +
              '<div style="margin-top:10px;padding:8px 10px;background:rgba(109,184,232,0.06);border:1px solid rgba(109,184,232,0.15);border-radius:7px;color:#8ba5be;font-size:10px;">' +
              'Tip: results appear in the editor for review — keep them by clicking <b>Use</b>, or press <b>Undo</b> (Ctrl+Z) to restore your previous text.' +
              '</div>',
          },
          {
            id: "frommedia",
            label: "From media",
            html:
              '<div style="line-height:1.8;">' +
              '<b>Image to Prompt</b> — open any image to describe as a prompt (needs a vision model, e.g. qwen3.5, gemma4).<br>' +
              '<b>Video to Prompt</b> — samples multiple frames from a clip and writes an image prompt from a video.<br>' +
              '<b>Extract from Image</b> — pulls the embedded prompt from a ComfyUI-generated PNG/JPEG/WebP.<br><br>' +
              'You can also run <b>Image to Prompt</b> or <b>Video to Prompt</b> directly on any search result from Civitai, Genur.art, or Sea.art, or just run an <b>Enhance</b> on the image prompt itself — click on/open a search result and use the button in its detail panel.' +
              '</div>',
          },
          {
            id: "styletuning",
            label: "Style tuning",
            html:
              '<div style="line-height:1.8;">' +
              'Pick a <b>Style</b> (Midjourney, DALL·E, Anime, Cinematic…) to have the AI create a prompt that renders an image close to that look/feel. <b>Default</b> resets the style and all sliders. Adjust the sliders alongside the Style for more custom results.<br><br>' +
              '<b>Override Off</b> — the style only fills gaps your prompt leaves open.<br>' +
              '<b>Override On</b> — the style replaces your prompt\'s look; subjects, poses, and scene stay.' +
              '</div>' +
              '<div style="margin-top:10px;padding:8px 10px;background:rgba(109,184,232,0.06);border:1px solid rgba(109,184,232,0.15);border-radius:7px;color:#8ba5be;font-size:10px;">' +
              'Tip: the 6 sliders (Creativity, Length, Focus, Variability, Boldness, Subject grip) fine-tune every transform. Hover over a slider for more tips.' +
              '</div>',
          },
          {
            id: "instructedit",
            label: "Instruct edit",
            html:
              '<div style="line-height:1.8;">' +
              '<ul style="margin:0;padding-left:18px;line-height:1.7;">' +
              '<li>Use the <b>✎</b> row above the toolbar to change your prompt in plain language — e.g. "change the lighting to golden hour" or "make her hair red".</li>' +
              '<li>The edit ripples coherently: changing a subject\'s age, species, or the season also updates related details. Streams into the editor with <b>Apply</b> / <b>Undo</b>.</li>' +
              '</ul>' +
              '</div>',
          },
          {
            id: "editortools",
            label: "Editor tools",
            html:
              '<div style="line-height:1.8;">' +
              '<b>Tabs</b> — up to 4 prompts side by side, saved with your workflow.<br>' +
              '<b>File ▾</b> — save to Favorites/Snippets, clear, import/export text.<br>' +
              '<b>Undo/Redo</b> — Ctrl+Z / Ctrl+Y; also recalls the prompt from before an AI result.<br>' +
              '<b>Find</b>, <b>Aa</b> (case/sort), <b>Clean</b> (strip markdown/weights), <b>Synonyms</b>, <b>Flag words</b> (weak words → replacements), <b>Wrap</b>.' +
              '</div>',
          },
          {
            id: "library",
            label: "Library",
            html:
              '<div style="line-height:1.8;">' +
              'Search prompts from <b>Civitai</b>, <b>Genur.art</b>, and <b>Sea.art</b> — type a term and scroll to load more. Image/video previews included.' +
              '<ul style="margin:6px 0 0;padding-left:18px;line-height:1.7;">' +
              '<li>Click a result to open it, then <b>Use</b>, <b>Enhance</b>, <b>Variations</b>, <b>Save</b>, <b>Image to Prompt</b> on an image, or <b>Video to Prompt</b> on a video result.</li>' +
              '<li><b>Workflows</b> — search and load ComfyUI workflows from the results.</li>' +
              '<li><b>Favorites</b> / <b>Snippets</b> — your saved prompts and reusable fragments.</li>' +
              '</ul>' +
              '</div>',
          },
        ];

        const helpBtn = document.createElement("button");
        helpBtn.textContent = "? Help";
        helpBtn.title = "Help — quick start and feature guides";
        helpBtn.style.cssText =
          "background:none;border:none;color:#ffffff;font-size:13px;cursor:pointer;" +
          "padding:0 4px;line-height:1;";
        helpBtn.onmouseenter = () => { helpBtn.style.color = "#a8d6f5"; };
        helpBtn.onmouseleave = () => { helpBtn.style.color = "#ffffff"; };
        try { titleRight.insertBefore(helpBtn, aiSettingsBtn); } catch (_e) {}

        // Help is a floating, draggable window so users can read it WHILE
        // working in the editor (rather than a full overlay that covers it).
        const helpOverlay = document.createElement("div");
        helpOverlay.style.cssText =
          "position:fixed;display:none;z-index:10001;background:#0f141c;" +
          "top:120px;left:120px;width:440px;height:520px;min-width:280px;min-height:200px;" +
          "border:1px solid rgba(109,184,232,0.35);border-radius:10px;" +
          "box-shadow:0 10px 34px rgba(0,0,0,0.55);box-sizing:border-box;" +
          "flex-direction:column;overflow:hidden;";

        // Drag header
        const helpHdr = document.createElement("div");
        helpHdr.style.cssText =
          "flex-shrink:0;display:flex;align-items:center;justify-content:space-between;" +
          "gap:8px;padding:8px 12px;cursor:move;user-select:none;" +
          "background:rgba(109,184,232,0.10);border-bottom:1px solid rgba(109,184,232,0.20);";
        const helpHdrTitle = document.createElement("div");
        helpHdrTitle.innerHTML = '<span style="color:#c2e2f8;font-size:12px;font-weight:600;">? Help</span>' +
          '<span style="color:#5f7a92;font-size:9px;margin-left:8px;">drag to move</span>';
        helpHdr.appendChild(helpHdrTitle);

        // Single scrolling content column with all sections stacked.
        const helpContent = document.createElement("div");
        helpContent.style.cssText =
          "flex:1;min-height:0;box-sizing:border-box;background:rgba(6,10,16,0.5);" +
          "padding:14px 16px;overflow-y:auto;font-size:12px;color:#9fb4c8;position:relative;";

        const helpClose = document.createElement("button");
        helpClose.textContent = "✕";
        helpClose.title = "Close help";
        helpClose.style.cssText =
          "background:rgba(109,184,232,0.08);border:1px solid rgba(109,184,232,0.25);" +
          "border-radius:6px;color:#a8d6f5;font-size:12px;line-height:1;padding:3px 9px;cursor:pointer;flex-shrink:0;";
        helpClose.onclick = () => { helpOverlay.style.display = "none"; };
        helpHdr.appendChild(helpClose);

        _EPE_HELP_TOPICS.forEach((t, i) => {
          const sec = document.createElement("div");
          sec.style.cssText = i === 0
            ? "margin-bottom:16px;"
            : "border-top:1px solid rgba(109,184,232,0.12);padding-top:14px;margin-bottom:16px;";
          sec.innerHTML =
            '<div style="color:#c2e2f8;font-weight:500;font-size:14px;margin-bottom:6px;">' + t.label + "</div>" + t.html;
          helpContent.appendChild(sec);
        });

        helpOverlay.appendChild(helpHdr);
        helpOverlay.appendChild(helpContent);

        // Resize grip (bottom-right).
        const helpGrip = document.createElement("div");
        helpGrip.title = "Drag to resize";
        helpGrip.style.cssText = [
          "position:absolute;bottom:2px;right:2px;width:16px;height:16px;",
          "cursor:nwse-resize;z-index:3;border-radius:0 0 9px 0;",
          "background:linear-gradient(135deg,",
          "transparent 25%,rgba(109,184,232,0.8) 25%,rgba(109,184,232,0.8) 38%,",
          "transparent 38%,transparent 52%,rgba(109,184,232,0.8) 52%,rgba(109,184,232,0.8) 65%,",
          "transparent 65%,transparent 79%,rgba(109,184,232,0.8) 79%,rgba(109,184,232,0.8) 92%,",
          "transparent 92%);",
        ].join("");
        helpOverlay.appendChild(helpGrip);
        (() => {
          let rz = false, sx = 0, sy = 0, sw = 0, sh = 0;
          const mv = (e) => {
            if (!rz) return;
            helpOverlay.style.width = Math.max(280, sw + e.clientX - sx) + "px";
            helpOverlay.style.height = Math.max(200, sh + e.clientY - sy) + "px";
          };
          const up = () => { rz = false; document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
          helpGrip.addEventListener("mousedown", (e) => {
            e.preventDefault(); e.stopPropagation();
            rz = true; sx = e.clientX; sy = e.clientY;
            sw = helpOverlay.offsetWidth; sh = helpOverlay.offsetHeight;
            document.addEventListener("mousemove", mv);
            document.addEventListener("mouseup", up);
          });
        })();

        document.body.appendChild(helpOverlay);

        // Drag behaviour (header grab).
        (() => {
          let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
          const onMove = (e) => {
            if (!dragging) return;
            const nx = ox + e.clientX - sx, ny = oy + e.clientY - sy;
            helpOverlay.style.left = nx + "px";
            helpOverlay.style.top = ny + "px";
            helpOverlay.style.right = "auto";
          };
          const onUp = () => { dragging = false; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
          helpHdr.addEventListener("mousedown", (e) => {
            if (e.target === helpClose) return;
            e.preventDefault(); e.stopPropagation();
            dragging = true; sx = e.clientX; sy = e.clientY;
            ox = helpOverlay.offsetLeft; oy = helpOverlay.offsetTop;
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
          });
        })();

        helpBtn.onclick = () => {
          const opening = helpOverlay.style.display === "none";
          helpOverlay.style.display = opening ? "flex" : "none";
          if (opening) helpContent.scrollTop = 0;
        };
        // Help lives on document.body (to float free of the node), so it must be
        // explicitly removed when the node is disposed, or it leaks.
        if (_epeOwnerNode) {
          const _prevDispose = _epeOwnerNode._epeDispose;
          _epeOwnerNode._epeDispose = () => {
            try { _prevDispose && _prevDispose(); } catch (_e) {}
            try { helpOverlay.remove(); } catch (_e) {}
          };
        }
        // ─────────────────────────────────────────────────────────────────

        floatingWin.appendChild(titleBar);
        floatingWin.appendChild(toolbar);
        floatingWin.appendChild(bodyWrap);
        floatingWin.appendChild(extractFileInput);
        floatingWin.appendChild(img2imgFileInput);

        // Return the element for addDOMWidget embedding
        requestAnimationFrame(() => {
          textEl.focus();
          textEl.setSelectionRange(textEl.value.length, textEl.value.length);
        });

        return floatingWin;
      }

// ── ComfyUI Node Registration ─────────────────────────────────────────────────

// ── Wireless injection: write each EPE node's prompt into its targets at run ──
// EPE is a pure-UI node (no graph I/O), so wireless delivery happens here: just
// before ComfyUI serializes the prompt, every EPE node's current text is written
// into the live widget of each of its picked targets. ComfyUI's normal serialize
// then carries those values to the backend. Fully self-contained — no WCP needed.
(function _epeInstallWirelessInjection() {
  if (!app || typeof app.graphToPrompt !== "function") return;
  if (app._epeWirelessHooked) return;
  app._epeWirelessHooked = true;

  const _epeForEachNode = (graph, fn, visited) => {
    if (!graph) return;
    visited = visited || new Set();
    const gid = graph.id || graph._id || graph;
    if (visited.has(gid)) return;
    visited.add(gid);
    const nodes = graph._nodes || graph.nodes || [];
    for (const n of nodes) {
      if (!n) continue;
      fn(n);
      const inner = _epeGetInnerGraph(n);
      if (inner) _epeForEachNode(inner, fn, visited);
    }
  };

  const orig = app.graphToPrompt;
  app.graphToPrompt = function () {
    try {
      const rootGraph = (app.canvas?._graph_stack?.length > 0) ? app.canvas._graph_stack[0] : (this.graph || app.graph);
      _epeForEachNode(rootGraph, (n) => {
        const isEpe = (n.type === "EPENode" || n.comfyClass === "EPENode");
        if (!isEpe) return;
        const targets = n.properties && n.properties.epe_wireless_targets;
        if (!Array.isArray(targets) || targets.length === 0) return;
        // Prefer the live editor text; fall back to the persisted prompt so a
        // node whose editor was never opened this session still injects its
        // saved value (matches native-node behavior on reload).
        let text = "";
        if (typeof n._epeGetPrompt === "function") text = n._epeGetPrompt();
        else if (n.properties && typeof n.properties.epe_prompt === "string") text = n.properties.epe_prompt;
        for (const t of targets) {
          try { _epeApplyToTarget(t, text); } catch (_e) {}
        }
      });
    } catch (_e) {}
    return orig.apply(this, arguments);
  };
})();

app.registerExtension({
  name: "EnhancedPromptEditor.Node",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "EPENode") return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    // After ComfyUI restores serialized state (properties) on load, re-sync the
    // editor so restored wireless targets + prompt paint without a manual edit.
    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      try { this._epeDispose && this._epeDispose(); } catch (_e) {}
      return onRemoved?.apply(this, arguments);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      try {
        const self = this;
        // Defer a tick: properties are applied around configure time; this makes
        // sure epe_wireless_targets / epe_prompt are present before we refresh.
        // The editor DOM (and its restore hooks) may still be building, so retry
        // briefly until the hooks exist rather than silently doing nothing.
        let _tries = 0;
        const _tryRefresh = () => {
          _tries++;
          try {
            if (self._epeRefreshFromProps) { self._epeRefreshFromProps(); return; }
          } catch (_e) { return; }
          if (_tries < 20) setTimeout(_tryRefresh, 50);
        };
        setTimeout(_tryRefresh, 0);
      } catch (_e) {}
      return r;
    };

    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);

      const epeEl = _epeOpenEPEStandalone(this);
      if (!epeEl) return r;

      const _node = this;
      const _epeFullW = 980;
      const _epeFullH = 640;
      const _titleH = LiteGraph.NODE_TITLE_HEIGHT ?? 30;

      // Embed via addDOMWidget.
      // getMinHeight drives the DOM widget container height.
      // floatingWin is height:100% so it always fills whatever the container gets.
      const _epeMinH = 200; // fixed floor — never tracks current size
      const _epeWidget = this.addDOMWidget("epe_editor", "EPE", epeEl, {
        getMinHeight: () => _epeMinH,
        getMinWidth:  () => _epeFullW,
      });
      if (_epeWidget) _epeWidget._epeH = _epeFullH;

      // Helper: sync widget.computedHeight and node.size atomically
      const _applySize = (w, h) => {
        if (_epeWidget) {
          _epeWidget._epeH = h;
          _epeWidget.computedHeight = h;
        }
        _node.size[0] = w;
        _node.size[1] = h + _titleH + 8;
        app.graph.setDirtyCanvas(true, true);
      };

      // Initial size
      _applySize(_epeFullW, _epeFullH);
      this.resizable = true;

      // When the user drags to resize the node, update widget height to match.
      // floatingWin is height:100% so it fills the new container size automatically.
      this.onResize = function() {
        const h = Math.max(200, _node.size[1] - _titleH - 8);
        if (_epeWidget) {
          _epeWidget._epeH = h;
          _epeWidget.computedHeight = h;
        }
        app.graph.setDirtyCanvas(true, true);
      };

      // In-panel resize grip. The node is resizable via LiteGraph's native
      // canvas handle, but the EPE DOM panel overlays the node and hides it —
      // so users couldn't find a way to make the window bigger (needed to see
      // the Advanced AI-setup section). This adds an obvious drag corner that
      // drives the same _applySize path.
      if (epeEl) {
        const _rGrip = document.createElement("div");
        _rGrip.title = "Drag to resize";
        _rGrip.style.cssText = [
          "position:absolute;bottom:2px;right:2px;width:18px;height:18px;",
          "cursor:nwse-resize;z-index:50;border-radius:0 0 8px 0;",
          "background:linear-gradient(135deg,",
          "transparent 25%,rgba(109,184,232,0.8) 25%,rgba(109,184,232,0.8) 38%,",
          "transparent 38%,transparent 52%,rgba(109,184,232,0.8) 52%,rgba(109,184,232,0.8) 65%,",
          "transparent 65%,transparent 79%,rgba(109,184,232,0.8) 79%,rgba(109,184,232,0.8) 92%,",
          "transparent 92%);",
        ].join("");
        let _rgDrag = false, _rgX = 0, _rgY = 0, _rgW = 0, _rgH = 0;
        const _rgMove = (e) => {
          if (!_rgDrag) return;
          const w = Math.max(_epeFullW, _rgW + (e.clientX - _rgX));
          const h = Math.max(200, _rgH + (e.clientY - _rgY));
          _applySize(w, h);
        };
        const _rgUp = () => {
          _rgDrag = false;
          window.removeEventListener("mousemove", _rgMove);
          window.removeEventListener("mouseup", _rgUp);
        };
        _rGrip.addEventListener("mousedown", (e) => {
          e.preventDefault(); e.stopPropagation();
          _rgDrag = true;
          _rgX = e.clientX; _rgY = e.clientY;
          _rgW = _node.size[0];
          _rgH = Math.max(200, _node.size[1] - _titleH - 8);
          window.addEventListener("mousemove", _rgMove);
          window.addEventListener("mouseup", _rgUp);
        });
        epeEl.appendChild(_rGrip);
      }

      return r;
    };
  },
});
