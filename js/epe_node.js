/**
 * Enhanced Prompt Editor — Standalone ComfyUI Node
 * The EPE renders directly inside the node on the canvas via addDOMWidget().
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const _epeFont = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

// ── Live-editor registry, and the orphan sweep ────────────────────────────────
//
// WHY THIS EXISTS. An EPE node inside a ComfyUI subgraph never runs
// `_epeDispose`, so every workflow load leaks a capture-phase `document`
// mousedown listener closing over the whole editor scope, plus `_epeTip` and
// the help overlay on `document.body` and a ResizeObserver.
//
// Read out of the SHIPPED comfyui-frontend-package 1.49.6 bundle
// (settingStore-CwkLtSKP.js), not inferred:
//
//   LGraph.clear()            (:383310)  `this._subgraphs.clear()` runs BEFORE
//                                        the removal loop, and that loop
//                                        iterates `this._nodes` — the ROOT
//                                        graph's own nodes — only.
//   SubgraphNode.onRemoved()  (:263380)  aborts its own controller and clears
//                                        promoted/extra widgets. It does NOT
//                                        recurse into `subgraph.nodes`.
//   app.clean()              (:1655527)  -> `this.rootGraph.clear()`
//   loadGraphData()          (:1640144)  calls `this.clean()` BEFORE
//                                        `invokeExtensionsAsync("beforeConfigureGraph")`
//
// That last line is why the sweep hangs off `onNodeCreated` and not
// `beforeConfigureGraph`: by the time that hook runs the graph is already
// cleared and the orphans are already unreachable from it. Measured on the
// shipped build: a root-level node holds at 1 document listener over 20 loads;
// a subgraph-resident one climbs to 20.
//
// WHY A REGISTRY AND NOT A GRAPH WALK. `clear()` empties `_subgraphs` first, so
// after it there is nothing left in the graph to walk TO the orphans. The only
// thing that still knows they exist is a reference we kept ourselves.
//
// SAFETY. Disposing a LIVE editor destroys the user's prompt, so every
// uncertainty here resolves to "do nothing":
//   * any shape it cannot walk — no rootGraph, `_nodes` not an array,
//     `subgraphs` not iterable, a subgraph whose `_nodes` is not an array —
//     abandons the whole sweep rather than sweeping a partial `live` set;
//   * the node whose `onNodeCreated` is running is excluded by identity, since
//     LiteGraph calls `createNode` -> `onNodeCreated` BEFORE `graph.add`, so it
//     is legitimately in no graph yet;
//   * a node whose graph belongs to a different root (clipboard staging, a
//     detached graph) is left alone.
//
// ORDERING, verified in `LGraph.configure` (:408374): subgraphs are created
// (`createSubgraph`) and configured — which is what builds their nodes — BEFORE
// `this._nodes = []` and the root creation loop. And within either loop, each
// node is `add`ed before the next is created. So every node created earlier in
// this same load is already reachable, and the sweep cannot mistake a sibling
// for an orphan.
const _epeLiveEditors = new Set();

const _epeSweepDeadEditors = (exceptNode) => {
  try {
    const root = app && app.rootGraph;
    if (!root) return;
    const rootNodes = root._nodes;
    if (!Array.isArray(rootNodes)) return;
    const subs = root.subgraphs;
    if (!subs || typeof subs.values !== "function") return;

    const live = new Set(rootNodes);
    for (const sg of subs.values()) {
      const ns = sg && sg._nodes;
      // A subgraph we cannot read means the live set is INCOMPLETE, and an
      // incomplete live set is exactly how a live editor gets disposed. Stop.
      if (!Array.isArray(ns)) return;
      for (const n of ns) live.add(n);
    }

    for (const n of Array.from(_epeLiveEditors)) {
      if (n === exceptNode) continue;
      if (live.has(n)) continue;
      let g = null;
      try { g = n.graph; } catch (_e) { g = null; }
      if (g) {
        let gr = null;
        try { gr = g.rootGraph; } catch (_e) { gr = undefined; }
        // Unreadable, or rooted somewhere else — not ours to tear down.
        if (gr !== root) continue;
      }
      _epeLiveEditors.delete(n);
      try { n._epeDispose && n._epeDispose(); } catch (_e) {}
    }
  } catch (_e) {}
};

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

  // Keyed by the GRAPH OBJECT, which is what "have I walked this already"
  // means. It used to be keyed by the id-chain to the graph — but the chain
  // gains a node id at every level, so the key was unique by construction and
  // `visited.has()` was NEVER true. The comment here said so and concluded
  // that the depth bound was what stopped it; the depth bound stops depth,
  // not breadth.
  //
  // ComfyUI shares one Subgraph object across every instance of a definition,
  // so a definition instantiated twice per level is reachable by 2^depth
  // distinct paths, and every one of them was walked and pushed:
  //
  //     levels  entries      time     heap
  //       14     49,150     0.13 s    21 MB
  //       18    786,430     2.27 s   162 MB
  //       20  3,145,726    12.23 s   752 MB
  //
  // At the depth cap that is tens of millions of entries — out of memory and
  // the tab gone, taking the unsaved prompt with it — from a few kilobytes of
  // workflow JSON, and reached synchronously the moment the user opens the
  // wireless target picker.
  //
  // Two instances of the same definition therefore now yield ONE walk of that
  // definition's contents, which is the right answer: the entries are keyed by
  // the id-chain at the point of use, and the picker lists widgets, not
  // instances.
  if (visited.has(graph)) return;
  if (chain.length > 24) return;
  visited.add(graph);

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
//     bindWidgetName, bindWidgetLabel, _bindRef:{nodeKey,nodeType,nodeTitle,slotName} }
// chainKey is the colon-joined node path through subgraphs (e.g. "88:30:45").
// The relocation cascade keeps a target valid when the graph is restructured:
//   Tier 1: direct chain-key lookup
//   Tier 2: deep leaf-ID search across all subgraphs
//   Tier 3: nodeType + widget-name match with title scoring
// (There was a fourth "grace period" step here. It returned null exactly like
// the miss it was meant to soften, so it did nothing but stamp a wall-clock
// timestamp into the workflow JSON — see the end of _epeLookupTargetNode.)

// _bindRef is DERIVED state — every field in it is recomputed from the four
// bind* siblings on the next resolve — but it was a plain property on a target
// that lives in node.properties.epe_wireless_targets. So it serialised into
// every saved workflow: four duplicated fields per target, in a file other
// people open, for no purpose. Same reasoning that removed _missTime in round
// 11.
//
// Non-enumerable keeps it out of JSON.stringify and LiteGraph's clone while
// staying an ordinary property to read. Targets loaded from a workflow saved
// before this carry an enumerable one; the resolver re-defines it on first
// touch, so the next save drops it.
function _epeSetBindRef(target, ref) {
  try {
    Object.defineProperty(target, "_bindRef", {
      value: ref, writable: true, enumerable: false, configurable: true,
    });
  } catch (_e) {
    target._bindRef = ref;
  }
  return target._bindRef;
}

function _epeWidgetLabel(w) {
  return String(w?.label ?? w?.name ?? w?.type ?? "Widget");
}

// Is this node a legitimate RELOCATION target for `ref`?
//
// Used by Tier 2 and Tier 3 — the tiers that pick a different node and then
// rewrite the stored binding to it. Tier 1 (the exact-key fast path) does NOT
// use this: there the key already names the node, and insisting on the title
// would break the ordinary act of renaming one.
//
// Two things it insists on that Tier 2 used to skip:
//
//   The TITLE and the SLOT, not just the class. Class alone is not evidence —
//   CLIPTextEncode is the overwhelmingly common case, ids are reused per
//   workflow tab and after delete+add, and Tier 2 took the first node that
//   merely shared the class, then wrote the new key into target.bind. That
//   lives in node.properties.epe_wireless_targets, so the mis-binding is saved
//   into the workflow and travels with the file. Measured: a target bound to
//   the "Negative Encoder" inside a subgraph silently re-bound to the Positive
//   Encoder, pill green, negative prompt text into the positive slot, from
//   then on, in the file too. Tier 3 has insisted on title + slot since round
//   6; Tier 2 runs first and did not.
//
//   MUTED (mode 2) and BYPASSED (mode 4) nodes are not candidates.
//   _epeEnumerateTextTargets refuses them, so the user was never offered one —
//   yet the resolver would relocate a live binding onto a muted clone, report
//   success, and paint the pill green while the prompt went into a node
//   ComfyUI will not execute. A target the user muted deliberately still
//   resolves through Tier 1; this only stops relocation from CHOOSING one.
function _epeRefCandidate(n, ref) {
  if (!n || !ref) return false;
  if (n.mode === 2 || n.mode === 4) return false;
  if (ref.nodeType && (n.type || "") !== ref.nodeType) return false;
  if (ref.nodeTitle && (n.title || n.type || "") !== ref.nodeTitle) return false;
  if (ref.slotName != null &&
      !(n.widgets || []).some(w => w && w.name === ref.slotName)) return false;
  return true;
}

// Tier-cascade node lookup. Mutates ref.nodeKey when a node is relocated so the
// next resolve takes the fast path. Returns the live node or null.
function _epeLookupTargetNode(ref) {
  if (!ref || !ref.nodeKey) return null;

  // Tier 1 — direct chain-key lookup. Same rule as Tier 2: ids are reused
  // (per-tab, and after delete + add), so a type mismatch is a MISS that
  // falls through to the deeper tiers, not a hit.
  const direct = _epeFindNodeGlobal(ref.nodeKey);
  if (direct && (!ref.nodeType || (direct.type || "") === ref.nodeType)) {
    if (!ref.nodeType && direct.type) ref.nodeType = direct.type;
    if (!ref.nodeTitle && (direct.title || direct.type)) ref.nodeTitle = direct.title || direct.type;
    return direct;
  }

  const rootGraph = (app.canvas?._graph_stack?.length > 0) ? app.canvas._graph_stack[0] : app.graph;

  // Tier 2 — deep leaf-ID search across all subgraphs
  const leafId = parseInt(String(ref.nodeKey).split(":").pop());
  if (!isNaN(leafId)) {
    const rootNode = _epeGetNode(rootGraph, leafId);
    // Ids are reused after a delete and are per workflow tab, so "a node
    // with this id exists" is not evidence it is the RIGHT node. Without
    // this check a copied node bound to 30:6 latched onto whatever held id
    // 6 in the new tab — and then wrote its own class into the ref, so the
    // mis-binding looked confirmed ever after.
    if (_epeRefCandidate(rootNode, ref)) {
      ref.nodeKey = String(leafId);
      if (!ref.nodeType && rootNode.type) ref.nodeType = rootNode.type;
      if (!ref.nodeTitle && (rootNode.title || rootNode.type)) ref.nodeTitle = rootNode.title || rootNode.type;
      return rootNode;
    }
    // `visited` and the depth bound are the same guards _epeTraverseNodes has
    // and this did not: a self-referential subgraph — the shape a hand-edited
    // or shared workflow produces — recursed until "RangeError: Maximum call
    // stack size exceeded", and the call site in renderWireless has no
    // try/catch, so the whole wireless panel failed to render.
    const deepSearch = (graph, chain, visited) => {
      if (!graph) return null;
      if (!visited) visited = new Set();
      if (visited.has(graph)) return null;
      if (chain.length > 24) return null;
      visited.add(graph);
      const nodes = graph._nodes || graph.nodes || [];
      for (const n of nodes) {
        if (!n || !n.id) continue;
        const inner = _epeGetInnerGraph(n);
        if (inner) {
          const newChain = [...chain, n.id];
          const found = _epeGetNode(inner, leafId);
          if (_epeRefCandidate(found, ref))
            return { node: found, chainKey: [...newChain, leafId].join(":") };
          const deeper = deepSearch(inner, newChain, visited);
          if (deeper) return deeper;
        }
      }
      return null;
    };
    const result = deepSearch(rootGraph, [], new Set());
    if (result) {
      ref.nodeKey = result.chainKey;
      if (!ref.nodeType && result.node.type) ref.nodeType = result.node.type;
      if (!ref.nodeTitle && (result.node.title || result.node.type)) ref.nodeTitle = result.node.title || result.node.type;
      return result.node;
    }
  }

  // Tier 3 — nodeType + widget-name match with title scoring
  if (ref.nodeType) {
    const matchByType = (graph, chain, visited) => {
      if (!graph) return null;
      // Same guards as deepSearch above, and for the same reason.
      if (!visited) visited = new Set();
      if (visited.has(graph)) return null;
      if (chain.length > 24) return null;
      visited.add(graph);
      const nodes = graph._nodes || graph.nodes || [];
      // Gather ALL candidates, then insist on one. The old code took the
      // best score with a floor of 1 — class matches, title does not — and
      // broke ties by array order, so a binding on the negative encoder
      // silently moved to the positive one and stayed there.
      const cands = [];
      for (const n of nodes) {
        if (!n || !n.id) continue;
        // Class + slot as before, plus the mute/bypass exclusion — this tier
        // would otherwise relocate a live binding onto a muted clone that the
        // picker would never have offered. The title is scored below rather
        // than required here, which is what lets a renamed node still be
        // found when it is the only candidate.
        if (n.mode === 2 || n.mode === 4) continue;
        if ((n.type || "") !== ref.nodeType) continue;
        let slotOk = true;
        if (ref.slotName != null) {
          slotOk = (n.widgets || []).some(w => w && w.name === ref.slotName);
        }
        if (!slotOk) continue;
        cands.push({ node: n, chain, titled: !!(ref.nodeTitle && (n.title || n.type) === ref.nodeTitle) });
      }
      // A title match beats an untitled one; if any titled candidate
      // exists, only those are eligible.
      const titled = cands.filter(c => c.titled);
      const pool = titled.length ? titled : (ref.nodeTitle ? [] : cands);
      // Exactly one, or none. Two identical CLIPTextEncodes are a genuine
      // ambiguity and the honest answer is to stay unresolved and show the
      // red dot, not to pick one and rewrite the binding to it.
      let bestMatch = (pool.length === 1) ? pool[0] : null;
      if (bestMatch) {
        const newKey = bestMatch.chain.length ? [...bestMatch.chain, bestMatch.node.id].join(":") : String(bestMatch.node.id);
        ref.nodeKey = newKey;
        return bestMatch.node;
      }
      for (const n of nodes) {
        if (!n || !n.id) continue;
        const inner = _epeGetInnerGraph(n);
        if (inner) {
          const found = matchByType(inner, [...chain, n.id], visited);
          if (found) return found;
        }
      }
      return null;
    };
    const matched = matchByType(rootGraph, [], new Set());
    if (matched) return matched;
  }

  // No grace period here any more. It was dead code — both branches
  // returned null, so it never tolerated anything — and its one real effect
  // was writing Date.now() into ref._missTime. That ref is part of
  // node.properties.epe_wireless_targets, which serializes into the workflow
  // JSON, so every shared workflow holding an unresolved target carried a
  // machine-local timestamp that changed on each save: noise in a file other
  // people open, and a spurious diff for anyone version-controlling
  // workflows.
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

  // `!target._bindRef` is FALSE for a string or a number, so a workflow saved
  // before _bindRef was made non-enumerable — or hand-edited — fell through
  // and assigned a property on a primitive: a TypeError under module strict
  // mode. Caught per target upstream, so the visible symptom was a wireless
  // target that silently never received the prompt.
  if (!target._bindRef || typeof target._bindRef !== "object") {
    _epeSetBindRef(target, {
      nodeKey,
      nodeType: target.bindNodeType || null,
      nodeTitle: target.bindNodeTitle || null,
      slotName: target.bindWidgetName || null,
    });
  } else if (Object.prototype.propertyIsEnumerable.call(target, "_bindRef")) {
    // Loaded from a workflow saved before _bindRef was hidden. Re-define it so
    // this file stops carrying it too.
    _epeSetBindRef(target, target._bindRef);
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
      // The saved name is gone. Falling back to the stored INDEX is a
      // guess, so it only counts if what is there still takes text.
      const byIdx = Number.isFinite(wIndex) ? ws[wIndex] : null;
      w = _epeWidgetTakesText(byIdx) ? byIdx : null;
    }
  } else {
    const byIdx = Number.isFinite(wIndex) ? ws[wIndex] : null;
    w = _epeWidgetTakesText(byIdx) ? byIdx : null;
  }

  if (!w) return null;
  // Last line of defence: even a name match can land on a renamed widget
  // of the wrong kind after a node is updated.
  if (!_epeWidgetTakesText(w)) return null;
  return { node, widget: w, widgetIndex: resolvedIndex, nodeKey: target._bindRef.nodeKey };
}

// Write text into a target's resolved widget. Returns true on success.
function _epeApplyToTarget(target, text) {
  const r = _epeResolveTargetWidget(target);
  if (!r || !r.widget) return false;
  if (!_epeWidgetTakesText(r.widget)) return false;
  try { r.widget.value = text; } catch (_e) { return false; }
  // Setting .value alone is invisible to the target: nodes that recompute
  // on their own widget changes (token counters, wildcard expanders) never
  // saw the injected prompt, and the canvas kept painting the old text.
  try { if (typeof r.widget.callback === "function") r.widget.callback(text, app.canvas, r.node); } catch (_e) {}
  try { if (typeof r.node.onWidgetChanged === "function") r.node.onWidgetChanged(r.widget.name, text, undefined, r.widget); } catch (_e) {}
  try { app.graph && app.graph.setDirtyCanvas(true, true); } catch (_e) {}
  return true;
}

// Does this widget hold free text? The wireless write used to assign the prompt
// to whatever widget the index landed on, with no type check on any path — and
// on a KSampler index 0 is `seed`.
const _EPE_TEXT_WIDGET_TYPES = ["customtext", "text", "string", "textarea"];
function _epeWidgetTakesText(w) {
  if (!w) return false;
  const t = String(w.type || "").toLowerCase();
  if (_EPE_TEXT_WIDGET_TYPES.indexOf(t) >= 0) return true;
  // A combo is a string too, and writing a prompt into one is never right.
  if (t === "combo" || t === "number" || t === "slider" || t === "toggle" ||
      t === "boolean" || t === "button") return false;
  // Some custom nodes ship an untyped textarea widget. Accept only if the
  // value it already holds is a string.
  return t === "" && typeof w.value === "string";
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
  _epeSetBindRef(target, {
    nodeKey: String(sel.bindKey).slice(0, String(sel.bindKey).lastIndexOf("|")),
    nodeType: target.bindNodeType,
    nodeTitle: target.bindNodeTitle,
    slotName: target.bindWidgetName,
  });
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
  // The ROOT graph, not app.graph. app.graph is whatever the user has
  // navigated INTO, so opening this picker from inside a subgraph listed only
  // that subgraph's widgets — and, worse, produced bind keys relative to it.
  // _epeLookupTargetNode resolves from the root, so those keys either missed
  // or, because node ids are reused per graph, latched onto the wrong node.
  // Same expression the resolver and _epeFindNodeGlobal already use.
  const _rootGraph = (app.canvas?._graph_stack?.length > 0)
    ? app.canvas._graph_stack[0] : app.graph;
  try { _epeTraverseNodes(_rootGraph, [], 'Root', entries, true); } catch(_e) { return results; }
  for (const e of entries) {
    if (e.isSubgraph || !e.node) continue;
    const n = e.node;
    if (n.mode === 2 || n.mode === 4) continue;
    if (!n.widgets) continue;
    for (let wi = 0; wi < n.widgets.length; wi++) {
      const w = n.widgets[wi];
      // LiteGraph leaves a hole in `widgets` after some removals, and `w.type`
      // on it threw out of the enumerator — so the target picker would not
      // open at all, with no message.
      if (!w || w.type !== 'customtext') continue;
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

// The picker overlay lives on document.body, outside every editor's own
// subtree, so nothing that tears an editor down can reach it by removing its
// DOM. It also closes over `entries`, which carry {widget, node} for EVERY
// text widget in the graph — so one stranded overlay pins the whole graph and
// the editor that opened it. Measured: 12 MB per node rebuild.
//
// Module scope, because the picker is a module-level function and two editors
// must not each think they own the live one.
let _epePickerOverlay = null;
function _epeCloseTargetPicker() {
  const o = _epePickerOverlay;
  _epePickerOverlay = null;
  try { if (o) o.remove(); } catch (_e) {}
}

function _epeShowTargetPicker(currentBindKey, onSelect) {
  // Only ever one. Clicking "Add target" five times used to stack five
  // overlays, and a backdrop click removed only the top one.
  _epeCloseTargetPicker();
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
  // Through the closer, so the slot is cleared with the element — a bare
  // remove() left _epePickerOverlay pointing at a detached node, which is the
  // same retention with an extra step.
  overlay.onclick = (ev) => { if (ev.target === overlay) _epeCloseTargetPicker(); };

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
  _epePickerOverlay = overlay;
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
          // String(): a node whose `title` is a number in the workflow JSON
          // made this throw on EVERY KEYSTROKE in the picker's search box.
          String(e.nodeTitle || "").toLowerCase().includes(f) ||
          String(e.widgetLabel || "").toLowerCase().includes(f) ||
          String(e.widgetName || "").toLowerCase().includes(f) ||
          String(e.path || "").toLowerCase().includes(f) ||
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
  // Open a new blank tab FIRST. If that step fails — older ComfyUI, the
  // command renamed, an extension that swallows it — the previous version
  // fell through to loading directly into the LIVE canvas, destroying the
  // user's current graph and any unsaved EPE prompt with it. A button
  // labelled "Load Workflow" cannot silently do that.
  //
  // Exception: if the current graph is EMPTY, there is nothing to destroy
  // and the "load into current tab" fallback is functionally identical to
  // "load into a new tab" — so users on older ComfyUI (where the new-tab
  // command doesn't exist) still have a working Load button on a blank
  // canvas. If the current graph has any nodes, refuse.
  const _openNewTab = async () => {
    await app.extensionManager.commands.execute('Comfy.NewBlankWorkflow');
    // Wait two rAF frames for the new tab to become active and its
    // workflow UUID to be assigned.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  };
  const _currentGraphIsEmpty = () => {
    try {
      const nodes = app.graph?._nodes;
      // A canvas with zero nodes has nothing to lose; treat as safe fallback.
      return Array.isArray(nodes) && nodes.length === 0;
    } catch (_e) { return false; }
  };
  const _tabOrEmptyCanvasFallback = async () => {
    try { await _openNewTab(); return true; }
    catch (e) {
      if (_currentGraphIsEmpty()) return false;   // fall through to load-into-current
      throw new Error("Could not open a new workflow tab — refusing to overwrite the current one. (" + ((e && e.message) || e) + ")");
    }
  };

  // API-format graphs (from a PNG's 'prompt' chunk) load via loadApiJson.
  if (format === "api") {
    if (typeof app.loadApiJson !== "function") {
      throw new Error("This ComfyUI version cannot load API-format workflows");
    }
    await _tabOrEmptyCanvasFallback();
    await app.loadApiJson(templateJSON, "workflow.json");
    return;
  }

  const _newTabOpened = await _tabOrEmptyCanvasFallback();

  // Patch the template UUID to match the new tab so loadGraphData loads
  // INTO the current (newly-opened) tab rather than spawning a second one.
  // On the empty-canvas fallback we skip the patch — we want the template's
  // OWN id, not the (possibly generated) empty-canvas one.
  if (_newTabOpened) {
    const currentId = app.graph?.serialize?.()?.id;
    const patched = Object.assign({}, templateJSON);
    if (currentId) patched.id = currentId;
    await app.loadGraphData(patched);
  } else {
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
  // hasOwnProperty, not a bare index. styleId round-trips through
  // node.properties — shared, hand-editable workflow JSON — so an id of
  // "constructor" or "toString" resolved to a function off Object.prototype
  // instead of missing. `rules` was then truthy with no .exclude and no
  // pools, so the style silently contributed nothing at all.
  const _hasRule = styleId && styleId !== "default" &&
    Object.prototype.hasOwnProperty.call(_EPE_STYLE_POOL_RULES, styleId);
  const rules = _hasRule ? _EPE_STYLE_POOL_RULES[styleId] : null;
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

SUBJECT FIDELITY — layered. Not everything the user wrote is protected the same way, and treating it all as locked is why prompts come back sounding like the input.

LOCKED, word for word. Subject nouns, counts and numbers, named actions and poses, proper nouns, and anything in "double quotes" carry through exactly as the user typed them.
- User wrote "elephant" → output says elephant. Not jaguar, not pachyderm, not "a sacred creature."
- User wrote "three children playing chess" → three children playing chess. Not two, not a trio of youngsters, not checkers.
A synonym is a subject change. Diffusion text encoders do not read "elephant" and "pachyderm" as the same thing, so swapping one for the other costs you the subject and buys nothing.

KEPT, but reworded. Setting, mood, and any attribute the user specified survive in meaning — expressed in your own fresh wording, not theirs.

NEVER DROPPED. If the user wrote it, it appears somewhere in your output.

EVERYTHING ELSE IS YOURS. Adjectives, sentence shapes, descriptive vocabulary, and the order you reveal things in are all your choice. Do not build your prompt by threading new words around the user's original phrasing — write fresh sentences that happen to contain the locked terms.

If a tradition implies a different subject, apply its technique to the user's actual subject.

IMMERSIVE VISUAL DETAIL — every noun earns concrete visible detail. Flesh out what the user left generic.

INVENTION QUOTA — your output must introduce AT LEAST 8 concrete visual specifics that are not in the user's description and are not restatements of it. A specific is something a viewer could point at: a material, a named colour, a light direction, a surface behaviour, a spatial relationship, a garment, a time of day, a weather condition. Count them before you answer. Preserving the subject is the floor, not the task — a prompt that says only what the user already said has failed. If an instruction below shortens the output, scale this to roughly one new specific per 20 words.

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

SUBJECT FIDELITY — layered, across all three variations. Not everything in the source is protected the same way, and treating it all as locked is why variations come back as paraphrases of each other.

LOCKED, word for word, in every variation. Subject nouns, counts and numbers, named actions and poses, proper nouns, and anything in "double quotes" carry through exactly as the source has them.
- Source says "elephant" → all three variations say elephant. Not jaguar, not pachyderm.
- Source says "three children playing chess" → all three have three children playing chess. Not a trio of youngsters, not checkers.
A synonym is a subject change. Diffusion text encoders do not read "elephant" and "pachyderm" as the same thing, so swapping one for the other costs you the subject and buys nothing.

KEPT, but reworded — differently in each variation. Setting, mood, and any attribute the source specified survive in meaning, in wording that belongs to that variation's tradition.

NEVER DROPPED. If the source says it, every variation contains it.

EVERYTHING ELSE IS YOURS. Adjectives, sentence shapes, descriptive vocabulary, and the order you reveal things in are your choice, and should differ sharply between the three. Do not use the source's sentences as a template and swap words inside them — write each variation from scratch around the locked terms. If two variations could be diffed word by word, you have written one variation three times.

If a tradition implies a different subject, pick another or apply its technique to the actual subject.

IMMERSIVE VISUAL DETAIL — every noun earns concrete visible detail, in every variation. Generic "lawn" → neatly edged, lush emerald green, freshly mowed. Generic "woman" → age range, eye color, hair, expression, posture, fabric and cut of clothing. DO NOT invent ethnicity, religion, or identity-defining traits the user didn't specify. Surfaces get active behavior: subsurface scattering, fabric fibers in rim light, wet asphalt holding oil-slick rainbow. The rendering tradition you pick isn't just named — its vocabulary describes the scene.

INVENTION QUOTA — each variation must introduce AT LEAST 6 concrete visual specifics that are not in the source, and no specific may be reused between variations. A specific is something a viewer could point at: a material, a named colour, a light direction, a surface behaviour, a spatial relationship, a garment, a time of day, a weather condition. Count them before you answer. Preserving the subject is the floor, not the task — a variation that says only what the source already said has failed.

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

SUBJECT FIDELITY — layered. What changes is the AESTHETIC WORLD. What does NOT change is the subject. But not everything in the source is protected the same way, and treating it all as locked is why counterparts come back as paraphrases.

LOCKED, word for word. Subject nouns, counts and numbers, named actions and poses, proper nouns, and anything in "double quotes" carry through exactly as the source has them.
- Source says "elephant" → counterpart says elephant, in a different aesthetic. Not jaguar, not pachyderm.
- Source says "three children playing chess" → counterpart has three children playing chess. Not a trio of youngsters, not checkers.
A synonym is a subject change. Diffusion text encoders do not read "elephant" and "pachyderm" as the same thing, so swapping one for the other costs you the subject and buys nothing.

KEPT, but reworded. Setting, mood, and any attribute the source specified survive in meaning, expressed in the new tradition's vocabulary rather than the source's.

NEVER DROPPED. If the source says it, the counterpart contains it.

EVERYTHING ELSE IS YOURS. Adjectives, sentence shapes, descriptive vocabulary, and the order you reveal things in are all your choice. Do not use the source's sentences as a template and swap words inside them — write the counterpart from scratch around the locked terms. If the counterpart could be diffed against the source phrase by phrase, you have edited it rather than reimagined it.

If a tradition implies a different subject, pick another, or apply its technique to the user's actual subject.

IMMERSIVE VISUAL DETAIL — every noun earns concrete visible detail in the counterpart, same as the source. Generic "woman" → age range, eye color, hair, expression, posture, clothing. DO NOT invent ethnicity, religion, or identity-defining traits not in the source. Surfaces get active behavior: subsurface scattering, fabric fibers in rim light, impasto brushstrokes — whatever the new tradition's materials actually do.

INVENTION QUOTA — the counterpart must introduce AT LEAST 6 concrete visual specifics that are not in the source. A specific is something a viewer could point at: a material, a named colour, a light direction, a surface behaviour, a spatial relationship, a garment, a time of day, a weather condition. Count them before you answer. Preserving the subject is the floor, not the task — a counterpart that says only what the source already said has failed.

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

Output ONLY the inverted prompt paragraph. No preamble, no explanation, no <think> tags.`,

    instructPrompt: `You revise image generation prompts for modern open-weight diffusion models (Flux 2, Qwen-Image, Z-Image, and similar) by carrying out a direction the user gives you. Think of yourself as taking notes from an art director: they say what they want changed, you rewrite the prompt so it is true.

SUBJECT — preserved by default. Every named thing in the prompt — person, animal, object, place, count, action, pose — survives unless the user's direction explicitly asks you to change it. "Reframe this as a war photograph" rebuilds the whole world around the subject but keeps the subject. "Make the woman a man" or "change the dog to a wolf" names the subject, so you change it.

MATCH THE SCOPE OF THE DIRECTION. Do not default to minimal edits.
- Narrow direction ("change her jacket to red", "make it rain") → change that and only what must follow from it, leave the rest word for word.
- Sweeping direction ("reframe as war photography", "make this feel like a memory", "start over but keep the subject") → you are expected to rewrite most of the prompt. Lighting, palette, framing, atmosphere, rendering tradition and detail may all change. Timidity here is a failure.

RIPPLE — carry dependent details so the image stays coherent. Changing gender updates pronouns, clothing, hairstyle, body description. Changing age updates skin, hair, posture, clothing. Changing species swaps in that creature's anatomy. Changing material updates texture, transparency, reflections. Changing time of day, season or weather updates lighting, shadows, sky and environment.

ABSTRACT DIRECTION MUST BECOME VISIBLE FACT — this is the most important rule. When the user names a mood, feeling, genre, intent or memory, you render what a camera would actually see. Never write the abstract word into the prompt.
- "make it melancholy" → overcast flat light, desaturated blue-grey palette, downcast gaze, rain beading on a window. NOT "a melancholy atmosphere."
- "make it feel like something just happened" → an overturned chair, dust still hanging in the air, a door left open, tracks through wet ground. NOT "a sense of aftermath."
- "more tension" → compressed framing, a hand half-raised, hard shadow cutting the face. NOT "tension fills the scene."

NEVER EXPLAIN YOUR EDIT. The output is a prompt, not a description of a prompt or a report on what you changed. Banned constructions anywhere in the output: "the scene captures", "the composition conveys", "creating a sense of", "evoking", "the mood is now", "this change makes", "reflecting the". State what IS there.

CRAFT RULES — the result must still be a well-formed prompt:
- Direct declarative description. State what IS there; never describe by absence ("no harsh light" → "soft diffuse light").
- Every noun earns concrete visible detail.
- Place elements spatially: "to her left", "lower foreground", "behind the fence".
- Words the user wants rendered as text in the image stay in "double quotes" verbatim.
- Empty quality words ("beautiful", "detailed", "stunning", "masterpiece", "4k/8k", "award-winning") → replace with the concrete quality you mean, or delete.
- Do NOT invent ethnicity, religion or nationality the prompt didn't already specify.
- Keep the prompt's existing form — if it is one flowing paragraph, return one flowing paragraph. No keyword lists, no parentheses weighting, no markdown.

EARLIER DIRECTION may be supplied for context. It is the history of what the user already asked for on this prompt, so relative instructions resolve against it — "dial that back" softens the most recent change, "more like dusk than night" refines it. Apply only the CURRENT instruction; the history is there to interpret it.

Output ONLY the full revised prompt. No preamble, no quotes around it, no commentary, no <think> tags.`
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
      // Only what the user actually changed. Callers routinely hand back
      // what getSettings() returned — { ...defaults, ...stored } — and
      // storing that verbatim wrote every current system prompt into
      // localStorage as an explicit override, freezing today's prompts for
      // good. That is the trap clearStoredKey's comment describes, reached
      // by simply picking a model from the dropdown.
      const lean = {};
      Object.keys(settings || {}).forEach(k => {
        if (settings[k] !== this._defaults[k]) lean[k] = settings[k];
      });
      localStorage.setItem("epe_ollama_settings", JSON.stringify(lean));
    } catch (e) { /* ignore */ }
  },

  // Drop ONE stored override (e.g. a single system prompt) and leave every other
  // stored value exactly as it was. Returns true if something was removed.
  //
  // Operates on the RAW stored object, never on what getSettings() returns.
  // getSettings() hands back { ...defaults, ...stored }, so deleting a key from
  // that and saving it would write every current default into localStorage as an
  // explicit value — freezing today's prompts permanently and defeating the
  // "only persist what the user customized" design.
  clearStoredKey(key) {
    try {
      const stored = localStorage.getItem("epe_ollama_settings");
      const parsed = stored ? (JSON.parse(stored) || {}) : {};
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) return false;
      delete parsed[key];
      localStorage.setItem("epe_ollama_settings", JSON.stringify(parsed));
      return true;
    } catch (e) { return false; }
  },

  // Clean LLM response — strip thinking tags, code blocks, etc.
  cleanResponse(text) {
    if (!text) return "";
    let cleaned = text;
    // Strip thinking/reasoning tags (greedy across newlines).
    //
    // A pair match alone is not enough, because either half goes missing in
    // practice and both failures end with the model's reasoning sitting in
    // the user's prompt box:
    //   - No closing tag: the model hit its token ceiling mid-thought. The
    //     pair match found nothing, so the WHOLE reasoning dump was returned
    //     and committed — it is a non-empty string, so nothing downstream
    //     objected. Everything from an unclosed opener onward is reasoning
    //     by definition.
    //   - No opening tag: several chat templates pre-fill "<think>" into the
    //     assistant turn, so the model only ever emits the closer and
    //     everything BEFORE it is reasoning.
    //
    // Ending up with "" is the correct outcome for a response that was
    // nothing but reasoning: both callers already treat an empty result as
    // "the model returned nothing", restore the original prompt and say so.
    // Three passes, and every one of them treats think / reasoning /
    // reflection as ONE set of interchangeable delimiters rather than three
    // independent tags. Models mix them — a block opened <reasoning> and
    // closed </think> is common — and handling each name on its own meant a
    // mismatched pair was never recognised as a pair at all: the opener
    // looked unterminated, everything from it onward was discarded, and the
    // prompt sitting after the closer went with it.
    const _EPE_THINK_TAGS = "think|reasoning|reflection";
    const _epeOpenRe  = new RegExp("<(?:" + _EPE_THINK_TAGS + ")>", "i");
    const _epeCloseRe = () => new RegExp("</(?:" + _EPE_THINK_TAGS + ")>", "gi");

    // 1. Every well-formed span goes — opened by any of the three names and
    //    closed by any of them — INNERMOST FIRST.
    //
    //    A plain non-greedy match stops at the first closer of any name, so
    //    on a nested block it cuts at the INNER closer and leaves the outer
    //    block's tail behind as ordinary text. That is the documented
    //    Reflection prompting shape (<reflection> inside <think>), and it
    //    used to put "Go with blue hour." — pure reasoning — into the prompt.
    //
    //    `(?:(?!<open>)[\s\S])*?` refuses to cross another opener, so the
    //    only spans that match are ones with nothing nested inside them.
    //    Removing those exposes the next layer out, so repeating collapses
    //    the whole nest. Each pass removes at least one span or changes
    //    nothing and stops; the counter is a backstop, not a limit any real
    //    response reaches.
    {
      const _inner = new RegExp(
        "<(?:" + _EPE_THINK_TAGS + ")>(?:(?!<(?:" + _EPE_THINK_TAGS + ")>)[\\s\\S])*?</(?:" +
        _EPE_THINK_TAGS + ")>", "gi");
      for (let _pass = 0; _pass < 20; _pass++) {
        const _before = cleaned;
        cleaned = cleaned.replace(_inner, "");
        if (cleaned === _before) break;
      }
    }

    // 2. An opener with nothing left to close it is unterminated — the model
    //    hit its token ceiling mid-thought — so everything from it onward is
    //    reasoning. One cut, once.
    {
      const _m = _epeOpenRe.exec(cleaned);
      if (_m) cleaned = cleaned.slice(0, _m.index);
    }

    // 3. Every opener is gone now, so a closer still standing is a genuine
    //    orphan — the shape a chat template produces when it pre-fills
    //    "<think>" into the assistant turn, leaving the model to emit only
    //    the closing half. Everything before it is reasoning.
    //
    //    The LAST one, deliberately: a model that re-opens its thinking emits
    //    several closers, and only the text after the final one is the
    //    answer.
    //
    //    If that leaves nothing, the answer really is nothing — the
    //    generation was truncated, or the model emitted only reasoning. "" is
    //    the honest result and both callers already handle it: they restore
    //    the user's prompt and say the model returned nothing. An earlier
    //    version of this guessed instead, keeping the text before the closer
    //    on the theory that a trailing closer was punctuation. That guess
    //    committed reasoning as the prompt, and with more than one closer it
    //    also fused the segments together with the tag simply deleted
    //    ("…reasoning about it" + "a fox…" -> "…about ita fox…").
    //
    //    Scanned with a case-insensitive regex over the ORIGINAL string
    //    rather than a lowercased copy: toLowerCase() is not
    //    length-preserving — U+0130 (Turkish dotted capital I) lowercases to
    //    two code units — so an index taken from the copy can point one
    //    character past where it should and slice a character off the user's
    //    prompt. The end offset comes from the match itself, so the tag's
    //    length is never assumed either.
    {
      const _re = _epeCloseRe();
      let _m, _end = -1;
      while ((_m = _re.exec(cleaned)) !== null) _end = _m.index + _m[0].length;
      if (_end !== -1) cleaned = cleaned.slice(_end);
    }
    cleaned = cleaned.replace(/<output>[\s\S]*?<\/output>/gi, function(m) {
      // Keep content inside <output> tags
      return m.replace(/<\/?output>/gi, "");
    });
    // Unwrap markdown code blocks instead of deleting them — models often
    // put the entire prompt inside one, and deleting the payload either
    // emptied the result or left only the junk preamble around it. A
    // leading language-tag line is dropped.
    cleaned = cleaned.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, "$1");
    cleaned = cleaned.replace(/```([\s\S]*?)```/g, "$1");
    // Strip surrounding quotes only when they really are a wrapper: the
    // SAME quote character opens and closes the string, and that character
    // appears nowhere in between.
    //
    // "starts with a quote and ends with a quote" was not enough. It is also
    // true of a prompt carrying two quoted phrases, and one character came
    // off each end:
    //     "OPEN" neon sign above a door reading "CLOSED"
    //  -> OPEN" neon sign above a door reading "CLOSED
    // which is not just wrong, it is unbalanced, and it went to the sampler
    // that way. The `+` on both anchors compounded it by eating a whole run
    // of quotes rather than the one that might have been a wrapper.
    {
      // One whole character ending at index i / starting at index i, surrogate
      // pairs kept together, so the tests below see code points.
      const _epeWordish = (c) => !!c && /^[\p{L}\p{N}\p{M}]$/u.test(c);
      const _epeCharBefore = (s, i) => {
        if (i <= 0) return "";
        const u = s.charCodeAt(i - 1);
        return (u >= 0xDC00 && u <= 0xDFFF && i >= 2) ? s.slice(i - 2, i) : s.charAt(i - 1);
      };
      const _epeCharAt = (s, i) => {
        if (i >= s.length) return "";
        const u = s.charCodeAt(i);
        return (u >= 0xD800 && u <= 0xDBFF && i + 1 < s.length) ? s.slice(i, i + 2) : s.charAt(i);
      };
      const _t = cleaned.trim();
      const _q = _t.charAt(0);
      if (_t.length > 1 && (_q === '"' || _q === "'") &&
          _t.charAt(_t.length - 1) === _q) {
        // Find the first quote AFTER the opening one that is not a
        // word-internal apostrophe. If that is the final character, the whole
        // string is one quoted span and the outer quotes really are a
        // wrapper. If it lands anywhere else, they are not:
        //     "OPEN" neon sign above a door reading "CLOSED"
        //      ^                                          ^
        //      first closer at index 5, so not a wrapper.
        //
        // Requiring the quote to be absent from the interior ENTIRELY — which
        // is what this did at first — was too strong: an apostrophe is that
        // character, so 'a cat's paw at dawn' stopped being unwrapped and the
        // wrapper quotes went to the sampler.
        let _close = -1;
        for (let i = 1; i < _t.length; i++) {
          if (_t.charAt(i) !== _q) continue;
          // "cat's" — an apostrophe with a letter or digit on both sides is
          // part of the word, not a quote.
          //
          // \p{L}\p{N}\p{M}, not [A-Za-z]. The ASCII-only version left the
          // very regression this exemption exists to prevent in place
          // wherever the neighbour is a digit or an accented letter, which is
          // most of the interesting cases — "the 80's neon glow", "the F1's
          // livery", "a café's terrace", "l'été". Only "a cat's paw" happened
          // to work.
          //
          // And the neighbours are read as CODE POINTS, not charAt(). charAt
          // returns one UTF-16 unit, so in NFD text ("cafe" + U+0301) the
          // character before the apostrophe is a lone combining mark, and for
          // an astral letter it is half a surrogate pair — both failed the
          // test and the wrapper quotes survived. \p{M} covers the first;
          // pairing the surrogates covers the second.
          if (_q === "'" && i < _t.length - 1 &&
              _epeWordish(_epeCharBefore(_t, i)) &&
              _epeWordish(_epeCharAt(_t, i + 1))) continue;
          _close = i;
          break;
        }
        if (_close === _t.length - 1) cleaned = _t.slice(1, -1);
      }
    }
    // Collapse excessive whitespace
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
    return cleaned.trim();
  },

  // Parse numbered variations from response
  parseVariations(text) {
    const cleaned = this.cleanResponse(text);
    const lines = cleaned.split("\n");
    const variations = [];
    let current = null;
    // Index of the last non-blank line — the only place a sign-off can be.
    let lastIdx = -1;
    for (let k = 0; k < lines.length; k++) if (lines[k].trim()) lastIdx = k;
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      // Match "1." or "1)" or "1:" — the rest may be empty, since some
      // models put the number on a line of its own.
      //
      // A digit IMMEDIATELY after the separator, with no space, means this is
      // a number and not a list marker. Aspect ratios and times start lines
      // constantly in this exact context, and every one of them was being
      // eaten:
      //   "16:9 cinematic still of a fox" -> ["9 cinematic still of a fox"]
      //   "4:30 pm golden light"          -> ["30 pm golden light"]
      //   "3.5 stars"                     -> ["5 stars"]
      // Real list markers are always written "1. ", "1) " or "1: " with the
      // space, or are alone on the line. cleanWeights had this same bug
      // fixed in round 9; parseVariations was still doing it.
      const match = line.match(/^\s*(\d+)([.):\-])(\s*)(.*)$/);
      // ...but only for separators that can actually appear INSIDE a number.
      // ")" cannot, so "1)2 girls sitting" is a real list item and applying
      // the guard to it collapsed the whole response into a single card.
      const _isNumber = match && match[2] !== ")" &&
                        match[3] === "" && /^\d/.test(match[4]);
      if (match && !_isNumber) {
        if (current !== null) variations.push(current);
        current = match[4] || "";
      } else if (current !== null) {
        if (!line.trim()) {
          // A blank line after content ends the variation — trailing
          // chatter beyond it is not part of the prompt. Blank lines
          // BEFORE any content (a bare "1." then a gap) are skipped.
          if (current.trim()) { variations.push(current); current = null; }
        } else if (!current) {
          // The number was alone on its line; this is the variation itself.
          current = line;
        } else if (idx === lastIdx && /[.!?"’”)\]]\s*$/.test(current)) {
          // The VERY LAST line of the response, following a variation that
          // already ends in a completed sentence: a sign-off ("Hope these
          // help!"), not a wrapped continuation — it used to be glued onto
          // the last variation and committed with it. Confined to the final
          // line on purpose: mid-variation, a break after a full stop is
          // ordinary hard wrapping and must still be kept.
        } else {
          // Continuation of a hard-wrapped paragraph — dropping these
          // silently amputated every variation to its first line.
          current += "\n" + line;
        }
      }
    }
    if (current !== null) variations.push(current);
    const out = variations.map(v => v.trim()).filter(Boolean);
    if (out.length > 0) return out;
    // If no numbered lines found, try splitting by double newline
    if (cleaned.length > 0) {
      const blocks = cleaned.split(/\n\n+/).filter(b => b.trim());
      if (blocks.length > 1) return blocks.map(b => b.trim());
      // Last resort: return as single variation
      return [cleaned];
    }
    return out;
  },

  // Check if Ollama is reachable
  // Backend check: probes Ollama server-side (no browser CORS) and
  // auto-starts a local Ollama if it isn't running yet.
  async _backendCheck(url) {
    try {
      const resp = await api.fetchApi("/epe/ollama/check", {
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
        // The retry returned empty without throwing — surface the friendly
        // message, never the internal sentinel.
        const _f2 = new Error("The model spent its whole response thinking. Try a non-thinking model, or increase Length.");
        _f2.thinking = e.thinking || "";
        throw _f2;
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
    let timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // If external signal provided, link it. Held so it can be detached: the
    // caller's controller outlives this call, and the retry re-uses the same
    // signal, so an un-removed listener accumulated one abort target per
    // attempt and kept this whole closure alive with it.
    let _extAbort = null;
    if (opts.signal) {
      _extAbort = () => controller.abort();
      opts.signal.addEventListener("abort", _extAbort);
    }
    // Every exit — success, failure, abort — runs this. The success paths
    // used to leave the last armed timer running, so a finished request
    // could abort a controller a later caller was still holding.
    const _finishTimers = () => {
      clearTimeout(timeoutId);
      if (_extAbort && opts.signal) {
        try { opts.signal.removeEventListener("abort", _extAbort); } catch (_e) {}
        _extAbort = null;
      }
    };
    
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
            // forward any extra Ollama options (top_p, top_k, num_predict,
            // min_p, seed, repeat_penalty, repeat_last_n) supplied by callers.
            // Spread comes last so option fields here override the temperature
            // default above when the caller provides their own.
            ...(opts.options || {}),
          }
      };
      if (opts.images && opts.images.length > 0) {
        body.images = opts.images;
      }
      const resp = await api.fetchApi(url, {
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
        
        // Reset the timeout on each chunk: the model is actively
        // generating. Clearing without re-arming — which is what this did —
        // left a model that stalled after its first token hanging forever,
        // with no timeout left to fire and nothing to resolve the promise.
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        
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
      throw e;
    } finally {
      // A `finally`, not a call on each exit path: the streaming loop
      // RETURNS from inside the try the moment it sees chunk.done, which is
      // how essentially every successful generation ends. Calling
      // _finishTimers only on the trailing return missed that path entirely
      // and left a 120s abort timer armed, plus the caller's abort listener
      // attached — the exact accumulation this was added to stop.
      _finishTimers();
    }
  },

  // Unload model from VRAM/RAM
  async unloadModel() {
    try {
      const settings = this.getSettings();
      if (!settings.model) return;
      await api.fetchApi("/epe/ollama/generate", {
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

  // Which editor owns the state below. There can be several EPE nodes in one
  // graph, and both the style bridge above and the abort controller here are
  // per-editor concerns living on a page-level singleton. Before this:
  //   - the bridge was written only from style-strip UI handlers, never at
  //     run time, so whichever node's strip was touched LAST decided how
  //     every node captioned — silently, and with no way to notice;
  //   - node B starting a caption aborted node A's in-flight request, and A's
  //     panel reported a failure the user never caused.
  _owner: null,

  // One controller per owner, not one for the page.
  _abortByOwner: null,

  // Every model pull currently in flight. This was a single slot, so a second
  // pull orphaned the first (unstoppable, and it fired onSelect when it
  // finished) and Cancel aborted whichever one happened to be in the slot.
  _pullAborts: null,
  _pullTake(ctrl, owner) {
    // Tagged with its owner. _pullAbortAll is right for the picker's own
    // Cancel button, which is modal — and wrong for a node's dispose, where
    // the node being deleted is not necessarily the one that started the
    // pull. Two nodes on the canvas and deleting the idle one killed the
    // other's multi-GB download with "Download cancelled" and no reason.
    try { ctrl._epeOwner = owner; } catch (_e) {}
    (this._pullAborts || (this._pullAborts = new Set())).add(ctrl);
    return ctrl;
  },
  _pullDone(ctrl) {
    if (this._pullAborts) this._pullAborts.delete(ctrl);
  },
  _pullAbortOwn(owner) {
    const s = this._pullAborts;
    if (!s || owner == null) return;
    for (const c of Array.from(s)) {
      if (c && c._epeOwner === owner) {
        try { c.abort(); } catch (_e) {}
        s.delete(c);
      }
    }
  },
  _pullAbortAll() {
    const s = this._pullAborts;
    if (!s) return;
    for (const c of Array.from(s)) {
      try { c.abort(); } catch (_e) {}
      s.delete(c);
    }
  },

  // Called by an editor immediately before it starts a vision run: claims the
  // shared state and installs THIS editor's style settings, so the request
  // that goes out is the one described by the strip the user is looking at.
  claim(owner, styleBridge) {
    this._owner = owner || null;
    if (styleBridge) this._styleBridge = styleBridge;
  },

  // Abort a specific owner's in-flight request and nothing else. Cancel
  // buttons pass the owner captured when their panel was built, so pressing
  // Cancel can only ever stop the run that panel belongs to.
  _abortOwn(owner) {
    const map = this._abortByOwner || (this._abortByOwner = Object.create(null));
    const key = String(owner == null ? "default" : owner);
    const ctrl = map[key];
    if (ctrl) { try { ctrl.abort(); } catch (e) {} }
  },

  // An owner is finished with (its node was disposed). Nothing removed
  // entries, so one AbortController accumulated per node instance for the
  // life of the page — add and remove a node fifty times and fifty were held.
  // The dispose chain knows exactly when this is true, so it says so; the
  // sweep is a backstop for owners that never got the chance.
  _releaseOwner(owner) {
    const map = this._abortByOwner;
    if (!map) return;
    const key = String(owner == null ? "default" : owner);
    const ctrl = map[key];
    if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    delete map[key];
    // Only prune signals that are already aborted. An earlier version of
    // this cross-checked against `app.graph._nodes.map(n => n.id)` — but
    // the keys here are WIN_IDs of the form "epe-epe-node-u<...>", not
    // node ids, so that check unconditionally aborted every OTHER live
    // node's in-flight vision request on every dispose. Reverted; the
    // dispose chain handles the intended case via the explicit _releaseOwner
    // call for the owner being disposed.
    for (const k of Object.keys(map)) {
      const c = map[k];
      if (!c || !c.signal || c.signal.aborted) delete map[k];
    }
  },

  // Which style settings a request should carry.
  //
  // While this editor still owns the singleton, the LIVE bridge wins: the
  // model picker is an overlay and the style strip underneath stays
  // interactive, so a style change made with the picker open is this same
  // node's change and belongs in the request. The copy captured at click time
  // is only needed once ANOTHER editor has claimed — which is precisely what
  // the owner comparison detects.
  _bridgeFor(ctx) {
    if (!ctx || !ctx.bridge) return this._styleBridge;
    return (this._owner === ctx.owner) ? this._styleBridge : ctx.bridge;
  },

  // Kept for callers that still read it; always the most recent controller.
  _abortController: null,

  // `owner` is passed explicitly by everything that runs after an await.
  // Reading this._owner here instead was the whole bug in the first cut:
  // run() awaits the model picker, which returns when the USER clicks, and by
  // then another editor may have claimed the singleton — so one node's
  // controller got filed under another node's key and the next run aborted
  // the wrong request.
  _abortPrevious(owner) {
    const map = this._abortByOwner || (this._abortByOwner = Object.create(null));
    const who = (owner === undefined) ? this._owner : owner;
    const key = String(who == null ? "default" : who);
    const prev = map[key];
    // Only this owner's previous run. A new request from ANOTHER editor is
    // not a reason to cancel this one.
    if (prev) {
      try { prev.abort(); } catch(e) {}
    }
    const ctrl = new AbortController();
    map[key] = ctrl;
    this._abortController = ctrl;
    return ctrl.signal;
  },
  async check() {
    try {
      const resp = await api.fetchApi("/epe/ollama/check", {
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
  showModelPicker(knownModels, installedModels, showAiPanel, hideAiPanel, onSelect, owner) {
    // The in-flight pull's controller hangs off the picker so the Dismiss
    // button can reach it; captured here because the row handlers below are
    // arrows nested inside a forEach.
    const _pickerSelf = this;
    // SNAPSHOT, not a live read. `_startPull` runs on a user click, long
    // after this picker opened, and `claim()` fires from every style-strip
    // handler — so `this._owner` at click time can be a different node
    // entirely, or a node that has since been disposed (_releaseOwner never
    // nulls _owner). run() already snapshots for exactly this reason and its
    // comment says why; the pull registry has to do the same or it tags the
    // download with the wrong node and dispose aborts the wrong one.
    const _pickerOwner = (owner !== undefined) ? owner : this._owner;
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
        // Named, so a failed or cancelled pull can put the row back to
        // "click to download" instead of leaving it dead.
        const _startPull = async () => {
          sub.textContent = "Downloading\u2026";
          dot.style.background = "#7a8a9c";
          row.style.cursor = "default";
          row.onclick = null;
          // A pull is minutes long. Without a way to abort it, dismissing
          // the panel left the download running and then fired onSelect when
          // it finished — spontaneously starting vision inference on an image
          // the user had walked away from a quarter of an hour earlier.
          // Registered, not assigned to a single slot. Overwriting the slot
          // left the previous pull running with nothing able to stop it, and
          // Cancel then aborted whatever happened to be in the slot with no
          // ownership check — so the earlier pull finished and fired onSelect,
          // starting inference on an image the user had abandoned. That is
          // verbatim the failure the Cancel button was added to prevent.
          //
          // A pull is machine-wide (Ollama has one model store) and this
          // picker is modal, so "every pull this picker started" is the right
          // unit for Cancel and for dispose.
          const pullCtrl = new AbortController();
          // `_owner` is whoever claimed the vision singleton, which the
          // editor does before every run and whenever its style strip is
          // touched — so at the moment a pull starts it is the node whose
          // panel opened this picker. Tagged here, once, so a later claim by
          // another node cannot retag a pull already in flight.
          _pickerSelf._pullTake(pullCtrl, _pickerOwner);
          try {
            const pullResp = await api.fetchApi("/epe/ollama/pull", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ modelName: m.name, ollamaUrl: this._ollamaUrl }),
              signal: pullCtrl.signal,
            });
            const reader = pullResp.body.getReader();
            const dec = new TextDecoder();
            // Incremental: a status line split across two chunks used to be
            // parsed as two broken halves and silently dropped.
            let buf = "";
            let pullErr = null;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              const lines = buf.split("\n");
              buf = lines.pop() || "";
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const d = JSON.parse(line);
                  if (d.status) {
                    const pct = d.total ? Math.round((d.completed||0)/d.total*100)+"%" : "";
                    sub.textContent = d.status + (pct ? " " + pct : "");
                  }
                  if (d.error) { pullErr = d.error; break; }
                } catch(e) {}
              }
              if (pullErr) break;
            }
            if (pullErr) {
              // Leave the row usable: it used to return with onclick already
              // nulled, so a transient failure made the model unpickable.
              sub.textContent = "Error: " + pullErr;
              dot.style.background = "#c66";
              row.style.cursor = "pointer";
              row.onclick = _startPull;
              return;
            }
            if (pullCtrl.signal.aborted) return;
            dot.style.background = "#4c8";
            sub.textContent = "Downloaded — starting\u2026";
            row.style.cursor = "pointer";
            row.onclick = () => onSelect(m.name);
            onSelect(m.name);
          } catch(e) {
            if (e && e.name === "AbortError") {
              sub.textContent = "Download cancelled.";
              row.style.cursor = "pointer";
              row.onclick = _startPull;
              return;
            }
            sub.textContent = "Download failed: " + e.message;
            row.style.cursor = "pointer";
            row.onclick = _startPull;
          } finally {
            _pickerSelf._pullDone(pullCtrl);
          }
        };
        row.onclick = _startPull;
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
    cancelBtn.onclick = () => {
      // A pull started from this panel keeps running after the panel closes,
      // and used to fire onSelect when it finished — starting inference on an
      // image the user abandoned. Cancel means cancel.
      _pickerSelf._pullAbortAll();
      hideAiPanel();
    };
    wrap.appendChild(cancelBtn);

    showAiPanel(wrap);
    if (showAiPanel.setTitle) showAiPanel.setTitle("Pick a vision model to generate a prompt");
  },

  // Run image-to-prompt via backend. imageUrl = CDN URL string.
  // onStart() called before request, onDone(prompt) on success, onError(msg) on fail.
  // ctx: { owner, bridge } captured by run() BEFORE the model picker awaited
  // the user. Falls back to the singleton for any direct caller.
  async generateImage(imageUrl, modelName, showAiPanel, hideAiPanel, onDone, ctx) {
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

    // Captured now, while this panel is being built, so Cancel aborts the
    // run this panel belongs to. It used to abort this._abortController —
    // module state that a second EPE node's run replaces — so Cancel on one
    // node's panel could stop the other node's request and leave this one
    // running.
    const _visionOwner = (ctx && "owner" in ctx) ? ctx.owner : this._owner;
    // The style settings this request must be described by. _bridgeFor picks
    // the LIVE ones while this editor still owns the singleton — the picker
    // is an overlay and the style strip under it stays interactive — and the
    // copy captured before the picker awaited the user once another editor
    // has claimed in the meantime. Reading this._styleBridge unconditionally
    // was what let a second editor's slider drag decide how this one
    // captioned.
    const _visionBridge = this._bridgeFor(ctx);
    let cancelled = false;
    cancelBtn.onclick = () => {
      cancelled = true;
      // Hiding the panel is not cancelling. The controller was created for
      // exactly this and never used, so Ollama kept generating and the next
      // attempt met "may still be processing a previous request".
      try { this._abortOwn(_visionOwner); } catch (_e) {}
      hideAiPanel();
    };

    wrap.appendChild(hdr);
    wrap.appendChild(status);
    wrap.appendChild(cancelBtn);
    showAiPanel(wrap);

    try {
      const signal = this._abortPrevious(_visionOwner);
      const resp = await api.fetchApi("/epe/ollama/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl, ollamaModel: modelName, ollamaUrl: this._ollamaUrl, ..._visionBridge }),
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
  async generateImageFromFile(file, modelName, showAiPanel, hideAiPanel, onDone, ctx) {
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

    // Captured now, while this panel is being built, so Cancel aborts the
    // run this panel belongs to. It used to abort this._abortController —
    // module state that a second EPE node's run replaces — so Cancel on one
    // node's panel could stop the other node's request and leave this one
    // running.
    const _visionOwner = (ctx && "owner" in ctx) ? ctx.owner : this._owner;
    // The style settings this request must be described by. _bridgeFor picks
    // the LIVE ones while this editor still owns the singleton — the picker
    // is an overlay and the style strip under it stays interactive — and the
    // copy captured before the picker awaited the user once another editor
    // has claimed in the meantime. Reading this._styleBridge unconditionally
    // was what let a second editor's slider drag decide how this one
    // captioned.
    const _visionBridge = this._bridgeFor(ctx);
    let cancelled = false;
    cancelBtn.onclick = () => {
      cancelled = true;
      // Hiding the panel is not cancelling. The controller was created for
      // exactly this and never used, so Ollama kept generating and the next
      // attempt met "may still be processing a previous request".
      try { this._abortOwn(_visionOwner); } catch (_e) {}
      hideAiPanel();
    };

    wrap.appendChild(thumbRow);
    wrap.appendChild(cancelBtn);
    showAiPanel(wrap);

    try {
      const signal = this._abortPrevious(_visionOwner);
      const resp = await api.fetchApi("/epe/ollama/generate-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: base64Full, ollamaModel: modelName, ollamaUrl: this._ollamaUrl, ..._visionBridge }),
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
  async generateVideo(videoUrl, modelName, showAiPanel, hideAiPanel, onDone, ctx) {
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

    // Captured now, while this panel is being built, so Cancel aborts the
    // run this panel belongs to. It used to abort this._abortController —
    // module state that a second EPE node's run replaces — so Cancel on one
    // node's panel could stop the other node's request and leave this one
    // running.
    const _visionOwner = (ctx && "owner" in ctx) ? ctx.owner : this._owner;
    // The style settings this request must be described by. _bridgeFor picks
    // the LIVE ones while this editor still owns the singleton — the picker
    // is an overlay and the style strip under it stays interactive — and the
    // copy captured before the picker awaited the user once another editor
    // has claimed in the meantime. Reading this._styleBridge unconditionally
    // was what let a second editor's slider drag decide how this one
    // captioned.
    const _visionBridge = this._bridgeFor(ctx);
    let cancelled = false;
    cancelBtn.onclick = () => {
      cancelled = true;
      // Hiding the panel is not cancelling. The controller was created for
      // exactly this and never used, so Ollama kept generating and the next
      // attempt met "may still be processing a previous request".
      try { this._abortOwn(_visionOwner); } catch (_e) {}
      hideAiPanel();
    };

    wrap.appendChild(hdr);
    wrap.appendChild(status);
    wrap.appendChild(note);
    wrap.appendChild(cancelBtn);
    showAiPanel(wrap);

    try {
      const signal = this._abortPrevious(_visionOwner);
      const resp = await api.fetchApi("/epe/ollama/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoUrl, ollamaModel: modelName, ollamaUrl: this._ollamaUrl, ..._visionBridge }),
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
    // Captured HERE, on the synchronous path from the editor's own click
    // handler, which called claim() immediately before. Everything below runs
    // after `await this.check()` and after showModelPicker awaits the user's
    // click — by which point another editor may have claimed the singleton.
    // Reading this._owner / this._styleBridge down there is what let node B's
    // style decide how node A captioned, and let node B's run abort node A's.
    const _ctx = { owner: this._owner, bridge: this._styleBridge };
    const check = await this.check();
    if (!check || !check.running) {
      this.showNotRunning(showAiPanel, hideAiPanel);
      return;
    }

    this.showModelPicker(check.knownModels, check.installedModels, showAiPanel, hideAiPanel, async (modelName) => {
      if (mode === "image-url") {
        await this.generateImage(source, modelName, showAiPanel, hideAiPanel, (prompt) => {
          this.showResult(prompt, showAiPanel, hideAiPanel, onResult, actions);
        }, _ctx);
      } else if (mode === "image-file") {
        await this.generateImageFromFile(source, modelName, showAiPanel, hideAiPanel, (prompt) => {
          this.showResult(prompt, showAiPanel, hideAiPanel, onResult, actions);
        }, _ctx);
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
          const signal = this._abortPrevious(_ctx.owner);
          const frameResp = await api.fetchApi("/epe/ollama/extract-frame", {
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
            (prompt) => { this.showResult(prompt, showAiPanel, hideAiPanel, onResult, actions); },
            _ctx
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
          // See the note on the other Cancel handlers: captured here so this
          // button can only abort its own panel's run.
          const _visionOwner = _ctx.owner;
          let cancelled = false;
          cancelBtn.onclick = () => {
      cancelled = true;
      // Hiding the panel is not cancelling. The controller was created for
      // exactly this and never used, so Ollama kept generating and the next
      // attempt met "may still be processing a previous request".
      try { this._abortOwn(_visionOwner); } catch (_e) {}
      hideAiPanel();
    };
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
          const signal = this._abortPrevious(_ctx.owner);
          const resp = await api.fetchApi("/epe/ollama/generate-video-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoData: base64Full, ollamaModel: modelName, ollamaUrl: this._ollamaUrl, ...this._bridgeFor(_ctx) }),
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
        }, _ctx);
      }
    }, _ctx.owner);
  },
};

// ── EPE Standalone Function ───────────────────────────────────────────────────
// Persists workflow search state across node re-creations (tab switches).
// Module scope on purpose: the node is rebuilt whenever ComfyUI switches
// workflow tabs, and a response still in flight from the old closure would
// otherwise pass an instance-local check and overwrite the shared cache.
//
// KNOWN LIMITATION: two EPE nodes on one canvas share this record, so the
// second node's pane repaints the first node's search after a tab switch.
// Keying it by node id does NOT work: LiteGraph has not assigned the id
// when onNodeCreated runs (see the uid note at the top of
// _epeOpenEPEStandalone), so every node keys to "-1" and nothing is
// separated. Fixing it properly means binding the record after the node is
// configured, which needs verifying in a live canvas first.
const _epeWfPersist = { query: "", source: "all", results: [], cursor: "",
                        page: 1, exhausted: false };
// Two different questions, and round 6 conflated them.
//   _epeWfGen   — "has a NEWER SEARCH replaced this response?"
//   _epeWfOwner — "is this panel still the one that owns the cache?"
// Bumping the generation when a panel was built answered the second
// question by breaking the first: creating any EPE node then aborted a
// sibling node's in-flight load.
let _epeWfGen = 0;
let _epeWfOwner = 0;

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
  // A dropped workflow file is untrusted input: its definitions can reference
  // each other in a cycle, and one definition can be instantiated many times
  // at many levels. Without a guard the first case recursed until the stack
  // blew (reported to the user as a metadata parse failure) and the second
  // walked the same definitions 2^N times, freezing the UI thread.
  // The set of definitions open on the CURRENT PATH. The previous guard was a
  // global set keyed by the chain of node ids — and the chain grows by one id
  // per level, so every key was new by construction and the guard never fired
  // once. A cycle was terminated only by the depth cap below.
  const onPath = new Set();
  // …and the depth cap alone does not bound the WORK. A definition holding ten
  // nodes of another definition expands ten-to-the-depth before it bites, so
  // the output is capped too. Nothing calls this function today; the ceiling
  // is here so that wiring it up cannot freeze the tab.
  const MAX_INSTANCES = 4096;
  const visit = (graph, chain) => {
    if (!graph || !Array.isArray(graph.nodes)) return;
    if (chain.length > 24) return;
    for (const n of graph.nodes) {
      if (!n) continue;
      const inner = _epeGetInnerSubgraph(n, workflowRoot);
      if (!inner) continue;
      const myChain = chain.concat([n.id]);
      out.push({ chain: myChain, inner });
      // Keyed by the chain of node ids: unique per INSTANCE, so every
      // instance is still collected, while a path that revisits the same
      // instance (a cycle) terminates.
      if (out.length >= MAX_INSTANCES) return;
      // A definition already open on this path is a cycle. A definition seen
      // on a DIFFERENT path is a separate instance and is still collected —
      // which is what the old comment promised and the old key could not
      // deliver.
      const defId = n.type;
      if (onPath.has(defId)) continue;
      onPath.add(defId);
      visit(inner, myChain);
      onPath.delete(defId);
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
  // Each DEFINITION is flattened once. Pushing it per instance duplicated
  // every node and link — and the comment above promising "IDs don't
  // collide" was wrong the moment a subgraph appeared twice, because both
  // instances contributed the same node objects. A cyclic reference also
  // recursed forever here.
  const doneDefs = new Set();

  // Node and link ids are PER GRAPH: every definition numbers its own from 1,
  // independently of the root and of every other definition. Concatenating
  // them means `wfNodesById[n.id] = n` downstream is last-write-wins, and
  // definitions land after the root nodes, so a definition node beats the root
  // node it collides with. The walk then follows the ROOT's links while
  // reading the SUBGRAPH node's title and widgets_values.
  //
  // Measured: the same root graph, once plain and once with a single unrelated
  // subgraph added, extracted two different positive prompts — the second one
  // being text from inside that subgraph. With two definitions both numbering
  // from 1 the positive prompt vanished altogether. Nothing throws, nothing is
  // logged, and the panel looks like a successful extraction.
  //
  // So every definition is remapped into a range of its own. Root ids are
  // untouched, which keeps a workflow with no subgraphs byte-identical.
  let _nextNodeId = 1, _nextLinkId = 1;
  for (const n of allNodes) {
    const v = parseInt(n && n.id, 10);
    if (Number.isFinite(v) && v >= _nextNodeId) _nextNodeId = v + 1;
  }
  for (const l of allLinks) {
    const v = parseInt(l && l[0], 10);
    if (Number.isFinite(v) && v >= _nextLinkId) _nextLinkId = v + 1;
  }

  let depth = 0;
  const visit = (graph) => {
    if (!graph || !Array.isArray(graph.nodes)) return;
    if (depth > 24) return;
    depth++;
    for (const n of graph.nodes) {
      const inner = _epeGetInnerSubgraph(n, workflowRoot);
      if (!inner) continue;
      const defKey = (inner.id != null ? String(inner.id) : null);
      if (defKey !== null) {
        if (doneDefs.has(defKey)) continue;
        doneDefs.add(defKey);
      }
      const defNodes = Array.isArray(inner.nodes) ? inner.nodes : [];
      const defLinks = Array.isArray(inner.links) ? inner.links : [];
      // Both maps are built BEFORE anything is pushed, because a node's
      // `inputs[].link` names a link and a link names two nodes.
      const nodeMap = Object.create(null);
      for (const nn of defNodes) {
        if (!nn || nn.id == null) continue;
        const k = String(nn.id);
        if (nodeMap[k] === undefined) nodeMap[k] = _nextNodeId++;
      }
      const linkMap = Object.create(null);
      const defNorm = [];
      for (const ll of defLinks) {
        const norm = _epeNormalizeLink(ll);
        if (!norm) continue;
        defNorm.push(norm);
        const k = String(norm[0]);
        if (linkMap[k] === undefined) linkMap[k] = _nextLinkId++;
      }
      // `inputs[].link` is what the positive/negative detection compares
      // against a link's own id, so it has to move with the link ids. Two
      // definitions reusing link id 3 would otherwise let a root node's
      // declared input match the wrong definition's link and flip the
      // classification. `outputs[].links` is remapped for consistency; the
      // parser does not read it.
      const _remapIn = (arr) => Array.isArray(arr) ? arr.map(inp => {
        if (!inp || typeof inp !== "object") return inp;
        const lid = linkMap[String(inp.link)];
        return lid === undefined ? inp : Object.assign({}, inp, { link: lid });
      }) : arr;
      const _remapOut = (arr) => Array.isArray(arr) ? arr.map(o => {
        if (!o || typeof o !== "object" || !Array.isArray(o.links)) return o;
        return Object.assign({}, o, {
          links: o.links.map(x => { const y = linkMap[String(x)]; return y === undefined ? x : y; }),
        });
      }) : arr;
      for (const nn of defNodes) {
        if (!nn || nn.id == null) continue;
        // A shallow clone: the caller's workflow object must come back
        // untouched, which the surrounding function already promises.
        // `_epeSrcId` keeps the definition's own numbering for the one place
        // an id reaches the user — the "node_<id>" title fallback.
        allNodes.push(Object.assign({}, nn, {
          id: nodeMap[String(nn.id)],
          _epeSrcId: nn.id,
          inputs: _remapIn(nn.inputs),
          outputs: _remapOut(nn.outputs),
        }));
      }
      for (const norm of defNorm) {
        const s = nodeMap[String(norm[1])], d = nodeMap[String(norm[3])];
        // A link naming a node this definition does not contain is a boundary
        // reference. Dropping it is the point: kept, it pointed at whatever
        // now holds that id at the root.
        if (s === undefined || d === undefined) continue;
        const out = norm.slice();
        out[0] = linkMap[String(norm[0])];
        out[1] = s;
        out[3] = d;
        allLinks.push(out);
      }
      visit(inner);
    }
    depth--;
  };
  visit(workflowRoot);
  // Return a shallow-merged copy so the caller (and existing graph-walk code)
  // can treat it identically to a flat workflow. Original is untouched.
  return Object.assign({}, workflowRoot, { nodes: allNodes, links: allLinks });
}
// ─────────────────────────────────────────────────────────────────────────────

// Parse the single text blob A1111-family UIs embed. Shape:
//
//   <positive prompt, may span lines>
//   Negative prompt: <negative prompt, may span lines>
//   Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 12345, Size: 512x512, ...
//
// Only the LAST line is the settings line, and only if it looks like one —
// a prompt can legitimately contain a colon, so a "key: value, key: value"
// shape is required rather than just "has a colon".
// Index of the line that opens the A1111 negative prompt, or -1.
//
// Replaces `body.search(/^\s*Negative prompt:\s*/mi)`. Under `m`, `^` is a
// valid start at every line and `\s` matches `\n`, so on a body of N newlines
// the engine restarted a full whitespace walk at each of N line starts: 16 K
// 274 ms, 32 K 979 ms, 64 K 3.9 s, 128 K 15.5 s, 256 K 62 s — clean ×4 per
// doubling, on the browser's main thread, over a PNG text chunk somebody else
// wrote. It is the same shape round 16 removed from the settings-line check
// three statements below, and the same line api.py carried; this was the last
// member of that family.
//
// Same answer. The regex can only match where the marker is preceded, back to
// some line start, by nothing but whitespace — which is exactly "the first
// line whose content starts with the marker". Where the two differ is only in
// how far back into a preceding run of blank lines the reported index sits,
// and both halves are trimmed by the caller, so that is invisible.
// Differential-fuzzed over 200,000 assembled inputs: the raw index differs on
// 9% and the caller's output on none.
const _EPE_NEG_MARK = "negative prompt:";
function _epeFindNegativeMarker(body) {
  // The line separators JS regexes treat as starting a new line for `^` under
  // `m`. `\r` matters: the caller normalises CRLF but a lone CR can survive.
  const _isBreak = (c) => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
  const _ws = /\s/;
  const n = body.length;
  for (let p = 0; p <= n; p++) {
    if (p !== 0 && !_isBreak(body[p - 1])) continue;
    // Intra-line whitespace only — stepping over a break here would run past
    // the line and report the wrong start.
    let i = p;
    while (i < n && _ws.test(body[i]) && !_isBreak(body[i])) i++;
    if (body.substr(i, _EPE_NEG_MARK.length).toLowerCase() === _EPE_NEG_MARK) return p;
  }
  return -1;
}

function _epeParseA1111Parameters(text) {
  if (!text || typeof text !== "string") return null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Drop trailing blank lines before looking for the settings line. Plenty of
  // tools end the parameters chunk with a newline, and with one present
  // `last` was "" — so the settings line was never recognised, stayed in the
  // body BEHIND the "Negative prompt:" marker, and the user got a negative
  // prompt with "Steps: 20, Sampler: ..." glued to the end of it while every
  // setting silently went missing.
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  let settingsLine = "";
  const last = (lines[lines.length - 1] || "").trim();
  // A linear check, not a regex. The pattern this replaces —
  //   /^[A-Za-z][A-Za-z0-9 ]*:\s*[^,]+(,\s*[A-Za-z][A-Za-z0-9 ]*:\s*[^,]+)+$/
  // — backtracks quadratically whenever the match FAILS, because `\s*` and
  // `[^,]+` both match a space, so a long run of spaces can be divided
  // between them in every possible way before the engine gives up. The
  // trigger is a last line that opens like a settings pair and never yields
  // a second one: "Model: " followed by spaces. Measured through this
  // function: 1600 chars 0.006s, 3200 0.025s, 6400 0.059s, 12800 0.194s — a
  // clean 4x per doubling, so ~100 KB is ~12s and 1 MB is roughly twenty
  // minutes with the tab frozen. The "parameters" chunk comes from whatever
  // tool wrote the PNG and can be megabytes.
  //
  // This accepts exactly the same strings: every comma-separated part must
  // be `Key: value`, Key matching [A-Za-z][A-Za-z0-9 ]*, value non-empty,
  // and there must be at least two parts.
  //
  // Differential-fuzzed against the old regex. It is NOT byte-for-byte
  // identical, and the earlier claim in this comment that it was came from a
  // fuzz alphabet that could not produce the difference: a key padded with a
  // TAB ("Steps\t: 20, Seed: 1") is rejected by the old pattern, because
  // [A-Za-z0-9 ] does not include tab, and accepted here, because the key is
  // trimmed. Accepting it is the better behaviour — a rejected settings line
  // does not merely lose its settings, it gets glued onto the end of the
  // user's negative prompt — but the difference is real and is stated here
  // rather than claimed away. The 4000-character ceiling is a second
  // deliberate difference.
  const _looksLikeSettings = (s) => {
    if (!s) return false;
    // Nothing legitimate is anywhere near this long, and the cap keeps even
    // the per-key regex below off a pathological input.
    if (s.length > 4000) return false;
    const parts = s.split(",");
    if (parts.length < 2) return false;
    for (const part of parts) {
      const c = part.indexOf(":");
      if (c <= 0) return false;
      const k = part.slice(0, c).trim();
      // NOT trimmed. `\s*[^,]+` in the old pattern accepts a value that is
      // nothing but a space, so "Denoising strength: , Seed: 1" counted as a
      // settings line. Trimming here rejected it instead — and a rejected
      // settings line does not just lose the settings, it gets glued onto the
      // end of the user's negative prompt. Differential fuzzing against the
      // old regex caught it; keep the old acceptance exactly.
      const v = part.slice(c + 1);
      if (!k || !v) return false;
      // Anchored, single greedy class, no nesting — linear.
      if (!/^[A-Za-z][A-Za-z0-9 ]*$/.test(k)) return false;
    }
    return true;
  };
  if (_looksLikeSettings(last)) {
    settingsLine = last;
    lines.pop();
  }

  const body = lines.join("\n");
  let positive = body, negative = "";
  const negIdx = _epeFindNegativeMarker(body);
  if (negIdx !== -1) {
    positive = body.slice(0, negIdx);
    negative = body.slice(negIdx).replace(/^\s*Negative prompt:\s*/i, "");
  }
  positive = positive.trim();
  negative = negative.trim();
  if (!positive && !negative) return null;

  // Settings are "Key: value" pairs, comma separated — but a value can hold
  // commas inside quotes (Lora hashes: "a: 1, b: 2"), and a regex lookahead
  // split there, inventing a bogus "b" setting. Split by hand, ignoring
  // commas that sit inside a quoted run.
  const settings = {};
  if (settingsLine) {
    const parts = [];
    let cur = "", inQ = false;
    for (let i = 0; i < settingsLine.length; i++) {
      const ch = settingsLine[i];
      if (ch === '"') { inQ = !inQ; cur += ch; continue; }
      if (ch === "," && !inQ) { parts.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    parts.forEach(pair => {
      const m = pair.match(/^\s*([A-Za-z][A-Za-z0-9 ]*)\s*:\s*([\s\S]*)$/);
      if (m) settings[m[1].trim()] = m[2].trim();
    });
  }
  return { positive, negative, settings };
}

// Append every element of `src` to `dst`, in place.
//
// `dst.push(...src)` passes one ARGUMENT per element, and V8 throws
// "RangeError: Maximum call stack size exceeded" somewhere around 125k of
// them. The arrays here are built from workflow JSON — one entry per string
// in a node's widgets_values — so the limit is reachable from a file, and it
// threw out of _epeParsePromptData entirely: 50,000 values recovered 50,000
// prompts in 220 ms, 130,000 recovered NOTHING and the image showed no
// metadata at all.
function _epePushAll(dst, src) {
  if (!dst || !src) return dst;
  for (let i = 0; i < src.length; i++) dst.push(src[i]);
  return dst;
}

// How many strings one node's widgets_values may contribute to a string walk.
// See the walk functions: without it, link count x value count is a product
// and both come from the same file.
const _EPE_WALK_MAX_VALUES = 32;

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
  // Mirrors the names in result.loras. The <lora:…> scan below used to answer
  // "have I seen this one" with `result.loras.some(…)` INSIDE the match loop:
  // 2,000 tags 27 ms, 4,000 103 ms, 8,000 609 ms, 16,000 2,273 ms — ×4 per
  // doubling, on tag text from someone else's workflow. Seeded from every
  // push, so it covers exactly what the scan covered.
  const _loraNames = new Set();
  
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
    // Object.create(null) on every map keyed by data from the file.
    //
    // These ids come out of a PNG's `workflow` chunk — a stranger's bytes.
    // With a plain object literal, `inLinks["__proto__"]` IS Object.prototype:
    // truthy, so the guard below does not replace it, and the next line writes
    // an attacker-named key onto the prototype of every object in the page.
    // A workflow chunk of
    //     {"nodes":[{"id":1,"type":"KSampler"}],
    //      "links":[[1,1,0,"__proto__","hasOwnProperty","CONDITIONING"]]}
    // left `typeof {}.hasOwnProperty === "object"`, after which every
    // hasOwnProperty call anywhere in the ComfyUI tab throws — LiteGraph, the
    // frontend, other extensions, the save path. Nothing here threw, so the
    // caller's try/catch never fired and the user saw no error at all.
    // "constructor" writes onto the global Object instead.
    const wfNodesById = Object.create(null);
    for (const n of workflowData.nodes) {
      // `nodes:[null]` is a TypeError on n.id, which costs the whole image's
      // metadata via the caller's catch.
      if (n && n.id !== undefined && n.id !== null) wfNodesById[n.id] = n;
    }

    // Links normalised ONCE, here, and used by every loop below.
    //
    // _epeNormalizeLink exists for the object form that newer ComfyUI writes,
    // but _epeFlattenWorkflow — the only thing that applied it — returns early
    // unless `definitions.subgraphs` is an array, so a plain workflow reached
    // the destructure raw. An object entry threw "l is not iterable" here, and
    // a null entry threw on l[5] in one of the four loops further down. Each
    // costs the image's entire metadata through the caller's catch.
    const wfLinks = [];
    for (const _rawLink of workflowData.links) {
      const _l = (typeof _epeNormalizeLink === "function")
        ? _epeNormalizeLink(_rawLink) : _rawLink;
      if (Array.isArray(_l) && _l.length >= 5) wfLinks.push(_l);
    }

    // Build incoming/outgoing link maps
    const inLinks = Object.create(null);   // nodeId → { inputSlot: linkArray }
    const outLinks = Object.create(null);  // nodeId → { outputSlot: [linkArrays] }
    for (const l of wfLinks) {
      const [lid, srcId, srcOut, dstId, dstIn, ltype] = l;
      if (!inLinks[dstId]) inLinks[dstId] = Object.create(null);
      inLinks[dstId][dstIn] = l;
      if (!outLinks[srcId]) outLinks[srcId] = Object.create(null);
      if (!outLinks[srcId][srcOut]) outLinks[srcId][srcOut] = [];
      outLinks[srcId][srcOut].push(l);
    }
    
    // Pair Set/Get "wireless" bus nodes by normalized title
    // These are custom linkless bridge nodes — the links array has NO link between Set→Get pairs.
    // We pair them by name so walks can bridge the gap. They are purely transparent bridges.
    const normBus = (title, prefix) => title.replace(prefix, "").replace(/^[>\-\s]+/, "").replace(/[>\-\s]+$/, "").trim().toLowerCase();
    // Same reason as the link maps above: these are keyed by a node TITLE
    // from the file, so `getBus["constructor"].push(n)` threw on a plain
    // object literal.
    const setBus = Object.create(null);
    const getBus = Object.create(null);
    for (const n of workflowData.nodes) {
      if (!n) continue;
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
      // _epeSrcId is the id this node had inside its own subgraph definition,
      // before flattening remapped it. It is what the user would recognise.
      const title = node.title || node.type ||
                    ("node_" + (node._epeSrcId != null ? node._epeSrcId : nodeId));
      
      // GetNode: jump to matching SetNode's source
      if (node.type === "GetNode") {
        const name = normBus(node.title || "", "Get_");
        const setNode = setBus[name];
        if (setNode && inLinks[setNode.id]) {
          for (const slot of Object.keys(inLinks[setNode.id])) {
            _epePushAll(results, walkBackString(inLinks[setNode.id][slot][1], visited));
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
            _epePushAll(results, walkBackString(link[1], visited));
          }
        }
      }
      
      // Terminal node: no incoming STRING links → check widgets_values for text
      // Also treat as terminal if the only incoming links are non-STRING (CLIP, MODEL, etc.)
      if (!hasStringInput) {
        const wv = node.widgets_values;
        if (Array.isArray(wv)) {
          // Bounded. `widgets_values` comes straight from the workflow file,
          // and one node contributing an entry per element is one half of the
          // links x values product measured at 19.9 s for a 1.26 MB file.
          // Nothing real has more than a handful of text widgets.
          let _taken = 0;
          for (const v of wv) {
            if (typeof v === "string" && v.trim().length > 10) {
              results.push({ nodeId, title, text: v.trim() });
              if (++_taken >= _EPE_WALK_MAX_VALUES) break;
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
      const title = node.title || node.type ||
                    ("node_" + (node._epeSrcId != null ? node._epeSrcId : nodeId));
      
      // SetNode: jump to matching GetNodes (don't collect SetNode widgets_values — they're bus labels)
      if (node.type === "SetNode") {
        const name = normBus(node.title || "", "Set_");
        for (const getNode of (getBus[name] || [])) {
          _epePushAll(results, walkForwardString(getNode.id, visited));
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
                _epePushAll(results, walkForwardString(link[3], visited));
              }
            }
          }
        }
        return results;
      }
      
      // Check widgets_values for cached text (skip short bus-label-like strings)
      // Bounded, for the same reason as the backward walk: one node
      // contributing an entry per element is one half of the links x values
      // product measured at 19.9 s for a 1.26 MB file.
      const wv = node.widgets_values;
      if (Array.isArray(wv)) {
        let _taken = 0;
        for (const v of wv) {
          if (typeof v === "string" && v.trim().length > 10) {
            results.push({ nodeId, title, text: v.trim() });
            if (++_taken >= _EPE_WALK_MAX_VALUES) break;
          }
        }
      }
      
      // Follow outgoing STRING links only (not * — those are often CONDITIONING/MODEL going to bus)
      if (outLinks[nodeId]) {
        for (const slot of Object.keys(outLinks[nodeId])) {
          for (const link of outLinks[nodeId][slot]) {
            if (link[5] === "STRING") {
              _epePushAll(results, walkForwardString(link[3], visited));
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
    for (const l of wfLinks) {
      const ltype = l[5] || "?";
      if (ltype === "CONDITIONING") {
        condSourceIds.add(l[1]);
      }
    }
    
    // Method 2: SetNodes receiving CONDITIONING (bus pattern)
    for (const n of workflowData.nodes) {
      if (!n || n.type !== "SetNode") continue;
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
    for (const l of wfLinks) {
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
    
    // Links grouped by SOURCE node, built once. The loop below used to walk
    // every link for every text encoder — encoders × links — which measured
    // 34 ms at 200/8,000, 1,089 ms at 1,600/64,000, and 21.6 s on a large
    // workflow: a frozen tab for as long as that takes, from dropping in a PNG.
    // Same links, in the same order, to the same code.
    const linksBySrc = new Map();
    for (const l of wfLinks) {
      const _k = l[1];
      let _a = linksBySrc.get(_k);
      if (!_a) { _a = []; linksBySrc.set(_k, _a); }
      _a.push(l);
    }

    for (const srcId of textEncoderIds) {
      const srcNode = wfNodesById[srcId];
      if (!srcNode) continue;
      
      // Determine positive vs negative
      let isNeg = false;
      const srcTitle = (srcNode.title || "").toLowerCase();
      if (srcTitle.includes("neg") || srcTitle.includes("uncond")) isNeg = true;
      // Also check destination input name or Set node title
      for (const l of (linksBySrc.get(srcId) || [])) {
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
      
      // Walk forward through STRING outputs: find enhanced/resolved prompts.
      //
      // ONE visited set for all of this encoder's links, not a fresh one per
      // link. With a fresh set per link, a node reachable from L of them was
      // walked and re-collected L times — link count and value count being two
      // independently scalable dimensions of the same file, that is a product
      // while the file is a sum: 2,000 x 2,000 measured 233 ms, 16,000 x
      // 16,000 measured 19,942 ms, a clean x4 per doubling of file size.
      //
      // Nothing is lost. `seenText` below discards a repeated text anyway, and
      // a node's contribution is its own widgets_values regardless of which
      // link arrived at it — so sharing the set removes only work that was
      // being thrown away.
      const _fwdSeen = new Set();
      if (outLinks[srcId]) {
        for (const slot of Object.keys(outLinks[srcId])) {
          for (const link of outLinks[srcId][slot]) {
            if (link[5] === "STRING") {
              const fwdResults = walkForwardString(link[3], _fwdSeen);
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
      // promptData is type-checked at the top of this function; its VALUES
      // never were. ComfyUI writes nulls here for some bypassed-node
      // combinations, and `node.inputs` on one of those threw TypeError out
      // of the whole parser — so a single null node reported the entire
      // image as unreadable.
      if (!node || typeof node !== "object") continue;
      const inp = (node.inputs && typeof node.inputs === "object") ? node.inputs : {};
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
    // Same reasoning as the encoder fallback above: this loop reads
    // class_type, inputs and _meta straight off the value.
    if (!node || typeof node !== "object") continue;
    const cls = node.class_type || "";
    const inp = (node.inputs && typeof node.inputs === "object") ? node.inputs : {};
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
      _loraNames.add(inp.lora_name);
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
          if (!_loraNames.has(name)) {
            _loraNames.add(name);
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
    //
    // The whitespace runs are BOUNDED. `\s*` in front of a literal the class
    // cannot match means every start position inside a run of spaces walks to
    // the end of that run and backtracks a character at a time before giving
    // up — 16 K of spaces measured 250 ms, ×4 per doubling. Nothing real puts
    // eight whitespace characters inside `(embedding : name : 1.1)`, and a
    // failed attempt now costs the bound instead of the string.
    cleaned = cleaned.replace(/\(?\s{0,8}embedding\s{0,8}:\s{0,8}[^,)\s]+(?:\s{0,8}:\s{0,8}-?[\d.]+)?\s{0,8}\)?/gi, "");
    // The three bracket regexes below drop the `\s*` that sat between the
    // capture and the ':'. That `\s*` was the entire cost — a lazy
    // run-consuming class in front of it re-divides a run of spaces on every
    // backtrack — and it is redundant for MATCHING, because `[^()]` already
    // matches whitespace. It was not redundant for the CAPTURE, though: `$1`
    // kept whatever the capture held, and without the `\s*` the capture now
    // also holds the whitespace that ran up to the ':'.
    //
    // This restores the old capture exactly. `$1` was the shortest non-empty
    // prefix whose remainder was all whitespace — i.e. the capture with its
    // trailing whitespace removed, except that it had to keep at least one
    // character, so an all-whitespace capture kept its first one. Both halves
    // matter: "(  a  :1.2)" captured "  a", and "(  :1.2)" captured " ".
    // Differential-fuzzed against `$1` over 400,000 assembled prompts: zero
    // differences.
    const _EPE_WEIGHT_INNER = (_m, inner) => inner.trimEnd() || inner.slice(0, 1);
    // Each loop below is a FULL PASS over the string and runs once per nesting
    // LEVEL, so cost is length × depth:
    //
    //     8 K chars     48 ms        64 K   2,437 ms
    //    16 K          169 ms       128 K   9,740 ms
    //    32 K          658 ms
    //
    // Clean ×4 per doubling, synchronously, on prompt text out of a workflow
    // file someone else made. Earlier rounds fixed the regex CONTENTS here;
    // the loop shape was never what was being looked at.
    //
    // 32 levels is far above anything real — "((word))" is depth 2 and even
    // heavy A1111 prompts rarely pass 5. Past the bound the remaining brackets
    // stay as literal text, which is already what unbalanced input gets.
    const WEIGHT_PASS_LIMIT = 32;
    let prev, passes;
    // Iteratively strip innermost (content:number) patterns to handle nesting
    // Supports negative weights, optional spaces, and scheduling (content:num:num)
    passes = 0;
    do {
      prev = cleaned;
      // NO `\s*` between the capture and the ':'. It was pure redundancy —
      // `[^()]` already matches whitespace and the capture is trimmed right
      // here — and it was the whole cost: a lazy run-consuming class in front
      // of `\s*` in front of a literal re-divides a run of spaces on every
      // backtrack. 16 K of spaces inside one pair of parens measured 286 ms,
      // ×4 per doubling; through the whole function, 128 K was 28 s.
      //
      // Round 23 capped the number of PASSES here and said so at length. The
      // cap never fires on this input: the string does not change, so the loop
      // exits after one pass, and one pass is the entire cost. The loop shape
      // was not the problem; this regex was.
      cleaned = cleaned.replace(/\(([^()]+?):\s*-?[\d.]+(?:\s*:\s*-?[\d.]+)?\s*\)/g, _EPE_WEIGHT_INNER);
    } while (cleaned !== prev && ++passes < WEIGHT_PASS_LIMIT);
    // Square brackets [content:number] (A1111 style)
    passes = 0;
    do {
      prev = cleaned;
      cleaned = cleaned.replace(/\[([^\[\]]+?):\s*-?[\d.]+(?:\s*:\s*-?[\d.]+)?\s*\]/g, _EPE_WEIGHT_INNER);
    } while (cleaned !== prev && ++passes < WEIGHT_PASS_LIMIT);
    // Curly braces {content:number}
    passes = 0;
    do {
      prev = cleaned;
      cleaned = cleaned.replace(/\{([^{}]+?):\s*-?[\d.]+(?:\s*:\s*-?[\d.]+)?\s*\}/g, _EPE_WEIGHT_INNER);
    } while (cleaned !== prev && ++passes < WEIGHT_PASS_LIMIT);
    // Strip remaining bare emphasis brackets: (text) → text, [text] → text, {text} → text
    passes = 0;
    do {
      prev = cleaned;
      cleaned = cleaned.replace(/\(([^()]+)\)/g, "$1");
      cleaned = cleaned.replace(/\[([^\[\]]+)\]/g, "$1");
      cleaned = cleaned.replace(/\{([^{}]+)\}/g, "$1");
    } while (cleaned !== prev && ++passes < WEIGHT_PASS_LIMIT);
    // Remove BREAK keywords (ComfyUI prompt section separators)
    cleaned = cleaned.replace(/\bBREAK\b/g, " ");
    // Clean up stray colons followed by numbers (leftover fragments).
    // NOT when a digit sits immediately before the colon: "shot at 4:30 pm"
    // and "16:9 aspect" are ordinary prompt text, and this rule was turning
    // them into "shot at 4 pm" and "16 aspect" in every extracted prompt.
    // Bounded run, for the same reason as the embedding strip: `[^\d]` matches
    // a space and so does the `\s*` after it, so a run of spaces is re-divided
    // between them at every start position. 16 K measured 213 ms, ×4 per
    // doubling. Sixty-four whitespace characters between a word and its stray
    // ":1.2" is far past anything real.
    cleaned = cleaned.replace(/(^|[^\d])\s{0,64}:\s*-?\d+(?:\.\d+)?(?![\d:])/g, "$1");
    // Clean up weight numbers directly attached to words (no colon):
    // "sprites1.3" → "sprites".
    //
    // TWO letters, not one. A single letter followed by a decimal is an
    // aperture, and this rule was destroying it in every photographic prompt
    // the node extracted:
    //   "85mm f1.4 portrait"      -> "85mm f portrait"
    //   "24-70mm f2.8, cinematic" -> "24-70mm f, cinematic"
    //   "cine lens T2.8"          -> "cine lens T"      (T-stop, cine lenses)
    // A leftover weight is always glued to a real word, so requiring two
    // letters costs nothing: "sprites1.3" still matches on "es1.3".
    cleaned = cleaned.replace(/([a-zA-Z]{2})-?\d+\.\d+/g, "$1");
    // Collapse multiple commas, spaces, and newlines
    cleaned = cleaned.replace(/,\s*,+/g, ",").replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
    // Remove leading/trailing commas — by hand, because `[,\s]+$` has nothing
    // to stop it: from every position inside a run it walks to the end of the
    // run and only then discovers there is no end-of-string there. 16 K of
    // spaces that do not reach the end measured 216 ms, ×4 per doubling. Two
    // walks from the ends are the same operation in linear time.
    {
      const _T = /[,\s]/;
      let _a = 0, _b = cleaned.length;
      while (_a < _b && _T.test(cleaned[_a])) _a++;
      while (_b > _a && _T.test(cleaned[_b - 1])) _b--;
      cleaned = cleaned.slice(_a, _b).trim();
    }
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
  // getUint32 throws RangeError on anything shorter than 8 bytes, so a
  // 0-byte or truncated file came back as "Offset is outside the bounds of
  // the DataView" instead of the "Unsupported image format" message this
  // function exists to produce. Dropping a partly-copied file is an ordinary
  // accident and deserves the ordinary error.
  const isPNG = buf.byteLength >= 8 &&
                view.getUint32(0) === 0x89504E47 && view.getUint32(4) === 0x0D0A1A0A;
  const isJPEG = bytes[0] === 0xFF && bytes[1] === 0xD8;
  const isWebP = dec.decode(bytes.slice(0, 4)) === "RIFF" && dec.decode(bytes.slice(8, 12)) === "WEBP";
  
  if (isPNG) {
    // Parse PNG tEXt/iTXt chunks
    let offset = 8;
    // `offset + 8 <=` , not `offset <`: the body reads a 4-byte length and a
    // 4-byte type, so a PNG truncated mid-chunk header threw RangeError out
    // of the whole function — throwing away every tEXt chunk already read.
    // A partly-downloaded PNG whose prompt chunk came through first should
    // still give up the prompt.
    while (offset + 8 <= buf.byteLength) {
      const length = view.getUint32(offset);
      const typeBytes = new Uint8Array(buf, offset + 4, 4);
      const type = dec.decode(typeBytes);
      // Same reason: a length field pointing past the end of the file (a
      // truncated chunk, or a corrupt one) made the Uint8Array construction
      // below throw. Stop cleanly and keep what we have.
      if (offset + 8 + length > buf.byteLength) break;
      
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
          } else if (keyword === "parameters" || keyword === "Parameters") {
            // A1111 / Forge / Fooocus and most SD web UIs write everything
            // into one plain-text chunk under this key. Kept raw here and
            // parsed below only if no ComfyUI metadata turns up.
            result.parameters = value;
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
      // String-aware. Counting braces blind meant one unbalanced brace inside
      // a prompt string — wildcard syntax like {red|blue, an emoticon — ended
      // the object at the wrong offset, and a JPEG that really did carry
      // metadata came back as having none.
      let inStr = false, esc = false;
      for (let i = startIdx; i < str.length; i++) {
        const ch = str[i];
        if (inStr) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
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
    
    // Methods 2-4 all search the same decoded bytes, and `fullText` above
    // already IS that string. The previous shape decoded `bytes.slice(i)` —
    // the entire remainder of the file — at every candidate offset, ran
    // extractJSON over that fresh copy, then advanced one byte and did it
    // again. Quadratic, and measured on this exact code: 32 KB 0.39s,
    // 64 KB 1.49s, 128 KB 6.02s, 256 KB 22.3s, a clean 4x per doubling. A
    // 1 MB crafted JPEG froze the ComfyUI tab for minutes and took any
    // unsaved prompt with it. extractJSON already accepts a start index, so
    // there is nothing to slice.
    //
    // The candidate cap bounds what remains: a file full of `{"1":{`
    // prefixes that never close. Each attempt is linear in what follows it,
    // so an unbounded number of them is still quadratic overall, however
    // cheap each one has become. 64 is far beyond any real image — the first
    // genuine match wins and breaks out.
    const _EPE_MAX_JSON_CANDIDATES = 64;

    // Method 2: Scan for the node-keyed JSON pattern directly
    // This is the most reliable for standard ComfyUI saves
    if (!result.prompt) {
      // Find something like {"1": {"inputs": ... "class_type": ...
      const re2 = /\{"\d+":\s*\{/g;
      let m2, tried2 = 0;
      while (tried2 < _EPE_MAX_JSON_CANDIDATES && (m2 = re2.exec(fullText)) !== null) {
        tried2++;
        const obj = extractJSON(fullText, m2.index);
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

    // Method 3: Look for "prompt" key in a wrapper object
    //
    // This runs even when method 2 already found a prompt. A wrapper carries
    // the workflow as well as the prompt, but method 2 wins on every wrapper
    // — the node-keyed object it matches is nested INSIDE the wrapper — so
    // `result.workflow` was left unset for every JPEG and WebP saved in this
    // shape. _epeParsePromptData takes the workflow to resolve node titles,
    // so dropping it quietly degrades the prompt that comes back.
    if (!result.prompt || !result.workflow) {
      const re3 = /\{\s*"prompt"\s*:/g;
      let m3, tried3 = 0;
      while (tried3 < _EPE_MAX_JSON_CANDIDATES && (m3 = re3.exec(fullText)) !== null) {
        tried3++;
        const obj = extractJSON(fullText, m3.index);
        if (obj && obj.prompt) {
          // Parse into locals before assigning anything. The old code
          // assigned result.prompt from an unguarded JSON.parse, so a
          // wrapper carrying a "prompt" string that is not JSON threw
          // straight out of readImageMetadata and the image was reported as
          // having no metadata at all — even when a later candidate would
          // have parsed. And a workflow that failed to parse after a prompt
          // that succeeded left result half-populated.
          try {
            const p = typeof obj.prompt === "string" ? JSON.parse(obj.prompt) : obj.prompt;
            const w = obj.workflow
              ? (typeof obj.workflow === "string" ? JSON.parse(obj.workflow) : obj.workflow)
              : null;
            // Fill in only what is missing — method 2 may already have the
            // prompt, and its answer is the one that was shipping.
            if (!result.prompt && p) result.prompt = p;
            if (!result.workflow && w) result.workflow = w;
            break;
          } catch (_e) {
            // Not a usable wrapper — keep looking.
          }
        }
      }
    }

    // Method 4: Look for tEXt-like null-separated key-value pairs (WebP EXIF)
    if (!result.prompt) {
      // NB the NUL: the byte loop this replaces matched "prompt" followed by
      // a zero byte, and the string form has to match the same thing.
      const KEY = "prompt\0";
      let from = 0, tried4 = 0;
      while (tried4 < _EPE_MAX_JSON_CANDIDATES) {
        const at = fullText.indexOf(KEY, from);
        if (at < 0) break;
        const valueStart = at + KEY.length;
        from = valueStart;
        // Look only inside the 10-character window the byte loop this
        // replaces used. `fullText.indexOf("{", valueStart)` scans to the end
        // of the file, so a file full of markers with no braces made every
        // one of them walk the whole remainder — the very quadratic this
        // rewrite exists to remove, straight back in. Measured on that
        // version: 128 KB 15ms, 256 KB 37ms, 512 KB 145ms, 1 MB 657ms,
        // against 15ms at 1 MB for the byte loop.
        //
        // EVERY brace in the window, not just the first. The byte loop tried
        // each one, so a decoy "{" in front of the real payload —
        // "prompt\0" + "{z" + the JSON — made the first-brace-only version
        // report the image as carrying no metadata at all.
        const _win = fullText.slice(valueStart, valueStart + 10);
        for (let rel = _win.indexOf("{"); rel !== -1; rel = _win.indexOf("{", rel + 1)) {
          // Count PARSE ATTEMPTS, not markers. Counting markers made the cap
          // a metadata-loss bug in its own right: a file carrying more than
          // 64 "prompt\0" markers before the real payload stopped looking
          // before it got there — the shipped byte loop, which had no cap at
          // all, found it. The marker walk needs no cap: `from` only ever
          // moves forward, so it is linear on its own. The cap is here to
          // bound extractJSON, which is not.
          if (++tried4 > _EPE_MAX_JSON_CANDIDATES) break;
          const obj = extractJSON(fullText, valueStart + rel);
          if (obj) { result.prompt = obj; break; }
        }
        if (result.prompt) break;
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
    // survives refresh/restart via node.properties → workflow JSON — but
    // NEVER during a review: streaming calls this with every partial, and
    // writing those here silently defeated _epePersistPrompt's guard, so a
    // save/autosave mid-review shipped the un-accepted result (or the raw
    // variations dump) as epe_prompt. try/catch: _reviewMode is declared
    // later in this closure and this runs once during build.
    let _inReview = false;
    try { _inReview = !!_reviewMode; } catch (_e) {}
    if (_epeOwnerNode && !_inReview) {
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
          _epeTakeAiSlot();
          _syncVisionStyleBridge();
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

            // No ComfyUI metadata, but an A1111-family `parameters` blob? Use
            // it. These images used to report "no metadata found" while the
            // prompt sat in plain text inside them.
            if (!metadata.prompt && !metadata.workflow && metadata.parameters) {
              const a1 = _epeParseA1111Parameters(metadata.parameters);
              if (a1) {
                metadata._a1111 = a1;
              }
            }

            if (!metadata.prompt && !metadata.workflow && !metadata._a1111) {
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
            
            let parsed;
            if (metadata._a1111) {
              // Same shape the graph walk produces, so every renderer below —
              // the prompt sections, the Use buttons, the metadata chips —
              // works unchanged.
              const a1 = metadata._a1111;
              const s = a1.settings || {};
              parsed = {
                positivePrompts: a1.positive
                  ? [{ nodeId: "a1111", className: "A1111", title: "Prompt", text: a1.positive }] : [],
                negativePrompts: a1.negative
                  ? [{ nodeId: "a1111", className: "A1111", title: "Negative prompt", text: a1.negative }] : [],
                samplers: (s["Steps"] || s["Sampler"] || s["CFG scale"] || s["Seed"]) ? [{
                  nodeId: "a1111", className: "A1111", title: s["Sampler"] || "Sampler",
                  steps: s["Steps"] || "", cfg: s["CFG scale"] || "",
                  sampler_name: s["Sampler"] || "", scheduler: s["Schedule type"] || "",
                  seed: s["Seed"] || "", denoise: s["Denoising strength"] || "",
                }] : [],
                models: s["Model"]
                  ? [{ nodeId: "a1111", className: "A1111", title: "Model", name: s["Model"] }] : [],
                loras: [], vaes: [], clipSettings: [],
                _source: "A1111",
              };
            } else {
              parsed = _epeParsePromptData(metadata.prompt, metadata.workflow);
            }
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
                // Replacing the editor contents wholesale, exactly like a
                // Library load — and it needs the same two things this button
                // was missing.
                //
                // A review open here meant this text was written INTO the
                // review: Discard would then restore _originalPrompt over it,
                // and Accept would commit the extracted prompt as though the
                // model had produced it.
                if (_reviewMode) _autoDiscardReview("Extracted prompt used — result discarded");
                // And without an undo push the user's prompt was gone with no
                // way back. Load-from-file, Clear, "Use this" and Append all
                // push; this one did not.
                if (textEl._epePushUndo) textEl._epePushUndo();
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
          // `lbl` never existed in this scope. The reference sat outside the
          // try below, in an async function, so it became an unhandled
          // rejection that the menu item's `() => { _doExport(); }` never saw:
          // no file, no error, no message. Export Text has never worked.
          //
          // Name the file after the start of the prompt, which is what the
          // user would have picked anyway.
          const _firstLine = (text.split("\n").find(l => l.trim()) || "").trim();
          // Bound, then collapse, then bound again.
          //
          // Slicing to 64 BEFORE the collapse was lossy: a first line opening
          // with 64 non-alphanumerics — a weight stack, a <lora:…> chain, a
          // CJK prefix — collapsed to a single "_", trimmed to "", and every
          // such export was named prompt.txt. Collapsing first fixes that.
          //
          // But the /^_+|_+$/g those comments called quadratic is not: V8
          // runs it linearly, measured flat from 10k to 400k characters. What
          // the slice really bought was not doing regex work over a megabyte
          // of prompt to produce thirty characters — an 8 MB first line went
          // from 0.05 ms to 476 ms when the slice moved. So the bound stays,
          // just wide enough that no realistic prefix can exhaust it.
          const safeName = _firstLine.slice(0, 512)
                                     .replace(/[^a-zA-Z0-9_-]+/g, "_")
                                     .replace(/^_+|_+$/g, "")
                                     .substring(0, 30) || "prompt";
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
          { label: "Save Favorite",  title: "Save current prompt to Favorites",      onclick: () => { if (saveFavBtn.onclick) saveFavBtn.onclick(); } },
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
        saveFavBtn.onclick = () => {
          // Same rule as the AI actions: during a variations review textEl is
          // the raw model dump, and this happily saved it to the library.
          if (_reviewMode && _reviewMode !== "single") {
            _toast("Finish the current result first — use it, or discard it.");
            return;
          }
          const _sel = textEl.value.slice(textEl.selectionStart, textEl.selectionEnd).trim();
          _libAddEntry("favorites", _sel || textEl.value);
        };

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
          _epeTakeAiSlot();
          _syncVisionStyleBridge();
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
          // Through hideAiPanel, which runs _destroy() — two document
          // mousemove/mouseup pairs and a ResizeObserver. Unreachable today
          // (the only caller checks _aiFloatPanel first), which is exactly
          // why it is worth closing: the second caller to appear would strand
          // four document listeners and an observer per call.
          if (_aiFloatPanel) { try { hideAiPanel(); } catch (_e) {} _aiFloatPanel = null; }
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
          const makeCollapsible = (title, textareaValue, defaultValue, settingsKey) => {
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
              if (defaultValue == null) return;
              ta.value = defaultValue;
              ta.style.display = "block";
              arrow.style.transform = "rotate(90deg)";
              hint.textContent = "click to collapse";
              // Commit the revert straight away, and touch nothing else. Without
              // this the reverted text lives only in the textarea, so closing the
              // panel with the X or the toolbar toggle silently discards it and
              // the user's old custom prompt stays in force — the button would
              // look like it worked and would not have. Only this one prompt's
              // stored override is removed; url, model and every other prompt are
              // left exactly as they are.
              if (settingsKey) _epeOllama.clearStoredKey(settingsKey);
              resetToDefaultBtn.textContent = "✓ Restored";
              if (resetToDefaultBtn._epeRevertT) clearTimeout(resetToDefaultBtn._epeRevertT);
              resetToDefaultBtn._epeRevertT = setTimeout(() => {
                resetToDefaultBtn.textContent = "↺ Default";
                resetToDefaultBtn._epeRevertT = null;
              }, 1500);
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

          const { section: expandSection, ta: expandTA } = makeCollapsible("Expand System Prompt", s.expandPrompt, _epeOllama._defaults.expandPrompt, "expandPrompt");
          advBody.appendChild(expandSection);

          const { section: variSection, ta: variTA } = makeCollapsible("Variations System Prompt", s.variationsPrompt, _epeOllama._defaults.variationsPrompt, "variationsPrompt");
          advBody.appendChild(variSection);

          const { section: img2imgSection, ta: img2imgTA } = makeCollapsible("Img2Img System Prompt", s.img2imgPrompt || _epeOllama._defaults.img2imgPrompt, _epeOllama._defaults.img2imgPrompt, "img2imgPrompt");
          advBody.appendChild(img2imgSection);

          const { section: invertSection, ta: invertTA } = makeCollapsible("Aesthetic Inverter Prompt", s.invertPrompt || _epeOllama._defaults.invertPrompt, _epeOllama._defaults.invertPrompt, "invertPrompt");
          advBody.appendChild(invertSection);

          const { section: instructSection, ta: instructTA } = makeCollapsible("Instruct Edit Prompt", s.instructPrompt || _epeOllama._defaults.instructPrompt, _epeOllama._defaults.instructPrompt, "instructPrompt");
          advBody.appendChild(instructSection);

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

          // Version footer — surfaces EPE version so a bug report always
          // carries it, without asking the reporter to paste startup logs.
          // Populated from /epe/ollama/check's response (see populateModels).
          const verFoot = document.createElement("div");
          verFoot.style.cssText = "font-size:9px;color:#4e5c6e;text-align:right;padding-top:6px;font-family:inherit;";
          verFoot.textContent = "EPE — checking version…";
          aiSettingsPanel.appendChild(verFoot);

          // --- Event handlers ---
          const populateModels = async (url) => {
            statusDot.style.background = "#ca0";
            testBtn.textContent = "...";
            // Ask the backend to ensure Ollama is up first — it will auto-start
            // a local Ollama if it isn't running. Returns { running, autoStart }.
            let ensured = null;
            try {
              // Bounded like the sibling _backendCheck — a hung socket
              // must not leave the version footer at "checking…" forever
              // (its purpose is bug-report visibility, so it MUST resolve
              // one way or another).
              const r = await api.fetchApi("/epe/ollama/check", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ollamaUrl: url }),
                signal: (typeof AbortSignal !== "undefined" && AbortSignal.timeout)
                  ? AbortSignal.timeout(20000) : undefined,
              });
              if (r.ok) ensured = await r.json();
            } catch (e) {}
            try {
              if (ensured && typeof ensured.epeVersion === "string") {
                verFoot.textContent = "EPE " + ensured.epeVersion;
              } else if (verFoot.textContent === "EPE — checking version…") {
                verFoot.textContent = "EPE — version unknown";
              }
            } catch (_e) {}
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
              } else if (reason === "already_starting") {
                // Another EPE tab (or another concurrent /epe/ollama/check
                // request) is already running the spawn/poll dance for this
                // URL. This handler deduped against it, waited up to ~18 s,
                // and re-probed — but Ollama still isn't answering.
                failOpt.textContent = "— Ollama is starting — try again shortly —";
                modelSelect.title = "Another EPE node is already starting Ollama on this URL. Wait a few seconds and press Test again.";
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
            if (instructTA.value !== _epeOllama._defaults.instructPrompt) {
              toSave.instructPrompt = instructTA.value;
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
            instructTA.value = _epeOllama._defaults.instructPrompt;
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
        // The slot is taken BEFORE the result takes over the review. A vision
        // answer arriving into a review that something else is still streaming
        // into is the case round 19 left open; from here on the stream is
        // stopped first. The vision run's own controller lives in
        // _epeOllamaVision._abortByOwner, not in _aiAbort, so this can only
        // ever abort a different run.
        showAiPanel._showAiResult = (opts) => { _epeTakeAiSlot(); return showAiResult(opts); };
        
        const hideAiPanel = () => {
          if (_aiFloatPanel) {
            if (_aiFloatPanel._destroy) _aiFloatPanel._destroy();
            _aiFloatPanel.remove();
            _aiFloatPanel = null;
          }
        };
        // The float panel lives on document.body — without this, every node
        // dispose (workflow-tab switch, node delete) orphaned the panel plus
        // its two document listener pairs and its ResizeObserver.
        if (_epeOwnerNode) {
          const _fpPrevDispose = _epeOwnerNode._epeDispose;
          _epeOwnerNode._epeDispose = () => {
            try { _fpPrevDispose && _fpPrevDispose(); } catch (_e) {}
            try { hideAiPanel(); } catch (_e) {}
          };
        }

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
          // A vision run is not tracked in _aiAbort and leaves _reviewMode
          // null while it works, so the tab switch that cancels a streaming
          // run does not touch it. Its caption can therefore land on a
          // variations review the user came back to — and _reviewSetMode
          // ("single") calls _applyReviewModeUI, which calls
          // _clearVariationsCards: all three cards gone, with no toast and
          // without the user choosing Use this or Discard. Announced instead,
          // which is what every other path that replaces a result does.
          if (_reviewMode === "variations") {
            _autoDiscardReview("New result arrived — variations discarded");
          }
          if (_reviewMode) {
            _reviewSetMode("single");
            // A result arriving here is never an instruct result — instruct
            // has its own path. Without this, chaining a vision result onto
            // an instruct review kept the flag and skipped _ieThreadClear
            // on commit, carrying stale direction into later edits.
            // Dropping the flag orphans any instruct snapshot the earlier
            // review was still holding — Discard gates the thread rollback
            // on the flag — so roll the thread back to it NOW, while this
            // result replaces a prompt those instructions no longer describe.
            if (_ieReviewIsInstruct && _ieThreadSnapshot) {
              _ieThreadSet(_ieThreadSnapshot);
            }
            // RE-MARKED, not nulled — runAiAction's twin thirty lines down has
            // done this since the round it was written, and this one did not.
            // An instruct edit chained onto THIS result takes _ieApplyOne's
            // chained branch, which deliberately does not snapshot; so leaving
            // it null produced a review that was isInstruct with no rollback
            // point. Discard then kept the rejected instruction, and the park
            // — which gates its rollback on the same pair — left it live for
            // the next persist to write into the saved workflow.
            _ieThreadSnapshot = _ieThreadGet().slice();
            _ieReviewIsInstruct = false;
          } else {
            _reviewEnter("single");
            // Mark the instruct rollback point here as well. An instruct
            // edit chained onto an Image-to-Prompt result takes the CHAINED
            // branch, which deliberately does not snapshot — so without this
            // there was nothing to roll back to and Discard silently kept
            // the rejected instruction in the thread.
            _ieThreadSnapshot = _ieThreadGet().slice();
            // ...and this is NOT an instruct review. Nothing resets the flag
            // on commit, so a true left over from an earlier instruct edit
            // made this result skip _ieThreadClear and carry that stale
            // direction into every later edit.
            _ieReviewIsInstruct = false;
          }

          // Replace editor content with the final cleaned result.
          textEl.value = text;
          updateTokenBadge(textEl.value);
          // Persist it, but keep it off the undo stack: _reviewEnter already
          // pushed the pre-AI prompt, and pushing the output on top of that
          // made the first ↶ restore what was already on screen — and, after
          // a Discard, resurrect the text just thrown away.
          if (textEl._epeUndoMute) textEl._epeUndoMute(true);
          try {
            textEl.dispatchEvent(new Event("input"));
          } finally {
            if (textEl._epeUndoMute) textEl._epeUndoMute(false);
          }
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

        // Take the AI slot for a new run, aborting whatever holds it.
        //
        // A vision run started while Enhance was streaming used to leave BOTH
        // alive: the vision result took over the review through showAiResult,
        // the Enhance stream kept calling onToken, and once the review exited
        // every later partial was written straight into
        // node.properties.epe_prompt by updateTokenBadge — with no undo entry
        // for it, and the next queue shipped the partial to the sampler.
        // Discard/Use this/Esc could not stop it either: they gate their abort
        // on _reviewMode === "streaming", and the review was "single" by then.
        //
        // _ieApplyOne has done this before taking the slot since round 4.
        // Round 19 covered one ordering — Enhance streaming, then a vision run
        // starts — because that is the one that was reported. The reverse
        // ordering was open: with a vision run in flight, clicking Enhance
        // aborted nothing, and when the caption landed, showAiResult took over
        // the review with _reviewSetMode("single") while the Enhance stream was
        // still live. From then on Discard, Esc and _autoDiscardReview all gate
        // their abort on `_reviewMode === "streaming"` and could not stop it,
        // and once the review exited, every later partial went straight into
        // node.properties.epe_prompt. Measured: after Discard the editor
        // visibly restored the user's prompt and then mutated by itself into a
        // half-finished enhance — which is what the next Queue sent to the
        // sampler, with the original gone from the undo stack too.
        //
        // So the slot is BOTH: the editor's own controller and this node's
        // vision run. Starting Enhance ends the caption, which is what the user
        // already believes happened — starting Enhance removes the vision
        // progress panel and its Cancel button.
        const _epeTakeAiSlot = () => {
          const _had = !!_aiAbort;
          if (_aiAbort) {
            try { _aiAbort.abort(); } catch (_e) {}
            _aiAbort = null;
          }
          try { _epeOllamaVision._abortOwn(WIN_ID); } catch (_e) {}
          // …and end the review that stream was writing into.
          //
          // runAiAction's AbortError branch returns without exiting review, on
          // the stated premise that "Discard/Cancel has already restored
          // original and exited". True of the strip's own Cancel; NOT true of
          // this function, which is what the vision runs, the model picker and
          // showAiPanel._showAiResult call. So: Enhance is streaming, the user
          // clicks Image to Prompt, the stream is aborted here, and the vision
          // run then bails (Ollama stopped, or they hit Cancel on the model
          // picker). Nothing else runs. The strip reads "Streaming…" forever,
          // textEl.readOnly stays true so they cannot type, and both
          // _epePersistPrompt and updateTokenBadge hard-return on _reviewMode
          // — so nothing they do afterwards is saved, with no request in
          // flight to explain it.
          if (_had && _reviewMode === "streaming") {
            try { _autoDiscardReview("Replaced by a new request"); } catch (_e) {}
          }
        };

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
            // Restores on screen AND onto the node. Setting textEl.value
            // alone left the AI result in node.properties.epe_prompt, and
            // the next rebuild silently undid the Discard.
            textEl._epeRestoreValue(_originalPrompt);
            updateTokenBadge(textEl.value);
          }
          // ROUND 66 (V-3): the restore above is a MUTED dispatch, so
          // _pushUndo's `_redo.length = 0` never runs and nothing removes the
          // rejected result from either stack. Put both back the way the
          // review found them. Must run BEFORE _reviewExit, which drops the
          // mark.
          if (textEl._epeUndoReviewRollback) textEl._epeUndoReviewRollback();
          // Auto-discarding an instruct result unwinds its direction too.
          if (_ieReviewIsInstruct && _ieThreadSnapshot) {
            _ieThreadSet(_ieThreadSnapshot);
          }
          _ieThreadSnapshot = null;
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
          // Innermost thing first. The comment below used to say dropdowns
          // "handle their own dismissal" — they do, on document MOUSEDOWN, and
          // nothing listened for Esc. So Esc over an open menu discarded the
          // result underneath it and left the menu floating on document.body
          // with nothing able to close it. A keystroke aimed at a menu must
          // not cost the user their result.
          try {
            if (_closeAllDropdowns() > 0) {
              ev.preventDefault();
              ev.stopPropagation();
              return;
            }
          } catch (_e) {}
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
            // Restores on screen AND onto the node. Setting textEl.value
            // alone left the AI result in node.properties.epe_prompt, and
            // the next rebuild silently undid the Discard.
            textEl._epeRestoreValue(_originalPrompt);
            updateTokenBadge(textEl.value);
          }
          // ROUND 66 (V-3): the restore above is a MUTED dispatch, so
          // _pushUndo's `_redo.length = 0` never runs and nothing removes the
          // rejected result from either stack. Put both back the way the
          // review found them. Must run BEFORE _reviewExit, which drops the
          // mark.
          if (textEl._epeUndoReviewRollback) textEl._epeUndoReviewRollback();
          // Esc IS Discard, so it must also reject the direction behind an
          // instruct result. Without this the instruction stayed in the
          // thread and went out as EARLIER DIRECTION on every later edit,
          // describing a change the prompt no longer had.
          if (_ieReviewIsInstruct && _ieThreadSnapshot) {
            _ieThreadSet(_ieThreadSnapshot);
          }
          _ieThreadSnapshot = null;
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
        
        
        // opts.sourceText: the caller has its own prompt text and is asking
        // for it to be used — the variations cards' "Options ▾" chain, and the
        // browser cards' Enhance / Variations shortcuts. Those are legitimate
        // mid-review re-runs; what the guard below exists to stop is the rail
        // and toolbar buttons silently re-sending whatever happens to be in
        // the hidden textarea.
        const runAiAction = async (mode, opts) => {
          const _srcText = opts && typeof opts.sourceText === "string"
            ? opts.sourceText.trim() : null;
          // Mid-review textEl is not the prompt — it holds an un-accepted
          // result, a half-streamed partial, or (in variations mode, where it
          // is hidden entirely) the raw multi-variation model dump. Sending
          // that back as the prompt is how "Enhance" turned into "enhance the
          // dump". Accept or discard first.
          if (_reviewMode && _reviewMode !== "single" && _srcText === null) {
            _toast("Finish the current result first — use it, or discard it.");
            return;
          }

          // EVERY check that can bail runs BEFORE review is entered. Entering
          // first left the editor read-only under a "Streaming…" bar with no
          // way out when Ollama was down — and, from the variations Options
          // chain, cleared the three generated cards before bailing.
          const promptText = _srcText !== null ? _srcText : textEl.value.trim();
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

          // Nothing below here bails, so it is safe to take over the review.
          // The token is bumped on EVERY entry, not just the instruct ones:
          // this call may have aborted an instruct edit that is still
          // unwinding, and without the bump that unwind matched the token and
          // tore down the review this call now owns — after which the stream
          // persisted straight into node.properties with no review bar.
          _ieReviewToken++;
          if (_srcText !== null) {
            const _wasFresh = !_reviewMode;
            if (_reviewMode) _reviewSetMode("streaming");
            else _reviewEnter("streaming");
            if (_wasFresh) {
              // Same rollback point every other fresh entry marks. Without
              // it, an instruct edit chained onto this result could not be
              // rolled back on Discard and stayed in the thread for good.
              _ieThreadSnapshot = _ieThreadGet().slice();
              _ieReviewIsInstruct = false;
            }
            if (textEl._epeUndoMute) textEl._epeUndoMute(true);
            try {
              textEl.value = _srcText;
              updateTokenBadge(_srcText);
            } finally {
              if (textEl._epeUndoMute) textEl._epeUndoMute(false);
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
            if (_reviewMode) {
              _reviewSetMode("streaming");
              // Chaining onto a review that may be an instruct edit's. Clearing
              // the flag below orphans that review's rollback point, because
              // Discard gates the thread rollback on the flag — so the
              // rejected instruction survived Discard and went on steering
              // every later edit. Roll the thread back NOW, while this result
              // replaces a prompt those instructions no longer describe, then
              // re-mark the rollback point at the state we just restored so an
              // instruct edit chained onto THIS review still has one.
              // _epeVisionResult does exactly this and says why; runAiAction
              // did not.
              if (_ieReviewIsInstruct && _ieThreadSnapshot) {
                _ieThreadSet(_ieThreadSnapshot);
              }
              _ieThreadSnapshot = _ieThreadGet().slice();
            } else {
              _reviewEnter("streaming");
              // Mark the rollback point here too. An instruct edit chained
              // onto this review flips _ieReviewIsInstruct to true, and
              // Discard then rolled the thread back to whatever stale
              // snapshot happened to be left over — which could empty the
              // user's entire accumulated direction.
              _ieThreadSnapshot = _ieThreadGet().slice();
            }
            _ieReviewIsInstruct = false;
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

          // Abort previous if still running. This run's controller is held
          // locally — see _ieApplyOne: a newer owner of _aiAbort must not be
          // nulled by this request's unwind.
          //
          // Through _epeTakeAiSlot, not inline, so this also ends a vision run
          // that is still in flight. Inline it only ever aborted _aiAbort, and
          // a caption arriving afterwards took over this review while this
          // stream kept writing into it.
          _epeTakeAiSlot();
          const _runCtrl = new AbortController();
          _aiAbort = _runCtrl;
          
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
            // (temperature, top_p, top_k, num_predict, min_p, seed, repeat_penalty, repeat_last_n).
            const sliderOpts = _composeOllamaOpts();
            // Variations emits THREE ~180-word paragraphs — roughly 3x the output of
            // a single prompt. The Length slider's num_predict cap (200-800) starves
            // that budget, so the model stops partway through and the 3rd variation
            // comes back unfinished (or only 2 parse out). Give this mode a floor
            // sized for all three paragraphs; the slider still sets each one's length
            // via the system prompt's word target.
            if (mode === "variations") {
              sliderOpts.num_predict = Math.max(sliderOpts.num_predict || 0, 2048);
            }
            let tokenCount = 0;
            const raw = await _epeOllama.generate(systemPrompt, promptText, {
              signal: _runCtrl.signal,
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
                    // Same as Discard: the value has to reach the node, or a
                    // rebuild brings back the result this call failed on.
                    textEl._epeRestoreValue(orig);
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
                    // Same as Discard: the value has to reach the node, or a
                    // rebuild brings back the result this call failed on.
                    textEl._epeRestoreValue(orig);
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
              if (_aiAbort === _runCtrl) _aiAbort = null;
              return;
            }
            // Network/other failure: restore original prompt and exit review (if active)
            // before surfacing the error in the floating panel.
            if (useReviewMode) {
              const orig = _originalPrompt;
              _reviewExit();
              singleActionRow.style.display = "none";
              if (orig !== null) {
                textEl._epeRestoreValue(orig);
                updateTokenBadge(textEl.value);
              }
            }
            showAiError(/thinking/i.test(err.message || "") ? err.message : `Request failed: ${err.message}`);
          }
          if (_aiAbort === _runCtrl) _aiAbort = null;
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
        // flex-shrink 1 (was 0) and a much lower floor: the tuning block below
        // now has a draggable height, so the editor has to be able to give space
        // back as well as take it. Without the shrink the editor would refuse to
        // yield and leftPane would just scroll instead.
        editorWrap.style.cssText = `
          display: flex;
          flex: 1 1 auto;
          min-height: 120px;
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
          // A result under review is not the user's prompt yet. Writing it
          // here meant a node rebuild — a workflow-tab switch, a reload —
          // committed a result nobody had accepted and destroyed the
          // original, which existed only in this closure. The node keeps the
          // last COMMITTED value; Use this / Append persist explicitly.
          if (_reviewMode) return;
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
            try {
              // THE RULE: what is in the prompt box is what renders.
              //
              // Queueing is how you EVALUATE a prompt — enhance, look at the
              // result, render it to see what it does, maybe enhance again
              // from it, and only then decide. So the prompt you are looking
              // at is the one that should go to the render, accepted or not.
              //
              // Before round 70 this answered by review MODE and sent the
              // committed prompt for everything except a finished Instruct
              // Edit. That made the box lie in the common case, and a user
              // who learns the box sometimes lies cannot trust it in any case.
              //
              // Mid-stream is NOT an exception, deliberately. A box holding
              // "A red dragon with wings that" is not a prompt, and rendering
              // it wastes GPU time — but nobody queues a half-finished prompt
              // on purpose, they can see the box while it streams, and one
              // rule with no exceptions is worth more than a rare render.
              //
              // So the code asks the question the USER asks: is the prompt box
              // on screen? `display: none` is set in exactly one place in this
              // file — the variations branch of _applyReviewModeUI — where
              // three cards are showing and there is no single prompt in the
              // main window at all. That is the one state that still sends the
              // committed value, and it is read from the thing the user can
              // see rather than inferred from a mode name.
              //
              // Unreadable style (a rig, an exotic host) counts as VISIBLE, so
              // the rule holds by default rather than silently inverting.
              let _boxHidden = false;
              try { _boxHidden = !!(textEl.style && textEl.style.display === "none"); }
              catch (_e2) { _boxHidden = false; }
              if (_boxHidden) {
                return (_epeOwnerNode.properties && _epeOwnerNode.properties.epe_prompt) || "";
              }
              // DELIBERATELY does not write epe_prompt. QUEUEING SENDS; IT
              // NEVER COMMITS. Round 70 widened what is sent and changed
              // nothing about what is stored, and that is exactly why it is
              // safe where round 56's attempt was not.
              //
              // Round 56 did write it, so that a render queued mid-review would
              // be reproducible from the workflow saved beside it. It cost two
              // HIGH data-loss regressions in two consecutive rounds, because
              // it broke the invariant everything else here leans on:
              // **epe_prompt is only ever the last COMMITTED value.**
              // _epePersistPrompt's review guard, _epeTabRestore's reconcile
              // (which treats epe_prompt as authoritative over epe_tabs) and
              // the park machinery all assume it. Once an un-accepted result
              // could live there, Discard could not reliably remove it: on
              // the explicit path the rollback was swallowed by the review
              // guard, and on the workflow-reload path by the _epeRestoring
              // guard, and the reconcile then wrote the rejected text over
              // the user's own prompt in the tab array.
              //
              // The gap that leaves — a mid-review queue is not reproducible
              // from its own workflow — is on the register as an open
              // decision. It is not worth the user's prompt.
              return textEl.value || "";
            }
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
        const _reviewEnter = (mode, _restoreOriginal) => {
          if (_restoreOriginal !== undefined) {
            // Bringing a PARKED review back. The snapshot and its undo entry
            // were both taken when the review first opened; taking them again
            // would snapshot the tab's committed prompt over the user's real
            // starting point and push a second entry for the same edit.
            _originalPrompt = _restoreOriginal;
          } else if (!_reviewMode) {
            // Capture original on first entry only — chained operations preserve
            // the user's true starting prompt across streaming → single transitions.
            _originalPrompt = textEl.value;
            // Push the pre-AI prompt onto the undo stack so ↶ / Ctrl+Z recalls
            // it after the result is accepted (replaces the old Recall button).
            if (textEl._epePushUndo) textEl._epePushUndo();
          }
          // ROUND 66 (V-3): mark the boundary AFTER that push, so the pre-AI
          // prompt is below the floor — Discard restores to it, and ↶ inside
          // the review cannot step past it and put the rejected result on the
          // redo branch. Idempotent, so a parked review re-entering keeps the
          // boundary it opened with.
          if (textEl._epeUndoReviewMark) textEl._epeUndoReviewMark();
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
          // ROUND 66: drop the boundary WITHOUT restoring. The four
          // non-commit exits roll back first (they call
          // _epeUndoReviewRollback before reaching here); everything else
          // reaching this point is a commit, whose steps stay as history.
          // Doing it here rather than at each caller is the same reasoning
          // as _ieReviewIsInstruct three lines down: every exit passes
          // through, and "everyone remembers" has shipped a bug before.
          if (textEl._epeUndoReviewEnd) textEl._epeUndoReviewEnd();
          // Reset here rather than at every caller. Every non-park exit
          // must clear this — commit, Discard, auto-discard, failure — and
          // the "everyone remembers" contract has shipped a bug before
          // (the flag survived into a fresh Enhance review, letting
          // graphToPrompt inject the wrong prompt at queue time now that
          // _epeGetPrompt gates on it too). Single point of truth here.
          _ieReviewIsInstruct = false;
          // Every exit passes through here — commit (which has already
          // flushed), Discard, auto-discard, failure. Nothing pending can
          // survive into a later review.
          _ieChainUndo = [];
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
          // Flush the instruct thread now that _reviewMode is null.
          // _iePersistThreads refuses to write under review (an un-accepted
          // instruction is not direction yet), so this is where the accepted —
          // or rolled-back — thread actually reaches node.properties. Every
          // exit passes through here, so no commit or discard path needs to
          // remember to do it. Guarded because this runs during the build,
          // before _iePersistThreads is initialised.
          try { if (typeof _iePersistThreads === "function") _iePersistThreads(); } catch (_e) {}
          // No prompt flush here, deliberately.
          //
          // Round 56b added one to contain J-04's write, and it could not:
          // _epeTabRestore sets _epeRestoring BEFORE its own auto-discard, so
          // the one path that most needed the rollback was the one the guard
          // turned it off for. Removing the guard was worse — measured, it
          // persisted the OUTGOING workflow's tabs over the incoming file.
          //
          // With J-04 reverted there is nothing to flush: epe_prompt is only
          // ever written by an accepted commit, so a discard has nothing to
          // undo there and every exit already leaves it correct. This call
          // also reached _epeTabSync -> _persistTabs, which meant every review
          // exit rewrote epe_tabs — a write nothing in the suite covered.
        };

        // Discard / Cancel handler. During streaming this also aborts the in-flight
        // AI request. Always restores the original prompt and unloads the model.
        reviewDiscardBtn.onclick = () => {
          if (_reviewMode === "streaming" && _aiAbort) {
            try { _aiAbort.abort(); } catch (_e) {}
            _aiAbort = null;
          }
          if (_originalPrompt !== null) {
            // Restores on screen AND onto the node. Setting textEl.value
            // alone left the AI result in node.properties.epe_prompt, and
            // the next rebuild silently undid the Discard.
            textEl._epeRestoreValue(_originalPrompt);
            updateTokenBadge(textEl.value);
          }
          // ROUND 66 (V-3): the restore above is a MUTED dispatch, so
          // _pushUndo's `_redo.length = 0` never runs and nothing removes the
          // rejected result from either stack. Put both back the way the
          // review found them. Must run BEFORE _reviewExit, which drops the
          // mark.
          if (textEl._epeUndoReviewRollback) textEl._epeUndoReviewRollback();
          // Rejecting an instruct result also rejects the direction behind it.
          if (_ieReviewIsInstruct && _ieThreadSnapshot) {
            _ieThreadSet(_ieThreadSnapshot);
          }
          _ieThreadSnapshot = null;
          _reviewExit();
          singleActionRow.style.display = "none";
          try { _epeOllama.unloadModel(); } catch (_e) {}
        };

        // --- Dropdown helper ---
        // Creates a labelled dropdown button (e.g. "Save ▾", "Options ▾"). Items
        // are { id, label }. Picking an item invokes onPick(id) and closes the menu.
        // Click-outside dismisses; the menu auto-flips upward if there isn't enough
        // room below the button.
        // Every dropdown this editor has built. Their menus mount on
        // document.body with position:fixed — so they escape the editor's
        // overflow clipping, and nothing that tears the editor down removes
        // them by removing a parent. Only the two named dropdowns were closed
        // explicitly on Esc and on dispose; the per-card ones on the variation
        // cards were not, so an open one stayed on screen over the next tab's
        // canvas with its items still live against a destroyed editor.
        const _epeDropdowns = new Set();
        // Returns how many were actually open. Callers that only want the
        // teardown ignore it; Esc uses it to decide whether it has already
        // done the user's bidding.
        const _closeAllDropdowns = () => {
          let _closed = 0;
          for (const w of Array.from(_epeDropdowns)) {
            try { if (w && w._closeDropdown && w._closeDropdown() === true) _closed++; } catch (_e) {}
            // A wrap no longer in the document cannot be reopened, so stop
            // holding it.
            try { if (w && !w.isConnected) _epeDropdowns.delete(w); } catch (_e) {}
          }
          return _closed;
        };

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

          // Reports whether it actually closed something, so Esc can tell
          // "a menu was open" from "nothing was open" without reaching into
          // this closure.
          const _closeMenu = () => {
            const _was = _menuOpen;
            if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
            menu = null;
            _menuOpen = false;
            document.removeEventListener("mousedown", _onDocClick, true);
            return _was;
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
          // Registered so a teardown can reach it. Pruned here rather than on
          // every open: the variation cards build a pair of these on each
          // render, so the set would otherwise grow for the life of the node.
          if (_epeDropdowns.size > 64) {
            for (const w of Array.from(_epeDropdowns)) {
              // CLOSE, then forget. The registry entry is the wrap's only
              // teardown handle, so dropping one whose menu is still open on
              // document.body orphaned both the menu and its capture-phase
              // document listener with nothing left able to reach them.
              // The delete is in a finally: with both in one try, a throw
              // inside _closeMenu skipped it, the set never dropped below 64,
              // and the sweep re-ran — and re-threw — on every subsequent
              // dropdown for the life of the node. That is the unbounded
              // growth this block exists to prevent.
              if (w && !w.isConnected) {
                try { if (w._closeDropdown) w._closeDropdown(); } catch (_e) {}
                finally { try { _epeDropdowns.delete(w); } catch (_e2) {} }
              }
            }
          }
          _epeDropdowns.add(wrap);

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
          // The chain is kept, so its intermediate steps become undo steps now.
          _ieChainUndo.forEach(v => textEl._epePushUndoValue && textEl._epePushUndoValue(v));
          if (!_ieReviewIsInstruct) _ieThreadClear();
          _ieThreadSnapshot = null;   // committed — nothing to roll back to
          _reviewExit();
          // Persistence was suspended for the review, so the accepted value
          // has to be written now — after the exit, or it is suspended still.
          _epePersistPrompt();
          singleActionRow.style.display = "none";
          try { _epeOllama.unloadModel(); } catch (_e) {}
          // Phase 4 will surface the Recall prompt button here.
        };

        // Send to tab — put this result in ANOTHER tab and carry on here.
        //
        // Deliberately does not commit, exit the review, or touch this tab. It
        // is not a third way to accept a result; it is a way to park one
        // somewhere while you keep working on this one.
        const sendTabBtn = document.createElement("button");
        sendTabBtn.textContent = "Send to tab";
        sendTabBtn.title = "Put this result in another tab, without leaving this one";
        sendTabBtn.style.cssText = toolBtnStyle + "font-size:11px;padding:4px 11px;";
        toolBtnHover(sendTabBtn);
        sendTabBtn.onclick = (ev) => {
          ev.stopPropagation();
          // Published by _buildPromptTabs, which runs later in this same
          // builder — resolved at CLICK time, so the ordering is fine.
          if (_epeOwnerNode && _epeOwnerNode._epeOpenSendToTab) {
            _epeOwnerNode._epeOpenSendToTab(sendTabBtn, textEl.value);
          }
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
          // Same as the result path: pushing the value now on screen made
          // the first ↶ a no-op, and with a chain it bounced straight back
          // to the text just committed instead of stepping through it.
          if (textEl._epeUndoMute) textEl._epeUndoMute(true);
          try {
            textEl.dispatchEvent(new Event("input"));
          } finally {
            if (textEl._epeUndoMute) textEl._epeUndoMute(false);
          }
          updateTokenBadge(textEl.value);
          _ieChainUndo.forEach(v => textEl._epePushUndoValue && textEl._epePushUndoValue(v));
          if (!_ieReviewIsInstruct) _ieThreadClear();
          _ieThreadSnapshot = null;
          _reviewExit();
          _epePersistPrompt();
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
          // Remember the real label once and cancel any pending revert. A
          // second click inside 1.2 s used to capture "✓ Saved" as the label
          // to restore, and its timer fired last — so the button read
          // "✓ Saved" for the rest of the session.
          if (saveDdBtn._epeOrigLabel == null) saveDdBtn._epeOrigLabel = saveDdBtn._labelText;
          saveDdBtn._labelText = "✓ Saved";
          if (saveDdBtn._epeRevertT) clearTimeout(saveDdBtn._epeRevertT);
          saveDdBtn._epeRevertT = setTimeout(() => {
            saveDdBtn._labelText = saveDdBtn._epeOrigLabel;
            saveDdBtn._epeRevertT = null;
          }, 1200);
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
        singleActionBtns.appendChild(sendTabBtn);
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

        // The two dropdown wraps each card builds. _epeDropdowns is a
        // registry with one sweep — inside _makeDropdownBtn, and only past 64
        // entries — so a card's wraps outlived the card, and each wrap's
        // onPick closes over cardBody and through it the whole detached card,
        // prompt text included. Rendering the cards once per AI run kept that
        // near empty; parking rebuilds them on every tab round trip, which
        // parked the pool AT its cap instead — measured, thirty detached cards
        // and about fifty kilobytes of prompt held permanently.
        let _cardDropdowns = [];

        const _clearVariationsCards = () => {
          // Closed, then forgotten — the same order and the same reason as the
          // sweep in _makeDropdownBtn: the registry entry is the wrap's only
          // teardown handle, so dropping one whose menu is still open on
          // document.body would orphan the menu and its capture-phase
          // document listener with nothing left able to reach them.
          for (const w of _cardDropdowns) {
            try { if (w && w._closeDropdown) w._closeDropdown(); } catch (_e) {}
            finally { try { _epeDropdowns.delete(w); } catch (_e2) {} }
          }
          _cardDropdowns = [];
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
              // No push here: textEl still holds the raw multi-variation
              // stream dump, and pushing it made the first undo after a
              // commit restore that dump. The pre-AI prompt is already on
              // the stack (_reviewEnter pushed it) — that is what undo
              // should reach.
              textEl.value = txt;
              updateTokenBadge(txt);
              // Muted like the other commit paths, so the committed value is
              // not its own undo step.
              if (textEl._epeUndoMute) textEl._epeUndoMute(true);
              try {
                textEl.dispatchEvent(new Event("input"));
              } finally {
                if (textEl._epeUndoMute) textEl._epeUndoMute(false);
              }
              // Committing a variation replaces the prompt wholesale, which
              // makes any existing instruct direction stale — same contract
              // as Use this / Append (and the chain, if this review grew out
              // of an instruct chain, becomes undo steps now).
              _ieChainUndo.forEach(v => textEl._epePushUndoValue && textEl._epePushUndoValue(v));
              if (!_ieReviewIsInstruct) _ieThreadClear();
              _ieThreadSnapshot = null;
              _reviewExit();
              // Persistence is suspended during review; the commit persists
              // explicitly after the exit (same as Use this / Append).
              _epePersistPrompt();
              try { _epeOllama.unloadModel(); } catch (_e) {}
            };

            // Send to tab — the case Daniel described: keep one variation
            // while you try a different style, instead of having to choose now.
            const cardSendBtn = document.createElement("button");
            cardSendBtn.textContent = "Send to tab";
            cardSendBtn.title = "Put this variation in another tab, without leaving this one";
            cardSendBtn.style.cssText = toolBtnStyle + "font-size:11px;padding:4px 11px;";
            toolBtnHover(cardSendBtn);
            cardSendBtn.onclick = (ev) => {
              ev.stopPropagation();
              if (_epeOwnerNode && _epeOwnerNode._epeOpenSendToTab) {
                _epeOwnerNode._epeOpenSendToTab(cardSendBtn, cardBody.value);
              }
            };

            // Save ▾
            const cardSaveDd = _makeDropdownBtn("Save", [
              { id: "fav", label: "Favorites" },
              { id: "snip", label: "Snippets" },
            ], (id) => {
              const target = id === "fav" ? "favorites" : "snippets";
              _libAddEntry(target, cardBody.value);
              // Same as the editor's Save button: capture the label once,
              // cancel any pending revert, or a double click sticks it.
              if (cardSaveDd._epeOrigLabel == null) cardSaveDd._epeOrigLabel = cardSaveDd._labelText;
              cardSaveDd._labelText = "✓ Saved";
              if (cardSaveDd._epeRevertT) clearTimeout(cardSaveDd._epeRevertT);
              cardSaveDd._epeRevertT = setTimeout(() => {
                cardSaveDd._labelText = cardSaveDd._epeOrigLabel;
                cardSaveDd._epeRevertT = null;
              }, 1200);
            });

            // Options ▾
            const cardOptDd = _makeDropdownBtn("Options", [
              { id: "enhance", label: "Enhance again" },
              { id: "variations", label: "Variations of this" },
            ], (id) => {
              // Chain into a new AI action with this card's text as input.
              // Handed over explicitly rather than written into textEl first:
              // runAiAction enters review BEFORE swapping the text in, so
              // _originalPrompt still snapshots the user's real prompt.
              const _t = cardBody.value;
              if (id === "enhance") runAiAction("expand", { sourceText: _t });
              else if (id === "variations") runAiAction("variations", { sourceText: _t });
            });

            _cardDropdowns.push(cardSaveDd, cardOptDd);
            cardBtns.appendChild(cardUseBtn);
            cardBtns.appendChild(cardSendBtn);
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
          let _allSaved = true;
          cards.forEach((ta) => {
            const v = ta.value;
            const items = _libLoad("favorites");
            const def = v.slice(0, 48).replace(/\s+/g, " ").trim() + (v.length > 48 ? "\u2026" : "");
            items.push({ id: _libNewId(), name: def, text: v.trim(), date: new Date().toISOString() });
            // _libSaveItems reports now instead of swallowing: at the storage
            // quota these saves evaporated while the button said "✓ Saved".
            if (!_libSaveItems("favorites", items)) _allSaved = false;
          });
          if (reviewSaveAllBtn._epeOrigLabel == null)
            reviewSaveAllBtn._epeOrigLabel = reviewSaveAllBtn.textContent;
          reviewSaveAllBtn.textContent = _allSaved ? "✓ Saved" : "Save failed";
          // Cancelled and re-armed, or a second click inside 1.2 s left the
          // flash label up permanently.
          if (reviewSaveAllBtn._epeRevertT) clearTimeout(reviewSaveAllBtn._epeRevertT);
          reviewSaveAllBtn._epeRevertT = setTimeout(() => {
            reviewSaveAllBtn.textContent = reviewSaveAllBtn._epeOrigLabel;
            reviewSaveAllBtn._epeRevertT = null;
          }, 1200);
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
          const _t = _epeNode.properties.epe_wireless_targets;
          if (!Array.isArray(_t)) { _epeNode.properties.epe_wireless_targets = []; return _epeNode.properties.epe_wireless_targets; }
          // The CONTAINER being an array was the only thing checked. A shared
          // or hand-edited workflow carrying `[null]` reached `t.bind` on null
          // inside renderWireless, which the build calls unguarded from an
          // unguarded onNodeCreated — so the whole editor failed to
          // construct: no textarea, no toolbar, no error, and the prompt in
          // properties.epe_prompt unreachable until the file was repaired by
          // hand. Healed in place, once, so the bad entry does not come back.
          if (_t.some(x => !x || typeof x !== "object")) {
            const _clean = _t.filter(x => x && typeof x === "object");
            console.warn("[EPE] dropped " + (_t.length - _clean.length) +
                         " malformed wireless target(s)");
            _epeNode.properties.epe_wireless_targets = _clean;
            return _clean;
          }
          return _t;
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
            //
            // Guarded: this walks the whole graph, which is untrusted shape
            // from a shared workflow file. An unresolvable target must show a
            // red dot, not take the entire wireless panel down with it — which
            // is what a RangeError out of the tier cascade used to do.
            if (!t || typeof t !== "object") return;
            let resolved = null;
            try { resolved = _epeResolveTargetWidget(t); } catch (_e) { resolved = null; }
            if (resolved && (!t.bindLabel)) { try { _epeRebuildTargetLabel(t); } catch (_e) {} }
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
              // FIRST. _epeTabRestore's finally persists the thread map, so a
              // map that has not been loaded yet is a map that overwrites the
              // file's. Its own try/catch means a malformed epe_ie_threads
              // cannot unwind the three restores below it either — which is how
              // a bad epe_style used to take the threads and the panel layout
              // down with it.
              // ONE TRY EACH, not one for the four.
              //
              // These read `epe_style` and `epe_ui` out of a shared,
              // hand-editable workflow file, and this function has the
              // precedent on record: a workflow-supplied
              // `epe_style.sliders.__proto__` threw out of _epeStyleRestore
              // into the blanket catch below, so _epeUiRestore never ran and
              // the saved threads and panel layout were dropped on every open
              // of that file. That one site was hardened; its siblings were
              // not, and round 59 put the repaint downstream of all three —
              // so a throw anywhere above it left the instruct panel showing
              // the PREVIOUS workflow's steps while the delete buttons acted
              // on this one's.
              try { if (_epeOwnerNode._epeThreadsRestore) _epeOwnerNode._epeThreadsRestore(); } catch (_e2) {}
              try { if (_epeOwnerNode._epeTabRestore) _epeOwnerNode._epeTabRestore(); } catch (_e2) {}
              try { if (_epeOwnerNode._epeStyleRestore) _epeOwnerNode._epeStyleRestore(); } catch (_e2) {}
              try { if (_epeOwnerNode._epeUiRestore) _epeOwnerNode._epeUiRestore(); } catch (_e2) {}
              // LAST, once, and only here.
              //
              // The instruct panel and its chip resolve the tab through
              // _ieTabKey() -> properties.epe_tab_active, and _epeTabRestore
              // is what CORRECTS that index (an over-MAX or hand-edited active
              // tab is clamped to the last surviving slot). Round 58 repainted
              // from inside the thread load, which now runs first — so the
              // panel showed one tab's steps while the editor showed another's,
              // and the panel's per-row delete re-reads the thread when
              // CLICKED: the user deleted a step they could see and a
              // different tab lost one. That is the failure _switchTo's own
              // comment records from round 33, on the restore path.
              try { _ieRefresh(); } catch (_e) {}
            } catch (_e) {}
          };
        }

        // Back-compat alias: some code below references `btnRow` as the footer row.
        const btnRow = footer;

        // --- Actions ---
        const closeEditor = () => {
          // dropdown menus are mounted to document.body, close any open
          // ones before the EPE goes away so they don't orphan in the DOM.
          // All of them, not just the two named ones — see _epeDropdowns.
          try { _closeAllDropdowns(); } catch (_e) {}
          // UNREACHABLE in node mode, and has been for a long time: closeBtn
          // is mounted only under `if (!_epeOwnerNode)`, and the one call site
          // of this builder always passes a node. _epeDispose is the teardown
          // that actually runs, and it releases all of this and a dozen things
          // more — the resize observer, the drag handlers, the in-flight
          // aborts, the dropdown registry, the tooltip.
          //
          // So this stays a partial list ON PURPOSE. Making it delegate to
          // _epeDispose would change what an unreachable path does, which is
          // the worst place to be wrong; making it a full copy would be a
          // second list to keep in step. If this path is ever given a reason
          // to run, delete it and call _epeDispose instead.
          try { _clearVariationsCards(); } catch (_e) {}
          _epeTip.remove();
          floatingWin.remove();
        };

        closeBtn.onclick = closeEditor;
        saveAsBtn.onclick = () => _libAddEntry("favorites", textEl.value);

        loadBtn.onclick = () => {
          const _fileInput = document.createElement("input");
          _fileInput.type = "file"; _fileInput.accept = ".txt"; _fileInput.style.display = "none";
          // NOT appended to document.body. It used to be, and it was removed
          // only inside onchange — which never fires when the user cancels
          // the OS file dialog. So every cancelled Load left an <input>
          // parented to document.body for the life of the page, its onchange
          // closure holding textEl and with it the entire editor. A detached
          // input opens the picker perfectly well.
          _fileInput.onchange = () => {
            const file = _fileInput.files && _fileInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
              const txt = (e.target.result || "").trim();
              if (!txt) return;
              // Same as Clear Prompt: leave review before replacing the text.
              // Discarding afterwards restored the pre-AI prompt over the file
              // the user had just imported, and Ctrl+Z then resurrected the
              // rejected AI result into node.properties.
              if (_reviewMode) _autoDiscardReview("Text imported — result discarded");
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
          // Leave review FIRST, like every other wholesale replacement here.
          // Without this the review strip stayed up over unrelated text with
          // Use this / Append / Discard live, the push below put the AI result
          // on the undo stack, and Discard-then-Ctrl+Z brought the rejected
          // result back — into the editor and into node.properties. Use this
          // after a Clear committed "" and wiped the prompt outright.
          if (_reviewMode) _autoDiscardReview("Prompt cleared — result discarded");
          // Record it, so ↶ brings the prompt back.
          if (textEl._epePushUndo) textEl._epePushUndo();
          textEl.value=""; updateTokenBadge("");
          // The dispatch is the whole fix: updateTokenBadge writes
          // epe_prompt, but only the input listener runs _epeTabSync, and a
          // rebuild reads the TAB slot first — so the cleared text came back.
          textEl.dispatchEvent(new Event("input"));
          textEl.focus();
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
            // Embedded in a node — the only live mode — closeEditor() would
            // remove() the node's own DOM-widget element with nothing to put
            // it back, so a reflexive Esc blanked the node until reload.
            // Drop focus instead.
            ev.preventDefault(); ev.stopPropagation();
            try { textEl.blur(); } catch (_e) {}
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

        // ══════════════════════════════════════════════════════════════════
        // INSTRUCT EDIT — thread state + saved sequences
        // ══════════════════════════════════════════════════════════════════
        // The "thread" is the running list of instructions given for the
        // current prompt tab. The last few are sent to the model as context so
        // relative direction ("dial that back", "more like dusk") resolves
        // against what came before. Threads are scoped per prompt tab — read
        // from the EDITOR's active tab since round 63, not from the persisted
        // epe_tab_active — and saved with the node.
        const IE_CONTEXT_DEPTH = 5;
        // Ceiling on what a tab's thread STORES. Only the last
        // IE_CONTEXT_DEPTH are ever sent to the model; without a cap, every
        // instruction ever typed shipped inside shared workflow files.
        const IE_THREAD_MAX = 20;

        // A stable id for an entry that was stored without one.
        //
        // The random mint is used only when the heal write below SUCCEEDS. If
        // it does not — a store at quota rejects the heal, which GROWS the
        // value by adding ids, while the delete write that SHRINKS it still
        // goes through — then a random id differs between the render's load
        // and the delete's load, `filter(x => x.id !== item.id)` matches
        // nothing, and the entry cannot be deleted, renamed or edited, in
        // silence. The deterministic fallback is derived from the entry
        // itself, so every load agrees on it without anything being written.
        const _epeMintId = () => "epe" + Date.now().toString(36) +
                                 Math.random().toString(36).slice(2, 8);
        const _epeDerivedId = (x, i) => {
          const s = String((x && x.name) || "") + "\u0000" +
                    String((x && x.text) || "") + "\u0000" +
                    (Array.isArray(x && x.steps) ? x.steps.join("\u0000") : "");
          let h = 0x811c9dc5;
          for (let k = 0; k < s.length; k++) {
            h ^= s.charCodeAt(k);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
          }
          return "epeD" + i + "_" + h.toString(36);
        };
        // Writes `out` back only if the write succeeds; the caller keeps the
        // deterministic ids when it does not. Returns whether it landed.
        // Cap is REQUIRED — no default. A default silently paper-cracks over
        // an uncapped caller ("wrote 4000 back and normalised it as if that
        // were the intended cap"); requiring it forces every caller to
        // decide, matching whatever their upstream load-side cap is.
        const _epeHealIds = (key, out, cap) => {
          try {
            if (Array.isArray(out) && typeof cap === "number" && cap > 0
                && out.length > cap) {
              out = out.slice(-cap);
            }
            localStorage.setItem(key, JSON.stringify(out));
            return true;
          } catch (_e) { return false; }
        };

        const _ieSeqKey  = "epe_library_sequences";
        // Whatever JSON.parse produced was returned straight to callers that
        // do `all.slice()` and `seq.steps.join()`. A non-array — or one entry
        // without `steps` — threw out of _ieRenderSaved, and the saved pane
        // then never rendered again for the life of the node. Same shape check
        // _libLoad already applies to the library.
        // Upper bound on stored sequences and steps-per-sequence. A hostile
        // or corrupt localStorage value with a million-entry array would
        // otherwise hang the tab on Instruct-Edit open — _ieRenderSaved
        // builds one card per entry, and the caps are the only thing
        // between that and an unresponsive UI.
        // Once per editor. A load-side truncation warning fires on every
        // open of the pane otherwise, and the user can only act on it once.
        let _epeStoreOverflowWarned = false;
        const IE_SEQ_MAX_COUNT = 200;   // sequences per user
        const IE_SEQ_MAX_STEPS = 200;   // steps per sequence
        const _ieSeqLoad = () => {
          let v;
          try { v = JSON.parse(localStorage.getItem(_ieSeqKey) || "[]"); }
          catch(_e) { return []; }
          if (!Array.isArray(v)) return [];
          // Healed INLINE, on every load, like _libLoad. Round 40 healed from
          // a one-shot IIFE at editor construction instead, so an id-less
          // entry that appeared afterwards — a second tab, a hand-edited
          // store, an older build — was minted afresh on every single load,
          // and _ieRenderSaved's card and the ✕ handler's reload disagreed
          // about its id. The delete filtered nothing and wrote the whole
          // list back: the sequence reappeared and could never be removed.
          // Keep the NEWEST, the same end _ieSeqSave keeps.
          //
          // This was slice(0, MAX) against a save-side slice(-MAX), and every
          // writer is save(<array derived from load()>) — so an over-cap store
          // had its newest entries hidden by the load and then written out of
          // existence by the very next save. Measured: 250 stored sequences,
          // one rename click, the 50 most recent gone for good with no toast.
          // The save-side toast cannot fire in that case either: by the time
          // _ieSeqSave runs, load has already cut the array to MAX.
          // The shape filter and the window, tracked BY ORIGINAL INDEX.
          //
          // The heal below writes back into the full stored array, and the
          // only safe way to know which stored slot a kept entry came from is
          // to remember it. Reconstructing it as `i - (all.length -
          // kept.length)` assumed every removal was a contiguous prefix; a
          // single junk entry in the middle shifted the mapping and grafted
          // one entry's id onto another.
          const _keptIdx = [];
          v.forEach((x, i) => { if (x && typeof x === "object") _keptIdx.push(i); });
          const _all = _keptIdx.map(i => v[i]);
          const _win = _keptIdx.slice(-IE_SEQ_MAX_COUNT);
          const kept = _win.map(i => v[i]);
          if (_all.length > IE_SEQ_MAX_COUNT && !_epeStoreOverflowWarned) {
            // Latch INSIDE the try, after the call. `_toast` is a const
            // declared much further down this same closure, and _libLoad —
            // which shares this flag — is reachable during node construction,
            // where that binding is still in its temporal dead zone. Setting
            // the flag first meant the throw burned the one warning all three
            // stores share and nothing was ever shown.
            try {
              _toast("Saved sequences over the " + IE_SEQ_MAX_COUNT +
                     " limit: the oldest " + (_all.length - IE_SEQ_MAX_COUNT) +
                     " are hidden, and will be dropped the next time this "
                     + "list is saved.");
              _epeStoreOverflowWarned = true;
            } catch(_e2) {}
          }
          let _healed = false;
          const out = kept.map((x, i) => ({
                    id:    (x.id === undefined || x.id === null || x.id === "")
                             ? ((_healed = true), _epeMintId())
                             : x.id,
                    name:  String(x.name || "Untitled"),
                    steps: Array.isArray(x.steps)
                             // Keep NEWEST steps (drop oldest) — matches the
                             // save-side semantics in _ieSeqSave. Was
                             // slice(0, MAX); asymmetry would silently drop
                             // the most-recent steps of an oversized entry.
                             ? x.steps.filter(s => typeof s === "string").slice(-IE_SEQ_MAX_STEPS)
                             : [],
                    date:  x.date,
                  }));
          if (_healed) {
            // Patched onto the ORIGINALS. Writing `out` back would persist
            // the normaliser's projection over the whole store — so merely
            // OPENING the pane deleted every field this build does not know
            // about, on entries that needed no repair at all.
            // Over the FULL stored array, not the window.
            //
            // `kept` is the newest IE_SEQ_MAX_COUNT; writing that back meant
            // one id-less entry turned a plain OPEN of the pane into a delete
            // of everything above the cap — measured 2500 -> 2000 with no user
            // action. The cap bounds what is RENDERED (one card per entry);
            // it has no business bounding what is already on disk. Truncation
            // belongs on the save path, where the user did something.
            // Every stored entry survives, in its stored position, with
            // whatever fields it had. Only the ones that were actually
            // normalised get an id patched on, and only into their OWN slot.
            // Entries the shape filter dropped are copied through untouched —
            // a read has no business deleting them either.
            const merged = v.slice();
            _win.forEach((_orig, _w) => {
              const x = v[_orig];
              if (x && (x.id === undefined || x.id === null || x.id === ""))
                merged[_orig] = Object.assign({}, x, { id: out[_w].id });
            });
            // `merged.length` as the cap: the parameter is required by design
            // (no default), and this is the explicit way to say "no
            // truncation" rather than passing a number that would trim.
            if (!_epeHealIds(_ieSeqKey, merged, merged.length)) {
              // The write was refused. Fall back to ids every load derives
              // the same way, so delete and rename still match.
              out.forEach((o, i) => {
                const x = kept[i];
                if (x.id === undefined || x.id === null || x.id === "")
                  o.id = _epeDerivedId(x, i);
              });
            }
          }
          return out;
        };
        // Cap on WRITE too, not just on load. Otherwise a save that pushes
        // total > IE_SEQ_MAX_COUNT succeeds silently and the newest entries
        // (last in the array) are the ones dropped on next load — a user
        // who just saved a sequence sees it vanish after any reload. Same
        // for per-sequence steps. If truncation happens, toast the user
        // rather than silently drop.
        const _ieSeqSave = (a) => {
          if (!Array.isArray(a)) return false;
          let _truncated = false;
          let out = a;
          // Drop OLDEST on overflow, not newest. Every writer pushes new
          // entries at the tail — `slice(0, MAX)` would keep the head and
          // discard the just-added entry, so the user's most-recent save
          // is the exact one that vanishes on toast. `slice(-MAX)` keeps
          // the tail (newest) and discards the head (oldest).
          if (out.length > IE_SEQ_MAX_COUNT) { out = out.slice(-IE_SEQ_MAX_COUNT); _truncated = true; }
          out = out.map((x) => {
            // Steps within a sequence are chronological too — keep the
            // most recent IE_SEQ_MAX_STEPS.
            if (x && Array.isArray(x.steps) && x.steps.length > IE_SEQ_MAX_STEPS) {
              _truncated = true;
              return Object.assign({}, x, { steps: x.steps.slice(-IE_SEQ_MAX_STEPS) });
            }
            return x;
          });
          try { localStorage.setItem(_ieSeqKey, JSON.stringify(out)); }
          catch(_e) {
            try { _toast("Could not save — browser storage is full or blocked."); } catch(_e2) {}
            return false;
          }
          if (_truncated) {
            try { _toast("Oldest sequences trimmed to fit (" + IE_SEQ_MAX_COUNT + " × " + IE_SEQ_MAX_STEPS + ")."); } catch(_e2) {}
          }
          return true;
        };

        let _ieThreads = {};                       // { "<promptTabIndex>": [instruction, …] }
        // Closing a prompt tab splices the tab array, so these keys have to
        // shift with it. Without this, tab N inherited tab N-1's edit
        // history and fed it to the model as context for a prompt it was
        // never applied to.
        // Pins held by an operation that is mid-flight — a sequence replay, an
        // edit waiting for its result. Round 24 pinned the tab so a SWITCH
        // could not redirect a write taken before an await; but the pin is an
        // INDEX, and closing or reopening a tab renumbers every index above
        // it, so after a close the pin named somebody else's tab. Measured:
        // closing tab 0 during a replay on tab 1 left the surviving tab
        // holding the replay's rollback, and a thread stranded under an index
        // no tab owns — which the next "+ new tab" inherits as its EARLIER
        // DIRECTION.
        //
        // A pin is an object, so the shifters below can move it exactly as
        // they move the threads. `key` going null means the pinned tab is gone
        // and the operation must stop writing.
        const _ieTabPins = new Set();
        const _iePin = (key) => { const p = { key }; _ieTabPins.add(p); return p; };
        const _ieUnpin = (p) => { try { _ieTabPins.delete(p); } catch (_e) {} };
        const _ieShiftPins = (fn) => {
          for (const p of _ieTabPins) {
            const n = parseInt(p.key, 10);
            if (!Number.isFinite(n)) continue;
            p.key = fn(n);
          }
        };

        const _ieThreadsDropTab = (idx) => {
          const out = {};
          Object.keys(_ieThreads).forEach(k => {
            const n = parseInt(k, 10);
            if (!Number.isFinite(n) || n === idx) return;
            out[String(n > idx ? n - 1 : n)] = _ieThreads[k];
          });
          _ieThreads = out;
          // Exactly the shift applied to the threads: the pinned tab itself is
          // gone (null), anything above it moves down one.
          _ieShiftPins((n) => (n === idx ? null : String(n > idx ? n - 1 : n)));
          _iePersistThreads();
        };
        // Inverse: reopen slot idx (empty) when the tab-close toast restores
        // a tab, so the threads above it move back to their own tabs.
        const _ieThreadsRestoreTab = (idx) => {
          const out = {};
          Object.keys(_ieThreads).forEach(k => {
            const n = parseInt(k, 10);
            if (!Number.isFinite(n)) return;
            out[String(n >= idx ? n + 1 : n)] = _ieThreads[k];
          });
          _ieThreads = out;
          _ieShiftPins((n) => String(n >= idx ? n + 1 : n));
          _iePersistThreads();
        };
        // Two tabs exchanged places rather than shifting: the over-MAX
        // restore swap in `_epeTabRestore`. The tab TEXTS are permuted there;
        // without this the index-keyed map is not, and two directions end up
        // describing prompts they were never applied to (B-5). Driven on a
        // 6-tab workflow saved on tab 5: slot 3 held PROMPT5 under PROMPT3's
        // direction, and slot 5 held PROMPT3 under PROMPT5's.
        //
        // Absence is meaningful and must travel too. If `a` has a thread and
        // `b` has none, `b` must END UP with the thread and `a` with none —
        // assigning in place would leave a stale copy behind at `a`.
        //
        // NO `_iePersistThreads()` here, unlike the two shifters above. This
        // runs mid-restore and `_epeTabRestore`'s own `finally` persists once
        // the tab arrays are final. Persisting from inside a shifter against a
        // half-assembled tab count is the round-57 B-2 defect, which deleted
        // the last parked tab's thread.
        const _ieThreadsSwapTabs = (a, b) => {
          const ka = String(a), kb = String(b);
          if (ka === kb) return;
          const ta = _ieThreads[ka], tb = _ieThreads[kb];
          if (tb === undefined) delete _ieThreads[ka]; else _ieThreads[ka] = tb;
          if (ta === undefined) delete _ieThreads[kb]; else _ieThreads[kb] = ta;
          // A pin naming either slot follows the text it was taken against.
          _ieShiftPins((n) => (n === a ? kb : (n === b ? ka : String(n))));
        };
        // Which tab is the user actually looking at?
        //
        // Ask the EDITOR, not the file. This used to read
        // properties.epe_tab_active, and the file's index can lag the editor's
        // — a workflow load that declines to reconcile, a partial payload, any
        // moment between a switch and its persist. When it lagged, the instruct
        // panel listed a different tab's steps than the one on screen, its
        // per-row ✕ deleted from that tab and saved it, and a new direction was
        // filed under an index no tab owns, where the dead-tab prune dropped it
        // on the next save. Round 33 measured that from a tab switch, round 59
        // from a repaint ordering, round 61 from a gated reconcile — three
        // rounds treating the symptom, because the reader was asking the wrong
        // object.
        //
        // Same published-getter shape as _epeTabCountFn below, for the same
        // reason: `_active` lives in the _buildPromptTabs IIFE, a deeper scope
        // than this one. The file is the fallback for the window before the tab
        // set is built.
        let _epeTabActiveFn = null;
        const _ieTabKey = () => {
          try {
            if (_epeTabActiveFn) {
              const _a = _epeTabActiveFn();
              if (Number.isFinite(_a) && _a >= 0) return String(_a);
            }
          } catch(_e) {}
          try {
            const p = (_epeOwnerNode && _epeOwnerNode.properties) || {};
            return String(p.epe_tab_active || 0);
          } catch(_e) { return "0"; }
        };
        // Set by (function _buildPromptTabs(){…}) once the tab array exists.
        // _iePersistThreads needs the LIVE tab count to prune dead thread
        // keys, and `_tabs` is declared inside that IIFE — a deeper scope
        // that this one cannot see. Round 49 read `_tabs` here directly; the
        // ReferenceError was swallowed by the catch below and epe_ie_threads
        // stopped being written at all.
        //
        // A getter rather than a captured reference, because _epeTabRestore
        // REASSIGNS _tabs (`_tabs = _fullTabs.slice(0, MAX)`), so a snapshot
        // would go stale on the first workflow load.
        //
        // null means "tabs not built yet" — distinct from "zero tabs". The
        // prune is skipped in that state rather than deleting every key.
        let _epeTabCountFn = null;
        const _iePersistThreads = () => {
          if (!_epeOwnerNode) return;
          // Not while a result is under review. The thread is the direction
          // that describes the COMMITTED prompt; an instruction whose result
          // the user has not accepted is not part of it yet.
          //
          // _epePersistPrompt has refused to write under review since round 5
          // for exactly this reason — "a result under review is not the user's
          // prompt yet" — but the thread wrote through, so a rebuild mid-review
          // (a workflow-tab switch, a reload) restored the old prompt with the
          // REJECTED instruction still attached. It then went out as EARLIER
          // DIRECTION on every later edit, describing a change the prompt does
          // not have. epe_ie_threads rides in node.properties, so it shipped
          // inside workflow files sent to other people too.
          //
          // _reviewExit flushes on the way out, so both Discard (which has
          // just rolled the thread back) and every commit path land correctly.
          if (_reviewMode) return;
          // Also refuse to persist during a tab restore in progress —
          // `_autoDiscardReview` inside `_epeTabRestore` calls _reviewExit
          // which calls _iePersistThreads BEFORE _tabs is replaced with
          // the incoming workflow's tab set. Pruning against the OLD
          // (smaller) _tabs.length there dropped legit threads for tab
          // indices that ARE about to become valid.
          if (_epeOwnerNode._epeRestoring) return;
          if (!_epeOwnerNode.properties) _epeOwnerNode.properties = {};
          try {
            // Prune keys that don't correspond to a live tab. Otherwise a
            // tab that was closed by any path other than _ieThreadsDropTab
            // (a workflow reload with fewer tabs, an old file with 6 tabs
            // where we now show 4) leaves its thread key in `_ieThreads`
            // and it ships in the saved workflow forever — visible to
            // anyone the file is shared with.
            // -1 = tab set not built yet. Key hygiene still applies; the
            // dead-tab prune does not, because "no tabs" and "tabs unknown"
            // must not both mean "delete everything".
            let _n = -1;
            try { if (_epeTabCountFn) _n = _epeTabCountFn(); } catch(_e2) { _n = -1; }
            if (!Number.isFinite(_n)) _n = -1;
            const _clean = {};
            Object.keys(_ieThreads).forEach(k => {
              // Pure-integer key check: coerce → back to string; equal
              // means the key was a canonical integer string. Rejects
              // "1.5" (coerces to 1, collides), "abc" (NaN), " 1" etc.
              if (k !== String(parseInt(k, 10))) return;
              const i = parseInt(k, 10);
              if (!Number.isFinite(i) || i < 0) return;
              if (_n >= 0 && i >= _n) return;
              _clean[k] = _ieThreads[k];
            });
            _epeOwnerNode.properties.epe_ie_threads = JSON.parse(JSON.stringify(_clean));
          } catch(_e) {}
        };
        // Load the saved threads into `_ieThreads`. THIS MUST RUN BEFORE
        // _epeTabRestore.
        //
        // It used to live at the top of _epeUiRestore, which
        // _epeRefreshFromProps calls THIRD:
        //
        //     _epeTabRestore();   // ends with _iePersistThreads() in a finally
        //     _epeStyleRestore();
        //     _epeUiRestore();    // <- the only thing that LOADS the threads
        //
        // On a fresh node `_ieThreads` is still {} when that finally fires, and
        // _iePersistThreads writes unconditionally — so opening ANY workflow
        // wrote {} over its own epe_ie_threads, and _epeUiRestore then read the
        // {} back. Every saved direction was gone on the first open, and gone
        // from the file the moment it was saved again. Round 55 made
        // _iePersistThreads execute at all (J-01); this is the other half of
        // that fix, and without it nothing round 57 did to the prune could be
        // observed on a reload.
        //
        // Also authoritative on ABSENCE: a workflow with no epe_ie_threads
        // resets the map. Leaving it alone let the outgoing workflow's
        // directions ride into the incoming one — measured: workflow A's
        // directions written into workflow B's properties over B's own, then
        // attached to B's prompts.
        if (_epeOwnerNode) {
          _epeOwnerNode._epeThreadsRestore = () => {
            // Instruct Edit threads ride along with the prompt tabs they belong
            // to, so reopening a workflow restores the direction that built it.
            try {
              const th = (_epeOwnerNode.properties || {}).epe_ie_threads;
              if (th && typeof th === "object") {
                const clean = {};
                Object.keys(th).forEach(k => {
                  // `clean[k] = …` with k === "__proto__" is not a property
                  // write — it calls Object.prototype's setter and REPLACES
                  // the object's prototype. epe_ie_threads comes out of a
                  // workflow file via JSON.parse, which produces "__proto__"
                  // as an OWN key, so Object.keys hands it over. The result
                  // was an _ieThreads whose prototype was an array: every
                  // thread lookup went through it, and _iePersistThreads wrote
                  // the wreckage back into the file the user shares.
                  if (k === "__proto__" || k === "constructor" || k === "prototype") return;
                  // Only pure non-negative integer string keys — reject
                  // "1.5", "abc", " 1" etc. that would coerce to a valid
                  // integer via parseInt but silently collide with
                  // legitimate keys or shift under `_ieThreadsDropTab`.
                  if (k !== String(parseInt(k, 10))) return;
                  if (parseInt(k, 10) < 0) return;
                  if (Array.isArray(th[k])) clean[k] = th[k].filter(x => typeof x === "string").slice(-IE_THREAD_MAX);
                });
                _ieThreads = clean;
              }
            } catch (_e) {}
            // NO reset on absence, and that is not an oversight.
            //
            // Rounds 58-63 carried one here, on the reasoning that a workflow
            // which has never used Instruct Edit must not inherit the map of
            // one that has. Under the contract verified in round 63 the case
            // cannot arise: LGraph.configure rebuilds every node, so `_ieThreads`
            // is the build's own `{}` when the loader above runs, and if the
            // file carries no map there is nothing to inherit. Driven by two
            // independent reviews — 381 firings over 1,000 node lifetimes, none
            // with anything to delete, and disabling it byte-identical over
            // 21,000 recorded states.
            //
            // If ComfyUI ever starts reusing a node across loads, this is where
            // the cross-workflow half of D-1 comes back, and the fix is to
            // record whether the incoming payload carried an `epe_ie_threads`
            // object and clear the map when it did not. Written down rather
            // than shipped, because dead code with a rationale is how the last
            // five rounds happened.
            // Drop the OUTGOING review's thread rollback before the restore
            // below auto-discards it.
            //
            // _autoDiscardReview unwinds an instruct result with
            // _ieThreadSet(_ieThreadSnapshot) and passes no key, so
            // _ieTabKey() reads properties.epe_tab_active — which the
            // configure has ALREADY replaced with the incoming workflow's.
            // Measured: leave an instruct result under review, switch
            // workflow tabs, and workflow A's pre-edit snapshot was written
            // into workflow B's active slot over B's own direction, then
            // persisted into B's file. The prompt half of the same discard is
            // harmless — _epeTabRestore overwrites textEl a moment later —
            // but the thread half lands in a keyed map that survives.
            //
            // _reviewExit clears both of these anyway; clearing them here just
            // means the rollback has nothing to write into the wrong workflow.
            try { _ieThreadSnapshot = null; _ieReviewIsInstruct = false; } catch (_e) {}
          };
        }
        // Declared here rather than beside the divider: _epePersistUi reads it and
        // runs during the initial _setRpTab, which happens before the divider is
        // built — a `let` read before its declaration throws (temporal dead zone).
        let _libCollapsed = false;
        // Same reasoning for the other two collapsible edges. Both are built far
        // below (the rail divider near the action rail, the tuning divider at the
        // end of layout assembly) but _epePersistUi is defined above them and runs
        // on the first _setRpTab, so these must exist by then.
        let _railCollapsed = false, _railW = 0;
        let _tuneH = 0;

        // Marks whether the active review came from Instruct Edit. Committing an
        // Enhance / Variations / Inverter result replaces the prompt wholesale,
        // which makes the existing direction stale — committing an instruct
        // result does not, because the thread is what produced it.
        let _ieReviewIsInstruct = false;
        // Values replaced by each step of an instruct chain. They reach the
        // undo stack only if the chain is committed; any exit drops them.
        let _ieChainUndo = [];
        // Bumped by every instruct run. _ieFinish compares against it so a
        // superseded run cannot tear down a newer run's review.
        let _ieReviewToken = 0;
        // Thread contents as they were when the current instruct review began.
        // Discarding the result must also unwind the direction that produced it,
        // otherwise the context would describe a change the prompt no longer has.
        let _ieThreadSnapshot = null;

        // ── Parked reviews ──────────────────────────────────────────────
        // A result under review is the user's until they Use it or Discard
        // it. Switching prompt tabs is neither, so it no longer throws the
        // result away: the review is PARKED, pinned to the tab it started
        // on, and restored intact when the user comes back.
        //
        // Parking has to happen because the tab must stay usable while the
        // review waits. A "single" result lives IN textEl, and a
        // "variations" review hides textEl behind the card picker — so a
        // review simply left running would either be overwritten by the
        // other tab's prompt or hide it. The park puts the user's own
        // prompt back on screen, tears the review UI down, and holds the
        // result, the snapshot, the instruct flags and the chain together.
        //
        // Nothing is discarded and nothing under review reaches the node:
        // what the tab saves is _originalPrompt, which is exactly what it
        // held before the AI ran.
        //
        // Pinned with the same registered pins the instruct edits use, so
        // closing a tab below a parked one renumbers the park with it
        // instead of stranding it on somebody else's prompt.
        const _reviewParks = [];

        const _reviewParkFind = (key) => {
          for (let i = 0; i < _reviewParks.length; i++)
            if (_reviewParks[i].pin.key === key) return i;
          return -1;
        };

        // Drops parks whose tab has been closed — _ieShiftPins nulls the key
        // — and, if `key` is given, any park held for that tab.
        const _reviewParkDrop = (key) => {
          for (let i = _reviewParks.length - 1; i >= 0; i--) {
            const p = _reviewParks[i];
            if (p.pin.key === null || (key !== undefined && p.pin.key === key)) {
              _ieUnpin(p.pin);
              _reviewParks.splice(i, 1);
            }
          }
        };

        // Park the live review against `key`. Returns true if one was parked.
        // A run still STREAMING is not parked: there is no result yet to keep,
        // and its tokens are landing in textEl, so the caller cancels it.
        const _reviewPark = (key) => {
          if (!_reviewMode || _reviewMode === "streaming") return false;
          // An instruct review with no rollback point cannot be parked
          // safely: clearing _reviewMode un-blocks _iePersistThreads, and
          // without a snapshot there is nothing to roll the live thread back
          // to, so the un-accepted instruction would persist. Every path that
          // enters or chains a review marks one, so this is unreachable — but
          // it was reachable until this round, and the failure was silent.
          // Discarding is the honest fallback: it says so.
          if (_reviewMode !== "variations" && _ieReviewIsInstruct && !_ieThreadSnapshot) {
            _autoDiscardReview("Result discarded — its edit history was incomplete");
            return false;
          }
          const _pin = _iePin(key);
          let _pushed = false;
          try {
          const park = {
            pin:        _pin,
            mode:       _reviewMode,
            original:   _originalPrompt,
            result:     (_reviewMode === "single") ? textEl.value : null,
            cards:      null,
            isInstruct: _ieReviewIsInstruct,
            threadSnap: _ieThreadSnapshot,
            // The LIVE thread as well as the rollback point. Clearing
            // _reviewMode below un-blocks _iePersistThreads, which refuses to
            // write while a result is under review precisely because an
            // instruction whose result the user has not accepted is not part
            // of the direction yet. Parking without this left that instruction
            // in _ieThreads, and the next persist from anywhere — an edit on
            // another tab, any review exiting, a tab close — wrote it into
            // node.properties.epe_ie_threads and out into the saved workflow,
            // describing a change the parked tab's prompt does not have.
            threadLive: (function () {
              try { return _ieThreadGet(key).slice(); } catch (_e) { return null; }
            })(),
            // Set by _ieFinish, showAiResult and _ieRunSequence to name what
            // is being reviewed. _reviewEnter resets it to the generic text,
            // so without this an instruct result came back calling itself an
            // Enhance result.
            label:      (function () {
              try { return reviewLabel.textContent; } catch (_e) { return null; }
            })(),
            chainUndo:  _ieChainUndo.slice(),
          };
          if (_reviewMode === "variations") {
            // The CURRENT card values, not the strings the model returned:
            // the cards are editable, and an edit made before the switch is
            // part of the result the user is holding.
            const tas = variationsContainer.querySelectorAll(".epe-variation-card textarea");
            park.cards = tas.length ? Array.from(tas).map(t => t.value)
                                    : _currentVariations.slice();
          }
          _reviewParkDrop(key);          // one park per tab; the newer wins
          _reviewParks.push(park);
          _pushed = true;
          // State FIRST, then the value. _epePersistPrompt refuses to write
          // while _reviewMode is set, so restoring the prompt before clearing
          // it would leave the AI result in node.properties.epe_prompt and the
          // next rebuild would undo the park.
          _reviewMode         = null;
          _originalPrompt     = null;
          _ieThreadSnapshot   = null;
          _ieChainUndo        = [];
          _ieReviewIsInstruct = false;
          // The teardown _reviewExit does, WITHOUT its side effects: no thread
          // rollback, no unloadModel, no toast, and the chain is carried in the
          // park rather than dropped.
          reviewStrip.style.display = "none";
          originalStrip.style.display = "none";
          reviewSaveAllBtn.style.display = "none";
          textEl.style.display = "";
          textEl.readOnly = false;
          textEl.style.opacity = "";
          variationsContainer.style.display = "none";
          _clearVariationsCards();
          singleActionRow.style.display = "none";
          // The thread goes back to what it was before this review, for the
          // same reason the prompt does: with _reviewMode cleared, the next
          // persist would otherwise ship an un-accepted instruction. The live
          // one is in the park and comes back on return.
          if (park.isInstruct && park.threadSnap) {
            try { _ieThreadSet(park.threadSnap, key); } catch (_e) {}
          }
          // The streaming placeholder, which _reviewExit restores and the
          // single-result finish does not — so a parked Enhance left
          // "Generating enhanced prompt…" over a tab with nothing running.
          if (textEl._savedPlaceholder != null) {
            textEl.placeholder = textEl._savedPlaceholder;
            textEl._savedPlaceholder = null;
          }
          // The user's own prompt, on screen and onto the node, so the caller's
          // `_tabs[_active] = textEl.value` saves what the tab really held.
          if (park.original !== null && textEl._epeRestoreValue) {
            textEl._epeRestoreValue(park.original);
            try { updateTokenBadge(textEl.value); } catch (_e) {}
          }
          return true;
          } finally {
            // _iePin registers into _ieTabPins immediately, but nothing can
            // release it until the park is in _reviewParks. A throw in the
            // window between would strand it there for the life of the node,
            // renumbering on every tab close — which is the exact shape of two
            // bugs this file already carries comments about.
            if (!_pushed) { try { _ieUnpin(_pin); } catch (_e) {} }
          }
        };

        // Bring back the park held for `key`, if there is one and no review is
        // live. Returns true if one was restored.
        const _reviewUnpark = (key) => {
          if (_reviewMode) return false;
          _reviewParkDrop();                  // prune anything closed meanwhile
          const i = _reviewParkFind(key);
          if (i < 0) return false;
          const park = _reviewParks[i];
          _reviewParks.splice(i, 1);
          _ieUnpin(park.pin);
          // A restored review is a NEW review. _ieFinish and _ieRunSequence
          // compare the token they captured at launch against this one, and a
          // run cancelled by the switch that brought us here unwinds a
          // microtask later: with the token unchanged its _ieFinish(false)
          // matched, took the `else if (_reviewMode)` branch, and tore down
          // the review it had just restored — the user watched the result come
          // back and then vanish, with no toast.
          _ieReviewToken++;
          _ieReviewIsInstruct = park.isInstruct;
          _ieThreadSnapshot   = park.threadSnap;
          _ieChainUndo        = park.chainUndo.slice();
          _reviewEnter(park.mode, park.original === null ? "" : park.original);
          // AFTER _reviewEnter, so _reviewMode is set again and
          // _iePersistThreads is blocked: the live thread goes back on screen
          // without reaching node.properties.
          if (park.isInstruct && park.threadLive) {
            try { _ieThreadSet(park.threadLive, key); } catch (_e) {}
          }
          // …and after it too, because _applyReviewModeUI resets the label.
          if (park.label) { try { reviewLabel.textContent = park.label; } catch (_e) {} }
          if (park.mode === "variations") {
            _renderVariationsCards(park.cards || []);
          } else if (park.result !== null && textEl._epeRestoreValue) {
            textEl._epeRestoreValue(park.result);
            try { updateTokenBadge(textEl.value); } catch (_e) {}
          }
          return true;
        };

        // Assigned for real once the panel DOM / instruct row exist; no-ops until then.
        let _ieRefresh     = () => {};
        let _ieUpdateChip  = () => {};
        let _ieRunSequence = () => {};

        // Shared collapse chevron — points sideways when closed, down when open,
        // matching the Style tuning header. Used by Instruct Edit sequence cards
        // and by the Favorites / Snippets cards.
        const _mkChevron = () => {
          const c = document.createElement("span");
          c.style.cssText =
            "width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;" +
            "border-left:5px solid #7a8a9c;transition:transform .15s;flex-shrink:0;";
          return c;
        };
        const _setChevron = (el, open) => {
          if (el) el.style.transform = open ? "rotate(90deg)" : "";
        };

        // `key` pins the write to a tab. Without it these resolved the tab
        // from node.properties.epe_tab_active at CALL time — and both callers
        // call them after an await. Switching prompt tabs during a sequence
        // replay therefore wrote tab A's direction into TAB B's slot, over
        // whatever B had: the switch aborts the stream, the step returns
        // false, and the rollback line lands on the wrong tab. epe_ie_threads
        // rides in node.properties, so that corruption is saved into the
        // workflow.
        const _ieThreadGet   = (key) => (_ieThreads[key || _ieTabKey()] || []);
        const _ieThreadSet   = (arr, key) => { _ieThreads[key || _ieTabKey()] = arr.slice(-IE_THREAD_MAX); _iePersistThreads(); _ieRefresh(); };
        const _ieThreadPush  = (t, key) => { const k = key || _ieTabKey(); const a = _ieThreadGet(k).slice(); a.push(t); _ieThreadSet(a, k); };
        const _ieThreadClear = () => { _ieThreadSet([]); };
        // Context handed to the model: the most recent few, oldest first.
        const _ieContext     = () => _ieThreadGet().slice(-IE_CONTEXT_DEPTH);

        // ── Right panel — Phase 2 Local Library ─────────────────────────────────

        // ── localStorage helpers ────────────────────────────────────────
        const _libKey       = (t) => t==="snippets" ? "epe_library_snippets" : "epe_library_favorites";
        // localStorage is user-editable and shared with everything else on
        // this origin, so what comes back is untrusted shape. A non-array here
        // reached callers that immediately .filter/.push/.map it — and the
        // first of those runs during the BUILD, so the node did not construct
        // at all: no editor, no error surfaced, and nothing in the UI that
        // could fix it. Entries are shape-checked for the same reason: cards
        // read .id, .name and .text off them.
        // Upper bound on stored library entries. Same rationale as
        // IE_SEQ_MAX_COUNT: a hand-edited or hostile localStorage value
        // with a million entries would hang the tab (one card per entry
        // in _epeRenderLibraryList) on library open.
        const LIB_MAX_COUNT = 2000;
        const _libLoad      = (t) => {
          let v;
          try { v = JSON.parse(localStorage.getItem(_libKey(t)) || "[]"); }
          catch(e) { return []; }
          if (!Array.isArray(v)) {
            console.warn("[EPE] " + _libKey(t) + " is not a list — ignoring it");
            return [];
          }
          // Keep the NEWEST, the same end _libSaveItems keeps. See the
          // note in _ieSeqLoad: the head/tail asymmetry meant an over-cap
          // library lost the entries the user had most recently added, on
          // the first edit after loading, silently.
          // The full stored array, kept for the heal write-back below.
          const _allLib = v;
          // The shape filter and the window, tracked BY ORIGINAL INDEX.
          //
          // Round 55b cap-sliced the array first and then filtered it, and
          // reconstructed the heal's write-back position as
          // `i - (_allLib.length - kept.length)`. That difference counts BOTH
          // removals, so it is only a valid offset when every removal is a
          // contiguous prefix — and a single junk entry in the middle shifted
          // the whole mapping, stamping one entry's id onto another.
          // _deleteItem is `filter(x => x.id !== item.id)`, which removes
          // every match, so deleting the corrupted card deleted a real one
          // with it. Worse, mapping over the RAW array read `.id` off a
          // `null` — legal JSON — and threw straight out of a function that
          // _setRpTab("favorites") calls at build time with no try/catch, so
          // the node stopped constructing entirely.
          //
          // Filter first, window second, and carry the indices.
          const _libIdx = [];
          _allLib.forEach((x, i) => { if (x && typeof x === "object") _libIdx.push(i); });
          const _libWin = _libIdx.slice(-LIB_MAX_COUNT);
          if (_libIdx.length > LIB_MAX_COUNT) {
            const _over = _libIdx.length - LIB_MAX_COUNT;
            if (!_epeStoreOverflowWarned) {
              // See _ieSeqLoad: latch only on delivery. THIS is the call that
              // throws — _setRpTab("favorites") runs at build time and reaches
              // here through _renderRpBody, long before `const _toast` is
              // initialised. Left unlatched, the next open of the pane (an
              // event handler, where _toast exists) delivers it.
              try {
                _toast("Library over the " + LIB_MAX_COUNT + " limit: the oldest "
                       + _over + " entries are hidden, and will be dropped the "
                       + "next time this list is saved.");
                _epeStoreOverflowWarned = true;
              } catch(_e2) {}
            }
          }
          // NORMALISED, not merely filtered. The comment above says entries
          // are shape-checked "because cards read .id, .name and .text off
          // them" — the filter checked none of the three. An entry with no
          // `text` made `textEl.value = undefined` (the literal string
          // "undefined" replacing the user's prompt) and then threw in
          // countTokens before the dispatch, so nothing persisted and the
          // only way back was the undo button. Insert did not even throw: it
          // spliced "undefined" in and saved it.
          //
          // A missing id is minted UNIQUE and healed straight back to
          // storage, so from the next load on it is a real id like any other.
          //
          // The positional `_pos<i>` this replaces was worse than the problem:
          // every writer persists what this function returned, so `_pos1`
          // became a real stored id — and the next id-less entry landing at
          // index 1 minted the same string. _deleteItem is
          // `filter(x => x.id !== item.id)`, which removes EVERY match, so the
          // user lost a saved prompt they never touched. A random mint alone
          // would have been wrong too (the render's load and the delete's load
          // are separate calls, so the ids would not match); writing the heal
          // back is what makes it right.
          const kept = _libWin.map(i => _allLib[i]);
          let _healed = false;
          const out = kept.map((x) => {
                         let id = x.id;
                         if (id === undefined || id === null || id === "") {
                           id = _epeMintId();
                           _healed = true;
                         }
                         return {
                           id,
                           name: String(x.name == null ? "" : x.name),
                           text: String(x.text == null ? "" : x.text),
                           date: x.date,
                         };
                       });
          if (_healed) {
            // The ORIGINALS with an id patched on, not `out`. Writing the
            // normalised projection back made this read destructive: one
            // legacy id-less entry, and opening the pane silently dropped
            // every field outside {id,name,text,date} from EVERY entry in the
            // store — including the ones that already had ids.
            // Over the FULL stored array — see the note in _ieSeqLoad. A
            // read must not delete entries the user has not asked to lose,
            // and it must not touch a slot it did not normalise.
            const merged = _allLib.slice();
            _libWin.forEach((_orig, _w) => {
              const x = _allLib[_orig];
              if (x && (x.id === undefined || x.id === null || x.id === ""))
                merged[_orig] = Object.assign({}, x, { id: out[_w].id });
            });
            // And if the write is REFUSED — a store at quota rejects this
            // one, which grows the value, while the delete that shrinks it
            // still succeeds — a random id would differ between this load and
            // the delete's, so the filter would match nothing and the entry
            // could never be removed. Derived ids agree across loads with
            // nothing written.
            if (!_epeHealIds(_libKey(t), merged, merged.length)) {
              out.forEach((o, i) => {
                const x = kept[i];
                if (x.id === undefined || x.id === null || x.id === "")
                  o.id = _epeDerivedId(x, i);
              });
            }
          }
          return out;
        };
        // Returns whether the write actually happened. It used to swallow
        // every failure, so a library at the storage quota — which it reaches
        // on its own, since nothing prunes it — lost saves in silence while
        // the button flashed "✓ Saved".
        const _libSaveItems = (t,items) => {
          if (!Array.isArray(items)) return false;
          // Cap on WRITE too, not just load. Drop OLDEST on overflow
          // (`slice(-MAX)`), not newest. Writers push new entries at the
          // tail, so `slice(0, MAX)` would discard the entry the user
          // just typed — the exact opposite of what the toast implies.
          let _trimmed = false;
          if (items.length > LIB_MAX_COUNT) { items = items.slice(-LIB_MAX_COUNT); _trimmed = true; }
          try { localStorage.setItem(_libKey(t),JSON.stringify(items));
            if (_trimmed) { try { _toast("Oldest library entries trimmed to fit (" + LIB_MAX_COUNT + ")."); } catch(_e2) {} }
            return true; }
          catch(e) {
            // _toast is declared further down the same closure; a build-time
            // call would hit its temporal dead zone, and every caller here is
            // an event handler, so the guard is belt and braces.
            try { _toast("Could not save — browser storage is full or blocked."); }
            catch(_e2) { console.warn("[EPE] library write failed:", e && e.name); }
            return false;
          }
        };
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
        // Compact spacing — a third tab row was added, so the block is tightened
        // to keep the overall vertical footprint roughly where it was.
        rpTabs.style.cssText = "display:flex;flex-direction:column;gap:4px;flex-shrink:0;background:#12171f;padding:5px 8px 4px;";
        // Flex centring keeps labels on the optical centre in both axes
        // regardless of length; min-height stops short labels collapsing.
        const _rpTabBase =
          "flex:1;white-space:nowrap;padding:4px;font-size:10px;font-weight:500;line-height:1;" +
          "display:flex;align-items:center;justify-content:center;min-height:22px;" +
          "color:#8ba5be;cursor:pointer;background:rgba(109,184,232,0.05);" +
          "border:1px solid rgba(109,184,232,0.15);user-select:none;transition:color .12s,background .12s,border-color .12s;";
        const rpTabEls = {};

        const rpTabRow1 = document.createElement("div");
        rpTabRow1.style.cssText = "display:flex;";
        const rpTabRow2 = document.createElement("div");
        rpTabRow2.style.cssText = "display:flex;";
        // Row 3 carries Instruct Edit alone, full width \u2014 it's a different kind
        // of thing from the browsers and collections, and the label needs room.
        const rpTabRow3 = document.createElement("div");
        rpTabRow3.style.cssText = "display:flex;";

        [
          ["civitai",   "Civitai",   "Browse Civitai image/video prompts",        rpTabRow1],
          ["genur",     "Genur.art", "Browse Genur.art image prompts",             rpTabRow1],
          ["workflows", "Workflows", "Search and load ComfyUI workflows",          rpTabRow2],
          ["favorites", "Favorites", "Saved prompts \u2014 click a card to load into editor", rpTabRow2],
          ["snippets",  "Snippets",  "Reusable fragments \u2014 click a card to insert at cursor", rpTabRow2],
          ["instruct",  "Instruct Edit", "Your prompt's direction \u2014 live thread and saved sequences", rpTabRow3]
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
        [rpTabRow1, rpTabRow2, rpTabRow3].forEach(row => {
          const kids = Array.from(row.children);
          kids.forEach((t, i) => {
            if (kids.length === 1) t.style.borderRadius = "8px";
            else if (i === 0) t.style.borderRadius = "8px 0 0 8px";
            else if (i === kids.length - 1) t.style.borderRadius = "0 8px 8px 0";
            if (i > 0) t.style.marginLeft = "-1px";
          });
        });

        rpTabs.appendChild(rpTabRow1);
        rpTabs.appendChild(rpTabRow2);
        rpTabs.appendChild(rpTabRow3);

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
        // Debounced. _renderRpBody rebuilds the whole panel — every card,
        // with a fresh IntersectionObserver each — and it ran synchronously
        // from oninput: 500 entries measured 331 ms PER KEYSTROKE, so typing
        // was unusable and the observers churned once per character. Nothing
        // in the panel needs the render to be synchronous with the keystroke.
        let _rpSearchT = null;
        const _rpSearchRender = () => {
          _rpSearchT = null;
          // _renderRpBody wipes rpBody, which detaches this input's own
          // wrapper and drops focus mid-keystroke — so only the first
          // character ever registered. Put the caret back where it was.
          const _s = rpSearch.selectionStart, _e = rpSearch.selectionEnd;
          _renderRpBody();
          try { rpSearch.focus(); rpSearch.setSelectionRange(_s, _e); } catch (_err) {}
        };
        rpSearch.oninput = () => {
          if (_rpSearchT) clearTimeout(_rpSearchT);
          _rpSearchT = setTimeout(_rpSearchRender, 140);
        };
        const rpSearchBtn = document.createElement("button");
        rpSearchBtn.textContent = "Search";
        rpSearchBtn.style.cssText =
          "background:#161d28;border:1px solid #202a38;border-radius:3px;" +
          "color:#7a8a9c;font-size:9px;padding:2px 8px;cursor:pointer;font-family:inherit;" +
          "white-space:nowrap;transition:color .1s,background .1s;";
        rpSearchBtn.onmouseenter = () => { rpSearchBtn.style.background="#202a38"; rpSearchBtn.style.color="#c2cddb"; };
        rpSearchBtn.onmouseleave = () => { rpSearchBtn.style.background="#161d28"; rpSearchBtn.style.color="#7a8a9c"; };
        // Explicit Search is immediate: cancel any pending debounce first so
        // the panel is not rebuilt twice.
        rpSearchBtn.onclick = () => {
          if (_rpSearchT) { clearTimeout(_rpSearchT); _rpSearchT = null; }
          _renderRpBody();
        };
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
        // Tabs that support Image/Video: civitai
        // Tabs that support Get Workflow button: civitai, genur (PNG metadata)
        const _MEDIA_TABS     = new Set(["civitai"]);
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

        // Cache: imageUrl -> hasWorkflow (boolean). The probe reply used to
        // be cached whole — entire workflow graphs — but was only ever read
        // for this boolean, and the Load button re-downloads anyway.
        // Bounded: oldest entries drop past 300.
        const _wfProbeCache = new Map();
        const _wfProbeSet = (url, has) => {
          if (_wfProbeCache.size >= 300) {
            const oldest = _wfProbeCache.keys().next().value;
            _wfProbeCache.delete(oldest);
          }
          _wfProbeCache.set(url, !!has);
        };

        // Fire-and-forget /extract-workflow probes fire once per scrolled
        // detail card open. Without an abort handle, a probe still in
        // flight when the node is disposed will resolve into the destroyed
        // editor's DOM via _setGetWfBtn. Wire every probe through an
        // AbortController, and abort them all in _epeDispose.
        const _wfProbeAborts = new Set();
        const _wfProbeStart = () => {
          const ac = (typeof AbortController !== "undefined") ? new AbortController() : null;
          if (ac) _wfProbeAborts.add(ac);
          return ac;
        };
        const _wfProbeDone = (ac) => {
          if (ac) _wfProbeAborts.delete(ac);
        };

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
            // Same stale-page defense as doSearch: bump the generation so a
            // page still in flight for the OTHER media type cannot land in
            // the freshly cleared list, and reset the error/empty counters
            // it may have accumulated.
            _civState.gen = (_civState.gen || 0) + 1;
            _civState.run = (_civState.run || 0) + 1;
            _civState.fails = 0; _civState.empties = 0;
            _civState.query = ""; _civState.page = 1; _civState.nextCursor = null;
            _civState.loading = false; _civState.exhausted = false; _civState.results = [];
            // Release any <video> src attrs before shedding — the media
            // toggle (Image ↔ Video) walks this path, and shedding 600
            // video cards without pause+detach pins ~12 MB per toggle.
            // Same rationale as doSearch; see _epeReleaseVideosIn.
            _epeReleaseVideosIn(civList);
            while (civList.lastChild) civList.removeChild(civList.lastChild);
            // Sentinel FIRST. Cards are inserted before the sentinel, so
            // appending the status first pins the retry message above every
            // card — the engine's own doSearch was fixed for exactly this and
            // this twin, which the image/video toggle calls, was not.
            civList.appendChild(civSentinel);
            civList.appendChild(civStatus);
            civStatus.style.display = "none";
            // Empty query is valid now (browse the featured feed), so always load.
            _civState.query = civSearchInput.value.trim();
            requestAnimationFrame(() => _civLoadMore());
          } else if (_rpActive === "genur") {
            _genurState.gen = (_genurState.gen || 0) + 1;
            _genurState.run = (_genurState.run || 0) + 1;
            _genurState.fails = 0; _genurState.empties = 0;
            _genurState.page = 1;
            _genurState.loading = false; _genurState.exhausted = false; _genurState.results = [];
            // Defensive: genur cards do not currently mount <video>, but if
            // a future card shape does, this covers it — same class as the
            // civ leak just above.
            _epeReleaseVideosIn(genurList);
            while (genurList.lastChild) genurList.removeChild(genurList.lastChild);
            genurList.appendChild(genurSentinel);
            genurList.appendChild(genurStatus);
            genurStatus.style.display = "none";
            // Empty query is valid (browse feed), so always load.
            _genurState.query = genurSearchInput.value.trim();
            requestAnimationFrame(() => _genurLoadMore());
          }
        };

        // Get Workflow button state — called from detail panels when image loads
        const _setGetWfBtn = (enabled, imageUrl) => {
          rpGetWfBtn._pendingImageUrl = enabled ? imageUrl : null;
          rpGetWfBtn._disabled = !enabled;
          // Disabling forgets which image an in-flight probe belongs to, so a
          // late reply can only arm the button if its own detail is still up.
          if (!enabled) rpGetWfBtn._probeUrl = null;
          // Stamped so a deferred disarm can tell whether the button still
          // belongs to the image it was scheduled for.
          rpGetWfBtn._armToken = (rpGetWfBtn._armToken || 0) + 1;
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
          // Re-entrancy guard: a second click during Fetching used to fire
          // a second /extract-workflow request and open TWO new canvas tabs
          // for the same image. `_fetching` gates the whole handler; the
          // `finally` clears it on both success and error paths.
          if (rpGetWfBtn._fetching) return;
          rpGetWfBtn._fetching = true;
          rpGetWfBtn.textContent = "Fetching\u2026";
          rpGetWfBtn.style.cursor = "default";
          try {
            const resp = await api.fetchApi("/epe/prompts/extract-workflow", {
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
              // Stamped: opening another image inside these two seconds
              // re-arms the shared button, and this timer used to disable it
              // anyway — so a workflow that WAS available read as absent.
              {
                const _tok = rpGetWfBtn._armToken;
                setTimeout(() => {
                  if (rpGetWfBtn._armToken !== _tok) return;
                  rpGetWfBtn.textContent = "\u21af Workflow";
                  _setGetWfBtn(false, null);
                }, 2000);
              }
              return;
            }
            rpGetWfBtn.textContent = "Loading\u2026";
            await _epeOpenTemplate(data.workflow, data.workflowFormat || "graph");
            rpGetWfBtn.textContent = "\u21af Workflow";
            _setGetWfBtn(false, null);
          } catch(e) {
            rpGetWfBtn.textContent = "Error";
            {
              const _tok = rpGetWfBtn._armToken;
              setTimeout(() => {
                if (rpGetWfBtn._armToken !== _tok) return;
                rpGetWfBtn.textContent = "\u21af Workflow";
                _setGetWfBtn(rpGetWfBtn._pendingImageUrl ? true : false, rpGetWfBtn._pendingImageUrl);
              }, 2000);
            }
          } finally {
            rpGetWfBtn._fetching = false;
          }
        };

        rpMediaBar.appendChild(rpMediaImgBtn);
        rpMediaBar.appendChild(rpMediaVidBtn);
        rpMediaBar.appendChild(rpGetWfBtn);

        // ── Workflow panel state ─────────────────────────────────────────
        // Building this panel makes it the owner of the shared cache, so an
        // earlier closure still holding a load cannot write over it. This is
        // deliberately NOT the search generation: bumping that here aborted
        // whatever a sibling node happened to have in flight.
        // `let`, not `const`: _wfDoSearch re-claims the pane when the user
        // runs a search in it, so a second node cannot wipe the first node's
        // cache and then be refused permission to refill it.
        let _wfEpoch = ++_epeWfOwner;
        let _wfState = { query: "", page: 1, cursor: "", loading: false, exhausted: false, results: [] };
        // Loop protection: some upstream cursor implementations return the
        // SAME cursor forever, which was measured at 30 fetches → 600 cards
        // → 20 distinct items on Civitai video queries. If the server hands
        // us back the cursor we just used, treat it as exhausted rather than
        // paging forever into duplicates.  Retains the "|| old" fallback for
        // the separate case where the server simply omits nextCursor.
        //
        // Also: some cursor APIs signal end-of-list with an EMPTY-STRING
        // nextCursor (rather than omitting the field). Falsy but distinct
        // from "field not present". Treat "" as end.
        const _wfAdvanceCursor = (nextCursor) => {
          // Empty-string cursor = end signal, but ONLY on the query path.
          //
          // /epe/prompts/search-workflows returns `nextCursor: ""` together
          // with `hasMore: true` for every BROWSE page — deliberately, because
          // browse pages by number and the client owns the number (api.py says
          // so at its own `next_cursor = cur if query else ""`). Reading that
          // as end-of-list killed the pane on page 1 of every browse: the
          // happy path lands the items BEFORE calling this, so results.length
          // was already 20 when the guard ran. And the branch never sets
          // wfStatus visible, so the retry control was not even clickable —
          // then `exhausted` was cached and restored on the next rebuild.
          //
          // The livelock this guard exists for is query-only anyway: browse
          // advances `_wfState.page` on every pass, so it cannot re-serve
          // page 1 forever. `hasMore` is the authority there, and the caller
          // already honours it.
          if (typeof nextCursor === "string" && nextCursor === ""
              && _wfState.query
              && (_wfState.cursor || _wfState.results.length > 0)) {
            _wfState.exhausted = true;
            return;
          }
          if (nextCursor && nextCursor === _wfState.cursor && _wfState.results.length > 0) {
            _wfState.exhausted = true;
            return;
          }
          _wfState.cursor = nextCursor || _wfState.cursor;
        };
        // Per-instance, like wfSpinner itself: a module-scope counter meant a
        // rebuilt node could never hide its own spinner, because the other
        // instance still held a count.
        let _wfInFlight = 0;
        // Consecutive hard failures. One blip should not kill the list.
        let _wfFails = 0;
        // Consecutive upstream pages on which every result was login-gated.
        // Bounds one attempt; deliberately NOT cached, see the soft stop below.
        let _wfEmpties = 0;
        // Which load is the latest for THIS panel. A superseded run used to
        // clear `loading` on its way out even when a newer load still held
        // it, and the scroll observer then fetched the same cursor twice.
        let _wfRun = 0;

        // ── Civitai placeholder ──────────────────────────────────────────
        // ══════════════════════════════════════════════════════════════════
        // PHASE 3 — CIVITAI BROWSER
        // ══════════════════════════════════════════════════════════════════

        // ── Prompt cleaner ───────────────────────────────────────────────
        // How much of a prompt the CARD preview considers. The preview is a
        // two-line clamp, so cleaning more than this to display ~120
        // characters is pure waste — and twenty cards of it is a freeze.
        const _CIV_PREVIEW_CHARS = 4096;

        // `limit` truncates before any work and is passed only by the card
        // builders. The detail panel and "Use Prompt" pass nothing, because
        // there the whole prompt is the point.
        const _civCleanPrompt = (raw, limit) => {
          if (!raw) return "";
          // Upstream `prompt` is not guaranteed to be a string. The Genur path
          // passes it through with no coercion, and a numeric one reached
          // `raw.replace` — not a function — which threw out of the card
          // builder and cost the whole page of results.
          let s = (typeof raw === "string") ? raw : String(raw);
          if (limit && s.length > limit) s = s.slice(0, limit);
          // The inner runs below are BOUNDED, and that is the whole fix.
          // `[^)]+` before a required ':' makes every '(' an attempt that
          // scans to the end of the string and backtracks the whole way:
          // 16 KB of '(' 0.286 s, 32 KB 1.117 s, 64 KB 4.224 s, 128 KB
          // 17.108 s — quadratic, on a stranger's text, once per card in a
          // synchronous render loop. With the cap a failed attempt costs the
          // cap instead of the string: 128 KB 0.269 s, 1 MB 2.098 s.
          //
          // 256 for a tag body (a LoRA name is tens of characters) and 512
          // for a weighted group (a phrase). Both sit far above anything real,
          // so nothing that used to be stripped survives now.
          // Strip LoRA tags: <lora:name:weight>
          s = s.replace(/<lora:[^>]{0,256}>/gi, "");
          // Strip embedding tags: <embedding:name>
          s = s.replace(/<embedding:[^>]{0,256}>/gi, "");
          // Strip weighted parens: (word:1.2) or (word word:0.8) -> word word
          s = s.replace(/\(([^)]{1,512}):\d+(\.\d+)?\)/g, (_, inner) => inner.trim());
          // Strip weighted brackets: [word] or [word:1.2] -> word
          s = s.replace(/\[([^\]]{1,512}?)(?::\d+(?:\.\d+)?)?\]/g, (_, inner) => inner.trim());
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
          period:   "Week",           // "" | "Week" | "Month" | "6Month" | "Year"
          baseModel:"",               // "" = any, or "Flux.1 D", "SD 1.5", "SDXL 1.0" etc
          baseModels: [],             // selected base models to filter by ([] = all)
          nextCursor: null,           // Civitai's REST API pages by cursor, not offset
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
        civCalloutText.textContent = "Browse Civitai images, or type words to match against prompt text \u2014 use any prompt as inspiration";
        civCalloutText.style.cssText = "font-size:9px;color:rgba(100,160,255,0.7);line-height:1.4;";
        civCallout.appendChild(civCalloutIcon);
        civCallout.appendChild(civCalloutText);
        civFilterBar.appendChild(civCallout);

        // Search row
        const civSearchRow = document.createElement("div");
        civSearchRow.style.cssText = "display:flex;gap:4px;";
        const civSearchInput = document.createElement("input");
        civSearchInput.type = "text";
        civSearchInput.placeholder = "Match words in prompts, or leave empty to browse\u2026";
        civSearchInput.value = "";
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
        civPeriodRow.style.cssText = "display:flex;gap:3px;flex-wrap:wrap;align-items:center;";
        // No 6Month bucket exists on Civitai's public API, so that chip is gone.
        [["All Time",""],["Day","Day"],["Week","Week"],["Month","Month"],["Year","Year"]].forEach(([label,val]) => {
          civPeriodRow.appendChild(_mkChip(label,"period",val, _civState.period===val));
        });

        // "Models" multi-select dropdown — filter the feed by one or more base
        // models. Empty selection = all models. The panel is inline (normal
        // flow) so it can't be clipped by the panel's overflow:hidden.
        const _CIV_MODELS = [
          "Illustrious", "SDXL 1.0", "Pony", "Flux.1 D", "ZImageTurbo", "Qwen",
          "SDXL Lightning", "Flux.2 Klein 9B", "ZImageBase", "Krea 2", "Flux.2 D",
          "OpenAI", "Nano Banana", "Seedream", "Ernie", "Imagen4", "Grok",
        ];
        const civModelsBtn = document.createElement("button");
        civModelsBtn.style.cssText =
          "font-size:11px;padding:2px 7px;border-radius:2px;cursor:pointer;margin-left:6px;" +
          "font-family:inherit;background:#12171f;border:1px solid #1c2431;color:#7a8a9c;" +
          "transition:color .1s,background .1s,border-color .1s;white-space:nowrap;";
        const _updateModelsBtn = () => {
          const n = _civState.baseModels.length;
          civModelsBtn.textContent = (n ? "Models (" + n + ")" : "Models") + " ▾";
          civModelsBtn.style.color       = n ? "#c2e2f8" : "#7a8a9c";
          civModelsBtn.style.borderColor = n ? "#4e5c6e" : "#1c2431";
          civModelsBtn.style.background  = n ? "#202a38" : "#12171f";
        };
        _updateModelsBtn();
        civPeriodRow.appendChild(civModelsBtn);

        // Dropdown panel — hidden until the button is clicked.
        const civModelsPanel = document.createElement("div");
        civModelsPanel.style.cssText =
          "display:none;flex-wrap:wrap;gap:3px;padding:5px;margin-top:1px;" +
          "max-height:150px;overflow-y:auto;background:#0d1119;" +
          "border:1px solid #1c2431;border-radius:3px;";
        const _mkModelChip = (name) => {
          const c = document.createElement("button");
          c.textContent = name;
          const _sel = () => _civState.baseModels.indexOf(name) >= 0;
          const _style = () => {
            c.style.cssText =
              "font-size:10px;padding:2px 6px;border-radius:2px;cursor:pointer;" +
              "font-family:inherit;transition:color .1s,background .1s,border-color .1s;" +
              (_sel()
                ? "background:#202a38;border:1px solid #4e5c6e;color:#c2e2f8;"
                : "background:#12171f;border:1px solid #1c2431;color:#6a7a8d;");
          };
          _style();
          c.onmouseenter = () => { if(!_sel()){ c.style.color="#a8b6c6"; c.style.borderColor="#28364a"; } };
          c.onmouseleave = () => { if(!_sel()){ c.style.color="#6a7a8d"; c.style.borderColor="#1c2431"; } };
          c.onclick = () => {
            const i = _civState.baseModels.indexOf(name);
            if (i >= 0) _civState.baseModels.splice(i, 1);
            else        _civState.baseModels.push(name);
            _style();
            _updateModelsBtn();
            _civDoSearch();
          };
          return c;
        };
        _CIV_MODELS.forEach(m => civModelsPanel.appendChild(_mkModelChip(m)));
        // Clear-all chip
        const civModelsClear = document.createElement("button");
        civModelsClear.textContent = "✕ Clear";
        civModelsClear.style.cssText =
          "font-size:10px;padding:2px 6px;border-radius:2px;cursor:pointer;font-family:inherit;" +
          "background:#161d28;border:1px solid #202a38;color:#7a8a9c;";
        civModelsClear.onclick = () => {
          if (_civState.baseModels.length === 0) return;
          _civState.baseModels = [];
          // Re-render chips to reflect the cleared state.
          civModelsPanel.innerHTML = "";
          _CIV_MODELS.forEach(m => civModelsPanel.appendChild(_mkModelChip(m)));
          civModelsPanel.appendChild(civModelsClear);
          _updateModelsBtn();
          _civDoSearch();
        };
        civModelsPanel.appendChild(civModelsClear);

        civModelsBtn.onclick = () => {
          civModelsPanel.style.display = (civModelsPanel.style.display === "none") ? "flex" : "none";
        };

        civFilterBar.appendChild(civSearchRow);
        civFilterBar.appendChild(civSortRow);
        civFilterBar.appendChild(civPeriodRow);
        civFilterBar.appendChild(civModelsPanel);

        // pause() alone releases nothing — the media resource is retained by
        // the <video>'s src attribute. A card list of 600 removed <video>
        // elements on a video-heavy Civitai query pins ~12 MB per new search
        // until GC. Same lesson _epeDispose already applies, spelled out in
        // its own comment: "src+load(), not just pause(): pause stops
        // playback, it does not release the media resource." Call this
        // BEFORE removeChild/innerHTML="" on any subtree that may contain
        // one.
        const _epeReleaseVideosIn = (root) => {
          if (!root) return;
          const list = (root.tagName === "VIDEO")
            ? [root]
            : (root.querySelectorAll ? root.querySelectorAll("video") : []);
          for (const v of list) {
            try { v.pause(); v.removeAttribute("src"); v.load(); } catch (_e) {}
          }
        };

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
            if (civDetail._activeVid) { _epeReleaseVideosIn(civDetail._activeVid); civDetail._activeVid = null; }
            // Also reset the workflow probe button — "↯ Checking…" would
            // otherwise stick until the in-flight probe returned (and could
            // arm the button for an image no longer on screen).
            try { _setGetWfBtn(false, null); } catch (_e) {}
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
              if (_wfProbeCache.get(item.imageUrl)) _setGetWfBtn(true, item.imageUrl);
            } else {
              rpGetWfBtn.textContent = "\u21af Checking\u2026";
              rpGetWfBtn.style.color = "#4e5c6e";
              rpGetWfBtn._probeUrl = item.imageUrl;
              const _ac = _wfProbeStart();
              api.fetchApi("/epe/prompts/extract-workflow", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ imageUrl: item.imageUrl }),
                signal: _ac ? _ac.signal : undefined,
              }).then(r => r.json()).then(d => {
                // Cache only a definitive answer — an {error:…} body from a
                // transient upstream hiccup is not "this PNG has no
                // workflow", and caching it made the workflow permanently
                // unloadable for the life of the node.
                if (d && !d.error) _wfProbeSet(item.imageUrl, !!d.hasWorkflow);
                // A slow probe must not arm the shared button for whatever
                // image is on screen NOW — only for the one it probed.
                if (rpGetWfBtn._probeUrl !== item.imageUrl) return;
                if (d && d.hasWorkflow) {
                  _setGetWfBtn(true, item.imageUrl);
                } else {
                  _setGetWfBtn(false, null);
                }
              }).catch(() => {
                if (rpGetWfBtn._probeUrl === item.imageUrl) _setGetWfBtn(false, null);
              }).finally(() => { _wfProbeDone(_ac); });
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
          pLabel.style.cssText = "font-size:9px;color:#31415a;font-weight:600;text-transform:uppercase;letter-spacing:.4px;flex-shrink:0;";
          pLabel.textContent = "Prompt";
          dBody.appendChild(pLabel);

          // Prompt textarea — collapsed read-only, click to expand+edit
          const LINE_H = 10 * 1.5;
          const PADDING_V = 10;
          const COLLAPSED_H = Math.round(LINE_H * 3 + PADDING_V) + "px";
          const _taROCSS =
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #24303f;" +
            "border-radius:3px;color:#aab8c8;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:none;height:"+COLLAPSED_H+";overflow-y:auto;font-family:inherit;outline:none;cursor:pointer;";
          const _taEditCSS =
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #4e5c6e;" +
            "border-radius:3px;color:#d4dfea;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:vertical;min-height:90px;max-height:300px;overflow-y:auto;font-family:inherit;outline:none;cursor:text;padding-bottom:12px;margin-bottom:8px;";

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
          civRow1.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;flex-shrink:0;";

          const civSaveNewBtn = _mkBtn("Save as New", "Save to Favorites", "rgba(109,184,232,0.8)");
          civSaveNewBtn.onclick = (ev) => { ev.stopPropagation(); const _civSel = civTA.value.slice(civTA.selectionStart, civTA.selectionEnd).trim(); _libAddEntry("favorites", _civSel || civTA.value.trim() || cleaned); };

          const civSnipBtn = _mkBtn("Snippets", "Save to Snippets");
          civSnipBtn.onclick = (ev) => { ev.stopPropagation(); const _civSel = civTA.value.slice(civTA.selectionStart, civTA.selectionEnd).trim(); _libAddEntry("snippets", _civSel || civTA.value.trim() || cleaned); };

          const civEnhBtn = _mkBtn("Enhance", "Run AI enhance on this prompt", "rgba(100,160,255,0.7)");
          civEnhBtn.onclick = (ev) => {
            ev.stopPropagation();
            // Handed over, not written in first — see runAiAction's
            // sourceText note. Writing textEl here persisted the remote text
            // as epe_prompt and made Discard restore it instead of the
            // user's own prompt.
            runAiAction("expand", { sourceText: civTA.value.trim() || cleaned });
          };

          civRow1.appendChild(civSaveNewBtn);
          civRow1.appendChild(civSnipBtn);
          civRow1.appendChild(civEnhBtn);

          // Row 2: Variations | Use + token count right
          const civRow2 = document.createElement("div");
          civRow2.style.cssText = "display:flex;align-items:center;gap:4px;flex-shrink:0;";

          const civVarBtn = _mkBtn("Variations", "Run AI variations on this prompt", "rgba(140,200,240,0.7)");
          civVarBtn.onclick = (ev) => {
            ev.stopPropagation();
            runAiAction("variations", { sourceText: civTA.value.trim() || cleaned });
          };

          const civUseBtn = _mkBtn("Use", "Send to main prompt editor", "rgba(109,184,232,0.8)");
          civUseBtn.onclick = (ev) => {
            ev.stopPropagation();
            const t = civTA.value.trim()||cleaned;
            // A review open here meant this text was written INTO the review:
            // updateTokenBadge and _epePersistPrompt both hard-return while
            // _reviewMode is set, so nothing persisted, Discard then restored
            // _originalPrompt over it, and the _epePushUndo below pushed the
            // UN-ACCEPTED AI result onto the undo stack — from where one
            // Ctrl+Z put it into node.properties and sent it to the sampler.
            // In "variations" mode textEl is display:none, so Use showed
            // nothing at all. _setRpTab carries this guard, but reaching a
            // card does not go through _setRpTab when the panel is already
            // on this tab.
            if (_reviewMode) _autoDiscardReview("Prompt used — result discarded");
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
          civDivider.style.cssText = "border-top:1px solid #161d28;margin:2px 0;flex-shrink:0;";
          dBody.appendChild(civDivider);

          const civImgPromptBtn = _mkBtn("\uD83D\uDDBC Image to Prompt",
            "Send this image to Ollama (qwen3.5 vision model) to generate a prompt",
            "rgba(109,184,232,0.8)");
          civImgPromptBtn.style.width = "100%"; civImgPromptBtn.style.flexShrink = "0";
          civImgPromptBtn.onclick = async (ev) => {
            ev.stopPropagation();
            const isVideo = item.mediaType === "video" && item.videoUrl;
            if (!isVideo && !item.imageUrl) return;
            _epeTakeAiSlot();
            _syncVisionStyleBridge();
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
            civVidPromptBtn.style.width = "100%"; civVidPromptBtn.style.flexShrink = "0";
            civVidPromptBtn.onclick = async (ev) => {
              ev.stopPropagation();
              _epeTakeAiSlot();
              _syncVisionStyleBridge();
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
        //   video   : allow <video> thumbnails (civitai yes, genur no)
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
          // Limited: this is the two-line card preview, not the detail panel.
          clean: (p) => _civCleanPrompt(p, _CIV_PREVIEW_CHARS),
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

          // One controller per panel, so dispose has something to abort. With
          // none, a page still in flight when the node was destroyed came back
          // and built its cards into a detached list — every one of them
          // firing a real image request — while holding the whole editor
          // closure alive until it settled.
          cfg.state.abort = null;
          const fetchPage = async (page) => {
            const q = (cfg.state.query || "").trim();
            if (!q && !cfg.allowEmpty) return null;
            try { if (cfg.state.abort) cfg.state.abort.abort(); } catch (_e) {}
            const _ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
            cfg.state.abort = _ctl;
            const resp = await api.fetchApi(cfg.endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(cfg.body(q, page)),
              signal: _ctl ? _ctl.signal : undefined,
            });
            if (!resp.ok) throw new Error(cfg.errLabel + " " + resp.status);
            return resp.json();
          };

          // Returns the items that actually landed. cfg.filter can pass an
          // item that mkCard then rejects (requireClean: a prompt that is
          // nothing but LoRA tags cleans to empty), so "the filter kept some"
          // was not the same as "the list grew" — and when nothing grew, the
          // observer had no intersection change to fire on and the list
          // stalled mid-catalogue with no message and no control.
          const appendItems = (items) => {
            const landed = [];
            items.forEach(raw => {
              // Per item, because both halves reach into upstream shape:
              // cfg.mapItem indexes the raw object and cfg.mkCard runs the
              // prompt through _civCleanPrompt. One malformed entry used to
              // throw out of this loop to loadMore's catch, which discarded
              // EVERY result on the page and burned a failure strike — two
              // such pages stop the browser for the session.
              let card = null;
              try { card = cfg.mkCard(cfg.mapItem(raw)); } catch (_e) { card = null; }
              if (card) { cfg.list.insertBefore(card, sentinel); landed.push(raw); }
            });
            return landed;
          };

          // cfg.filter reaches straight into each element (`i.prompt`), so a
          // null or a primitive in the list threw before any of the per-item
          // guarding above could help. A non-list `items` did the same.
          // One page is rendered in a single synchronous pass — appendItems
          // builds a DOM card per item with no yield — and BOORU_MAX_RESULTS
          // bounds only the ACCUMULATED list, checked BEFORE the fetch. So the
          // page itself was unbounded: measured, a stubbed page of 20,000
          // items froze the tab for 5.6 s and the cap noticed on the next
          // load. Bounded here, where the items enter, so appendItems, the
          // results array and the card DOM all inherit it.
          const BOORU_MAX_PAGE_ITEMS = 200;

          const usableItems = (rawItems) => {
            if (!Array.isArray(rawItems)) {
              if (rawItems != null)
                console.warn("[EPE] " + cfg.errLabel + ": upstream 'items' was not a list");
              return [];
            }
            if (rawItems.length > BOORU_MAX_PAGE_ITEMS) {
              console.warn("[EPE] " + cfg.errLabel + ": upstream page had " +
                           rawItems.length + " items — using the first " +
                           BOORU_MAX_PAGE_ITEMS);
              rawItems = rawItems.slice(0, BOORU_MAX_PAGE_ITEMS);
            }
            const objs = rawItems.filter(i => i && typeof i === "object");
            let out;
            try { out = cfg.filter(objs); } catch (_e) { out = objs; }
            return Array.isArray(out) ? out : [];
          };

          // Scrolling was unbounded: the results array, the DOM cards, and
          // every decoded image or video stayed resident for the node's
          // lifetime, so a long scroll is a memory leak with a scrollbar.
          // The cap is stated in the panel rather than the list just stopping.
          const BOORU_MAX_RESULTS = 600;

          const loadMore = async () => {
            if (cfg.state.loading || cfg.state.exhausted) return;
            if ((cfg.state.results || []).length >= BOORU_MAX_RESULTS) {
              cfg.state.exhausted = true;
              cfg.status.textContent =
                "Showing the first " + BOORU_MAX_RESULTS +
                " — narrow the search to see different results.";
              cfg.status.style.display = "block";
              return;
            }
            cfg.state.loading = true;
            cfg.spinner.style.display = "block";
            // Which search this belongs to, and which load. A stale page used to
            // append into the list a newer search had just cleared.
            const gen = (cfg.state.gen = cfg.state.gen || 0);
            const myRun = (cfg.state.run = (cfg.state.run || 0) + 1);
            let failed = false, skipToNext = false;
            try {
              const data = await fetchPage(cfg.state.page);
              // Superseded by a newer search on this same panel. Unlike the
              // workflow pane, this counter is per panel, so a newer search is
              // always already running — there is no blank pane to rescue and
              // nothing to say to the user.
              if (gen !== cfg.state.gen) return;
              if (!data || data.error) {
                // An upstream hiccup is not an empty catalogue, and it is the
                // common failure shape. Two strikes, like the workflow pane.
                failed = true;
                cfg.state.fails = (cfg.state.fails || 0) + 1;
                if (cfg.state.fails >= 2) cfg.state.exhausted = true;
                cfg.status.textContent = (data?.error || "No results found.")
                  + (cfg.state.fails < 2 ? " — click to retry" : "");
                cfg.status.style.display = "block";
              } else {
                const hasMore = data.metadata?.hasMore ?? false;
                // Cursor-paged sources hand back the next cursor; offset-paged
                // ones leave it undefined and this stays null.
                // Loop protection: if the server hands us back the SAME cursor
                // we just used, mark exhausted — see _wfAdvanceCursor for the
                // full note. Do this before overwriting the cursor. Also
                // treat an empty-string cursor as end-of-list (some cursor
                // APIs signal end that way rather than omitting the field).
                // MATCHES the wf variant: on the empty-string end signal,
                // PRESERVE the previous cursor so a retry click (which
                // resets `exhausted` but not `nextCursor`) does not send
                // `cursor: ""` and re-fetch page 1's items.
                const _prevCursor = cfg.state.nextCursor;
                const _newCursor  = data.metadata?.nextCursor ?? null;
                if (typeof _newCursor === "string" && _newCursor === ""
                    && (_prevCursor || cfg.state.results.length > 0)) {
                  cfg.state.exhausted = true;
                  // KEEP _prevCursor on cfg.state.nextCursor — do not overwrite.
                } else if (_newCursor && _newCursor === _prevCursor && cfg.state.results.length > 0) {
                  cfg.state.exhausted = true;
                  cfg.state.nextCursor = _newCursor;
                } else {
                  cfg.state.nextCursor = _newCursor;
                }
                let usable = usableItems(data.items);
                const landed = usable.length > 0 ? appendItems(usable) : [];
                const _added = landed.length;
                if (_added > 0) {
                  // A loop, not push(...landed). The spread passes ONE
                  // ARGUMENT PER ELEMENT, so a large enough upstream page
                  // throws "RangeError: Maximum call stack size exceeded"
                  // here — after the cards were already built and inserted.
                  for (let _i = 0; _i < landed.length; _i++) cfg.state.results.push(landed[_i]);
                  cfg.state.fails = 0;
                  cfg.state.empties = 0;
                } else {
                  // Nothing reached the list, whatever the filter thought.
                  usable = [];
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
                } else if (usable.length === 0) {
                  // A whole page filtered out. Nothing was inserted before the
                  // sentinel, so its intersection state never changes and the
                  // observer will NOT fire again — the old comment claiming it
                  // would is why the list silently stopped here. Fetch the next
                  // page directly, bounded so a filtered tail still terminates.
                  cfg.state.empties = (cfg.state.empties || 0) + 1;
                  if (cfg.state.empties < 5) {
                    skipToNext = true;
                  } else {
                    cfg.state.exhausted = true;
                    cfg.status.textContent = "Nothing usable on this stretch — click to keep looking.";
                    cfg.status.style.display = "block";
                    failed = true;   // a bound, not an end: do not treat as final
                  }
                }
              }
            } catch(err) {
              if (gen !== cfg.state.gen) return;
              failed = true;
              cfg.state.fails = (cfg.state.fails || 0) + 1;
              if (cfg.state.fails >= 2) cfg.state.exhausted = true;
              cfg.status.textContent = "Error: " + (err.message || "Failed to fetch")
                + (cfg.state.fails < 2 ? " — click to retry" : "");
              cfg.status.style.display = "block";
            } finally {
              // Only the latest load may hand the flag back. A superseded run
              // releasing it let the observer start a second fetch of a cursor
              // the live run was already using.
              // Both gated on ownership. A superseded run hiding the spinner
              // made the list look idle while the live run was still fetching.
              if (myRun === cfg.state.run) {
                cfg.state.loading = false;
                cfg.spinner.style.display = "none";
              }
            }
            if (skipToNext && gen === cfg.state.gen) return loadMore();
          };

          // The message itself is the retry control. On a failure that leaves
          // the list empty nothing is inserted before the sentinel, so there is
          // no scroll that can bring the observer back.
          cfg.status.style.cursor = "pointer";
          cfg.status.title = "Click to try again";
          cfg.status.onclick = () => {
            if (cfg.state.loading) return;
            cfg.state.exhausted = false;
            cfg.state.fails = 0;
            cfg.state.empties = 0;
            cfg.status.style.display = "none";
            loadMore();
          };

          const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !cfg.state.loading && !cfg.state.exhausted) {
              loadMore();
            }
          }, { root: cfg.list, threshold: 0.1 });
          observer.observe(sentinel);

          const doSearch = () => {
            const q = cfg.searchInput.value.trim();
            if (!q && !cfg.allowEmpty) return;
            // A new search always exits the detail view back to results.
            if (cfg.detail) {
              try { cfg.detail._cleanup && cfg.detail._cleanup(); cfg.detail._cleanup = null; } catch (_e) {}
              try { if (cfg.detail._activeVid) { _epeReleaseVideosIn(cfg.detail._activeVid); cfg.detail._activeVid = null; } } catch (_e) {}
              // Same reason as the civ/genur Back button handlers: leaving
              // rpGetWfBtn armed after a detail exit would let a click load
              // a workflow for an image no longer on screen.
              try { _setGetWfBtn(false, null); } catch (_e) {}
              cfg.detail.style.display = "none";
            }
            if (cfg.list) cfg.list.style.display = "";
            cfg.state.gen      = (cfg.state.gen || 0) + 1;   // drop stale pages
            cfg.state.fails    = 0;
            cfg.state.empties  = 0;
            cfg.state.query    = q;
            cfg.state.page     = 1;
            cfg.state.nextCursor = null;
            cfg.state.loading  = false;
            cfg.state.exhausted= false;
            cfg.state.results  = [];
            // Release any <video> src attrs before shedding the cards —
            // removeChild alone does not stop the browser from holding the
            // media resource. See _epeReleaseVideosIn.
            _epeReleaseVideosIn(cfg.list);
            while (cfg.list.lastChild) cfg.list.removeChild(cfg.list.lastChild);
            // Sentinel first, THEN the status: cards are inserted before the
            // sentinel, so appending the status first pinned the retry message
            // above every card. A failure five pages down then showed nothing
            // where the user was looking — the spinner just stopped. The
            // workflow pane already orders it this way.
            cfg.list.appendChild(sentinel);
            cfg.list.appendChild(cfg.status);
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
          allowEmpty: true,   // empty query = browse the featured-style feed
          body: (q, page) => ({
            query: q, sort: _civState.sort, period: _civState.period,
            baseModels: _civState.baseModels,
            nsfw: false, page, mediaType: _rpMediaType,
            cursor: _civState.nextCursor,
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

        const _genurState = { query:"", page:1, loading:false, exhausted:false, results:[], sort:"popular", baseModels:[] };

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
        genurCalloutText.textContent = "Browse Genur.art images, or type to search \u2014 use any prompt as inspiration";
        genurCalloutText.style.cssText = "font-size:9px;color:rgba(100,160,255,0.7);line-height:1.4;";
        genurCallout.appendChild(genurCalloutIcon);
        genurCallout.appendChild(genurCalloutText);
        genurFilterBar.appendChild(genurCallout);

        const genurSearchRow = document.createElement("div");
        genurSearchRow.style.cssText = "display:flex;gap:4px;";
        const genurSearchInput = document.createElement("input");
        genurSearchInput.type = "text";
        genurSearchInput.placeholder = "Search, or leave empty to browse\u2026";
        genurSearchInput.value = "";
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

        // Model dropdown — Genur uses the same base-model names as Civitai, but
        // its API only filters by ONE model at a time, so this is single-select.
        const genurModelsBtn = document.createElement("button");
        genurModelsBtn.style.cssText =
          "font-size:11px;padding:2px 7px;border-radius:2px;cursor:pointer;margin-left:6px;" +
          "font-family:inherit;background:#12171f;border:1px solid #1c2431;color:#7a8a9c;" +
          "transition:color .1s,background .1s,border-color .1s;white-space:nowrap;";
        const _genurUpdModelsBtn = () => {
          const sel = _genurState.baseModels[0];
          genurModelsBtn.textContent = (sel ? sel : "Model") + " ▾";
          genurModelsBtn.style.color       = sel ? "#c2e2f8" : "#7a8a9c";
          genurModelsBtn.style.borderColor = sel ? "#4e5c6e" : "#1c2431";
          genurModelsBtn.style.background  = sel ? "#202a38" : "#12171f";
        };
        _genurUpdModelsBtn();
        genurSortRow.appendChild(genurModelsBtn);

        const genurModelsPanel = document.createElement("div");
        genurModelsPanel.style.cssText =
          "display:none;flex-wrap:wrap;gap:3px;padding:5px;margin-top:1px;" +
          "max-height:150px;overflow-y:auto;background:#0d1119;border:1px solid #1c2431;border-radius:3px;";
        const _mkGenurModelChip = (name) => {
          const c = document.createElement("button");
          c.textContent = name;
          const _sel = () => _genurState.baseModels[0] === name;
          const _style = () => {
            c.style.cssText =
              "font-size:10px;padding:2px 6px;border-radius:2px;cursor:pointer;font-family:inherit;" +
              "transition:color .1s,background .1s,border-color .1s;" +
              (_sel() ? "background:#202a38;border:1px solid #4e5c6e;color:#c2e2f8;"
                      : "background:#12171f;border:1px solid #1c2431;color:#6a7a8d;");
          };
          _style();
          c.onmouseenter = () => { if(!_sel()){ c.style.color="#a8b6c6"; c.style.borderColor="#28364a"; } };
          c.onmouseleave = () => { if(!_sel()){ c.style.color="#6a7a8d"; c.style.borderColor="#1c2431"; } };
          c.onclick = () => {
            // Single-select: re-clicking the active model clears it.
            _genurState.baseModels = _sel() ? [] : [name];
            genurModelsPanel.querySelectorAll("button[data-gm='1']").forEach(b => b._restyle && b._restyle());
            _genurUpdModelsBtn();
            _genurDoSearch();
          };
          c._restyle = _style;
          c.dataset.gm = "1";
          return c;
        };
        _CIV_MODELS.forEach(m => genurModelsPanel.appendChild(_mkGenurModelChip(m)));
        genurModelsBtn.onclick = () => {
          genurModelsPanel.style.display = (genurModelsPanel.style.display === "none") ? "flex" : "none";
        };

        genurFilterBar.appendChild(genurSortRow);
        genurFilterBar.appendChild(genurModelsPanel);

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
            // Also reset the workflow probe button — same reason as the civ
            // Back path.
            try { _setGetWfBtn(false, null); } catch (_e) {}
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
              if (_wfProbeCache.get(item.imageUrl)) _setGetWfBtn(true, item.imageUrl);
            } else {
              rpGetWfBtn.textContent = "\u21af Checking\u2026";
              rpGetWfBtn.style.color = "#4e5c6e";
              rpGetWfBtn._probeUrl = item.imageUrl;
              const _ac = _wfProbeStart();
              api.fetchApi("/epe/prompts/extract-workflow", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ imageUrl: item.imageUrl }),
                signal: _ac ? _ac.signal : undefined,
              }).then(r => r.json()).then(d => {
                // Cache only a definitive answer — an {error:…} body from a
                // transient upstream hiccup is not "this PNG has no
                // workflow", and caching it made the workflow permanently
                // unloadable for the life of the node.
                if (d && !d.error) _wfProbeSet(item.imageUrl, !!d.hasWorkflow);
                if (rpGetWfBtn._probeUrl !== item.imageUrl) return;
                if (d && d.hasWorkflow) _setGetWfBtn(true, item.imageUrl);
                else _setGetWfBtn(false, null);
              }).catch(() => {
                if (rpGetWfBtn._probeUrl === item.imageUrl) _setGetWfBtn(false, null);
              }).finally(() => { _wfProbeDone(_ac); });
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
          pLabel.style.cssText = "font-size:9px;color:#31415a;font-weight:600;text-transform:uppercase;letter-spacing:.4px;flex-shrink:0;";
          pLabel.textContent = "Prompt";
          dBody.appendChild(pLabel);

          const LINE_H_G = 10 * 1.5;
          const PADDING_V_G = 10;
          const COLLAPSED_H_G = Math.round(LINE_H_G * 3 + PADDING_V_G) + "px";
          const _taROCSS_G =
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #24303f;" +
            "border-radius:3px;color:#aab8c8;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:none;height:"+COLLAPSED_H_G+";overflow-y:auto;font-family:inherit;outline:none;cursor:pointer;";
          const _taEditCSS_G =
            "width:100%;box-sizing:border-box;background:#0e1319;border:1px solid #4e5c6e;" +
            "border-radius:3px;color:#d4dfea;font-size:10px;line-height:1.5;padding:5px 7px;" +
            "resize:vertical;min-height:90px;max-height:300px;overflow-y:auto;font-family:inherit;outline:none;cursor:text;padding-bottom:12px;margin-bottom:8px;";

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
          genurRow1.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;flex-shrink:0;";

          const genurSaveNewBtn = _mkBtn("Save as New", "Save to Favorites", "rgba(109,184,232,0.8)");
          genurSaveNewBtn.onclick = (ev) => { ev.stopPropagation(); const _sel = genurTA.value.slice(genurTA.selectionStart, genurTA.selectionEnd).trim(); _libAddEntry("favorites", _sel || genurTA.value.trim() || cleaned); };

          const genurSnipBtn = _mkBtn("Snippets", "Save to Snippets");
          genurSnipBtn.onclick = (ev) => { ev.stopPropagation(); const _sel = genurTA.value.slice(genurTA.selectionStart, genurTA.selectionEnd).trim(); _libAddEntry("snippets", _sel || genurTA.value.trim() || cleaned); };

          const genurEnhBtn = _mkBtn("Enhance", "Run AI enhance on this prompt", "rgba(100,160,255,0.7)");
          genurEnhBtn.onclick = (ev) => {
            ev.stopPropagation();
            // Handed over, not written in first — see runAiAction's sourceText
            // note. Writing textEl here persisted the remote text as
            // epe_prompt and made Discard restore it instead of the user's.
            runAiAction("expand", { sourceText: genurTA.value.trim() || cleaned });
          };

          genurRow1.appendChild(genurSaveNewBtn);
          genurRow1.appendChild(genurSnipBtn);
          genurRow1.appendChild(genurEnhBtn);

          const genurRow2 = document.createElement("div");
          genurRow2.style.cssText = "display:flex;align-items:center;gap:4px;flex-shrink:0;";

          const genurVarBtn = _mkBtn("Variations", "Run AI variations on this prompt", "rgba(140,200,240,0.7)");
          genurVarBtn.onclick = (ev) => {
            ev.stopPropagation();
            runAiAction("variations", { sourceText: genurTA.value.trim() || cleaned });
          };

          const genurUseBtn = _mkBtn("Use", "Send to main prompt editor", "rgba(109,184,232,0.8)");
          genurUseBtn.onclick = (ev) => {
            ev.stopPropagation();
            const t = genurTA.value.trim()||cleaned;
            // Same as the Civitai twin above.
            if (_reviewMode) _autoDiscardReview("Prompt used — result discarded");
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
          genurDivider.style.cssText = "border-top:1px solid #161d28;margin:2px 0;flex-shrink:0;";
          dBody.appendChild(genurDivider);

          const genurImgPromptBtn = _mkBtn("\uD83D\uDDBC Image to Prompt",
            "Send this image to Ollama (qwen3.5 vision model) to generate a prompt",
            "rgba(109,184,232,0.8)");
          genurImgPromptBtn.style.width = "100%"; genurImgPromptBtn.style.flexShrink = "0";
          genurImgPromptBtn.onclick = async (ev) => {
            ev.stopPropagation();
            if (!item.imageUrl) return;
            _epeTakeAiSlot();
            _syncVisionStyleBridge();
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
          clean: (p) => _civCleanPrompt(p || "", _CIV_PREVIEW_CHARS),
          preview: (it, cleaned) => cleaned || it.prompt || "",
          onClick: _showGenurDetail,
        });

        const _genurEngine = _mkBooruEngine({
          state: _genurState, list: genurList, status: genurStatus, spinner: genurSpinner, detail: genurDetail,
          searchInput: genurSearchInput, searchBtn: genurSearchBtn,
          endpoint: "/epe/prompts/search-genur", errLabel: "Genur.art search error",
          allowEmpty: true,   // empty query = browse the ranked feed
          body: (q, page) => ({ query: q, page, sort: _genurState.sort, baseModels: _genurState.baseModels }),
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

        // ── Micro action button ──────────────────────────────────────────
        // ── Font sizer helper — wraps any textarea with an always-visible ──
        // ── centered A/size/A bar above it. Faded by default; brightens on ──
        // ── bar hover or textarea focus.                                   ──
        //
        // Per-node registry of the font-sizer MutationObservers. The
        // observer only self-disconnects when its callback fires AND the
        // textarea is disconnected — a card removed without any style
        // mutation triggers no callback and leaves the observer running.
        // Bounded but observable (measured 398/404 collectable), so track
        // and disconnect all on node dispose.
        const _fsObservers = [];
        const _mkFontSizerWrap = (ta, defaultSize) => {
          let _fs = defaultSize || 10;
          ta.style.fontSize = _fs + "px";

          // Re-apply font size whenever the textarea cssText is reset by result panels
          let _fsApplying = false;
          const _fsObs = new MutationObserver(() => {
            if (!ta.isConnected) {
              _fsObs.disconnect();
              const _i = _fsObservers.indexOf(_fsObs);
              if (_i >= 0) _fsObservers.splice(_i, 1);
              return;
            }
            if (_fsApplying) return;
            if (ta.style.fontSize !== _fs + "px") {
              _fsApplying = true;
              ta.style.fontSize = _fs + "px";
              _fsApplying = false;
            }
          });
          _fsObs.observe(ta, { attributes: true, attributeFilter: ["style"] });
          // Prune before adding. The self-cleanup above only runs when the
          // observer's own callback FIRES, and a card removed without any
          // style mutation never fires one — so the array grew for the whole
          // life of the node (measured: 6 of 404 stayed). Each entry pins its
          // textarea and everything that textarea's handlers close over.
          //
          // Keyed off the observed element, stashed on the observer, because a
          // MutationObserver exposes no way to ask what it is watching.
          _fsObs._epeTa = ta;
          for (let _i = _fsObservers.length - 1; _i >= 0; _i--) {
            const _o = _fsObservers[_i];
            const _ota = _o && _o._epeTa;
            // Only drop one we can PROVE is detached. An entry with no stashed
            // element is left alone — dispose still disconnects it.
            if (_ota && _ota.isConnected === false) {
              try { _o.disconnect(); } catch (_e) {}
              _fsObservers.splice(_i, 1);
            }
          }
          _fsObservers.push(_fsObs);

          // Outer wrap — column so the bar sits above the textarea.
          // Deliberately flex:0 0 auto: it sizes to the textarea's own height
          // instead of competing for space. When the panel is short the parent
          // (dBody, overflow-y:auto) scrolls, rather than the wrap being
          // squeezed below the textarea's min-height and letting the textarea
          // overflow on top of the buttons underneath it.
          const wrap = document.createElement("div");
          wrap.style.cssText = "display:flex;flex-direction:column;flex:0 0 auto;min-width:0;";

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
          "Search Civitai ComfyUI workflows. Click Load to open in a new canvas tab.";

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

        wfFilterBar.appendChild(wfCallout);
        wfFilterBar.appendChild(wfSearchRow);

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
            const _ac = _wfProbeStart();
            try {
              const resp = await api.fetchApi("/epe/prompts/workflow-detail", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  id:          item.id,
                  source:      item.source,
                  downloadUrl: item.downloadUrl || "",
                  versionId:   item.versionId   || "",
                }),
                signal: _ac ? _ac.signal : undefined,
              });
              const data = await resp.json();
              if (_ac && _ac.signal.aborted) return;
              if (resp.status === 403) throw new Error("\u26a0 Login required on Civitai to download this workflow");
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              if (data.error) throw new Error(data.error);
              if (!data.workflow) throw new Error("No workflow returned");
              loadBtn.textContent = "Loading\u2026";
              await _epeOpenTemplate(data.workflow);
              if (_ac && _ac.signal.aborted) return;
              loadBtn.textContent = "Loaded \u2713";
              setTimeout(() => {
                if (_ac && _ac.signal.aborted) return;
                loadBtn.textContent = "Load Workflow"; loadBtn.disabled = false;
              }, 2000);
            } catch(e) {
              if (_ac && _ac.signal.aborted) return;
              loadBtn.textContent = "Error: " + (e.message || "failed");
              loadBtn.style.color = "#c66";
              loadBtn.disabled = false;
              setTimeout(() => {
                if (_ac && _ac.signal.aborted) return;
                loadBtn.textContent = "Load Workflow";
                loadBtn.style.color = "rgba(109,184,232,0.85)";
              }, 3000);
            } finally {
              _wfProbeDone(_ac);
            }
          };
          info.appendChild(loadBtn);
          card.appendChild(info);
          return card;
        };

        // ── Fetch + load logic ────────────────────────────────────────────
        // Civitai is the only workflow source left, so this is constant.
        const _wfActiveSource = () => "civitai";

        // Same as the booru engine's: dispose needs something to abort.
        let _wfAbort = null;
        const _wfFetchPage = async (page) => {
          const q = _wfState.query.trim();
          try { if (_wfAbort) _wfAbort.abort(); } catch (_e) {}
          const _ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
          _wfAbort = _ctl;
          const resp = await api.fetchApi("/epe/prompts/search-workflows", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: q, page, cursor: _wfState.cursor, source: _wfActiveSource() }),
            signal: _ctl ? _ctl.signal : undefined,
          });
          if (!resp.ok) throw new Error(`Workflow search error ${resp.status}`);
          return resp.json();
        };

        // The three guards _mkBooruEngine has and this hand-rolled loader
        // never adopted. Same numbers, same reasons — see the comments there.
        const WF_MAX_PAGE_ITEMS = 200;
        const WF_MAX_RESULTS    = 600;

        // One page in, capped, per-item guarded, pushed and rendered. A
        // single malformed item used to throw out of the forEach into
        // _wfLoadMore's catch, which discarded every card on the page and
        // burned a failure strike; two such pages killed the pane for the
        // session.
        const _wfLandItems = (items) => {
          if (!Array.isArray(items)) return 0;
          if (items.length > WF_MAX_PAGE_ITEMS) {
            console.warn("[EPE] workflow search: upstream page had " +
                         items.length + " items — using the first " +
                         WF_MAX_PAGE_ITEMS);
            items = items.slice(0, WF_MAX_PAGE_ITEMS);
          }
          const landed = [];
          for (const item of items) {
            if (!item || typeof item !== "object") continue;
            let card = null;
            try { card = _mkWfCard(item); } catch (_e) { card = null; }
            if (card) { wfList.insertBefore(card, wfSentinel); landed.push(item); }
          }
          _epePushAll(_wfState.results, landed);
          return landed.length;
        };

        const _wfLoadMore = async () => {
          if (_wfState.loading || _wfState.exhausted) return;
          // Scrolling was unbounded here: the results array, the DOM cards and
          // every decoded cover image stayed resident for the node's lifetime.
          // The cap is stated in the pane rather than the list just stopping.
          if (_wfState.results.length >= WF_MAX_RESULTS) {
            _wfState.exhausted = true;
            wfStatus.textContent =
              "Showing the first " + WF_MAX_RESULTS +
              " — narrow the search to see different results.";
            wfStatus.style.display = "block";
            return;
          }
          _wfState.loading = true;
          _wfInFlight++;
          wfSpinner.style.display = "block";
          const gen = _epeWfGen;
          const myRun = ++_wfRun;
          // A run that ends in failure must not write its exhausted flag
          // into the cache, or the pane stays dead across every rebuild.
          let _failed = false;
          // Nor may hitting the gated-page bound: that is a stop for this
          // attempt, not a statement about the catalogue.
          let _softStop = false;
          // Set when the page came back empty while upstream says there is
          // more: every result on it was login-gated.
          let _skipToNext = false;
          try {
            const data = await _wfFetchPage(_wfState.page);
            if (gen !== _epeWfGen) {
              // Superseded — by this panel's own newer search, or by another
              // EPE node's (the counter is shared). In the second case this
              // panel is left with nothing rendered and an observer that will
              // not fire again, so leave a control behind rather than a
              // silently blank pane.
              if (myRun === _wfRun) {
                wfStatus.textContent = _wfState.results.length
                  ? "Load interrupted — click to continue."
                  : "Search interrupted — click to try again.";
                wfStatus.style.display = "block";
              }
              return;
            }
            if (data && data.error && data.items && data.items.length) {
              // Partial: results came back but a later page failed. Show what
              // arrived and say why the list stops here.
              _wfLandItems(data.items);
              // Keep going: the server returns a usable cursor with a partial
              // page, and ending the search here threw that away over what may
              // be a transient upstream blip.
              // A partial page still delivered items, so it clears the
              // strike count — otherwise "consecutive" failures could be
              // separated by successful pages and still kill the list.
              _wfFails = 0;
              _wfEmpties = 0;
              _wfState.page++;
              _wfAdvanceCursor(data.metadata?.nextCursor);
              if (!data.metadata?.hasMore) _wfState.exhausted = true;
              wfStatus.textContent = "Some results unavailable: " + data.error;
              wfStatus.style.display = "block";
            } else if (data && data.error) {
              // Upstream trouble is not the same as an empty catalogue —
              // and a 200 carrying an error is the COMMON failure shape, so
              // it earns the same tolerance as a thrown request instead of
              // killing a hundred loaded cards on one rate-limit blip.
              _failed = true;
              _wfFails++;
              if (_wfFails >= 2) _wfState.exhausted = true;
              wfStatus.textContent = "Search error: " + data.error
                + (_wfFails < 2 ? " — click to retry" : "");
              wfStatus.style.display = "block";
            } else if (!data || !data.items || data.items.length === 0) {
              if (data && data.metadata && data.metadata.hasMore && _wfEmpties < 5) {
                // Empty but not finished: every result on this upstream page
                // needed a login to download, so the server dropped them all.
                // Reading that as the end of the catalogue made everything
                // past the first fully gated page unreachable. Advance and
                // try the next one — bounded, so a wholly gated tail still
                // terminates instead of scrolling forever.
                _wfEmpties++;
                _wfState.page++;
                _wfAdvanceCursor(data.metadata.nextCursor);
                _skipToNext = true;
              } else {
                _wfState.exhausted = true;
                // Stopping because the bound ran out is not the same as
                // reaching the end. Say so, offer the retry, and keep it out
                // of the cache so a rebuild is not born dead.
                if (data && data.metadata && data.metadata.hasMore) {
                  _softStop = true;
                  // Consume this page like the skip branch does, or every
                  // "keep looking" click re-fetches the page already known
                  // to be entirely gated — the slowest request there is.
                  _wfState.page++;
                  _wfAdvanceCursor(data.metadata.nextCursor);
                  wfStatus.textContent =
                    "Only login-required workflows on this stretch — click to keep looking.";
                  wfStatus.style.display = "block";
                } else if (_wfState.results.length === 0) {
                  wfStatus.textContent = "No workflows found.";
                  wfStatus.style.display = "block";
                } else {
                  const endMsg = document.createElement("div");
                  endMsg.style.cssText = "color:#24303f;font-size:9px;text-align:center;padding:8px;";
                  endMsg.textContent = "\u2014 end of results \u2014";
                  wfList.appendChild(endMsg);
                }
              }
            } else {
              const _landed = _wfLandItems(data.items);
              _wfFails = 0;
              _wfState.page++;
              _wfAdvanceCursor(data.metadata?.nextCursor);
              if (!data.metadata?.hasMore) _wfState.exhausted = true;
              // Nothing rendered from a page that HAD items — every one of
              // them failed to build a card. Nothing was inserted before the
              // sentinel, so the observer's intersection state never changes
              // and it will not fire again; without this the pane stopped
              // mid-catalogue with no cards, no message and no control. The
              // booru engine has had this branch all along.
              // No Array.isArray here: _wfLandItems returns 0 for a
              // non-array outright, so gating on it excluded the one shape
              // where landing is GUARANTEED to fail — an upstream or proxy
              // that answers `items` as a string passed the emptiness guard
              // above, landed nothing, and fell to the else, leaving the pane
              // blank and inert with the observer unable to fire again.
              if (_landed === 0 && data.items && data.items.length) {
                _wfEmpties++;
                if (_wfEmpties < 5 && !_wfState.exhausted) {
                  _skipToNext = true;
                } else {
                  _softStop = true;
                  _wfState.exhausted = true;
                  wfStatus.textContent = _wfState.results.length
                    ? "No more usable results — click to try again."
                    : "Nothing usable came back — click to try again.";
                  wfStatus.style.display = "block";
                }
              } else {
                _wfEmpties = 0;
              }
            }
          } catch(e) {
            if (gen !== _epeWfGen) return;
            // Stop the scroll observer re-firing against a failing endpoint,
            // but not on the first blip — and never write that into the cache,
            // or the pane stays dead across node rebuilds.
            _failed = true;
            _wfFails++;
            if (_wfFails >= 2) _wfState.exhausted = true;
            wfStatus.textContent = "Search error: " + (e.message || e)
              + (_wfFails < 2 ? " — click to retry" : "");
            wfStatus.style.display = "block";
          } finally {
            _wfInFlight = Math.max(0, _wfInFlight - 1);
            if (_wfInFlight === 0) wfSpinner.style.display = "none";
            // Release `loading` only if this is still the latest load for
            // this panel. Guarding it by GENERATION stranded a panel whose
            // run another panel superseded; not guarding it at all let a
            // superseded run free a flag the live one owned, and the
            // observer then fetched the same cursor twice.
            if (myRun === _wfRun) _wfState.loading = false;
            // The cache: only the current search, from the panel that owns it.
            if (gen === _epeWfGen && _wfEpoch === _epeWfOwner) {
            // Survives the node rebuild that a workflow tab switch causes.
            // Capped: the restore block repaints every cached card and each one
            // pulls a cover image, so an unbounded cache turns a tab switch into
            // hundreds of DOM builds and image requests.
            _epeWfPersist.results   = _wfState.results.slice(-150);
            _epeWfPersist.cursor    = _wfState.cursor;
            // Browse pages by NUMBER, and the restore used to rebuild that
            // from the card count — which under-counts as soon as the server
            // has dropped login-gated results, so it re-served pages the
            // user had already scrolled past.
            _epeWfPersist.page      = _wfState.page;
            // Never cache a failure. Round 3 said it did not and then wrote
            // it here anyway, so two bad rounds left the pane dead for the
            // rest of the session, across every rebuild, even once the
            // endpoint recovered.
            _epeWfPersist.exhausted = _wfState.exhausted && !_failed && !_softStop;
            }
          }
          // Outside the finally, so `loading` has already been released:
          // the page just consumed was entirely gated, so go get the next.
          if (_skipToNext && gen === _epeWfGen && _wfEpoch === _epeWfOwner)
            return _wfLoadMore();
        };

        const _wfDoSearch = () => {
          const q = wfSearchInput.value.trim();
          _epeWfGen++;                  // invalidate anything still in flight
          // The write-back further down is guarded by `_wfEpoch ===
          // _epeWfOwner`; this clear was not. So a non-owner node wiped the
          // OWNER's cache, seeded it with its own query, and then refused to
          // fill it — and the owner's next rebuild saw a non-empty query with
          // empty results and re-ran a search the user never typed there,
          // throwing away everything they had scrolled through. Searching
          // here is a claim on the pane, so take ownership rather than
          // skipping the clear. (_wfEpoch is a `let` for this reason — see
          // its declaration.)
          _wfEpoch = ++_epeWfOwner;
          _epeWfPersist.query = q;
          _epeWfPersist.results = []; _epeWfPersist.cursor = "";
          _epeWfPersist.page = 1; _epeWfPersist.exhausted = false;
          _wfFails = 0;
          _wfEmpties = 0;
          _wfState.query = q; _wfState.page = 1; _wfState.cursor = "";
          _wfState.loading = false; _wfState.exhausted = false; _wfState.results = [];
          // innerHTML="" detaches wfStatus too, and it is never re-added —
          // every status message after the first search went to a node that
          // was no longer in the document.
          wfList.innerHTML = ""; wfList.appendChild(wfSentinel); wfList.appendChild(wfStatus);
          wfStatus.style.display = "none";
          // An empty box browses. It used to print "Enter a search term
          // above." and return — and the observer, seeing the sentinel back
          // at the top of an emptied list, immediately browsed anyway, so
          // the results and the message contradicted each other.
          _wfLoadMore();
        };
        wfSearchBtn.onclick  = _wfDoSearch;
        wfSearchInput.onkeydown = (ev) => { if (ev.key === "Enter") _wfDoSearch(); };

        // Restore after a node rebuild (switching ComfyUI workflow tabs, which
        // is exactly what loading a workflow does). Repaint the cards we already
        // have rather than re-running the search — a refetch drops everything
        // scrolled past and leaves the pane blank while it waits on Civitai.
        // Not `if (query)`: an empty box BROWSES, and a browse fills this
        // cache like any search. Gating on the query meant every browse page
        // was cached and none of them could ever be read back.
        if (_epeWfPersist.query || _epeWfPersist.results.length) {
          wfSearchInput.value = _epeWfPersist.query;
          if (_epeWfPersist.results.length) {
            _wfState.query     = _epeWfPersist.query;
            // Filled from what actually RENDERS, below — an entry whose card
            // throws is not a result. Copying the cache wholesale let
            // _wfState.results exceed the visible cards, so WF_MAX_RESULTS
            // counted phantoms and the next write put them back in the cache.
            _wfState.results   = [];
            _wfState.cursor    = _epeWfPersist.cursor;
            _wfState.exhausted = _epeWfPersist.exhausted;
            // From the CACHE's length, not the state's: the state is filled
            // below now, so reading it here would always see zero.
            _wfState.page      = _epeWfPersist.page
                              || (1 + Math.ceil(_epeWfPersist.results.length / 20));
            wfStatus.style.display = "none";
            // The cache is a stranger's data too once a workflow file has
            // been round-tripped through it, and _mkWfCard reads .coverUrl
            // straight off each entry.
            _epeWfPersist.results.forEach(item => {
              if (!item || typeof item !== "object") return;
              let card = null;
              try { card = _mkWfCard(item); } catch (_e) { card = null; }
              if (card) { wfList.insertBefore(card, wfSentinel); _wfState.results.push(item); }
            });
          } else {
            requestAnimationFrame(() => _wfDoSearch());
          }
        }

        // A failure that leaves the list empty inserts nothing before the
        // sentinel, so its intersection state never changes and the observer
        // below never fires again — "scroll to retry" was advice the user
        // could not follow. Make the message itself the control.
        wfStatus.style.cursor = "pointer";
        wfStatus.title = "Click to try again";
        wfStatus.onclick = () => {
          // No query guard: the pane BROWSES with an empty query, which is
          // exactly the state that produces an empty list with a message on
          // it — so guarding on "has a query or has cards" disabled the
          // control in the only case it was added for.
          if (_wfState.loading) return;
          _wfState.exhausted = false;
          _wfEmpties = 0;
          _wfFails = 0;
          wfStatus.style.display = "none";
          _wfLoadMore();
        };

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
          dBadge.textContent = "CIVITAI";
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
          dDescLabel.style.cssText = "font-size:9px;color:#31415a;font-weight:600;text-transform:uppercase;letter-spacing:.4px;flex-shrink:0;";
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
          // Civitai needs downloadUrl, versionId, or at minimum item.id (the backend will resolve)
          const _canFetchWf = !!(item.downloadUrl || item.versionId || item.id);

          if (_canFetchWf) {
            const dInfoStatus = document.createElement("div");
            dInfoStatus.style.cssText = "font-size:9px;color:#31415a;font-style:italic;";
            dInfoStatus.textContent = "Fetching workflow info…";
            dInfoSection.appendChild(dInfoStatus);

            const _wfDetailAc = _wfProbeStart();
            api.fetchApi("/epe/prompts/workflow-detail", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                id:          item.id,
                source:      item.source,
                downloadUrl: item.downloadUrl || "",
                versionId:   item.versionId   || "",
              }),
              signal: _wfDetailAc ? _wfDetailAc.signal : undefined,
            }).then(r => { return r.json().then(data => ({ status: r.status, data })); })
            .then(({ status, data }) => {
              // Bail if the fetch was aborted during dispose — otherwise
              // this handler pins the detached editor DOM by mutating it.
              if (_wfDetailAc && _wfDetailAc.signal.aborted) return;
              dInfoSection.innerHTML = "";
              if (data.error) {
                // Even on error, populate description if the backend returned one
                if (data.description && wfTA.value === "No description available.") {
                  wfTA.value = data.description;
                }
                const errEl = document.createElement("div");
                errEl.style.cssText = "font-size:9px;font-style:italic;" + (status === 403 ? "color:#a07830;" : "color:#744;");
                // `data.error` was read for truthiness and then thrown
                // away, so every non-403 showed the same eight words. The
                // server now refuses an over-size archive rather than quietly
                // handing back a different workflow from inside it — and that
                // refusal is only useful if its reason is visible.
                // typeof-checked before .trim(): `error` is whatever the
                // server sent, and a proxy that answers `{"error": 500}` would
                // throw inside the very branch that exists to report a
                // failure.
                const _why = (typeof data.error === "string" && data.error.trim())
                  ? data.error.trim().slice(0, 200) : "";
                errEl.textContent = status === 403
                  ? "⚠ Login required on Civitai to download this workflow."
                  : (_why ? "Could not load workflow info — " + _why
                          : "Could not load workflow info.");
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
              // Same abort-check as .then above — an abort rejects the
              // chain, and we must NOT touch the detached DOM after that.
              if (_wfDetailAc && _wfDetailAc.signal.aborted) return;
              dInfoSection.innerHTML = "";
              const errEl = document.createElement("div");
              errEl.style.cssText = "font-size:9px;color:#744;font-style:italic;";
              errEl.textContent = "Could not load workflow info.";
              dInfoSection.appendChild(errEl);
            }).finally(() => { _wfProbeDone(_wfDetailAc); });
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
              // Same abort wiring as the fetch branch below. `_epeOpenTemplate`
              // itself self-protects against destroying the user's graph, but
              // the post-await setTimeouts would still mutate a detached
              // dLoadBtn if dispose fired mid-load.
              const _ac0 = _wfProbeStart();
              try {
                await _epeOpenTemplate(dLoadBtn._cachedWorkflow);
                if (_ac0 && _ac0.signal.aborted) return;
                dLoadBtn.textContent = "Loaded \u2713";
                setTimeout(() => { if (_ac0 && _ac0.signal.aborted) return;
                  dLoadBtn.textContent = "Load Workflow"; dLoadBtn.disabled = false; }, 2000);
              } catch(e) {
                if (_ac0 && _ac0.signal.aborted) return;
                dLoadBtn.textContent = "Error: " + (e.message || "failed");
                dLoadBtn.style.color = "#c66";
                dLoadBtn.disabled = false;
                setTimeout(() => { if (_ac0 && _ac0.signal.aborted) return;
                  dLoadBtn.textContent = "Load Workflow"; dLoadBtn.style.color = "rgba(109,184,232,0.85)"; }, 3000);
              } finally {
                _wfProbeDone(_ac0);
              }
            } else {
              // Workflow not yet cached — fetch now
              dLoadBtn.textContent = "Fetching\u2026";
              dLoadBtn.disabled = true;
              const _ac2 = _wfProbeStart();
              try {
                const resp = await api.fetchApi("/epe/prompts/workflow-detail", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    id:          item.id,
                    source:      item.source,
                    downloadUrl: item.downloadUrl || "",
                    versionId:   item.versionId   || "",
                  }),
                  signal: _ac2 ? _ac2.signal : undefined,
                });
                const data = await resp.json();
                if (_ac2 && _ac2.signal.aborted) return;
                if (resp.status === 403) throw new Error("\u26a0 Login required on Civitai to download this workflow");
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                if (data.error) throw new Error(data.error);
                if (!data.workflow) throw new Error("No workflow returned");
                dLoadBtn.textContent = "Loading\u2026";
                await _epeOpenTemplate(data.workflow);
                if (_ac2 && _ac2.signal.aborted) return;
                dLoadBtn.textContent = "Loaded \u2713";
                setTimeout(() => { if (_ac2 && _ac2.signal.aborted) return;
                  dLoadBtn.textContent = "Load Workflow"; dLoadBtn.disabled = false; }, 2000);
              } catch(e) {
                if (_ac2 && _ac2.signal.aborted) return;
                dLoadBtn.textContent = "Error: " + (e.message || "failed");
                dLoadBtn.style.color = "#c66";
                dLoadBtn.disabled = false;
                setTimeout(() => { if (_ac2 && _ac2.signal.aborted) return;
                  dLoadBtn.textContent = "Load Workflow"; dLoadBtn.style.color = "rgba(109,184,232,0.85)"; }, 3000);
              } finally {
                _wfProbeDone(_ac2);
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
            "color:"+(col||"#6a7a8d")+";font-size:11px;padding:3px 7px;cursor:pointer;font-family:inherit;" +
            "display:inline-flex;align-items:center;justify-content:center;line-height:1;min-height:20px;" +
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
          // Loading a saved prompt replaces the text wholesale, so the direction
          // that shaped the previous prompt no longer describes what's here.
          _ieThreadClear();
          // Every other wholesale replacement pushes first — Use Prompt from a
          // PNG extract, Civitai Use, Genur Use, Clear, Load from file, and
          // both review commits. This one did not, so on a freshly-loaded
          // workflow (empty undo stack) the user's prompt went with no way
          // back: Ctrl+Z did nothing, and the dispatch below had already
          // written the new text into epe_prompt AND the tab slot.
          if (textEl._epePushUndo) textEl._epePushUndo();
          textEl.value=item.text; updateTokenBadge(item.text);
          // updateTokenBadge writes epe_prompt, but ONLY the input listener
          // runs _epeTabSync — and a rebuild reads the TAB slot first, so
          // without this the loaded prompt was silently replaced by the one
          // it had just overwritten. Same fix as Clear Prompt.
          textEl.dispatchEvent(new Event("input"));
          textEl.focus();
        };
        const _insertItem = (item) => {
          // same guard — inserting into a hidden/streaming editor
          // would be confusing. Discard first, then insert into restored text.
          if (_reviewMode) _autoDiscardReview("Snippet insert — result discarded");
          // Same as _useItem, and worse: this splices out [selectionStart,
          // selectionEnd). The selection survives the click on the rail, so a
          // user who had a paragraph selected lost it — silently, and with
          // nothing on the undo stack to get it back.
          if (textEl._epePushUndo) textEl._epePushUndo();
          const s=textEl.selectionStart, e2=textEl.selectionEnd;
          const before=textEl.value.slice(0,s), after=textEl.value.slice(e2);
          const sep=(before.length>0 && !/,\s*$/.test(before)) ? ", " : "";
          textEl.value=before+sep+item.text+after;
          const pos=s+sep.length+item.text.length;
          textEl.setSelectionRange(pos,pos);
          updateTokenBadge(textEl.value);
          textEl.dispatchEvent(new Event("input"));   // see _useItem above
          textEl.focus();
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

          // Name row — chevron matches every other collapsible in the node:
          // sideways when closed, down when open. Clicking it toggles the card.
          const nameRow=document.createElement("div");
          nameRow.style.cssText="display:flex;align-items:center;gap:7px;margin-bottom:2px;cursor:pointer;user-select:none;";
          const nameChev=_mkChevron();
          const nameEl=document.createElement("div");
          nameEl.style.cssText =
            "font-size:11px;font-weight:600;color:#9aaaba;flex:1;" +
            "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
          nameEl.textContent=item.name; nameEl.title=item.name;
          nameRow.appendChild(nameChev); nameRow.appendChild(nameEl);

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

          // Declared here, before _collapseTA/_expandTA close over it — those
          // run during the initial render, so a `const` further down puts this
          // in the temporal dead zone and the whole extension fails to load.
          const cardBodyWrap = document.createElement("div");
          cardBodyWrap.style.cssText = "display:none;";

          // Track open card across all cards in this render
          if(!rpList._openTA) rpList._openTA=null;

          // Commit an edit without the user having to press Save. Called on every
          // close path — chevron, outside click, another card opening, or focus
          // moving to the Instruct box — so switching away never loses work.
          // Declared before _collapseTA because that closes over it.
          // Returns:
          //   "noop"   — nothing to save (unchanged, empty, or item gone)
          //   "saved"  — write succeeded
          //   "failed" — write refused (quota, private mode); toast fired
          // Callers that ONLY care about save failure (like _collapseTA)
          // key off "failed" to keep the textarea open so the user can
          // retry rather than losing the edit to a silent auto-commit.
          const _commitEdit=()=>{
            const newText=editTA.value.trim();
            if(!newText || newText===(item.text||"").trim()) return "noop";
            const arr=_libLoad(tabId);
            const idx=arr.findIndex(x=>x.id===item.id);
            if(idx<0) return "noop";                 // entry deleted elsewhere
            // Stage into the array, but do NOT touch item.text before the
            // write is confirmed. On a quota refusal (localStorage full,
            // private-mode block) _libSaveItems returns false and the item
            // is discarded — otherwise item.text=newText locks the guard
            // above out on every later attempt and the edit can never be
            // retried, even after the user frees space.
            arr[idx].text=newText;
            if(!_libSaveItems(tabId,arr)) return "failed";
            item.text=newText;
            return "saved";
          };
          const _collapseTA=()=>{
            if (_commitEdit() === "failed") {
              // Save refused. Do NOT collapse — the user's edit stays
              // visible so they can retry or copy it out. _libSaveItems
              // already toasted "Could not save — browser storage is full
              // or blocked."; the textarea staying open is what prevents
              // the auto-commit silent-loss path.
              return;
            }
            editTA.style.cssText=_taCollapsedCSS;
            editTA.readOnly=true;
            cardBodyWrap.style.display="none";
            _setChevron(nameChev,false);
            if(rpList._openTA===editTA) rpList._openTA=null;
            try { document.removeEventListener("mousedown",_outsideHandler,true); } catch(_e){}
          };
          const _expandTA=()=>{
            // Close any other open card first
            if(rpList._openTA && rpList._openTA!==editTA){
              // Refuse to open a second card if the current one's edit was
              // refused by storage (quota / private mode). Same rationale
              // as _collapseTA's own "failed" gate — otherwise the user
              // clicks the next card, the first one collapses silently and
              // their unsaved edit vanishes behind the toast.
              if(rpList._openTA._epeCommit && rpList._openTA._epeCommit() === "failed") {
                editTA.focus();   // keep the caller's cursor sane
                return;
              }
              rpList._openTA.style.cssText=_taCollapsedCSS;
              rpList._openTA.readOnly=true;
              if(rpList._openTA._epeBody) rpList._openTA._epeBody.style.display="none";
              if(rpList._openTA._epeChev) _setChevron(rpList._openTA._epeChev,false);
              // This path closes the other card by hand instead of calling
              // its _collapseTA, so its document mousedown listener was left
              // attached. They piled up one per expand, and the next click
              // outside ran every stale one — each calling _commitEdit on a
              // card the user had moved on from, writing text back to the
              // library that they thought was no longer in play.
              if(rpList._openTA._epeReleaseOutside) rpList._openTA._epeReleaseOutside();
            }
            cardBodyWrap.style.display="";
            editTA.style.cssText=_taExpandedCSS;
            editTA.readOnly=false;
            _setChevron(nameChev,true);
            editTA.focus();
            rpList._openTA=editTA;
            // Listen for outside clicks only while expanded; _collapseTA removes it.
            document.addEventListener("mousedown",_outsideHandler,true);
          };
          editTA._epeChev=nameChev;
          editTA._epeBody=cardBodyWrap;
          editTA._epeCommit=_commitEdit;
          // _outsideHandler is a per-card closure, so nothing outside _mkCard
          // can remove it. Expose a release that ONLY detaches the listener —
          // no _commitEdit, no style changes — for the two callers that need
          // to drop a card's listener without running a full collapse:
          // _expandTA taking over from another card, and _epeDispose.
          editTA._epeReleaseOutside=()=>{
            try { document.removeEventListener("mousedown",_outsideHandler,true); } catch(_e){}
          };
          nameRow.onclick=(ev)=>{
            ev.stopPropagation();
            if(editTA.readOnly) _expandTA(); else _collapseTA();
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
            // Three outcomes:
            //   idx < 0            → the entry was deleted between click
            //                        and handler; not a storage problem.
            //   save returns false → quota / private mode; toast fires.
            //   save returns true  → success.
            // Distinguishing them stops the "Save failed" label from
            // misinforming users whose only real problem is a stale card.
            let _label = "Saved!", _hold = 1200;
            if (idx < 0) { _label = "Entry gone"; _hold = 1800; }
            else {
              arr[idx].text=newText;
              if(_libSaveItems(tabId,arr)) { item.text=newText; }
              else { _label = "Save failed"; _hold = 1800; }
            }
            saveBtn.textContent = _label;
            setTimeout(()=>saveBtn.textContent="Save", _hold);
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

          const toEnhBtn=_mkBtn("Enhance","Run AI enhance on this prompt","rgba(100,160,255,0.7)");
          toEnhBtn.onclick=(ev)=>{
            ev.stopPropagation();
            runAiAction("expand", { sourceText: editTA.value.trim() || item.text });
          };

          saveRow.appendChild(saveBtn);
          saveRow.appendChild(saveNewBtn);
          saveRow.appendChild(toSnipBtn);
          saveRow.appendChild(toEnhBtn);

          // Bottom action row: Variations | Use  Rename  ✕ — always visible
          const acts=document.createElement("div");
          acts.style.cssText="display:flex;align-items:center;margin-top:5px;gap:4px;flex-wrap:wrap;";

          if(tabId==="favorites"){
            const favVarBtn=_mkBtn("Variations","Run AI variations on this prompt","rgba(140,200,240,0.7)");
            favVarBtn.onclick=(ev)=>{
              ev.stopPropagation();
              runAiAction("variations", { sourceText: editTA.value.trim() || item.text });
            };
            const favUseBtn=_mkBtn("Use","Replace editor text with this prompt","rgba(109,184,232,0.7)");
            favUseBtn.onclick=(ev)=>{ev.stopPropagation();_useItem(item);};
            const favRenBtn=_mkBtn("Rename","Rename this entry");
            favRenBtn.onclick=(ev)=>{ev.stopPropagation();_renameItem(item,"favorites");};
            const favDelBtn=_mkBtn("\u2715","Delete this entry","#664");
            favDelBtn.onclick=(ev)=>{ev.stopPropagation();_deleteItem(item,"favorites");};
            acts.appendChild(favVarBtn); acts.appendChild(favUseBtn); acts.appendChild(favRenBtn); acts.appendChild(favDelBtn); acts.appendChild(charSpan);
          } else {
            const snpVarBtn=_mkBtn("Variations","Run AI variations on this prompt","rgba(140,200,240,0.7)");
            snpVarBtn.onclick=(ev)=>{
              ev.stopPropagation();
              runAiAction("variations", { sourceText: editTA.value.trim() || item.text });
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

          // Everything below the title row goes in the wrapper hoisted above, so
          // a collapsed card shows only chevron + name + token count — the same
          // shape as an Instruct Edit saved sequence card.
          cardBodyWrap.appendChild(dateEl);
          cardBodyWrap.appendChild(_mkFontSizerWrap(editTA, 10));
          cardBodyWrap.appendChild(saveRow);
          cardBodyWrap.appendChild(acts);
          // Token count sits on the title row and stays visible when collapsed.
          const nameTokens = document.createElement("span");
          nameTokens.style.cssText =
            "font-size:9px;color:#4e5c6e;flex-shrink:0;margin-left:6px;";
          const _syncNameTokens = () => {
            try { nameTokens.textContent = countTokens(editTA.value) + " tokens"; }
            catch (_e) { nameTokens.textContent = ""; }
          };
          _syncNameTokens();
          editTA.addEventListener("input", _syncNameTokens);
          nameRow.appendChild(nameTokens);
          card.appendChild(nameRow);
          card.appendChild(cardBodyWrap);
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
            // Width is only meaningful when expanded — reading it while collapsed
            // would persist 0 and reopen to a zero-width panel.
            const _w = _libCollapsed ? undefined : (parseInt(rightPanel.style.width, 10) || undefined);
            // `epe_ui` comes out of the workflow FILE, and JSON.parse makes
            // "__proto__" an ordinary own property. Object.assign copies with
            // [[Set]], which runs Object.prototype's __proto__ SETTER — so a
            // downloaded workflow could hand the merged object an
            // attacker-chosen prototype, and every key on it would then read
            // back as though the user had set it (driven: `libraryCollapsed`
            // arriving from a prototype nobody wrote).
            //
            // Object.prototype itself is never touched — the damage is scoped
            // to this object — but "opening someone else's workflow is safe"
            // is a promise worth being able to make.
            //
            // Own enumerable keys only, __proto__ dropped, and copied with
            // defineProperty so no inherited setter can run during the copy.
            const _prevRaw = (_epeOwnerNode.properties || {}).epe_ui || {};
            const _prev = {};
            try {
              for (const _k of Object.keys(_prevRaw)) {
                if (_k === "__proto__") continue;
                Object.defineProperty(_prev, _k, {
                  value: _prevRaw[_k], writable: true,
                  enumerable: true, configurable: true,
                });
              }
            } catch (_e) {}
            // Same rule for the rail and the tuning block: only record a size
            // while the panel is open, or a collapsed session would persist 0
            // and reopen to nothing.
            const _rw = _railCollapsed ? undefined : (_railW || undefined);
            const _th = !_styleOpen ? undefined : (_tuneH || undefined);
            // Object.assign MERGES onto _prev — a workflow saved by a NEWER
            // build carries keys this build does not know, and rebuilding
            // from a fixed literal would drop them the first time a panel
            // is dragged. Keeps forward compatibility for schema additions
            // without needing this file to enumerate every future key.
            _epeOwnerNode.properties.epe_ui = Object.assign({}, _prev, {
              tab: _rpActive,
              styleOpen: _styleOpen,
              libraryWidth: _w || _prev.libraryWidth || undefined,
              libraryCollapsed: _libCollapsed || undefined,
              railWidth: _rw || _prev.railWidth || undefined,
              railCollapsed: _railCollapsed || undefined,
              tuneHeight: _th || _prev.tuneHeight || undefined,
            });
          } catch (_e) {}
        };

        const _setRpTab = (id, opts) => {
          // This used to discard an active review, on the reasoning that
          // switching library tabs "implicitly abandons the result". It does
          // not: this is the right-hand rail, and it cannot reach the result at
          // all — the review strips, the prompt box and the variations cards
          // are all in the editor. Moving from Favorites to Civitai is neither
          // Use this nor Discard, so it no longer ends the review.
          //
          // (The keepReview opt is kept for callers that pass it: focusing the
          // ✎ box, the steps chip and the first-keystroke jump all call this to
          // bring the Instruct pane into view, and are not tab switches at all.)
          const _rpPrev = _rpActive;
          _rpActive=id;
          // The Load Workflow button is shared by every media tab. Leaving it
          // armed across a tab switch meant clicking it while browsing Genur
          // loaded a workflow for a Civitai image that was no longer on
          // screen. Any genuine move re-arms from the new tab's own detail.
          if (_rpPrev !== id) { try { _setGetWfBtn(false, null); } catch (_e) {} }
          if (!(opts && opts.silent)) _epePersistUi();
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
          // Opening a browse-capable source lands on its default feed. Only
          // auto-load the first time (empty results) so returning to the tab
          // keeps whatever the user was already looking at.
          if (id === "civitai" && !_civState.loading && _civState.results.length === 0) {
            requestAnimationFrame(() => _civDoSearch());
          } else if (id === "genur" && !_genurState.loading && _genurState.results.length === 0) {
            requestAnimationFrame(() => _genurDoSearch());
          }
        };
        Object.values(rpTabEls).forEach(t => { t.onclick=()=>_setRpTab(t._id); });

        // ── Render body ──────────────────────────────────────────────────
        const _renderRpBody = () => {
          // Leaving Favorites/Snippets rebuilds the list from storage, so commit
          // any card still open before it is thrown away. If that commit was
          // refused by storage, log it — the tab switch will still throw away
          // the DOM (the rebuild is unavoidable, the switch already happened)
          // but at least a diagnostic is emitted rather than the failure
          // vanishing entirely. The saved-warning toast from _libSaveItems is
          // the user-facing signal.
          try {
            if (rpList && rpList._openTA && rpList._openTA._epeCommit) {
              const _r = rpList._openTA._epeCommit();
              if (_r === "failed") {
                try { console.warn("[EPE] auto-commit on tab switch was refused by storage"); } catch (_e2) {}
              }
            }
          } catch (_e) {}
          // …and RELEASE it. _outsideHandler is a per-card closure, so nothing
          // outside _mkCard can remove it; the release exists for exactly this
          // and only _expandTA and _epeDispose were given it. Left attached,
          // it held the detached card and textarea, and rpList._openTA still
          // pointed at the detached textarea — so the next expand ran
          // _epeCommit() on the discarded card and wrote its text back into
          // the library.
          try { if (rpList && rpList._openTA && rpList._openTA._epeReleaseOutside) rpList._openTA._epeReleaseOutside(); } catch (_e) {}
          try { if (rpList) rpList._openTA = null; } catch (_e) {}
          rpBody.innerHTML="";
          if(_rpActive==="civitai"){   rpBody.appendChild(rpCivPanel);      return; }
          if(_rpActive==="genur"){     rpBody.appendChild(rpGenurPanel);    return; }
          if(_rpActive==="workflows"){ rpBody.appendChild(rpWorkflowPanel); return; }
          if(_rpActive==="instruct"){
            rpBody.appendChild(rpInstructPanel);
            _ieShowPane(_iePane);
            return;
          }
          rpBody.appendChild(rpSearchWrap);
          rpBody.appendChild(rpList);
          rpList.innerHTML="";
          const q=rpSearch.value.trim().toLowerCase();
          const all=_libLoad(_rpActive);
          const filtered = q
            // String(): _libLoad guarantees the entries are OBJECTS, not that
            // they carry a string `name` and `text`. One entry from an older
            // build, hand-edited, or truncated by a full storage quota threw
            // on every keystroke and left the pane blank. The node picker's
            // search has used this idiom since the title-is-a-number bug.
            ? all.filter(x => String(x.name || "").toLowerCase().includes(q) ||
                              String(x.text || "").toLowerCase().includes(q))
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
          // keepReview: revealing the tab we just saved to is not the user
          // abandoning their result. Without it, _setRpTab counted this as a
          // tab switch and ran _autoDiscardReview — so "Save > Snippets" on a
          // review put the text in the library and then wiped it from the
          // editor a moment later, and from a variation card it took all three
          // cards with it. Every other reveal caller (the pen box, the steps
          // chip, the first-keystroke jump) already passes this.
          _setRpTab(tabId, { keepReview: true });
        };

        // ══════════════════════════════════════════════════════════════════
        // INSTRUCT EDIT PANEL — Live thread + Saved sequences
        // ══════════════════════════════════════════════════════════════════
        const rpInstructPanel = document.createElement("div");
        rpInstructPanel.style.cssText = "flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;";

        // Live / Saved sub-toggle
        const ieSubBar = document.createElement("div");
        ieSubBar.style.cssText = "display:flex;gap:5px;padding:0 8px 5px;flex-shrink:0;";
        let _iePane = "live";
        const _mkIeSub = (label, id) => {
          const b = document.createElement("button");
          b.textContent = label;
          const paint = () => {
            b.style.cssText =
              "font-size:10px;padding:4px 13px;border-radius:4px;cursor:pointer;font-family:inherit;" +
              "display:flex;align-items:center;justify-content:center;line-height:1;min-height:22px;" +
              "transition:color .12s,background .12s,border-color .12s;" +
              (_iePane === id
                ? "background:#202a38;border:1px solid #4e5c6e;color:#c2e2f8;"
                : "background:#12171f;border:1px solid #1c2431;color:#6a7a8d;");
          };
          paint(); b._paint = paint;
          b.onclick = () => _ieShowPane(id);
          return b;
        };
        const ieSubLive  = _mkIeSub("Live", "live");
        const ieSubSaved = _mkIeSub("Saved", "saved");
        ieSubBar.appendChild(ieSubLive); ieSubBar.appendChild(ieSubSaved);

        const ieBody = document.createElement("div");
        ieBody.style.cssText = "flex:1;overflow-y:auto;padding:0 8px 10px;min-height:0;";

        const _mkIeCallout = (txt) => {
          const c = document.createElement("div");
          c.style.cssText =
            "display:flex;gap:5px;padding:5px 7px;background:rgba(100,160,255,0.07);" +
            "border:1px solid rgba(100,160,255,0.15);border-radius:3px;margin-bottom:8px;";
          const s = document.createElement("span");
          s.textContent = txt;
          s.style.cssText = "font-size:9px;color:rgba(100,160,255,0.7);line-height:1.5;";
          c.appendChild(s); return c;
        };

        // ── Live view ──────────────────────────────────────────────────
        const ieLiveView = document.createElement("div");
        ieLiveView.appendChild(_mkIeCallout(
          "Your direction for this prompt. The last few steps are sent as context, so “dial that back” knows what you meant."));

        const ieThreadHead = document.createElement("div");
        ieThreadHead.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px;";
        const ieThreadTitle = document.createElement("span");
        ieThreadTitle.textContent = "This prompt's direction";
        ieThreadTitle.style.cssText = "font-size:10px;color:#8ba5be;font-weight:500;";
        const ieThreadCount = document.createElement("span");
        ieThreadCount.style.cssText = "font-size:9px;color:#5d6f85;margin-left:auto;";
        const ieThreadClearBtn = document.createElement("span");
        ieThreadClearBtn.textContent = "✕";
        ieThreadClearBtn.title = "Clear this thread";
        ieThreadClearBtn.style.cssText = "font-size:11px;color:#4e5c6e;cursor:pointer;padding:0 3px;";
        ieThreadClearBtn.onmouseenter = () => { ieThreadClearBtn.style.color = "#e08a8a"; };
        ieThreadClearBtn.onmouseleave = () => { ieThreadClearBtn.style.color = "#4e5c6e"; };
        ieThreadClearBtn.onclick = () => { if (_ieThreadGet().length) _ieThreadClear(); };
        ieThreadHead.appendChild(ieThreadTitle);
        ieThreadHead.appendChild(ieThreadCount);
        ieThreadHead.appendChild(ieThreadClearBtn);
        ieLiveView.appendChild(ieThreadHead);

        const ieStepsBox = document.createElement("div");
        ieLiveView.appendChild(ieStepsBox);

        const ieSaveSeqWrap = document.createElement("div");
        ieSaveSeqWrap.style.cssText = "margin-top:8px;";
        const ieSaveSeqBtn = document.createElement("button");
        ieSaveSeqBtn.textContent = "☆ Save sequence";
        ieSaveSeqBtn.title = "Save these steps as a reusable sequence";
        ieSaveSeqBtn.style.cssText =
          "width:100%;background:rgba(109,184,232,0.14);border:1px solid rgba(140,200,240,0.4);" +
          "border-radius:5px;color:#c2e2f8;font-size:10px;padding:7px;cursor:pointer;font-family:inherit;" +
          "display:flex;align-items:center;justify-content:center;line-height:1;";
        ieSaveSeqBtn.onmouseenter = () => { ieSaveSeqBtn.style.background = "rgba(109,184,232,0.24)"; };
        ieSaveSeqBtn.onmouseleave = () => { ieSaveSeqBtn.style.background = "rgba(109,184,232,0.14)"; };
        ieSaveSeqBtn.onclick = () => {
          const steps = _ieThreadGet();
          if (!steps.length) { _toast("Nothing to save — the thread is empty."); return; }
          const def = steps[0].slice(0, 40).replace(/\s+/g, " ").trim() + (steps.length > 1 ? "…" : "");
          const name = window.prompt("Save sequence as:", def);
          if (!name || !name.trim()) return;
          const all = _ieSeqLoad();
          all.push({ id: _libNewId(), name: name.trim(), steps: steps.slice(), date: new Date().toISOString() });
          _ieSeqSave(all);
          _ieShowPane("saved");
        };
        ieSaveSeqWrap.appendChild(ieSaveSeqBtn);
        ieLiveView.appendChild(ieSaveSeqWrap);

        // ── Saved view ─────────────────────────────────────────────────
        const ieSavedView = document.createElement("div");
        ieSavedView.style.display = "none";
        ieSavedView.appendChild(_mkIeCallout(
          "Saved sequences replay step by step against the current prompt, and land in the live thread."));
        const ieCardsBox = document.createElement("div");
        ieSavedView.appendChild(ieCardsBox);

        ieBody.appendChild(ieLiveView);
        ieBody.appendChild(ieSavedView);
        rpInstructPanel.appendChild(ieSubBar);
        rpInstructPanel.appendChild(ieBody);

        // ── Renderers ──────────────────────────────────────────────────
        // Highlight state during a sequence replay: index of the running step.
        let _ieRunningIdx = -1;

        const _ieRenderThreadList = () => {
          const steps = _ieThreadGet();
          ieStepsBox.innerHTML = "";
          ieThreadCount.textContent = steps.length + (steps.length === 1 ? " step" : " steps");
          if (!steps.length) {
            const e = document.createElement("div");
            e.style.cssText = "color:#3a4a5c;font-size:10px;text-align:center;padding:22px 10px;line-height:1.8;";
            e.innerHTML = "No direction yet.<br><span style=\"font-size:9px;color:#2b3949;\">Describe an edit above and it appears here.</span>";
            ieStepsBox.appendChild(e);
            return;
          }
          steps.forEach((txt, i) => {
            const row = document.createElement("div");
            const running = (i === _ieRunningIdx);
            const done    = (_ieRunningIdx >= 0 && i < _ieRunningIdx);
            const pending = (_ieRunningIdx >= 0 && i > _ieRunningIdx);
            row.style.cssText =
              "display:flex;gap:7px;align-items:flex-start;padding:7px 8px;margin-bottom:5px;border-radius:5px;" +
              "background:" + (running ? "rgba(109,184,232,0.08)" : "#0d1119") + ";" +
              "border:1px solid " + (running ? "rgba(140,200,240,0.55)" : "#1c2431") + ";" +
              (pending ? "opacity:0.45;" : "");
            const n = document.createElement("span");
            n.textContent = String(i + 1);
            n.style.cssText =
              "font-size:9px;border-radius:3px;padding:1px 5px;flex-shrink:0;margin-top:1px;" +
              (done ? "color:#8fe0cc;background:rgba(93,208,181,0.14);"
                    : "color:#6db8e8;background:rgba(109,184,232,0.14);");
            const tx = document.createElement("span");
            tx.textContent = txt;
            tx.style.cssText = "font-size:10.5px;color:#aab8c8;line-height:1.5;flex:1;word-break:break-word;";
            const del = document.createElement("span");
            del.textContent = "✕";
            del.title = "Remove this step";
            del.style.cssText = "font-size:10px;color:#5d6f85;cursor:pointer;flex-shrink:0;display:none;";
            del.onclick = () => { const a = _ieThreadGet().slice(); a.splice(i, 1); _ieThreadSet(a); };
            row.onmouseenter = () => { del.style.display = "block"; if (!running) row.style.borderColor = "#28364a"; };
            row.onmouseleave = () => { del.style.display = "none";  if (!running) row.style.borderColor = "#1c2431"; };
            row.appendChild(n); row.appendChild(tx); row.appendChild(del);
            ieStepsBox.appendChild(row);
          });
        };

        const _ieRenderSaved = () => {
          const all = _ieSeqLoad();
          ieCardsBox.innerHTML = "";
          if (!all.length) {
            const e = document.createElement("div");
            e.style.cssText = "color:#3a4a5c;font-size:10px;text-align:center;padding:24px 10px;line-height:1.8;";
            e.innerHTML = "No saved sequences yet.<br><span style=\"font-size:9px;color:#2b3949;\">Build a thread, then <em>Save sequence</em>.</span>";
            ieCardsBox.appendChild(e);
            return;
          }
          all.slice().reverse().forEach(seq => ieCardsBox.appendChild(_mkIeSeqCard(seq)));
        };

        const _mkIeSeqCard = (seq) => {
          const card = document.createElement("div");
          card.style.cssText =
            "background:#0d1119;border:1px solid #1c2431;border-radius:6px;margin-bottom:8px;overflow:hidden;";
          let open = false;

          const head = document.createElement("div");
          head.style.cssText = "display:flex;align-items:center;gap:7px;padding:7px 9px;cursor:pointer;user-select:none;";
          const chev = _mkChevron();
          const nm = document.createElement("span");
          nm.textContent = seq.name; nm.title = seq.name;
          nm.style.cssText =
            "font-size:10.5px;color:#c2cddb;font-weight:500;flex:1;overflow:hidden;" +
            "text-overflow:ellipsis;white-space:nowrap;";
          const sc = document.createElement("span");
          sc.style.cssText = "font-size:9px;color:#5d6f85;flex-shrink:0;";
          const _steps = () => ta.value.split("\n").map(x => x.trim()).filter(Boolean);
          head.appendChild(chev); head.appendChild(nm); head.appendChild(sc);

          const body = document.createElement("div");
          body.style.cssText = "padding:0 9px 9px;display:none;";
          const ta = document.createElement("textarea");
          ta.spellcheck = false;
          ta.value = (seq.steps || []).join("\n");
          ta.style.cssText =
            "width:100%;box-sizing:border-box;background:#121821;border:1px solid #24303f;border-radius:4px;" +
            "color:#aab8c8;font-size:10.5px;line-height:1.6;padding:7px 9px;resize:vertical;" +
            "font-family:inherit;outline:none;min-height:70px;";
          const _upCount = () => { const n2 = _steps().length; sc.textContent = n2 + (n2 === 1 ? " step" : " steps"); };
          ta.oninput = _upCount; _upCount();

          const acts = document.createElement("div");
          acts.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-top:7px;";
          const runBtn = _mkBtn("▶ Run on current prompt", "Replay these steps in order against the current prompt", "#c2e2f8");
          runBtn.style.borderColor = "rgba(140,200,240,0.5)";
          runBtn.style.background  = "rgba(109,184,232,0.16)";
          runBtn.onclick = (ev) => { ev.stopPropagation(); const s = _steps(); if (s.length) _ieRunSequence(s, seq.name); };
          const saveBtn = _mkBtn("Save", "Save edits to this sequence", "rgba(109,184,232,0.8)");
          saveBtn.onclick = (ev) => {
            ev.stopPropagation();
            const s = _steps(); if (!s.length) return;
            const arr = _ieSeqLoad(); const i = arr.findIndex(x => x.id === seq.id);
            if (i >= 0) { arr[i].steps = s; seq.steps = s; _ieSeqSave(arr); }
            saveBtn.textContent = "Saved!"; setTimeout(() => saveBtn.textContent = "Save", 1200);
          };
          const saveNewBtn = _mkBtn("Save as New", "Save these steps as a new sequence", "rgba(140,200,240,0.7)");
          saveNewBtn.onclick = (ev) => {
            ev.stopPropagation();
            const s = _steps(); if (!s.length) return;
            const name = window.prompt("Save sequence as:", seq.name + " copy");
            if (!name || !name.trim()) return;
            const arr = _ieSeqLoad();
            arr.push({ id: _libNewId(), name: name.trim(), steps: s, date: new Date().toISOString() });
            _ieSeqSave(arr); _ieRenderSaved();
          };
          const renBtn = _mkBtn("Rename", "Rename this sequence");
          renBtn.onclick = (ev) => {
            ev.stopPropagation();
            const name = window.prompt("Rename sequence:", seq.name);
            if (!name || !name.trim()) return;
            const arr = _ieSeqLoad(); const i = arr.findIndex(x => x.id === seq.id);
            if (i >= 0) { arr[i].name = name.trim(); _ieSeqSave(arr); _ieRenderSaved(); }
          };
          const delBtn = _mkBtn("✕", "Delete this sequence", "#664");
          delBtn.onclick = (ev) => {
            ev.stopPropagation();
            if (!window.confirm('Delete "' + seq.name + '"?')) return;
            _ieSeqSave(_ieSeqLoad().filter(x => x.id !== seq.id)); _ieRenderSaved();
          };
          [runBtn, saveBtn, saveNewBtn, renBtn, delBtn].forEach(b => acts.appendChild(b));
          body.appendChild(ta); body.appendChild(acts);

          head.onclick = () => {
            open = !open;
            body.style.display = open ? "block" : "none";
            _setChevron(chev, open);
            card.style.borderColor = open ? "#28364a" : "#1c2431";
          };
          card.appendChild(head); card.appendChild(body);
          return card;
        };

        function _ieShowPane(which) {
          _iePane = which;
          ieLiveView.style.display  = which === "live"  ? "" : "none";
          ieSavedView.style.display = which === "saved" ? "" : "none";
          ieSubLive._paint(); ieSubSaved._paint();
          if (which === "live") _ieRenderThreadList(); else _ieRenderSaved();
        }

        // Real implementation of the early no-op hook.
        _ieRefresh = () => { _ieRenderThreadList(); _ieUpdateChip(); };

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

        // ── Draggable divider — resize the Library column ────────────────
        const LIB_MIN_W = 220, LIB_MAX_W = 620, LIB_DEFAULT_W = 300;
        // Publishes the current column width on the root element for code in the
        // onNodeCreated scope. It no longer drives the node's minimum width —
        // that is fixed at the editor floor, because a minimum that moved with
        // this value snapped the node back out whenever the column reopened.
        // Kept as a read-only signal of the column's state.
        const _epeRootEl = () =>
          rightPanel.closest(".epe-panel") || rightPanel.parentElement;
        const _publishLibW = () => {
          try {
            const w = _libCollapsed ? 0 : (parseInt(rightPanel.style.width, 10) || LIB_DEFAULT_W);
            const root = _epeRootEl();
            if (root) root._epeLibW = w;
          } catch (_e) {}
        };
        // Same signal for the Transform rail, so the node's minimum width can
        // drop when the rail is collapsed instead of always reserving room.
        const _publishRailW = (w) => {
          try {
            const root = _epeRootEl();
            if (root) root._epeRailW = Math.max(0, w | 0);
          } catch (_e) {}
        };
        // Ask the node to widen if a just-expanded column left it under its
        // minimum. No-op while dragging — a drag is the user setting the size
        // directly and must not be fought.
        const _epeGrowToMin = () => {
          try {
            const root = _epeRootEl();
            if (root && typeof root._epeGrowToMin === "function") root._epeGrowToMin();
          } catch (_e) {}
        };
        let _libDragging = false, _libStartX = 0, _libStartW = LIB_DEFAULT_W;
        const libGrip = document.createElement("div");
        libGrip.title = "Drag to resize — double-click to reset";
        libGrip.style.cssText =
          "flex-shrink:0;width:5px;cursor:ew-resize;background:#1c2431;position:relative;" +
          "align-self:stretch;transition:background .12s;";
        libGrip.onmouseenter = () => { if (!_libDragging) libGrip.style.background = "#3a4a60"; };
        libGrip.onmouseleave = () => { if (!_libDragging) libGrip.style.background = "#1c2431"; };
        // Upper bound depends on the current node width so the editor is never
        // crushed below a usable minimum.
        const _libClampMax = () => {
          const total = bodyWrap.clientWidth || 0;
          const dynMax = total ? Math.max(LIB_MIN_W, total - 280) : LIB_MAX_W;
          return Math.min(LIB_MAX_W, dynMax);
        };
        const _libOnMove = (e) => {
          if (!_libDragging) return;
          const delta = _libStartX - e.clientX;          // drag left → wider panel
          // Floor is 0, not LIB_MIN_W: the drag runs smoothly all the way shut
          // and back out again, with no snap and no separate collapsed mode.
          const w = Math.max(0, Math.min(_libClampMax(), _libStartW + delta));
          _libSetCollapsed(w <= 0, w);
          e.preventDefault();
        };
        const _libOnUp = (e) => {
          if (!_libDragging) return;
          _libDragging = false;
          libGrip.style.background = "#1c2431";
          window.removeEventListener("pointermove", _libOnMove, true);
          window.removeEventListener("pointerup", _libOnUp, true);
          // pointercancel was not listened for at all, so a cancelled pointer
          // — a touch interrupted, the OS taking over the gesture, a context
          // menu — left _libDragging true (the column then followed an
          // unpressed mouse) and both window listeners alive for the life of
          // the page.
          window.removeEventListener("pointercancel", _libOnUp, true);
          try { libGrip.releasePointerCapture(e && e.pointerId); } catch (_e) {}
          _epePersistUi();
        };
        // The drag holds two window listeners. A node destroyed mid-drag never
        // reaches _libOnUp, so dispose ends it the same way a pointerup does.
        const _libEndDrag = () => { try { _libOnUp({}); } catch (_e) {} };
        _publishLibW();   // initial value for a fresh node with no saved UI state
        libGrip.addEventListener("pointerdown", (e) => {
          // No early-out when collapsed: dragging back out is how you reopen
          // without reaching for the tab.
          if (e.target === libHandle) return;
          _libDragging = true;
          _libStartX = e.clientX;
          _libStartW = _libCollapsed ? 0 : (parseInt(rightPanel.style.width, 10) || LIB_DEFAULT_W);
          libGrip.style.background = "#4e5c6e";
          try { libGrip.setPointerCapture(e.pointerId); } catch (_e) {}
          window.addEventListener("pointermove", _libOnMove, true);
          window.addEventListener("pointerup", _libOnUp, true);
          window.addEventListener("pointercancel", _libOnUp, true);
          // Keep the ComfyUI canvas from starting a node-drag on the grip.
          e.preventDefault(); e.stopPropagation();
        });
        libGrip.addEventListener("dblclick", (e) => {
          // Explicit width: this is the "reset the column" gesture, so unlike the
          // ensure-visible callers it does want to overwrite the current width.
          _libSetCollapsed(false, LIB_DEFAULT_W);
          _epePersistUi();
          e.preventDefault(); e.stopPropagation();
        });
        libGrip.addEventListener("mousedown", (e) => e.stopPropagation());

        // ── Collapse pull-tab ────────────────────────────────────────────
        // Hides the whole Library column so the editor gets the full width.
        // Its own pointer handlers stop the grip starting a resize drag (and
        // the ComfyUI canvas dragging the node) on the same press.
        rightPanel.style.transition = "width .16s ease";
        const libHandle = document.createElement("div");
        libHandle.textContent = "›";
        libHandle.style.cssText =
          "position:absolute;top:50%;left:-7px;transform:translateY(-50%);" +
          "width:16px;height:46px;border-radius:4px;background:#1b2430;border:1px solid #2b3a4e;" +
          "display:flex;align-items:center;justify-content:center;cursor:pointer;color:#7a8a9c;" +
          "font-size:12px;line-height:1;z-index:3;transition:color .12s,background .12s,border-color .12s;";
        libHandle.onmouseenter = () => {
          libHandle.style.background = "#26333f"; libHandle.style.color = "#c2e2f8";
          libHandle.style.borderColor = "#4e5c6e";
        };
        libHandle.onmouseleave = () => {
          libHandle.style.background = "#1b2430"; libHandle.style.color = "#7a8a9c";
          libHandle.style.borderColor = "#2b3a4e";
        };
        // Width the panel needs to show its controls without wrapping. Measured
        // so the tab reopens to something usable rather than to the last drag
        // width, which may have been a two-pixel sliver.
        // Deliberately NOT measured from content. The Library's scrollWidth is
        // whatever its image results happen to be, which is enormous and has
        // nothing to do with a sensible column width — measuring it made the
        // panel balloon every time something reopened it. The rail and the
        // tuning block do measure, because their content has a real intrinsic
        // size; this one has a designed width instead.
        const _libOpenW = () => {
          const props = (_epeOwnerNode && _epeOwnerNode.properties) || {};
          const saved = (typeof props.epe_ui === "object" && props.epe_ui && props.epe_ui.libraryWidth) || 0;
          const want = saved >= LIB_MIN_W ? saved : LIB_DEFAULT_W;
          return Math.max(LIB_MIN_W, Math.min(_libClampMax(), want));
        };
        // `w` is optional: mid-drag the caller passes the exact width so the edge
        // tracks the cursor. Without it (tab click, restore) we open at _libOpenW.
        const _libSetCollapsed = (v, w, silent) => {
          const wasCollapsed = _libCollapsed;
          _libCollapsed = !!v;
          if (_libCollapsed) {
            rightPanel.style.width = "0px";
            rightPanel.style.borderLeft = "none";
          } else if (typeof w === "number") {
            rightPanel.style.width = w + "px";
            rightPanel.style.borderLeft = "1px solid #1c2431";
          } else if (wasCollapsed) {
            // Only choose a width when actually reopening. Callers like the
            // Instruct Edit box call this to *ensure* the panel is visible; if
            // it already was, its current width is the user's and must not be
            // touched.
            rightPanel.style.width = _libOpenW() + "px";
            rightPanel.style.borderLeft = "1px solid #1c2431";
          } else {
            rightPanel.style.borderLeft = "1px solid #1c2431";
          }
          rightPanel.style.overflow = "hidden";
          libHandle.textContent = _libCollapsed ? "‹" : "›";
          libHandle.title = _libCollapsed ? "Show the Library panel" : "Collapse the Library panel";
          _publishLibW();
          // Mid-drag this runs on every pointermove; persisting there would write
          // node.properties dozens of times a second and mark the graph dirty on
          // each one. The pointerup handler persists once at the end instead.
          if (!_libDragging) { if (!silent) _epePersistUi(); if (!_libCollapsed) _epeGrowToMin(); }
        };
        libHandle.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
        libHandle.addEventListener("mousedown",   (e) => { e.stopPropagation(); });
        libHandle.addEventListener("dblclick",    (e) => { e.preventDefault(); e.stopPropagation(); });
        libHandle.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          _libSetCollapsed(!_libCollapsed);
        });
        libGrip.appendChild(libHandle);
        libHandle.title = "Collapse the Library panel";

        bodyWrap.appendChild(libGrip);
        bodyWrap.appendChild(rightPanel);

        // The node's minimum width is fixed at the editor's floor, so narrowing
        // the node can leave the Library wider than there is room for. Rather
        // than pushing the node back out (which is what produced the "jumps to
        // a default size" snap), the column trims itself to fit. _libClampMax
        // never returns less than LIB_MIN_W, so it can shrink but not vanish —
        // collapsing stays something the user does deliberately.
        // Declared out here, not inside the try, so _epeDispose can reach
        // it. A ResizeObserver with a live observation is kept alive by the
        // browser and holds its target strongly, so leaving this connected
        // roots bodyWrap — and through it the whole editor subtree, the undo
        // stacks and _epeOwnerNode — for the life of the page. A workflow-tab
        // switch destroys and rebuilds the node, so it leaked one per switch.
        let _libFitRO = null;
        try {
          _libFitRO = new ResizeObserver(() => {
            if (_libCollapsed || _libDragging) return;
            const cur = parseInt(rightPanel.style.width, 10) || 0;
            const max = _libClampMax();
            if (cur > max) {
              rightPanel.style.width = max + "px";
              _publishLibW();
              // No persist here: this fires on every frame of a node drag. The
              // next deliberate action writes the trimmed width out.
            }
          });
          _libFitRO.observe(bodyWrap);
        } catch (_e) {}

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
          { id: "length",      label: "Length / Density", tooltip: "How long and detailed the output prompt is.\nLow: terse, ~50\u2013100 words.\nHigh: expansive, ~260\u2013300 words." },
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
          if      (sg <= 30) mods.push("SUBJECT FIDELITY OVERRIDE — this unlocks the LOCKED layer above: named subjects are no longer word-for-word, and you may metaphorize or transform them if the result is more evocative. The invention quota still applies.");
          else if (sg >= 70) mods.push("SUBJECT FIDELITY — the LOCKED layer is absolute: named subjects, counts, locations and entities appear exactly as the user wrote them, no substitutions and no synonyms. This tightens the LOCKED layer only — everything outside it is still yours to reword freshly, and the invention quota still applies.");

          return mods.join("\n");
        };

        // Compose final system prompt:
        //   1. Strip any stale addendum block from the base prompt
        //   2. Prepend the active style's addendum (skipped for Default)
        //   3. Append slider-driven modifier text (skipped if none apply)
        // Own keys only, and only strings. `_styleActive` comes from
        // node.properties — a shared, hand-editable file — and STYLE_ADDENDUMS
        // is a plain object literal, so "constructor" returned Object's
        // constructor: truthy, and "function Object() { [native code] }" was
        // prepended to every system prompt inside a STYLE TARGET block while
        // the UI still read "Default". "toString", "valueOf" and "__proto__"
        // do the same.
        const _styleAddendum = (id) =>
          (typeof id === "string" &&
           Object.prototype.hasOwnProperty.call(STYLE_ADDENDUMS, id) &&
           typeof STYLE_ADDENDUMS[id] === "string") ? STYLE_ADDENDUMS[id] : "";

        const _composeSystemPromptForStyle = (basePrompt) => {
          const cleaned = _stripStyleAddendum(basePrompt) || "";
          let result = cleaned;
          const _add = _styleAddendum(_styleActive);
          if (_styleActive !== "default" && _add) {
            const block = STYLE_ADDENDUM_START + "\n" + _add + "\n" + STYLE_ADDENDUM_END;
            result = block + "\n\n" + cleaned;
          }
          // Unknown style id (another build, hand-edited workflow): no
          // STYLE TARGET block was written above, so the OVERRIDE paragraph
          // must not go out referencing one.
          if (_styleOverride && _styleActive !== "default" && _add) {
            result = result + "\n\nAESTHETIC OVERRIDE — the STYLE TARGET above REPLACES the source's aesthetic. This relaxes SUBJECT FIDELITY for aesthetic language only: discard the source's rendering style, medium, lighting, and global color grade, and re-render the scene fully in the style target. PRESERVE unchanged: subjects, counts, poses, actions, scene layout, and named objects with their identity colors — a red bicycle stays red, expressed in the target style's idiom.";
          }
          const mods = _composeSliderModifiers();
          if (mods) result = result + "\n\n" + mods;
          return result;
        };

        // Map current slider values to an Ollama options object. Phase 4 mapping:
        // each slider owns exactly one sampling lever, so no slider can silently
        // cancel part of another. Neutral (50) sits close to Ollama's own stock
        // sampling rather than well below it.
        //   creativity → temperature (0.55–1.20)   50 → 0.875
        //   length     → num_predict (200–800)
        //   focus      → top_p (0.98–0.78), top_k (100–40)   50 → 0.88 / 70
        //   variability→ repeat_penalty (1.00–1.15), repeat_last_n,
        //                seed (fixed 42 at <=10, else random)
        //   boldness   → min_p (0.06–0.00)   50 → 0.03
        //   subjectGrip→ system prompt modifier only (no sampling param)
        //
        // Phase 3 sent presence_penalty, which is not an Ollama parameter — it was
        // silently discarded, leaving Variability inert apart from the seed pin.
        // repeat_penalty / repeat_last_n are the supported repetition controls.
        // Phase 3 also took top_p as min(creativity term, focus term); at Focus >= 50
        // the focus term always won, so Creativity's top_p contribution never applied.
        // Focus now owns top_p outright.
        const _composeOllamaOpts = () => {
          const cr = _sliderValues.creativity;
          const ln = _sliderValues.length;
          const fc = _sliderValues.focus;
          const vb = _sliderValues.variability;
          const bd = _sliderValues.boldness;

          const temperature = +(0.55 + (cr / 100) * 0.65).toFixed(3);
          const top_p = +(0.98 - (fc / 100) * 0.20).toFixed(3);
          const top_k = Math.round(100 - (fc / 100) * 60);
          const num_predict = Math.round(200 + (ln / 100) * 600);
          const seed = (vb <= 10) ? 42 : -1;
          const repeat_penalty = +(1.00 + (vb / 100) * 0.15).toFixed(3);
          const repeat_last_n = vb > 50 ? 256 : 64;
          const min_p = +(0.06 - (bd / 100) * 0.06).toFixed(3);

          return { temperature, top_p, top_k, num_predict, min_p, seed,
                   repeat_penalty, repeat_last_n };
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
        // Also claims the vision singleton for THIS editor. It is called from
        // the style-strip handlers as before, and now immediately before every
        // vision run as well — without that, the bridge was whatever the last
        // node whose strip was touched had left behind, and a second EPE node
        // in the graph silently captioned in the wrong style.
        const _syncVisionStyleBridge = () => {
          try {
            _epeOllamaVision.claim(WIN_ID, {
              style: _styleActive,
              lengthSlider: _sliderValues.length,
              focusSlider: _sliderValues.focus,
              styleOverride: (typeof _styleOverride !== "undefined") ? _styleOverride : false,
            });
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
          // Same reason as _EPE_STYLE_POOL_RULES: a bare index on a
          // prototype key returns a function, which is truthy, so the
          // `|| .default` fallback never fired and Object.keys() of it is
          // empty — the sliders simply did not move and nothing said why.
          const preset = Object.prototype.hasOwnProperty.call(STYLE_SLIDER_DEFAULTS, styleId)
            ? STYLE_SLIDER_DEFAULTS[styleId] : STYLE_SLIDER_DEFAULTS.default;
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
            // The Instruct-Edit thread load used to be here. It is
            // _epeThreadsRestore now, called BEFORE _epeTabRestore — see the
            // hook's own comment. This one runs THIRD, which was fatal.
            const ui = (_epeOwnerNode.properties || {}).epe_ui;
            if (!ui) return;
            // Everything below runs silent: restoring saved layout must not
            // write epe_ui back and dirty a workflow the user only opened.
            if (ui.tab && rpTabEls[ui.tab]) _setRpTab(ui.tab, {silent:true});
            // Tuning block: restore its height first, then its open state, so
            // reopening lands on the height this node was saved at.
            if (typeof ui.tuneHeight === "number" && ui.tuneHeight > 40 && ui.tuneHeight <= 1200) {
              _tuneH = ui.tuneHeight;
            }
            if (typeof ui.styleOpen === "boolean") {
              _tuneApply(ui.styleOpen ? (_tuneH || _tuneOpenH()) : 0, true);
            }
            if (typeof ui.libraryWidth === "number" && ui.libraryWidth >= 180 && ui.libraryWidth <= 800) {
              rightPanel.style.width = ui.libraryWidth + "px";
            }
            if (ui.libraryCollapsed) _libSetCollapsed(true, undefined, true);
            if (typeof ui.railWidth === "number" && ui.railWidth >= 40 && ui.railWidth <= 400) {
              _railApply(ui.railWidth, true);
            }
            if (ui.railCollapsed) _railApply(0, true);
            _publishLibW();   // so the node's min width is right from the first frame
          };

          _epeOwnerNode._epeStyleRestore = () => {
            const st = (_epeOwnerNode.properties || {}).epe_style;
            if (!st) return;
            // epe_style rides in node.properties — a shared, hand-editable
            // file. `st.style` went straight into the payload posted to
            // /epe/ollama/generate-image, where a list or dict raises
            // "unhashable type" out of _EPE_STYLE_POOL_RULES.get() and every
            // caption came back HTTP 500 until the node was rebuilt. Accept
            // only an id this build actually offers; anything else is Default.
            _styleActive = (typeof st.style === "string" &&
                            STYLE_OPTIONS.some(o => o.id === st.style))
                           ? st.style : "default";
            _styleOverride = !!st.override;
            if (st.sliders) {
              Object.keys(st.sliders).forEach(id => {
                // hasOwnProperty, because sliderEls is a plain object literal
                // and epe_style comes out of a workflow file via JSON.parse —
                // which makes "__proto__" an OWN key, so Object.keys hands it
                // over. `sliderEls["__proto__"]` is Object.prototype: truthy,
                // so the `if (!el)` guard passed, and `el.input.value` threw.
                // That throw unwound _epeStyleRestore into
                // _epeRefreshFromProps's blanket catch, so _epeUiRestore never
                // ran and the saved Instruct Edit threads and panel layout
                // were silently dropped on every open of that file.
                if (!Object.prototype.hasOwnProperty.call(sliderEls, id)) return;
                const el = sliderEls[id];
                if (!el || !el.input) return;
                // Clamp: a value carried in from another build (or a
                // hand-edited workflow) fed the sampling math directly and
                // could produce a negative top_p / min_p.
                const v = Number(st.sliders[id]);
                if (!Number.isFinite(v)) return;
                const c = Math.max(0, Math.min(100, v));
                _sliderValues[id] = c;
                el.input.value = String(c);
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
        // No longer a toggle: the divider above the block owns collapse now, the
        // same way the Library divider owns the Library column. Cursor stays
        // default so the bar doesn't advertise a click it no longer handles.
        styleHdr.style.cssText =
          "display:flex;align-items:center;gap:8px;padding:8px 12px;user-select:none;" +
          "background:rgba(109,184,232,0.08);border:1px solid rgba(109,184,232,0.2);border-radius:8px;";
        const styleHdrLabel = document.createElement("span");
        styleHdrLabel.textContent = "Style tuning";
        styleHdrLabel.style.cssText = "font-size:10px;color:#8ba5be;";
        const styleHdrState = document.createElement("span");
        styleHdrState.style.cssText = "font-size:10px;color:#6d849a;margin-left:auto;";
        const styleHdrToggle = document.createElement("span");
        styleHdrToggle.style.cssText = "font-size:9px;color:#5f7a92;";
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
          styleHdrToggle.textContent = "";
          styleHdrState.textContent = _styleOpen ? "" :
            (STYLE_OPTIONS.find(o => o.id === _styleActive)?.label || "Default") +
            (_styleOverride ? " · Override on" : "");
        };
        // styleBody is always shown; hiding is done by collapsing the whole
        // tuning block (style tuning + wireless targets) from its divider.
        styleBody.style.display = "";
        _updateStyleHdrState();
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
            if (_epeOpenPop._epeArmT) { clearTimeout(_epeOpenPop._epeArmT); _epeOpenPop._epeArmT = null; }
            if (_epeOpenPop._onDoc) document.removeEventListener("mousedown", _epeOpenPop._onDoc, true);
            // Drag pair on `document` — otherwise a Synonyms/Flag-words popover
            // dragged and released outside the mouseup path (right-click, alt-tab,
            // focus loss) strands two listeners that hold the whole editor.
            if (_epeOpenPop._epeEndDrag) { try { _epeOpenPop._epeEndDrag(); } catch (_e) {} }
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
            // Expose so _closePopovers can force-drop the drag pair on paths
            // that skip mouseup (right-click, alt-tab, node dispose).
            p._epeEndDrag = onUp;
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
          // Installed NOW, not inside a setTimeout. The handle used to be
          // written in the timer callback, so a dispose in the SAME TICK found
          // pop._onDoc still undefined, removed nothing — and the listener was
          // installed a moment later on a document that would keep it for the
          // life of the page. Capture phase, holding the whole editor closure.
          //
          // The timer's actual job was to ignore the click that opened the
          // popover; the armed flag does that without owning the teardown.
          const onDoc = (e) => {
            if (!pop._epeArmed) return;
            if (!pop.contains(e.target) && e.target !== btn) _closePopovers();
          };
          pop._onDoc = onDoc;
          // Capture phase: LiteGraph's canvas calls stopPropagation() on
          // mousedown, so a bubble-phase listener never sees canvas clicks
          // and the popover would stay open over the graph.
          document.addEventListener("mousedown", onDoc, true);
          pop._epeArmT = setTimeout(() => {
            pop._epeArmed = true;
            pop._epeArmT = null;
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
          // The callback may REFUSE — "close a tab first" — and a refusal has
          // to leave the control on screen, or the message names a remedy for
          // an affordance it has just deleted. Returning false keeps it up.
          let _tid = setTimeout(() => t.remove(), 5000);
          u.onclick = () => {
            let keep = false;
            try { keep = (onUndo && onUndo()) === false; } catch (_e) {}
            if (!keep) { clearTimeout(_tid); t.remove(); return; }
            // Kept — and given its five seconds back. The timer was armed
            // once at construction and never rearmed, so a refusal at 3.5 s
            // left the user 1.5 s to act on a message that asks them to go
            // and close a tab first. The control named a remedy and then
            // vanished before it could be followed.
            clearTimeout(_tid);
            _tid = setTimeout(() => t.remove(), 5000);
          };
          t.appendChild(u);
          floatingWin.appendChild(t);
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
          // Take the slot: abort whatever holds it, THEN own it. Overwriting
          // it left request #1 streaming with nothing able to stop it, and
          // #1's completion then nulled #2's controller — so dispose and Esc
          // were no-ops on #2 as well, and it streamed into a detached element
          // for up to 120 s holding the whole editor closure alive.
          //
          // The controller is held locally as well, because the shared slot
          // may be taken over by a newer request while this one unwinds.
          // _ieApplyOne has done exactly this since round 4.
          if (_wordAltAbort) { try { _wordAltAbort.abort(); } catch (_e) {} }
          const _waCtrl = new AbortController();
          _wordAltAbort = _waCtrl;
          const _sig = _waCtrl.signal;
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
            // Only if this call still owns the slot — see the take above.
            if (_wordAltAbort === _waCtrl) { _wordAltAbort = null; _cancelWordAltGrace(); }
            if (!_uniq.length) _toast("No suggestions returned.");
            return _uniq.slice(0, 6);
          } catch (_e) {
            if (_wordAltAbort === _waCtrl) { _wordAltAbort = null; _cancelWordAltGrace(); }
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
          // A DEPTH, not a flag. Instruct edit takes the mute before its
          // await and releases it after; anything the user does in between —
          // ↶, Esc, Discard — used to release it early, and the streamed
          // result then landed on the undo stack after all.
          let _undoMuteDepth = 0;
          const _mute = (on) => {
            _undoMuteDepth = Math.max(0, _undoMuteDepth + (on ? 1 : -1));
          };
          const _pushUndo = (force) => {
            if (_undoMuteDepth) return;
            const now = Date.now();
            if (!force && now - _lastPush < 500) return;
            // Never stack the same text twice. The input event records the
            // value AFTER the edit, so the last push before the user stops
            // typing already IS what is on screen — and _reviewEnter then
            // pushed it a second time. Popping either changes nothing, which
            // is what made the first ↶ read as a dead button.
            if (_undo.length && _undo[_undo.length - 1] === textEl.value) {
              // Clear the redo branch even here. Skipping it let Ctrl+Y jump
              // forward into a state a later edit had already invalidated.
              _lastPush = now; _redo.length = 0; return;
            }
            _lastPush = now; _undo.push(textEl.value);
            if (_undo.length > 100) _undo.shift(); _redo.length = 0;
          };
          textEl._epePushUndo = () => _pushUndo(true);
          // Let a caller write into the editor without the change landing on the
          // stack. Instruct edit uses this: it pushes the pre-edit prompt itself,
          // then mutes while the result streams in — otherwise the final input
          // event pushes the edit's own output on top and the first press of ↶
          // restores what is already on screen, which reads as a dead button.
          textEl._epeUndoMute = (on) => _mute(on);
          // Push a value that is no longer on screen. Instruct edit holds its
          // chain aside and flushes it here only if the chain is kept, so
          // nothing has to be unwound if it is abandoned.
          textEl._epePushUndoValue = (v) => {
            if (_undoMuteDepth) return;
            _lastPush = Date.now(); _undo.push(v);
            if (_undo.length > 100) _undo.shift(); _redo.length = 0;
          };
          // One history per prompt tab. A single shared stack, fed by the
          // tab switch's own input event, let Ctrl+Z in one tab paste
          // another tab's prompt over it — and _epeTabSync then wrote that
          // into the workflow.
          const _tabUndo = {}, _tabRedo = {}, _tabMark = {};
          // ROUND 66 (V-3). The review boundary.
          //
          // `null` outside a review. Inside one it holds the two stacks as
          // they were the instant the review opened, which is both the floor
          // that ↶/↷ may not step below and the state a Discard restores.
          //
          // It lives here rather than beside _reviewMode because _undo/_redo
          // are in this scope and nothing else may touch them; the review
          // scope drives it through the three textEl hooks below.
          let _reviewMark = null;
          // Marks are per TAB, like the stacks: park a review, work on
          // another tab, come back, and the boundary must still be the one
          // that review opened with. Swapped in the same three places
          // _tabUndo/_tabRedo are.
          textEl._epeUndoReviewMark = () => {
            // Idempotent. A parked review re-entering must not re-mark — its
            // boundary was set when it first opened, and re-marking would put
            // the floor above the result and make Discard a no-op.
            if (_reviewMark) return;
            _reviewMark = { u: _undo.slice(), r: _redo.slice() };
            // Everything on the redo branch from here is review-era, so the
            // floor for ↷ is simply zero. (_pushUndo already clears _redo on
            // the entry push in every unmuted case; doing it here covers the
            // muted one and makes the invariant unconditional rather than
            // inherited.)
            _redo.length = 0;
          };
          // A non-commit exit: Discard, Esc, auto-discard, a failed finish.
          // Puts both stacks back exactly as the review found them, so no
          // rejected text survives on either branch.
          textEl._epeUndoReviewRollback = () => {
            if (!_reviewMark) return;
            const m = _reviewMark; _reviewMark = null;
            _undo.length = 0; m.u.forEach(v => _undo.push(v));
            _redo.length = 0; m.r.forEach(v => _redo.push(v));
          };
          // A commit. The review's steps stay: this drops the boundary and
          // keeps the stacks untouched, so the accept path behaves exactly as
          // it did before round 66.
          textEl._epeUndoReviewEnd = () => { _reviewMark = null; };
          // The floor. Below it lies text from before the review opened.
          const _undoFloor = () => (_reviewMark ? _reviewMark.u.length : 0);
          let _undoTabKey = "0";
          // A configure replaces the whole tab list, so every stack keyed to
          // the outgoing list is meaningless — and worse than meaningless,
          // because _epeUndoUseTab's same-key early return leaves the live one
          // loaded. Called by _epeTabRestore, and only for a real configure.
          textEl._epeUndoResetAll = () => {
            Object.keys(_tabUndo).forEach(k => delete _tabUndo[k]);
            Object.keys(_tabRedo).forEach(k => delete _tabRedo[k]);
            _undo.length = 0; _redo.length = 0;
            _undoTabKey = "\u0000";   // force the next useTab to load
          };
          textEl._epeUndoUseTab = (key) => {
            const k = String(key);
            if (k === _undoTabKey) return;
            _tabUndo[_undoTabKey] = _undo.slice();
            _tabRedo[_undoTabKey] = _redo.slice();
            // ROUND 66: a parked review's boundary belongs to its tab.
            _tabMark[_undoTabKey] = _reviewMark;
            _undoTabKey = k;
            _undo.length = 0; _redo.length = 0;
            (_tabUndo[k] || []).forEach(v => _undo.push(v));
            (_tabRedo[k] || []).forEach(v => _redo.push(v));
            _reviewMark = _tabMark[k] || null;
          };
          // Closing a tab splices the array, so every key above it shifts
          // down by one — exactly what the tab list does.
          textEl._epeUndoDropTab = (idx) => {
            _tabUndo[_undoTabKey] = _undo.slice();
            _tabRedo[_undoTabKey] = _redo.slice();
            const shift = (m) => {
              const out = {};
              Object.keys(m).forEach(k => {
                const n = parseInt(k, 10);
                if (!Number.isFinite(n) || n === idx) return;
                out[String(n > idx ? n - 1 : n)] = m[k];
              });
              return out;
            };
            const nu = shift(_tabUndo), nr = shift(_tabRedo), nm = shift(_tabMark);
            Object.keys(_tabUndo).forEach(k => delete _tabUndo[k]);
            Object.keys(_tabRedo).forEach(k => delete _tabRedo[k]);
            Object.keys(_tabMark).forEach(k => delete _tabMark[k]);
            Object.assign(_tabUndo, nu); Object.assign(_tabRedo, nr);
            Object.assign(_tabMark, nm);
            _undoTabKey = "\u0000";   // force the next useTab to load
            _undo.length = 0; _redo.length = 0; _reviewMark = null;
          };
          // Inverse of drop: reopen a slot at idx (the reopened tab starts
          // with empty history). The tab-close toast's Undo needs this — a
          // restore without it left every tab above the closed one running
          // on its lower neighbour's history.
          textEl._epeUndoRestoreTab = (idx) => {
            _tabUndo[_undoTabKey] = _undo.slice();
            _tabRedo[_undoTabKey] = _redo.slice();
            const shift = (m) => {
              const out = {};
              Object.keys(m).forEach(k => {
                const n = parseInt(k, 10);
                if (!Number.isFinite(n)) return;
                out[String(n >= idx ? n + 1 : n)] = m[k];
              });
              return out;
            };
            const nu = shift(_tabUndo), nr = shift(_tabRedo), nm = shift(_tabMark);
            Object.keys(_tabUndo).forEach(k => delete _tabUndo[k]);
            Object.keys(_tabRedo).forEach(k => delete _tabRedo[k]);
            Object.keys(_tabMark).forEach(k => delete _tabMark[k]);
            Object.assign(_tabUndo, nu); Object.assign(_tabRedo, nr);
            Object.assign(_tabMark, nm);
            _undoTabKey = "\u0000";   // force the next useTab to load
            _undo.length = 0; _redo.length = 0; _reviewMark = null;
          };
          // B-3. A closed tab's undo history is dropped with it, so the toast's
          // Undo used to bring back the text and nothing else. These two let
          // the close capture it and the undo put it back.
          //
          // The live stacks are only flushed into `_tabUndo` on a SWITCH, so
          // for the tab that is currently active they are the authoritative
          // copy and `_tabUndo[idx]` is stale. Read the right one.
          textEl._epeUndoCaptureTab = (idx) => {
            const k = String(idx);
            if (k === _undoTabKey) return { u: _undo.slice(), r: _redo.slice() };
            return { u: (_tabUndo[k] || []).slice(), r: (_tabRedo[k] || []).slice() };
          };
          // Install a captured history at `idx`. Called after the restore has
          // opened the slot and BEFORE _epeUndoUseTab loads it into the live
          // stacks. No review mark is restored: a review open at close time was
          // discarded or parked by _closeTab, so there is no boundary to honour.
          textEl._epeUndoLoadTab = (idx, hist) => {
            if (!hist) return;
            const k = String(idx);
            _tabUndo[k] = (hist.u || []).slice();
            _tabRedo[k] = (hist.r || []).slice();
          };
          textEl.addEventListener("input", () => _pushUndo(false));
          // Persist and refresh the restored text without recording it: an
          // undo that pushes its own result back onto the stack leaves the
          // next press with nothing to do.
          const _applyStep = () => {
            _mute(true);
            try { textEl.dispatchEvent(new Event("input")); }
            finally { _mute(false); }
          };
          // Put a value back into the editor: on screen, onto the node, and
          // NOT onto the undo stack. Every "restore what it was" path needs
          // exactly this — without the dispatch, node.properties.epe_prompt
          // keeps the AI result and the next rebuild undoes the restore.
          textEl._epeRestoreValue = (v) => {
            textEl.value = v;
            _applyStep();
          };
          const _undoOnce = () => {
            // Drop anything that is already on screen before stepping back,
            // so ↶ always actually moves — but never below the review floor,
            // or the discard-time rollback would have nothing to put back.
            while (_undo.length > _undoFloor() &&
                   _undo[_undo.length - 1] === textEl.value) _undo.pop();
            // ROUND 66 (V-3): inside a review, ↶ steps through the user's own
            // edits TO the result and stops at the boundary. It does NOT step
            // out to the pre-AI prompt — doing that put the AI result on the
            // redo branch, where a Discard could not remove it and one Ctrl+Y
            // wrote the rejected text into the workflow file. It also left the
            // screen holding the pre-review prompt while a review was open, so
            // parking captured that as the "result" and destroyed the real one,
            // and `Use this` committed it. The user's own edits stay undoable:
            // refusing those would cost them work.
            if (_undo.length <= _undoFloor()) return false;
            _redo.push(textEl.value); textEl.value = _undo.pop();
            _applyStep(); return true;
          };
          const _redoOnce = () => {
            while (_redo.length && _redo[_redo.length - 1] === textEl.value) _redo.pop();
            if (!_redo.length) return false;
            _undo.push(textEl.value); textEl.value = _redo.pop();
            _applyStep(); return true;
          };
          textEl.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
              if (_undoOnce()) e.preventDefault();
            } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
              if (_redoOnce()) e.preventDefault();
            }
          });
          const _setText = (v) => { _pushUndo(true); textEl.value = v; textEl.dispatchEvent(new Event("input")); };

          const undoBtn = _mk("↶", "Undo (Ctrl+Z)");
          undoBtn.onclick = () => { _undoOnce(); };
          const redoBtn = _mk("↷", "Redo (Ctrl+Y)");
          redoBtn.onclick = () => { _redoOnce(); };


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
                 // The uncapped, unanchored twin of cleanWeights. That one has
                 // had a 32-pass bound since round 23 and linear regexes since
                 // round 28; this one is five `do … while (v !== prev)` loops
                 // over the same shapes, with three `\s+` regexes below that
                 // have nothing to stop them restarting at every character of
                 // a whitespace run. 8 K chars measured 132 ms, 16 K 533 ms,
                 // 32 K 2,111 ms — a clean x4 per doubling, with no nesting
                 // needed at all. And cleanWeights HANDS it the input: it
                 // peels 32 levels and stops, so Extract then "Use this"
                 // leaves the rest in the editor for the tool built to strip
                 // exactly that.
                 //
                 // Differential-fuzzed against the old form over 300,000
                 // assembled prompts: zero differences. 32 K is now 1 ms.
                 const PASS_LIMIT = 32;
                 let v = textEl.value, prev, passes;
                 // (word:1.2) and (word:-1.4), innermost first for nesting
                 passes = 0;
                 do { prev = v; v = v.replace(/\(([^()]*?):\s*-?\d*\.?\d+\s*\)/g, "$1"); } while (v !== prev && ++passes < PASS_LIMIT);
                 // [word:0.25] prompt-editing / bracket weights
                 passes = 0;
                 do { prev = v; v = v.replace(/\[([^\[\]]*?):\s*-?\d*\.?\d+\s*\]/g, "$1"); } while (v !== prev && ++passes < PASS_LIMIT);
                 v = v.replace(/\(\s*-?\d*\.?\d+\s*\)/g, "");   // orphan (1.4)
                 v = v.replace(/::\s*-?\d*\.?\d+/g, "");           // Midjourney cat::2
                 // emphasis-only grouping: ((word)) [word] {word}
                 passes = 0;
                 do { prev = v; v = v.replace(/\(([^()]*)\)/g, "$1"); } while (v !== prev && ++passes < PASS_LIMIT);
                 passes = 0;
                 do { prev = v; v = v.replace(/\[([^\[\]]*)\]/g, "$1"); } while (v !== prev && ++passes < PASS_LIMIT);
                 passes = 0;
                 do { prev = v; v = v.replace(/\{([^{}]*)\}/g, "$1"); } while (v !== prev && ++passes < PASS_LIMIT);
                 v = v.replace(/([A-Za-z0-9])[+]{1,5}(?=[\s,]|$)/g, "$1");   // horse++
                 v = v.replace(/([A-Za-z0-9])[-]{2,5}(?=[\s,]|$)/g, "$1");   // dog--
                 // leftover " word -1.4" (sign or decimal required, so ISO 100 survives)
                 // `(?<!\s)` makes only the FIRST character of a whitespace
                 // run a valid start. Greedy `\s+` already matched maximally,
                 // so the starts this prunes are exactly the ones that could
                 // never have matched — the answer is unchanged and a failed
                 // attempt happens once per run instead of once per character.
                 v = v.replace(/(?<!\s)\s+-\d*\.?\d+(?=\s*,|\s*$)/g, "");
                 v = v.replace(/(?<!\s)\s+\d+\.\d+(?=\s*,|\s*$)/g, "");
                 return v.replace(/[ \t]{2,}/g, " ").replace(/(?<!\s)\s+,/g, ",")
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
             // TWO changes, and both are needed. `[^\S\n]*` is horizontal
             // whitespace only, so the run in front of the `\n` cannot swallow
             // one — and the negative lookbehind makes only a run's FIRST
             // character a valid start, so a long run with no newline after it
             // is walked once instead of once per index. `[^\S\n]*` alone is
             // still quadratic: measured, 40,000 spaces cost 1.55 s with the
             // lookbehind missing and 0 ms with it. Same reasoning as the
             // `(?<!\s)` on the two items above.
             ["Remove line breaks", () => textEl.value.replace(/(?<![^\S\n])[^\S\n]*\n\s*/g," ").replace(/\s{2,}/g," ").trim()],
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
              // Resolves FIRST, so the highlight and the splice always name the
              // same occurrence. It used to read the stale f.at, so after an
              // edit made while the call was in flight it showed the user one
              // occurrence and edited another.
              const _revealWord = () => {
                if (typeof _fixAt === "function" && _fixAt() < 0) {
                  _toast("That word is no longer in the prompt.");
                  return;
                }
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
              // REVALIDATED, not just re-read. `f.at` is the offset from the
              // scan that opened this popover, and `replace` focuses the
              // textarea and leaves the popover up across the Ollama call —
              // so the user can edit the prompt while it is in flight. Any
              // edit before that offset shifts it, and the chip then spliced
              // f.word.length characters out of the middle of unrelated text
              // and committed the result to node.properties and the tab slot.
              // WORD BOUNDARIES, because the scan that produced this row used
              // `\b…\b` and this did not. _FLAG_WORDS holds "hd", "4k", "8k",
              // "epic" — so a bare indexOf could relocate the fix onto the
              // "hd" inside "hdr" and splice mid-word into text the user never
              // flagged, and the fast path had the same hole.
              const _isWordAt = (v, at, n) =>
                !/\w/.test(v.charAt(at - 1) || "") && !/\w/.test(v.charAt(at + n) || "");
              const _fixAt = () => {
                const v = textEl.value, w = f.word, n = w.length;
                if (v.substr(f.at, n).toLowerCase() === w.toLowerCase() &&
                    _isWordAt(v, f.at, n)) return f.at;
                // Moved: take the nearest occurrence to where it was, so a
                // prompt with the word twice does not jump to the other one.
                const low = v.toLowerCase(), lw = w.toLowerCase();
                let best = -1, bestD = Infinity, i = low.indexOf(lw);
                while (i >= 0) {
                  if (_isWordAt(v, i, n)) {
                    const d = Math.abs(i - f.at);
                    if (d < bestD) { bestD = d; best = i; }
                  }
                  i = low.indexOf(lw, i + 1);
                }
                if (best >= 0) f.at = best;
                return best;
              };
              fixB.onclick = async (ev) => {
                if (ev) ev.stopPropagation();
                if (chipWrap.style.display === "flex") { chipWrap.style.display = "none"; return; }
                _revealWord();   // show which occurrence is being replaced
                chipWrap.style.display = "flex"; chipWrap.innerHTML = "";
                const loading = _epeThinkingLine(); chipWrap.appendChild(loading);
                const alts = await _epeOllamaWordAlternatives(f.word, textEl.value, chipWrap);
                chipWrap.innerHTML = "";
                if (!alts.length) { const n = document.createElement("span"); n.textContent = "no suggestions"; n.style.cssText = "color:#6d849a;font-size:10px;"; chipWrap.appendChild(n); return; }
                alts.forEach(a => { const chip = document.createElement("span"); chip.textContent = a; chip.style.cssText = "background:rgba(109,184,232,0.14);border:1px solid rgba(140,200,240,0.4);border-radius:5px;color:#a8d6f5;font-size:10px;padding:2px 9px;cursor:pointer;"; chip.addEventListener("mousedown", _swallowDown); chip.onclick = (ev) => { if (ev) ev.stopPropagation(); const at = _fixAt(); if (at>=0) _setText(textEl.value.slice(0,at)+a+textEl.value.slice(at+f.word.length)); else _toast("\u201c" + f.word + "\u201d is no longer in the prompt."); _closePopovers(); }; chipWrap.appendChild(chip); });
              };
              const delB = document.createElement("span"); delB.textContent = "delete"; delB.style.cssText = "color:#6d849a;cursor:pointer;font-size:10px;";
              delB.addEventListener("mousedown", _swallowDown);
              delB.onclick = (ev) => { if (ev) ev.stopPropagation(); const at = _fixAt(); if (at>=0) _setText((textEl.value.slice(0,at)+textEl.value.slice(at+f.word.length)).replace(/\s{2,}/g," ").replace(/\s+([,.])/g,"$1")); else _toast("\u201c" + f.word + "\u201d is no longer in the prompt."); _closePopovers(); };
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
            // Ten, up from four (round 73, Daniel's request).
            //
            // Nothing else in the tab machinery mentions the number. Every fix
            // rounds 55-69 made here is index-generic — the "+" handler opening
            // a slot in the keyed maps (B-2), the close capturing thread and
            // undo history (B-3), the clamped landing index (B-4), the restore
            // swap permuting the thread map (B-5) — so none of them are
            // sensitive to what MAX is.
            //
            // The parking machinery below was written for exactly this move:
            // "a build with a larger MAX gets them back". A workflow saved by
            // an older 4-tab build opens with all its tabs visible now, and one
            // saved here with 10 opens in an older build as 4 visible + 6
            // parked, which round-57's B-1 fix already counts correctly.
            const MAX = 10;
            const props = (_epeOwnerNode && _epeOwnerNode.properties) || {};
            // Load or seed tab state. tabs = array of strings; active = index.
            //
            // Validated the same way _epeTabRestore validates it. These are two
            // readers of the same untrusted workflow field and they disagreed:
            // a non-string entry became "[object Object]" in the editor and in
            // every wireless target, and a bad active index filed instruct
            // threads under keys like "-1". Under stock LiteGraph the restore
            // path is the one that runs, which is why this never bit — but a
            // divergence between two readers of the same field is a bug
            // waiting for a different load order.
            const _initTabs = Array.isArray(props.epe_tabs) && props.epe_tabs.length
              ? props.epe_tabs.map(t => typeof t === "string" ? t : "")
              : [textEl.value || ""];
            let _tabs = _initTabs.slice(0, MAX);
            const _rawActive = parseInt(props.epe_tab_active, 10);
            let _active = Math.max(0, Math.min(
              Number.isFinite(_rawActive) ? _rawActive : 0, _tabs.length - 1));
            let _lastClosed = null;
            // Tabs from the workflow file that do not fit in MAX.
            //
            // They used to be dropped on the floor: `_tabs = _fullTabs.slice(0,
            // MAX)` and then the restore's OWN muted input dispatch ran
            // _epePersistPrompt -> _epeTabSync -> _persistTabs, which wrote the
            // truncated array straight back over properties.epe_tabs. Opening a
            // 6-tab workflow deleted two of its tabs, before the user had
            // touched anything, and said nothing unless the active tab happened
            // to be one of the casualties.
            //
            // Parked here and re-appended by _persistTabs instead, so the file
            // round-trips losslessly and a build with a larger MAX gets them
            // back. Reset on every restore — see _epeTabRestore.
            let _overflowTabs = _initTabs.slice(MAX);
            // Once per node. `_epeTabRestore` runs on every workflow-tab
            // switch and on every Ctrl+Z of a graph change, so the overflow
            // toast fired over and over with nothing the user could do about
            // it. (R56b-J5.)
            let _overflowToldOnce = false;
            // Hand the live count UP to _iePersistThreads, which is declared
            // in the enclosing closure and cannot see `_tabs`. Assigned here,
            // after the declaration above, so the arrow never reads a
            // temporal-dead-zone binding.
            // The FULL count — visible plus parked — because that is what
            // _persistTabs writes (`_tabs.concat(_overflowTabs)`) and what
            // _ieThreadsDropTab / _ieThreadsRestoreTab index against.
            //
            // Round 56 handed up `_tabs.length` alone, and _iePersistThreads
            // drops every key >= the count it is given. So opening a 6-tab
            // workflow in a 4-tab build kept all six prompts (J-05) and
            // deleted tabs 5 and 6's instruct threads from the file on the
            // very first load — _epeTabRestore's own finally calls
            // _iePersistThreads — before the user had touched anything. The
            // toast said the rest were "kept in the file"; half of what they
            // carry was being deleted as it said so.
            _epeTabCountFn = () => _tabs.length + _overflowTabs.length;
            // And which one is on screen — see _ieTabKey's comment. Published
            // here beside the count, for the same scope reason.
            _epeTabActiveFn = () => _active;

            const tabBar = document.createElement("div");
            // `flex-wrap:wrap` because ten tabs do not fit: each is about 70px
            // and the editor's own minimum width is 320px. Wrapping keeps every
            // tab visible and clickable at any node width; a horizontal scroller
            // would hide the tab you want behind a gesture. The bar grows
            // downward only as far as the tab count actually needs.
            tabBar.style.cssText = "display:flex;flex-wrap:wrap;align-items:flex-end;gap:2px;flex-shrink:0;margin-left:-1px;";

            const _persistTabs = () => {
              if (!_epeOwnerNode) return;
              if (!_epeOwnerNode.properties) _epeOwnerNode.properties = {};
              // `.concat(_overflowTabs)` — see the declaration. Anything the
              // workflow carried beyond MAX is preserved verbatim rather than
              // silently deleted by the act of opening the file.
              _epeOwnerNode.properties.epe_tabs = _tabs.concat(_overflowTabs);
              _epeOwnerNode.properties.epe_tab_active = _active;
            };
            // Called by _epePersistPrompt: keep active slot in sync with textarea.
            _epeOwnerNode && (_epeOwnerNode._epeTabSync = () => { _tabs[_active] = textEl.value; _persistTabs(); });

            // ── Send a result to another tab ──────────────────────────────
            //
            // Published on the NODE, not into a `let` the whole editor closure
            // can see. T38: any mutable binding at that scope needs a
            // reachability census, and there is no reason to add a third — every
            // fact this needs (`_tabs`, `_active`, `_overflowTabs`,
            // `_persistTabs`, `_render`, the index-keyed maps) already lives in
            // here, and `_epeTabSync` above is the same publication shape.
            //
            // DANIEL'S RULE, and the whole design: "nothing changes in the
            // current tab, the new tab would get the sent result as a main
            // prompt which could be edited by switching to the tab, none of our
            // mechanics change." So this does NOT commit, does NOT exit the
            // review, does NOT move `_active`, and does NOT write `textEl`. The
            // review strip is still up and Use this / Append / Discard still
            // mean exactly what they meant before.
            //
            // Safe to persist mid-review: `_persistTabs` writes `_tabs`, and
            // `_tabs[_active]` holds the last COMMITTED value during a review —
            // `_epeTabSync` is only reached through `_epePersistPrompt`, which
            // refuses under review. So writing the file here cannot leak the
            // un-accepted result into the current tab. That is the J-04
            // invariant, and it is asserted in the suite rather than trusted.
            _epeOwnerNode && (_epeOwnerNode._epeOpenSendToTab = (anchorEl, text) => {
              const _txt = typeof text === "string" ? text : "";
              _closePopovers();
              const pop = _mkPopover();

              const _title = document.createElement("div");
              _title.textContent = "Send result to";
              _title.style.cssText = "font-size:10px;color:#7d9cb8;margin-bottom:7px;letter-spacing:.3px;";
              pop.appendChild(_title);

              const _rowStyle =
                "display:flex;align-items:center;justify-content:space-between;gap:10px;" +
                "padding:4px 8px;border-radius:5px;font-size:11px;cursor:pointer;" +
                "background:rgba(109,184,232,0.08);border:1px solid rgba(109,184,232,0.2);" +
                "color:#a8d6f5;margin-bottom:4px;";
              const _deadStyle =
                "display:flex;align-items:center;justify-content:space-between;gap:10px;" +
                "padding:4px 8px;border-radius:5px;font-size:11px;" +
                "background:rgba(120,140,160,0.06);border:1px solid rgba(120,140,160,0.15);" +
                "color:#5f748a;margin-bottom:4px;";

              // The confirm. ONE shape for every send, deliberately — Daniel:
              // "the mechanics stays constant no edge cases". A rule with an
              // exception is the round-70 lesson: it teaches the user the rule
              // sometimes does not hold, and that doubt costs them every time.
              const _confirm = (msg, onYes) => {
                _closePopovers();
                const cp = _mkPopover();
                cp.style.minWidth = "0";
                const q = document.createElement("div");
                q.textContent = msg;
                q.style.cssText = "font-size:11px;color:#c2d4e6;margin-bottom:8px;text-align:center;max-width:220px;";
                const row = document.createElement("div");
                row.style.cssText = "display:flex;gap:6px;";
                const yes = document.createElement("span");
                yes.textContent = "Send";
                yes.style.cssText = "flex:1;text-align:center;background:rgba(226,168,75,0.15);border:1px solid rgba(226,168,75,0.4);border-radius:5px;color:#e8c88a;font-size:10px;padding:4px 12px;cursor:pointer;";
                yes.onclick = (ev) => { ev.stopPropagation(); _closePopovers(); onYes(); };
                const no = document.createElement("span");
                no.textContent = "Cancel";
                no.style.cssText = "flex:1;text-align:center;background:rgba(109,184,232,0.1);border:1px solid rgba(109,184,232,0.25);border-radius:5px;color:#a8d6f5;font-size:10px;padding:4px 12px;cursor:pointer;";
                no.onclick = (ev) => { ev.stopPropagation(); _closePopovers(); };
                row.appendChild(yes); row.appendChild(no);
                cp.appendChild(q); cp.appendChild(row);
                _anchorPopover(cp, anchorEl);
              };

              const _warn = (msg) => {
                _closePopovers();
                const wp = _mkPopover();
                wp.style.minWidth = "0";
                const q = document.createElement("div");
                q.textContent = msg;
                q.style.cssText = "font-size:11px;color:#e8c88a;margin-bottom:8px;text-align:center;max-width:220px;";
                const ok = document.createElement("span");
                ok.textContent = "OK";
                ok.style.cssText = "display:block;text-align:center;background:rgba(109,184,232,0.1);border:1px solid rgba(109,184,232,0.25);border-radius:5px;color:#a8d6f5;font-size:10px;padding:4px 12px;cursor:pointer;";
                ok.onclick = (ev) => { ev.stopPropagation(); _closePopovers(); };
                wp.appendChild(q); wp.appendChild(ok);
                _anchorPopover(wp, anchorEl);
              };

              // Write into an EXISTING tab.
              const _sendTo = (i) => {
                const _old = _tabs[i] || "";
                _tabs[i] = _txt;
                // One Ctrl+Z in that tab puts back exactly what was there.
                // Through round 69's capture/load pair rather than by reaching
                // into the maps, and only for a tab that is NOT on screen — the
                // active tab's stacks are the live ones and are not ours.
                try {
                  if (i !== _active && textEl._epeUndoCaptureTab && textEl._epeUndoLoadTab) {
                    const _h = textEl._epeUndoCaptureTab(i);
                    if (_h) {
                      _h.u = (_h.u || []).concat([_old]);
                      _h.r = [];
                      textEl._epeUndoLoadTab(i, _h);
                    }
                  }
                } catch (_e) {}
                // That tab's Instruct-Edit direction described the prompt that
                // is no longer there. Same contract as Use this and Append,
                // which clear it for exactly this reason. Through _ieThreadSet
                // with an explicit key — never by touching _ieThreads, which is
                // the K-2 reachability census.
                try {
                  if (typeof _ieThreadSet === "function") _ieThreadSet([], String(i));
                } catch (_e) {}
                _persistTabs();
                try { _toast("Sent to Tab " + (i + 1) + "."); } catch (_e) {}
              };

              // Write into a NEW tab.
              const _sendToNew = () => {
                // Byte-for-byte the "+" handler's order, and for its reasons:
                // PUSH FIRST, then open the slot in each index-keyed map, or
                // the shift persists against a count one too small and deletes
                // the last parked tab's thread on the way past (B-2).
                const _at = _tabs.length;
                _tabs.push(_txt);
                if (textEl._epeUndoRestoreTab) textEl._epeUndoRestoreTab(_at);
                if (typeof _ieThreadsRestoreTab === "function") _ieThreadsRestoreTab(_at);
                // NO _switchTo — the current tab does not change. That also
                // means the review is still live, so _iePersistThreads refuses;
                // _reviewExit flushes the map on the way out of the review.
                // The shift is a no-op unless tabs are PARKED, which after this
                // round only a pre-existing 11+ tab file can produce.
                _persistTabs();
                _render();
                try { _iePersistThreads(); } catch (_e) {}
                try { _toast("Sent to a new Tab " + (_at + 1) + "."); } catch (_e) {}
              };

              _tabs.forEach((_t, i) => {
                if (i === _active) {
                  // Shown, not hidden, so the numbering a user reads here is the
                  // numbering on the tab bar. Sending to where you already are
                  // is what "Use this" does.
                  const d = document.createElement("div");
                  d.style.cssText = _deadStyle;
                  const a = document.createElement("span"); a.textContent = "Tab " + (i + 1);
                  const b = document.createElement("span"); b.textContent = "current";
                  b.style.cssText = "font-size:9px;";
                  d.appendChild(a); d.appendChild(b);
                  pop.appendChild(d);
                  return;
                }
                const r = document.createElement("div");
                r.style.cssText = _rowStyle;
                const a = document.createElement("span"); a.textContent = "Tab " + (i + 1);
                const b = document.createElement("span");
                b.textContent = (_tabs[i] || "").trim() ? "has a prompt" : "empty";
                b.style.cssText = "font-size:9px;color:#7d9cb8;";
                r.appendChild(a); r.appendChild(b);
                r.onmouseenter = () => { r.style.background = "rgba(109,184,232,0.18)"; };
                r.onmouseleave = () => { r.style.background = "rgba(109,184,232,0.08)"; };
                r.onclick = (ev) => {
                  ev.stopPropagation();
                  _confirm("Sending to Tab " + (i + 1) + " will overwrite its current prompt.",
                           () => _sendTo(i));
                };
                pop.appendChild(r);
              });

              // New tab — offered at the same threshold the "+" button uses, so
              // the two controls never disagree about whether there is room.
              const nr = document.createElement("div");
              const _full = _tabs.length >= MAX;
              nr.style.cssText = _full ? _deadStyle : _rowStyle;
              const na = document.createElement("span"); na.textContent = "New tab";
              nr.appendChild(na);
              if (_full) {
                const nb = document.createElement("span");
                nb.textContent = MAX + " open";
                nb.style.cssText = "font-size:9px;";
                nr.appendChild(nb);
                nr.style.cursor = "pointer";
                nr.onclick = (ev) => {
                  ev.stopPropagation();
                  // A refusal the user can read, rather than a row that does
                  // nothing when clicked.
                  _warn("You already have " + MAX + " tabs. Close one before sending to a new tab.");
                };
              } else {
                nr.onmouseenter = () => { nr.style.background = "rgba(109,184,232,0.18)"; };
                nr.onmouseleave = () => { nr.style.background = "rgba(109,184,232,0.08)"; };
                nr.onclick = (ev) => {
                  ev.stopPropagation();
                  _confirm("Send this result to a new Tab " + (_tabs.length + 1) + "?", _sendToNew);
                };
              }
              pop.appendChild(nr);

              _anchorPopover(pop, anchorEl);
            });

            const _render = () => {
              tabBar.innerHTML = "";
              _tabs.forEach((_, i) => {
                const t = document.createElement("div");
                const on = i === _active;
                // Tighter once there are more than five, so a full ten fit in
                // two rows at the editor's minimum width instead of four.
                const _tight = _tabs.length > 5;
                t.style.cssText =
                  "display:flex;align-items:center;gap:" + (_tight ? "5px" : "8px") +
                  ";padding:5px " + (_tight ? "8px" : "12px") + ";font-size:10px;cursor:pointer;" +
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
                // A click on the ALREADY-ACTIVE tab is not a switch —
                // without this it auto-discarded an in-progress review.
                t.onclick = () => { if (i !== _active) _switchTo(i); };
                tabBar.appendChild(t);
              });
              if (_tabs.length < MAX) {
                const add = document.createElement("div");
                add.textContent = "+";
                add.title = "New tab";
                add.style.cssText =
                  "padding:5px 11px;font-size:11px;cursor:pointer;color:#8ba5be;" +
                  "border:1px solid rgba(109,184,232,0.14);border-bottom:none;border-radius:8px 8px 0 0;background:#10151d;";
                add.onclick = () => {
                  _tabs[_active] = textEl.value;
                  // Make room in the index-keyed maps FIRST.
                  //
                  // The new tab lands at index `_tabs.length` of the
                  // CONCATENATED array _persistTabs writes — i.e. in front of
                  // anything parked in _overflowTabs, whose threads and undo
                  // stacks are still live under exactly those keys. Round 56
                  // pushed with no bookkeeping: close one visible tab (which
                  // shifts every key above it down, parked ones included, so
                  // they walk into visible range) then press "+", and the new
                  // blank tab showed a step count it never earned and sent a
                  // parked tab's direction to the model as EARLIER DIRECTION —
                  // then _iePersistThreads wrote it into the workflow under
                  // the new tab's key.
                  //
                  // With nothing parked there is no key at or above
                  // _at, so both calls are no-ops.
                  //
                  // PUSH FIRST, then shift. _ieThreadsRestoreTab ends with its
                  // own _iePersistThreads(), which prunes every key >= the live
                  // tab count — so shifting before the push persists against a
                  // count one too small and deletes the LAST parked tab's
                  // thread on the way past. (Driven: a 6-tab file, close one,
                  // press "+", and key 5 was gone from epe_ie_threads while it
                  // was still live in memory.) Nothing reads the maps between
                  // the push and the shift.
                  const _at = _tabs.length;
                  _tabs.push("");
                  if (textEl._epeUndoRestoreTab) textEl._epeUndoRestoreTab(_at);
                  if (typeof _ieThreadsRestoreTab === "function") _ieThreadsRestoreTab(_at);
                  _switchTo(_tabs.length - 1);
                  // Persist AFTER the switch, because the shift above may not
                  // have reached the file. _ieThreadsRestoreTab ends with its
                  // own _iePersistThreads(), and that returns early while a
                  // review is live — while _switchTo writes the grown epe_tabs
                  // regardless. So pressing "+" over an Enhance or Variations
                  // result saved a tab array with a new slot beside a thread map
                  // without one: the new blank tab owned a parked tab's
                  // direction, in the file, until something else happened to
                  // persist. _switchTo has parked or discarded the review by
                  // now, so this one runs.
                  try { _iePersistThreads(); } catch (_e) {}
                };
                tabBar.appendChild(add);
              }
            };
            const _switchTo = (i) => {
              // A review belongs to the tab it started on — _originalPrompt,
              // the thread snapshot and the chain are single, not per-tab — so
              // it cannot simply be left running across a switch.
              //
              // It used to be DISCARDED here, which threw away a result the
              // user had neither used nor discarded: generate variations, copy
              // one out to paste into another tab, come back, and the picker
              // was empty and the prompt had been rolled back. Nothing about
              // the switch actually touched the cards — they live in
              // variationsContainer, not textEl — so the loss was gratuitous.
              //
              // It is PARKED instead: pinned to this tab, restored below when
              // the user returns. A run still streaming has no result to keep,
              // and its tokens are landing in textEl, so that one is cancelled.
              if (_reviewMode === "streaming") _autoDiscardReview("Tab switch — request cancelled");
              else _reviewPark(String(_active));
              _tabs[_active] = textEl.value;      // save current
              _active = i;
              textEl.value = _tabs[i] || "";
              // Swap to this tab's own history, and do not record the swap:
              // an unmuted dispatch here put both tabs' text on one stack.
              if (textEl._epeUndoUseTab) textEl._epeUndoUseTab(i);
              if (textEl._epeUndoMute) textEl._epeUndoMute(true);
              try { textEl.dispatchEvent(new Event("input")); }
              finally { if (textEl._epeUndoMute) textEl._epeUndoMute(false); }
              // _ieRefresh, like the reopen path below already does. The
              // instruct panel resolves its thread from epe_tab_active at
              // render time, and every rendered step's delete button re-reads
              // the thread when CLICKED — so a panel left showing the old tab
              // deleted a step from the new one. Measured: after switching to
              // tab 2 the panel still showed tab 1's three steps and the chip
              // still said "3 steps"; clicking a row's delete emptied tab 2.
              _persistTabs(); _render(); _ieRefresh();
              // AFTER _persistTabs, so epe_tab_active — which _ieTabKey and the
              // instruct panel both read — already names the tab this review is
              // being rebuilt over.
              _reviewUnpark(String(_active));
            };
            const _closeTab = (i) => {
              // Closing any tab repaints the editor from saved tab text, so an
              // open review cannot just be left running — same rule as
              // _switchTo. But only the review belonging to the tab being
              // CLOSED has nowhere to go: closing tab 3 used to discard a
              // result under review on tab 1, which the user had not acted on
              // and which the close does not affect.
              if (_reviewMode === "streaming") _autoDiscardReview("Tab closed — request cancelled");
              else if (i === _active) _autoDiscardReview("Tab closed — result discarded");
              else _reviewPark(String(_active));
              // Save the live text before the splice reindexes: closing some
              // other tab used to drop whatever was unsaved in this one.
              _tabs[_active] = textEl.value;
              // B-3: capture what the close is about to destroy. This MUST run
              // before _ieThreadsDropTab and _epeUndoDropTab below, which is
              // why it is here and not beside the toast that uses it.
              _lastClosed = {
                idx: i, text: _tabs[i],
                thread: (() => {
                  try {
                    return (typeof _ieThreadGet === "function")
                      ? _ieThreadGet(String(i)).slice() : [];
                  } catch (_e2) { return []; }
                })(),
                hist: (() => {
                  try {
                    return textEl._epeUndoCaptureTab
                      ? textEl._epeUndoCaptureTab(i) : null;
                  } catch (_e2) { return null; }
                })(),
              };
              _tabs.splice(i, 1);
              // Undo history and instruct threads are keyed by tab index,
              // so the splice has to move them too — otherwise every tab
              // above the closed one inherits its neighbour's history, and
              // the instruct thread of a prompt that was never edited that
              // way is sent to the model as EARLIER DIRECTION.
              if (textEl._epeUndoDropTab) textEl._epeUndoDropTab(i);
              if (typeof _ieThreadsDropTab === "function") _ieThreadsDropTab(i);
              if (_active >= _tabs.length) _active = _tabs.length - 1;
              else if (i < _active) _active--;
              textEl.value = _tabs[_active] || "";
              if (textEl._epeUndoUseTab) textEl._epeUndoUseTab(_active);
              if (textEl._epeUndoMute) textEl._epeUndoMute(true);
              try { textEl.dispatchEvent(new Event("input")); }
              finally { if (textEl._epeUndoMute) textEl._epeUndoMute(false); }
              // _ieRefresh here too — see _switchTo. _closeTab moves
              // _active as well, and the panel's delete buttons re-read the
              // thread when clicked, so a stale row deletes from the tab that
              // is active now.
              _persistTabs(); _render(); _ieRefresh();
              // _ieThreadsDropTab has already renumbered the pins, so a park
              // held above the closed tab has moved down with it and the park
              // for the closed tab itself now has a null key. Drop that one,
              // then bring back whatever belongs to the tab we landed on.
              _reviewParkDrop();
              _reviewUnpark(String(_active));
              // Captured, not read back. _lastClosed is a single shared slot
              // and the callback used to read it at CLICK time: close tab A,
              // close tab B inside A's five-second toast, click A's Undo, and
              // B came back while A — already spliced out, its undo history
              // dropped and its instruct thread cleared — was gone for good.
              const _rec = _lastClosed;
              _toastUndo("Tab closed.", () => {
                if (!_rec) return;
                if (_tabs.length >= MAX) {
                  _toast("Close a tab first — the maximum is " + MAX + ".");
                  return false;      // keeps this toast, and its record, alive
                }
                // The same rule _closeTab and _switchTo follow, and for the
                // same reason: this moves _active, so a live review has to be
                // parked against the tab it belongs to FIRST.
                //
                // Round 41 got away without it — _closeTab discarded any
                // review unconditionally, so _reviewMode was always null by
                // the time this toast could be clicked. Round 42 made the
                // close park and unpark instead, and left this callback
                // behind: the line below then wrote the un-accepted AI result
                // into the tab array and _persistTabs shipped it into
                // node.properties.epe_tabs, destroying the tab's real prompt,
                // while the review bar stayed up over a different tab with
                // _originalPrompt naming the old one.
                let _parked = false;
                if (_reviewMode === "streaming") _autoDiscardReview("Tab restored — request cancelled");
                else _parked = _reviewPark(String(_active));
                // Whatever was typed since the close belongs to the tab that is
                // active right now — save it before _active moves.
                _tabs[_active] = textEl.value;
                // B-4. `_rec.idx` is where this tab was when it was CLOSED, and
                // the toast lives five seconds — another close inside that
                // window shifts the array out from under it. Splicing at a
                // stale index appended instead of inserting, left `_active`
                // past the end (empty editor, no tab highlighted), and the
                // muted dispatch below then wrote that empty string into the
                // out-of-range slot — a phantom tab that filled MAX and made
                // the OTHER toast's Undo refuse, turning that close permanent.
                //
                // ONE clamped index for all four uses. The splice, `_active`
                // and both keyed-map shifts have to agree, or the tab lands in
                // one place and its undo history and Instruct-Edit direction
                // in another. `_tabs.length` (not length-1) is a legal splice
                // position: it means append.
                const _at = Math.max(0, Math.min(_rec.idx, _tabs.length));
                _tabs.splice(_at, 0, _rec.text);
                // The close shifted every keyed map down by one; restoring
                // the tab shifts them back up, or every tab above it keeps
                // its lower neighbour's undo history and instruct thread
                // (fed to the model as EARLIER DIRECTION for a prompt it
                // never edited). The reopened tab starts both empty.
                if (textEl._epeUndoRestoreTab) textEl._epeUndoRestoreTab(_at);
                if (typeof _ieThreadsRestoreTab === "function") _ieThreadsRestoreTab(_at);
                // B-3: the slot at `_at` is open now — put back what the close
                // took. The undo history has to be installed BEFORE
                // _epeUndoUseTab below, which is what loads a tab's stored
                // stacks into the live ones.
                try {
                  if (textEl._epeUndoLoadTab) textEl._epeUndoLoadTab(_at, _rec.hist);
                } catch (_e2) {}
                // Through the sanctioned accessor, never by touching _ieThreads
                // from here — the K-2 reachability census forbids that, and it
                // exists because six wipes at one unsanctioned site once passed
                // 46 suites. An empty thread is left absent rather than written
                // as an empty key.
                try {
                  if (_rec.thread && _rec.thread.length &&
                      typeof _ieThreadSet === "function") _ieThreadSet(_rec.thread, String(_at));
                } catch (_e2) {}
                _active = _at;
                // Only if this toast is still the one holding the slot.
                if (_lastClosed === _rec) _lastClosed = null;
                if (textEl._epeUndoUseTab) textEl._epeUndoUseTab(_active);
                textEl.value = _tabs[_active] || "";
                if (textEl._epeUndoMute) textEl._epeUndoMute(true);
                try { textEl.dispatchEvent(new Event("input")); }
                finally { if (textEl._epeUndoMute) textEl._epeUndoMute(false); }
                _persistTabs(); _render(); _ieRefresh();
                // _ieThreadsRestoreTab shifts every key >= idx UP to make room
                // for the reinserted tab, so the slot we land on is by
                // construction the one slot no park can be pinned to. The park
                // made above is therefore never restored HERE — it is correct,
                // and it is waiting on the tab it belongs to. The round-43
                // comment claimed this line restored it; exhaustively checked
                // over every tab count, active index and closed index, it can
                // never fire. Kept only for the prune, and the user is told
                // where the result went rather than watching it vanish.
                _reviewParkDrop();
                if (!_reviewUnpark(String(_active)) && _parked) {
                  _toast("Result kept on its own tab.");
                }
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
                // _cleanup is ONE removeEventListener. The Back button and
                // the new-search path both pair it with pausing _activeVid;
                // dispose — the larger teardown — did not, so a looping
                // <video> was detached still playing and went on fetching and
                // decoding off-screen, holding the detail subtree with it.
                // src+load(), not just pause(): pause stops playback, it does
                // not release the media resource.
                const _endDetail = (d) => {
                  if (!d) return;
                  try { if (d._cleanup) { d._cleanup(); d._cleanup = null; } } catch (_e) {}
                  try {
                    if (d._activeVid) {
                      _epeReleaseVideosIn(d._activeVid);
                      d._activeVid = null;
                    }
                  } catch (_e) {}
                };
                try { _endDetail(civDetail); } catch (_e) {}
                try { _endDetail(genurDetail); } catch (_e) {}
                // The CARD LISTS, which are the large ones. Every other
                // list-clearing path — a new search, a media-toggle reset, the
                // detail Back buttons — releases these; dispose, the teardown
                // that is bigger than all of them, released only the open
                // detail video. A node deleted with a video-heavy Civitai
                // result set on screen left up to 600 <video> elements with
                // their src still attached: ~12 MB by this round's own
                // measurement, and each one still holding a decoder.
                try { _epeReleaseVideosIn(civList); } catch (_e) {}
                try { _epeReleaseVideosIn(genurList); } catch (_e) {}
                try { _epeReleaseVideosIn(wfList); } catch (_e) {}
                try { _civScrollObs.disconnect(); } catch (_e) {}
                try { _genurScrollObs.disconnect(); } catch (_e) {}
                try { _wfObserver.disconnect(); } catch (_e) {}
                // In-flight /extract-workflow probes: abort them all so a
                // slow response after node destruction cannot touch the
                // torn-down editor DOM via _setGetWfBtn.
                try {
                  for (const _ac of _wfProbeAborts) { try { _ac.abort(); } catch (_e2) {} }
                  _wfProbeAborts.clear();
                } catch (_e) {}
                // Font-sizer observers — one per Civitai/Genur detail open
                // and per library card render. They only self-cleanup on a
                // style mutation, so a silent removal leaves them running.
                try {
                  for (const _o of _fsObservers) { try { _o.disconnect(); } catch (_e2) {} }
                  _fsObservers.length = 0;
                } catch (_e) {}
                try { typeof _closeStyleMenu === "function" && _closeStyleMenu(); } catch (_e) {}
                // _hideEpeTip first: it clears the pending timer as well as
                // hiding the element. Removing the element alone left the
                // callback armed, holding the button and the surrounding
                // closure until it fired against a detached node.
                try { _hideEpeTip(); } catch (_e) {}
                try { _epeTip.remove(); } catch (_e) {}
                // Everything below was registered OUTSIDE this node's own DOM
                // subtree, so none of it dies when floatingWin is removed.
                // Each survivor kept a document-level listener or an observer
                // alive holding the editor closure — textEl, the undo stacks,
                // the loaded result grids, _epeOwnerNode itself. A
                // workflow-tab switch destroys and rebuilds the node, so they
                // accumulated one set per switch.
                //
                // Variations-card outside-click listener: added in the card
                // renderer, removed only by _clearVariationsCards, which no
                // dispose path called.
                try { _clearVariationsCards(); } catch (_e) {}
                // Library-card outside-click listener: added by _expandTA on
                // whichever card is open, removed only by _collapseTA. Only
                // one card can be expanded at a time and rpList._openTA is
                // it. Release rather than collapse — a full collapse would
                // run _commitEdit and write to the library on node deletion.
                try {
                  const _openTA = rpList && rpList._openTA;
                  if (_openTA && _openTA._epeReleaseOutside) _openTA._epeReleaseOutside();
                  if (rpList) rpList._openTA = null;
                } catch (_e) {}
                // Dropdown menus mount on document.body. _closeDropdown was
                // only ever reached from closeEditor, which does not run for
                // the embedded node — so deleting the node with a menu open
                // left it floating over the canvas.
                // All of them. The two named dropdowns were the only ones
                // reached here; the variation cards build their own pair on
                // every render and those orphaned on document.body.
                try { _closeAllDropdowns(); } catch (_e) {}
                try { _epeDropdowns.clear(); } catch (_e) {}
                // ResizeObserver on bodyWrap — the root of the editor subtree.
                try { if (_libFitRO) _libFitRO.disconnect(); } catch (_e) {}
                // An in-flight generation keeps streaming into a detached
                // textEl and holds the editor for the life of the request.
                try { if (_aiAbort) { _aiAbort.abort(); _aiAbort = null; } } catch (_e) {}
                try { if (_rpSearchT) { clearTimeout(_rpSearchT); _rpSearchT = null; } } catch (_e) {}
                // A drag in progress holds two window listeners that only
                // _libOnUp removes, and this node never reaches one.
                try { _libEndDrag(); } catch (_e) {}
                // All three dividers, not just the Library one. These two are
                // declared further down the same builder scope; dispose only
                // ever runs after layout is fully assembled, and the try/catch
                // covers the impossible case where it does not.
                try { _tuneEndDrag(); } catch (_e) {}
                try { _railEndDrag(); } catch (_e) {}
                // The node's own resize grip (window listeners) and the help
                // window's resize and header drags (document listeners). All
                // three close over this scope, so a drag left open holds the
                // whole editor.
                try { if (_epeOwnerNode && _epeOwnerNode._epeEndGripDrag) _epeOwnerNode._epeEndGripDrag(); } catch (_e) {}
                try { if (helpOverlay._epeEndResize) helpOverlay._epeEndResize(); } catch (_e) {}
                try { if (helpOverlay._epeEndMove) helpOverlay._epeEndMove(); } catch (_e) {}
                // The wireless picker, which lives on document.body and holds
                // {widget, node} for every text widget in the graph.
                try { _epeCloseTargetPicker(); } catch (_e) {}
                // Drop this node's AbortController entry. Nothing pruned the
                // map, so one accumulated per node instance for the life of
                // the page.
                // WIN_ID, which is what claim()/_abortPrevious() key on — a
                // stable per-instance string. Passing the node object would
                // stringify to "[object Object]" for every node and collide.
                try { _epeOllamaVision._releaseOwner(WIN_ID); } catch (_e) {}
                // A model pull outlives the panel it was started from and, on
                // completion, calls back into an editor that no longer exists.
                // Nothing reached it from here at all.
                // This node's pulls, not the page's. See _pullAbortOwn.
                try { _epeOllamaVision._pullAbortOwn(WIN_ID); } catch (_e) {}
                // The three browser panes. Nothing reached these at all: a
                // page in flight came back to a destroyed editor and built a
                // screenful of cards and image requests for nobody.
                try { if (_civState.abort) { _civState.abort.abort(); _civState.abort = null; } } catch (_e) {}
                try { if (_genurState.abort) { _genurState.abort.abort(); _genurState.abort = null; } } catch (_e) {}
                try { if (_wfAbort) { _wfAbort.abort(); _wfAbort = null; } } catch (_e) {}
                try { _cancelWordAltGrace(); } catch (_e) {}
                try { if (_wordAltAbort) { _wordAltAbort.abort(); _wordAltAbort = null; } } catch (_e) {}
              };
            }
            // Restore hook — ComfyUI restores properties AFTER this builds, so
            // onConfigure calls this to reload saved tabs and repaint.
            if (_epeOwnerNode) {
              _epeOwnerNode._epeTabRestore = () => {
                // _autoDiscardReview → _reviewExit → _iePersistThreads runs
                // BEFORE _tabs is replaced with the incoming set. Pruning
                // against the OLD tab count drops threads for indices that
                // are about to become valid — silently losing per-tab
                // instruct history on any workflow reload that has a live
                // review AND the incoming workflow has more tabs. Gate
                // _iePersistThreads via _epeRestoring for the whole restore.
                _epeOwnerNode._epeRestoring = true;
                try {
                const pp = _epeOwnerNode.properties || {};
                // A configure replaces the tab list and the active index
                // wholesale, so nothing that belongs to the OLD list survives
                // it. A live review was left with its strips up over text this
                // was about to overwrite — the result gone, the bar still
                // claiming to review it — and a park was left pinned to an
                // index that now names a different prompt, ready to drop a
                // stale result over it on the next tab round trip.
                if (_reviewMode) _autoDiscardReview("Workflow reloaded — result discarded");
                try {
                  while (_reviewParks.length) {
                    const _p = _reviewParks.pop();
                    try { _ieUnpin(_p.pin); } catch (_e2) {}
                  }
                } catch (_e) {}
                // Does this configure carry a tab identity at all?
                //
                // A workflow file can name an EPE node without naming its
                // tabs — hand-edited, written by a third-party tool, or saved
                // by a build that predates them. The third outcome below
                // deliberately leaves `_tabs` alone in that case rather than
                // wiping them, and everything else that belongs to the
                // outgoing workflow answers the same question, or the guard is
                // only as good as the one line it covers.
                //
                // NOT "properties arriving in pieces". That was asserted here
                // from round 59 and refuted in round 63: one configure carries
                // the whole bag and fires onConfigure once. See the register.
                // Same answer, same source: what onConfigure saw in the
                // incoming payload. Reading `pp` here is reading the node's own
                // container, which the build has already seeded — the test was
                // unconditionally true and the guard did nothing.
                const _realCfg = !!_epeOwnerNode._epeCfgEvidence;
                // The per-tab undo stacks belong to the OUTGOING workflow too.
                //
                // _epeUndoUseTab returns early when the key has not changed,
                // and the incoming workflow's active index is usually the same
                // 0 — so the outgoing workflow's live stack stayed loaded
                // across the switch. Measured: open workflow A, edit it, click
                // to workflow B, press Ctrl+Z once, and B's prompt was replaced
                // by A's text on screen AND in B's file, because the restore's
                // dispatch is muted but the undo's is not.
                if (_realCfg && textEl._epeUndoResetAll) textEl._epeUndoResetAll();
                // Belongs to the OUTGOING workflow, so it goes with it — but
                // only once we know there IS an incoming one. Unguarded, a
                // partial configure deleted the parked tail while leaving the
                // visible tabs on screen, and the next keystroke persisted the
                // truncated array.
                if (_realCfg) _overflowTabs = [];
                // `_realCfg &&` on BOTH branches, or the guard is a lie.
                //
                // _realCfg comes from the incoming payload; `pp` is the node's
                // own merged container, which never shrinks. Round 60 gated the
                // three resets on the first and left the branch tests on the
                // second, so a payload carrying neither key still REPLACED the
                // tab list from the stale residue while declining to reset the
                // undo stack that belonged to what it replaced — a hybrid of
                // two workflows, with the comments above still claiming the two
                // tests could not disagree. One gate for all five.
                if (_realCfg && Array.isArray(pp.epe_tabs) && pp.epe_tabs.length) {
                  // Validate: workflow files are shared and hand-editable. A
                  // non-string entry became "[object Object]" in the editor
                  // (and in every wireless target); a bad active index gave
                  // an empty editor and filed instruct threads under keys
                  // like "-1".
                  //
                  // Reconcile FIRST, then truncate — otherwise a workflow
                  // saved with 6 tabs (say active=5) had its committed
                  // epe_prompt written into `_tabs[_active_clamped_to_3]`,
                  // clobbering a surviving tab that had never been touched.
                  // The dispatch below then persisted that mangled array.
                  const _fullTabs = pp.epe_tabs.map(t => typeof t === "string" ? t : "");
                  const _rawActive = parseInt(pp.epe_tab_active, 10);
                  const _origActive = Math.max(0,
                    Math.min(Number.isFinite(_rawActive) ? _rawActive : 0, _fullTabs.length - 1));
                  // epe_prompt is the value this node actually committed, and
                  // the value the graphToPrompt hook injects at queue time.
                  // epe_tabs is a MIRROR of it, maintained by the input
                  // listener — and the two can be out of step in any workflow
                  // saved before that mirroring was made reliable, or in one
                  // that has been hand-edited or came from someone else.
                  // An EMPTY epe_prompt is not evidence of anything and must
                  // not be allowed to wipe a tab that has text in it.
                  const _committed = (typeof pp.epe_prompt === "string") ? pp.epe_prompt : "";
                  if (_committed) {
                    if (_origActive < MAX) {
                      // Common case: original active is a surviving slot.
                      // Reconcile into it directly.
                      if (_committed !== _fullTabs[_origActive]) {
                        _fullTabs[_origActive] = _committed;
                      }
                    } else {
                      // Original active is beyond MAX. The committed prompt
                      // is what the user was LAST editing at save time and
                      // what graphToPrompt injects at queue time — it MUST
                      // survive the restore. Reclaim `_fullTabs[MAX-1]` for
                      // it; any pre-existing content there is displaced.
                      //
                      // A prior version left MAX-1 alone in this case and
                      // relied on `properties.epe_prompt` to survive as a
                      // side channel — but the input dispatch at the end of
                      // this function overwrites epe_prompt with the
                      // currently-visible tab's content, and the
                      // graphToPrompt hook reads textEl.value, not
                      // properties.epe_prompt. Result: silent committed-
                      // prompt loss on the restore itself. So we reclaim,
                      // and log/toast rather than lose the recent edit.
                      const _tail = _fullTabs[MAX - 1] || "";
                      // SWAP. The tab being displaced from the last visible
                      // slot takes the slot the committed prompt came from —
                      // which is beyond MAX, so it is parked rather than lost.
                      //
                      // This was a plain overwrite, which round 55 could get
                      // away with because everything past MAX was being thrown
                      // out anyway. Round 56 started preserving the tail, and
                      // the overwrite became visible: a 6-tab file saved with
                      // active=5 came back as t0,t1,t2,t5,t4,t5 — tab 3 gone,
                      // tab 5 twice.
                      //
                      // `_fullTabs[_origActive]` is epe_tabs' MIRROR of the
                      // active tab; `_committed` is epe_prompt, which is
                      // authoritative for that slot. Overwriting the mirror
                      // with the displaced tail therefore costs nothing.
                      _fullTabs[_origActive] = _fullTabs[MAX - 1];
                      // B-5: the same permutation, applied to the index-keyed
                      // thread map. Both or neither — a tab and its direction
                      // must never move apart.
                      try {
                        if (typeof _ieThreadsSwapTabs === "function")
                          _ieThreadsSwapTabs(_origActive, MAX - 1);
                      } catch (_e2) {}
                      if (_tail !== "" && _tail !== _committed) {
                        try { console.warn("[EPE] tab restore: workflow had " + _fullTabs.length + " tabs, MAX is " + MAX + "; showing your most-recent (committed) prompt from tab " + _origActive + " in slot " + (MAX-1) + ", displacing its previous content."); } catch (_e2) {}
                        try { if (typeof _toast === "function") _toast("Workflow has more tabs than fit — showing your most recent edit."); } catch (_e2) {}
                      }
                      _fullTabs[MAX - 1] = _committed;
                    }
                  }
                  _tabs = _fullTabs.slice(0, MAX);
                  // Parked, not dropped. Reset first: a second restore of a
                  // SMALLER workflow must not keep the previous file's tail.
                  _overflowTabs = _fullTabs.slice(MAX);
                  if (_overflowTabs.length && !_overflowToldOnce) {
                    _overflowToldOnce = true;
                    try { console.warn("[EPE] tab restore: workflow has "
                      + _fullTabs.length + " tabs and this build shows " + MAX
                      + "; the remaining " + _overflowTabs.length
                      + " are kept in the file and will be saved back."); } catch (_e2) {}
                    try { if (typeof _toast === "function")
                      _toast("This workflow has " + _fullTabs.length
                             + " prompt tabs — showing the first " + MAX
                             + ". The rest are kept in the file."); } catch (_e2) {}
                  }
                  // Belt and braces. Everything was dropped above, before
                  // the list was replaced; this catches a park made between
                  // the two by anything re-entrant, and a key that is not a
                  // number at all.
                  try {
                    for (let _p = _reviewParks.length - 1; _p >= 0; _p--) {
                      const _n = parseInt(_reviewParks[_p].pin.key, 10);
                      if (!Number.isFinite(_n) || _n >= _tabs.length) {
                        _ieUnpin(_reviewParks[_p].pin);
                        _reviewParks.splice(_p, 1);
                      }
                    }
                  } catch (_e) {}
                  // If the workflow's active tab was beyond MAX, clamp to
                  // the last surviving slot — which now HOLDS the committed
                  // prompt (see the reconcile above), so the user lands on
                  // the value they had when they saved.
                  _active = Math.min(_origActive, _tabs.length - 1);
                  // Point the undo machinery at the restored tab BEFORE any
                  // dispatch: leaving it keyed to tab 0 while _active is
                  // elsewhere is exactly the cross-tab history bleed the
                  // per-tab stacks exist to prevent.
                  if (textEl._epeUndoUseTab) textEl._epeUndoUseTab(_active);
                  textEl.value = _tabs[_active] || "";
                  // Muted: a restore is not a user edit and must not become
                  // an undo step.
                  if (textEl._epeUndoMute) textEl._epeUndoMute(true);
                  try { textEl.dispatchEvent(new Event("input")); }
                  finally { if (textEl._epeUndoMute) textEl._epeUndoMute(false); }
                  _render();
                } else if (_realCfg && typeof pp.epe_prompt === "string") {
                  // No epe_tabs, but this IS a saved EPE node (it has an
                  // epe_prompt). The tab list belongs to the OUTGOING
                  // workflow; keeping it meant a single-prompt file opened
                  // showing the previous file's tabs, with the new prompt
                  // dropped into slot 0 beside them.
                  //
                  // Guarded on epe_prompt so a payload that names this node
                  // without naming a prompt — hand-edited, or from a tool that
                  // writes only some keys — cannot wipe the tabs.
                  //
                  // This comment used to say "a partial configure — properties
                  // arriving in pieces, which ComfyUI does". It does not; see
                  // the register's verified contract.
                  _tabs = [pp.epe_prompt];
                  _active = 0;
                  if (textEl._epeUndoUseTab) textEl._epeUndoUseTab(0);
                  textEl.value = pp.epe_prompt;
                  if (textEl._epeUndoMute) textEl._epeUndoMute(true);
                  try { textEl.dispatchEvent(new Event("input")); }
                  finally { if (textEl._epeUndoMute) textEl._epeUndoMute(false); }
                  _render();
                }
                } finally {
                  // Release the persist-gate now that _tabs matches the
                  // incoming set. Anything the dispatch above set in motion
                  // (e.g. a follow-up _iePersistThreads) can now write
                  // against the correct tab count.
                  try { _epeOwnerNode._epeRestoring = false; } catch (_e) {}
                  // Explicitly persist threads once now that we're settled,
                  // so any pruning is against the CORRECT (new) _tabs.
                  try { _iePersistThreads(); } catch (_e) {}
                }
              };
            }
          })();
          // ═══════════════════════════════════════════════════════════════════

          // ── Instruct-edit row (natural-language prompt direction) ──────────
          // The input is a wrapping textarea that grows with the instruction, and
          // the whole operation runs through the shared review machinery so it
          // gets Cancel / Discard / the original-prompt strip / follow-up actions
          // exactly like Enhance, Variations and Inverter.
          const ieRow = document.createElement("div");
          ieRow.style.cssText =
            "display:flex;gap:6px;align-items:flex-end;flex-shrink:0;margin:-1px -1px 0;" +
            "background:rgba(109,184,232,0.07);border:1px solid rgba(109,184,232,0.14);" +
            "border-radius:8px 8px 0 0;padding:6px 6px 6px 10px;";
          const iePen = document.createElement("span");
          iePen.textContent = "✎"; iePen.style.cssText = "color:#6db8e8;font-size:11px;padding-bottom:4px;flex-shrink:0;";

          const ieInput = document.createElement("textarea");
          ieInput.rows = 1;
          ieInput.spellcheck = false;
          ieInput.placeholder = 'Describe an edit — "change the lighting to golden hour", "reframe as a war photograph"…  (Enter applies, Shift+Enter new line)';
          ieInput.style.cssText =
            "flex:1;background:none;border:none;outline:none;color:#dce6f2;font-size:11px;" +
            "font-family:inherit;resize:none;line-height:1.55;overflow-y:auto;" +
            "min-height:20px;max-height:118px;padding:3px 0;";
          // scrollHeight is 0 until the element has been laid out, so an early
          // _ieGrow() used to set height:0 and the box became impossible to
          // click into. Floor it so there is always something to hit.
          const _ieGrow = () => {
            ieInput.style.height = "auto";
            const h = ieInput.scrollHeight || 20;
            ieInput.style.height = Math.max(20, Math.min(h, 118)) + "px";
          };
          // Keep the canvas from swallowing the click that should focus the box.
          // stopPropagation only — no preventDefault, so the browser still focuses.
          ieInput.addEventListener("pointerdown", (e) => { e.stopPropagation(); });
          ieInput.addEventListener("mousedown",   (e) => { e.stopPropagation(); });
          // Clicking into the box is a deliberate "I want to work on instructions",
          // so surface the panel immediately: open the Library column if it is
          // collapsed and switch to the Instruct Edit tab. Previously this only
          // happened on the first keystroke, which was unreachable while the box
          // could not be focused at all.
          ieInput.addEventListener("focus", () => {
            ieInput._epeJumped = true;   // typing shouldn't jump again afterwards
            try { _libSetCollapsed(false); } catch (_e) {}
            try { _setRpTab("instruct", {keepReview:true}); _ieShowPane("live"); } catch (_e) {}
          });

          // Steps chip — shows the thread depth and jumps to the panel.
          const ieChip = document.createElement("span");
          ieChip.style.cssText =
            "font-size:9px;color:#a8d6f5;background:rgba(109,184,232,0.16);cursor:pointer;" +
            "border:1px solid rgba(109,184,232,0.35);border-radius:9px;padding:3px 8px;white-space:nowrap;" +
            "display:none;align-items:center;justify-content:center;line-height:1;";
          ieChip.title = "Open the Instruct Edit thread";
          ieChip.onclick = () => { _libSetCollapsed(false); _setRpTab("instruct", {keepReview:true}); _ieShowPane("live"); };
          _ieUpdateChip = () => {
            const n = _ieThreadGet().length;
            ieChip.textContent = n + (n === 1 ? " step" : " steps");
            ieChip.style.display = n ? "flex" : "none";
          };

          const ieBtn = document.createElement("button");
          ieBtn.textContent = "Apply Edit";
          ieBtn.style.cssText =
            "background:rgba(109,184,232,0.2);border:1px solid rgba(140,200,240,0.5);white-space:nowrap;" +
            "border-radius:6px;color:#c2e2f8;font-size:11px;padding:5px 12px;cursor:pointer;font-family:inherit;" +
            "display:flex;align-items:center;justify-content:center;line-height:1;";

          const ieStack = document.createElement("span");
          ieStack.style.cssText = "display:flex;gap:6px;align-items:center;flex-shrink:0;padding-bottom:1px;";
          ieStack.appendChild(ieChip); ieStack.appendChild(ieBtn);

          // Core: run one instruction through the review machinery.
          // Returns true when a usable result landed.
          const _ieApplyOne = async (instr, opts) => {
            opts = opts || {};
            const settings = _epeOllama.getSettings ? _epeOllama.getSettings() : {};
            if (!settings.model) { _toast("No Ollama model selected (AI Setup)."); return false; }

            const sys = settings.instructPrompt || _epeOllama._defaults.instructPrompt;
            // Prior direction gives relative instructions ("dial that back") a
            // referent. Excluded when replaying a saved sequence step, which
            // carries its own preceding steps.
            const ctx = (opts.context || []).filter(Boolean);
            const usr =
              (ctx.length ? "EARLIER DIRECTION (oldest first):\n- " + ctx.join("\n- ") + "\n\n" : "") +
              "PROMPT:\n" + textEl.value +
              "\n\nINSTRUCTION: " + instr;

            // Enter review: fresh entry snapshots the prompt; a chained call
            // (mid-sequence) keeps the original from the first step.
            if (_reviewMode) {
              _reviewSetMode("streaming");
              // Chained edit. Hold the result this step is about to replace —
              // it becomes an undo step only if the chain is kept. That is what
              // makes ↶ walk a committed chain one edit at a time without
              // leaving anything behind when a chain is abandoned.
              _ieChainUndo.push(textEl.value);
            } else {
              _reviewEnter("streaming");
              _ieThreadSnapshot = _ieThreadGet().slice();   // fresh entry — mark the rollback point
            }
            _ieReviewIsInstruct = true;

            // The pre-edit prompt is on the stack now; keep everything this call
            // writes off it, so one edit is one undo step.
            if (textEl._epeUndoMute) textEl._epeUndoMute(false), textEl._epeUndoMute(true);
            // Abort whatever is still running before taking the slot. Without
            // this, starting an instruct edit while Enhance streamed left both
            // alive and their onToken writes interleaved in the same textarea.
            // Through _epeTakeAiSlot, not inline — the same correction
            // runAiAction got. Inline this aborted _aiAbort and left a vision
            // run in flight, and when that landed it took the slot back,
            // aborted the edit the user was watching, and replaced it with a
            // caption for an image they had moved on from.
            _epeTakeAiSlot();
            // Own controller held locally: the shared _aiAbort may be taken
            // over by a newer request while this one unwinds, and nulling it
            // blindly in the finally made Cancel/Esc a no-op on the stream
            // that actually owned it.
            const _ieCtrl = new AbortController();
            _aiAbort = _ieCtrl;
            let ok = false;
            try {
              let tokenCount = 0;
              const raw = await _epeStreamGenerate(
                sys, usr,
                {
                  signal: _ieCtrl.signal,
                  // Rewrites can be long; without a floor this inherits Ollama's
                  // default and truncates mid-sentence on sweeping edits.
                  options: { temperature: 0.4, num_predict: 2048 },
                },
                null,
                (partial) => {
                  tokenCount++;
                  textEl.value = partial;
                  updateTokenBadge(partial);
                  textEl.scrollTop = textEl.scrollHeight;
                  reviewLabel.textContent = (opts.label || "Applying edit") + `… ${tokenCount} tokens`;
                }
              );
              const out = _epeOllama.cleanResponse(raw || "").trim();
              if (out) {
                textEl.value = out;
                textEl.dispatchEvent(new Event("input"));
                updateTokenBadge(out);
                ok = true;
              } else {
                _toast("No edit returned.");
              }
            } catch (err) {
              if (err && err.name === "AbortError") {
                // Discard/Cancel already restored the original prompt.
                return false;
              }
              _toast((err && err.message) || "Ollama request failed.");
            } finally {
              if (_aiAbort === _ieCtrl) _aiAbort = null;
              if (textEl._epeUndoMute) textEl._epeUndoMute(false);
            }
            return ok;
          };

          // `token` identifies the review this call entered. A superseded
          // call must not restore, exit, or unload on behalf of the review a
          // newer call now owns.
          const _ieFinish = (ok, label, token) => {
            if (token !== undefined && token !== _ieReviewToken) return;
            if (ok) {
              _reviewSetMode("single");
              reviewLabel.textContent = label || "Reviewing edited prompt";
            } else if (_reviewMode) {
              // Restore and leave review; nothing usable came back.
              if (_originalPrompt !== null) {
                textEl._epeRestoreValue(_originalPrompt);
                updateTokenBadge(textEl.value);
              }
              // ROUND 66 (V-3): same as the other three non-commit exits.
              if (textEl._epeUndoReviewRollback) textEl._epeUndoReviewRollback();
              _reviewExit();
            }
            try { _epeOllama.unloadModel(); } catch (_e) {}
          };

          // Mid-review, textEl is not the prompt: it holds an un-accepted
          // result, a half-streamed partial, or — in variations mode, where it
          // is hidden entirely — the raw multi-variation model dump.
          // runAiAction has refused on exactly this condition since round 5;
          // _ieApplyOne read textEl.value with no guard, so Apply Edit on a
          // variations review sent the numbered list of three prompts as the
          // PROMPT, destroyed the cards, and pushed the instruction into the
          // thread as direction for a prompt that never existed.
          //
          // The guard lives here rather than in _ieApplyOne because
          // _ieFinish(false) exits the review — which for a variations review
          // means discarding the cards, i.e. doing the damage it is meant to
          // prevent.
          const _ieBlockedByReview = () => {
            if (_reviewMode && _reviewMode !== "single") {
              _toast("Finish the current result first — use it, or discard it.");
              return true;
            }
            return false;
          };

          const _runInstructEdit = async () => {
            const instr = ieInput.value.trim();
            if (!instr) return;
            if (_ieBlockedByReview()) return;
            // The instruction deliberately stays in the box for reuse, so a
            // second Enter is one keystroke away. Without this the second
            // call aborted the first, and the FIRST call's unwind then tore
            // down the review the second had just entered — after which the
            // live stream persisted every token into node.properties with no
            // review bar and no way to discard it.
            if (ieBtn.disabled) return;
            ieBtn.textContent = "…"; ieBtn.disabled = true;
            const _tok = ++_ieReviewToken;
            // Pinned before the await: the push below lands on the tab the
            // edit was made against, not on whichever tab is active when the
            // model finally answers. A registered pin, so closing or reopening
            // a tab meanwhile moves it with the renumbering instead of leaving
            // it pointing at somebody else's tab.
            const _editPin = _iePin(_ieTabKey());
            let ok = false;
            // EVERYTHING that has to happen whatever the outcome is in the
            // finally, not just the unpin. Round 40 wrapped the sequence
            // replay's loop in a try/finally and called this the twin it was
            // copying — but this one only ever released the pin. `ieBtn` was
            // left disabled by a throw from _ieApplyOne outside its own inner
            // try (_reviewEnter builds DOM, _epeTakeAiSlot, _toast) or from
            // _ieThreadPush, and the guard sixteen lines up is
            // `if (ieBtn.disabled) return;` — so every later Apply Edit click
            // and every later Enter became a silent no-op for the life of the
            // node, with no message and no way back.
            try {
              ok = await _ieApplyOne(instr, { context: _ieContext(), label: "Applying edit" });
              // A null key means the tab this edit belonged to was closed
              // while the model was answering; there is nothing left to push
              // to. Inside the try, so a throw here still lands below.
              if (ok && _editPin.key !== null) _ieThreadPush(instr, _editPin.key);   // instruction stays in the box for reuse
            } finally {
              try { _ieUnpin(_editPin); } catch (_e) {}
              try { _ieFinish(ok, undefined, _tok); } catch (_e) {}
              try { ieBtn.textContent = "Apply Edit"; ieBtn.disabled = false; } catch (_e) {}
            }
          };

          // Replay a saved sequence: each step sees the result of the last, and
          // the executed steps land in the live thread so later relative
          // direction still resolves.
          _ieRunSequence = async (steps, name) => {
            if (!steps || !steps.length) return;
            if (ieBtn.disabled) return;
            if (_ieBlockedByReview()) return;
            ieBtn.textContent = "…"; ieBtn.disabled = true;
            // Same token discipline _runInstructEdit uses. runAiAction bumps
            // _ieReviewToken when it enters review, so an Enhance started
            // while this sequence was still running left the sequence's
            // _ieFinish(false) free to call _reviewExit() and restore
            // _originalPrompt over the review the user had just opened.
            const _tok = ++_ieReviewToken;
            _setRpTab("instruct"); _ieShowPane("live");
            // The tab this replay belongs to, pinned before the first await.
            // Every thread write below used to resolve the tab afresh, so a
            // switch mid-replay redirected them at the tab the user had just
            // moved to and destroyed its direction.
            //
            // A REGISTERED pin, not a captured string: round 24's version was
            // a tab index, and closing a tab renumbers every index above it,
            // so the pin came out of the close naming a different tab. The
            // shifters move live pins now; a null key means the pinned tab is
            // gone and this replay must stop writing.
            const _seqPin = _iePin(_ieTabKey());
            // Released in a finally, like the single-edit twin. Everything
            // between here and the unpin can throw — _ieThreadSet persists and
            // rebuilds DOM, _ieApplyOne enters and sets review mode — and a
            // throw stranded the pin in _ieTabPins for good, where every tab
            // close and restore went on renumbering it, with ieBtn left
            // disabled for the session.
            const _seqRelease = () => {
              try { _ieUnpin(_seqPin); } catch (_e) {}
              _ieRunningIdx = -1;
              try { _ieRefresh(); } catch (_e) {}
              try { ieBtn.textContent = "Apply Edit"; ieBtn.disabled = false; } catch (_e) {}
            };
            const _seqTab = _seqPin.key;
            const base = _ieThreadGet(_seqTab).slice();
            // Was a review ALREADY open when the sequence started? If so the
            // first step chains into it, _ieApplyOne does not re-snapshot,
            // and the live snapshot is the correct pre-chain rollback point
            // — re-marking it below would bury the earlier chain's own
            // uncommitted instructions in the persisted thread.
            const _seqFreshEntry = !_reviewMode;
            let ok = false;
            // The loop below runs inside a try whose finally is _seqRelease.
            // Round 38 extracted the release into a helper and then called it
            // on the normal path only — so the comment above it claimed a
            // finally that did not exist, and a throw anywhere in the loop
            // left Apply Edit disabled for the rest of the session with the
            // pin stranded in _ieTabPins.
            try {
            for (let i = 0; i < steps.length; i++) {
              // The tab moved out from under the replay. Every later step
              // would be editing a prompt that is no longer on screen — and
              // the switch has already discarded the review this was running
              // in — so stop, and roll this tab's thread back below.
              // The tab moved out from under the replay — switched away from,
              // or closed (in which case the pin's key is null).
              if (_seqPin.key === null || _ieTabKey() !== _seqPin.key) { ok = false; break; }
              _ieThreadSet(base.concat(steps.slice(0, i + 1)), _seqPin.key);
              // The cap may trim the front — the running step is always the
              // last entry of what is actually stored.
              _ieRunningIdx = _ieThreadGet(_seqPin.key).length - 1;
              const lbl = 'Running “' + (name || "sequence") + '” — step ' + (i + 1) + " of " + steps.length;
              ok = await _ieApplyOne(steps[i], { context: base.concat(steps.slice(0, i)), label: lbl });
              // The fresh review entry inside the first _ieApplyOne snapshots
              // the thread AS IT IS — which already held step 1. Re-mark the
              // rollback point at the true pre-sequence state, so Discard
              // does not leave step 1 behind in the persisted thread.
              if (i === 0 && ok && _seqFreshEntry) _ieThreadSnapshot = base.slice();
              if (!ok) {
                // _ieFinish(false) restores the prompt this review entered
                // with, so the thread rolls back to match — steps whose
                // effects were just rolled back must not survive as
                // direction. On a chained run that is the snapshot taken
                // before the whole chain, not this sequence's own base.
                // Only if the tab is still there. Writing this rollback with
                // a stale index is what put one tab's direction into another.
                if (_seqPin.key !== null) {
                  _ieThreadSet((!_seqFreshEntry && _ieThreadSnapshot) ? _ieThreadSnapshot : base, _seqPin.key);
                }
                break;
              }
            }
            } finally {
              _seqRelease();
              // _ieFinish too, for the same reason: a throw in the loop used
              // to skip it, leaving the review bar open over a prompt whose
              // replay had already stopped. ok is false on that path, which
              // is the correct recovery — restore and tear down.
              try {
                _ieFinish(ok, ok ? 'Reviewing “' + (name || "sequence") + '”' : undefined, _tok);
              } catch (_e) {}
            }
          };

          ieBtn.onclick = _runInstructEdit;
          ieInput.addEventListener("input", () => {
            _ieGrow();
            // First keystroke opens the panel on the thread — once per thread, so
            // it can't keep yanking you back while you browse another tab.
            if (!ieInput._epeJumped) {
              ieInput._epeJumped = true;
              _libSetCollapsed(false);
              _setRpTab("instruct", {keepReview:true});
              _ieShowPane("live");
            }
          });
          ieInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); _runInstructEdit(); }
          });
          ieRow.appendChild(iePen); ieRow.appendChild(ieInput); ieRow.appendChild(ieStack);
          leftPane.insertBefore(ieRow, bar);
          _ieGrow();
          _ieUpdateChip();
        })();
        // ════════════════════════════════════════════════════════════════════

        // ── Tuning block — Style tuning + Wireless targets as ONE unit ──────
        // Previously these were two independent siblings and only Style tuning
        // could be hidden, which left the wireless chips stranded on their own.
        // They now share a wrapper whose height is driven by the divider above
        // it, so one gesture clears both and the editor takes back the space.
        const tuneWrap = document.createElement("div");
        // overflow hidden here; btnRow below carries the scroll — when the block is dragged shorter than
        // its content the wireless "+ Add target" button would otherwise be
        // clipped with no way to reach it.
        tuneWrap.style.cssText =
          "display:flex;flex-direction:column;flex:0 0 auto;min-height:0;overflow:hidden;";
        tuneWrap.appendChild(styleSection);
        tuneWrap.appendChild(btnRow);       // btnRow === the wireless-targets footer

        // The two halves are sized explicitly rather than left to flex, because
        // flex shrinks every shrinkable child at once and what is wanted here is
        // strict priority: the sliders give up all of their height first, and
        // only once they are gone does the wireless section start to close.
        styleSection.style.boxSizing = "border-box";
        styleSection.style.overflow  = "hidden";
        styleSection.style.flex      = "0 0 auto";
        btnRow.style.boxSizing   = "border-box";
        btnRow.style.overflowX   = "hidden";
        btnRow.style.overflowY   = "auto";   // squeezed targets stay reachable
        btnRow.style.flex        = "0 0 auto";

        const TUNE_DEFAULT_H = 200;
        // Natural heights of each half. Measuring forces layout, so these are
        // cached and refreshed at the start of a drag / on expand rather than on
        // every pointermove.
        let _tuneNatS = 0, _tuneNatF = 0;
        const _sectionNatural = (el) => {
          const _h = el.style.height, _o = el.style.overflow;
          el.style.height = "auto"; el.style.overflow = "visible";
          const n = el.scrollHeight;
          el.style.height = _h; el.style.overflow = _o;
          return n;
        };
        const _tuneMeasure = () => {
          const _d = tuneWrap.style.display, _wh = tuneWrap.style.height;
          tuneWrap.style.display = "flex"; tuneWrap.style.height = "auto";
          _tuneNatS = _sectionNatural(styleSection);
          _tuneNatF = _sectionNatural(btnRow);
          tuneWrap.style.display = _d; tuneWrap.style.height = _wh;
          return _tuneNatS + _tuneNatF;
        };
        const _tuneNatural = () => (_tuneNatS + _tuneNatF) || _tuneMeasure() || TUNE_DEFAULT_H;
        // Never let the block squeeze the editor below a usable height.
        const _tuneMax = () => Math.max(80, (leftPane.clientHeight || 0) - 160);

        // Declared before tuneGrip: its hover handlers close over these, and the
        // house rule is that a `let` a handler reads must be declared above the
        // handler, not merely before the handler fires.
        let _tuneDragging = false, _tuneStartY = 0, _tuneStartH = 0;
        const tuneGrip = document.createElement("div");
        tuneGrip.title = "Drag to resize — click the tab to collapse";
        tuneGrip.style.cssText =
          "flex-shrink:0;height:5px;cursor:ns-resize;background:#1c2431;position:relative;" +
          "margin:2px 0;transition:background .12s;";
        tuneGrip.onmouseenter = () => { if (!_tuneDragging) tuneGrip.style.background = "#3a4a60"; };
        tuneGrip.onmouseleave = () => { if (!_tuneDragging) tuneGrip.style.background = "#1c2431"; };

        const tuneHandle = document.createElement("div");
        tuneHandle.textContent = "⌄";
        tuneHandle.style.cssText =
          "position:absolute;left:50%;top:-6px;transform:translateX(-50%);" +
          "width:46px;height:16px;border-radius:4px;background:#1b2430;border:1px solid #2b3a4e;" +
          "display:flex;align-items:center;justify-content:center;cursor:pointer;color:#7a8a9c;" +
          "font-size:12px;line-height:1;z-index:3;transition:color .12s,background .12s,border-color .12s;";
        tuneHandle.onmouseenter = () => {
          tuneHandle.style.background = "#26333f"; tuneHandle.style.color = "#c2e2f8";
          tuneHandle.style.borderColor = "#4e5c6e";
        };
        tuneHandle.onmouseleave = () => {
          tuneHandle.style.background = "#1b2430"; tuneHandle.style.color = "#7a8a9c";
          tuneHandle.style.borderColor = "#2b3a4e";
        };
        tuneGrip.appendChild(tuneHandle);

        // Height 0 IS the collapsed state — there is no separate mode and no
        // snap threshold, so a drag runs smoothly all the way shut and back.
        const _tuneApply = (h, silent) => {
          const open = h > 0;
          _styleOpen = open;
          tuneWrap.style.display = open ? "flex" : "none";
          if (open) {
            if (!_tuneNatS && !_tuneNatF) _tuneMeasure();
            // Cap at the content height — dragging taller than the block needs
            // would only add dead space under the wireless chips.
            const hh = Math.max(0, Math.min(Math.min(_tuneMax(), _tuneNatural()), h));
            // Wireless is served first, so it keeps its full height until the
            // sliders above it have completely closed; only then does it start
            // to shrink. That is the whole point of the split.
            const fH = Math.min(_tuneNatF, hh);
            const sH = Math.max(0, hh - fH);
            styleSection.style.height = sH + "px";
            btnRow.style.height       = fH + "px";
            tuneWrap.style.height     = hh + "px";
            _tuneH = hh;
          }
          tuneHandle.textContent = open ? "⌄" : "⌃";
          tuneHandle.title = open
            ? "Collapse Style tuning and Wireless targets"
            : "Show Style tuning and Wireless targets";
          _updateStyleHdrState();
          if (!_tuneDragging && !silent) _epePersistUi();   // see the Library note above
        };
        // Reopening by the tab always goes to a size that shows the whole block,
        // never back to whatever sliver the last drag left behind.
        const _tuneOpenH = () => {
          _tuneMeasure();
          return Math.min(_tuneMax(), Math.max(TUNE_DEFAULT_H, _tuneNatural()));
        };

        const _tuneOnMove = (e) => {
          if (!_tuneDragging) return;
          const h = _tuneStartH + (_tuneStartY - e.clientY);   // drag up → taller
          _tuneApply(Math.max(0, Math.min(_tuneMax(), h)));
          e.preventDefault();
        };
        const _tuneOnUp = (e) => {
          if (!_tuneDragging) return;
          _tuneDragging = false;
          tuneGrip.style.background = "#1c2431";
          window.removeEventListener("pointermove", _tuneOnMove, true);
          window.removeEventListener("pointerup", _tuneOnUp, true);
          // Round 26 added this to the Library divider and called the tuning
          // and rail dividers "the same contract" — then left both without it.
          // A cancelled pointer (touch interrupted, the OS taking the gesture,
          // a context menu) left _tuneDragging true, so the block followed an
          // unpressed mouse, and both window listeners outlived the drag.
          window.removeEventListener("pointercancel", _tuneOnUp, true);
          try { tuneGrip.releasePointerCapture(e && e.pointerId); } catch (_e) {}
          _epePersistUi();
        };
        // A node destroyed mid-drag never reaches _tuneOnUp, so dispose ends
        // the drag the same way a pointerup does.
        const _tuneEndDrag = () => { try { _tuneOnUp({}); } catch (_e) {} };
        tuneGrip.addEventListener("pointerdown", (e) => {
          if (e.target === tuneHandle) return;
          _tuneDragging = true;
          _tuneStartY = e.clientY;
          _tuneMeasure();   // targets may have been added/removed since last time
          // Round to match what _tuneApply writes, so frame one is a no-op at
          // zero cursor movement rather than a sub-pixel correction.
          _tuneStartH = _styleOpen ? Math.round(tuneWrap.getBoundingClientRect().height) : 0;
          tuneGrip.style.background = "#4e5c6e";
          try { tuneGrip.setPointerCapture(e.pointerId); } catch (_e) {}
          window.addEventListener("pointermove", _tuneOnMove, true);
          window.addEventListener("pointerup", _tuneOnUp, true);
          window.addEventListener("pointercancel", _tuneOnUp, true);
          // Keep the ComfyUI canvas from starting a node-drag on the grip.
          e.preventDefault(); e.stopPropagation();
        });
        tuneGrip.addEventListener("mousedown", (e) => e.stopPropagation());
        tuneGrip.addEventListener("dblclick", (e) => {
          _tuneApply(_tuneOpenH());
          e.preventDefault(); e.stopPropagation();
        });
        tuneHandle.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
        tuneHandle.addEventListener("mousedown",   (e) => { e.stopPropagation(); });
        tuneHandle.addEventListener("dblclick",    (e) => { e.preventDefault(); e.stopPropagation(); });
        tuneHandle.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          _tuneApply(_styleOpen ? 0 : _tuneOpenH());
        });

        leftPane.insertBefore(tuneGrip, aiSettingsPanel);
        leftPane.insertBefore(tuneWrap, aiSettingsPanel);

        // Normalise the block to an explicit height once the first layout has
        // happened. Left alone it sits at its content height, which nothing has
        // checked against _tuneMax — so the first drag frame re-clamped it and
        // the bar visibly jumped before it started tracking the cursor. Running
        // the same sizing path up front means the resting height is already the
        // height a drag would produce, and the first frame moves by exactly the
        // distance the cursor moved. Silent: this is not a user edit, so it must
        // not write node.properties or dirty a freshly loaded graph.
        requestAnimationFrame(() => {
          // _tuneH first: onConfigure's restore may already have applied the
          // saved drag height, and normalizing to the full open height here
          // clobbered it on every workflow load.
          try { if (_styleOpen) _tuneApply(_tuneH || _tuneOpenH(), true); } catch (_e) {}
        });

        // Action rail joins the body row, left of the workspace.
        bodyWrap.insertBefore(actionRail, leftPane);

        // ── Draggable divider — resize / collapse the Transform rail ────────
        // Same contract as the Library divider and the tuning divider: drag runs
        // smoothly to 0 with no snap, width 0 IS collapsed, and the tab reopens
        // at a width that shows the whole rail rather than the last drag size.
        const RAIL_DEFAULT_W = 118, RAIL_MAX_W = 260;
        const _railNatural = () => {
          const _w = actionRail.style.width, _d = actionRail.style.display;
          actionRail.style.display = "flex";
          actionRail.style.width = "auto";
          const n = actionRail.scrollWidth;
          actionRail.style.width = _w; actionRail.style.display = _d;
          return n || RAIL_DEFAULT_W;
        };
        let _railDragging = false, _railStartX = 0, _railStartW = RAIL_DEFAULT_W;
        const railGrip = document.createElement("div");
        railGrip.title = "Drag to resize — click the tab to collapse";
        railGrip.style.cssText =
          "flex-shrink:0;width:5px;cursor:ew-resize;background:#1c2431;position:relative;" +
          "align-self:stretch;transition:background .12s;";
        railGrip.onmouseenter = () => { if (!_railDragging) railGrip.style.background = "#3a4a60"; };
        railGrip.onmouseleave = () => { if (!_railDragging) railGrip.style.background = "#1c2431"; };

        const railHandle = document.createElement("div");
        railHandle.textContent = "‹";
        railHandle.style.cssText =
          "position:absolute;top:50%;left:-7px;transform:translateY(-50%);" +
          "width:16px;height:46px;border-radius:4px;background:#1b2430;border:1px solid #2b3a4e;" +
          "display:flex;align-items:center;justify-content:center;cursor:pointer;color:#7a8a9c;" +
          "font-size:12px;line-height:1;z-index:3;transition:color .12s,background .12s,border-color .12s;";
        railHandle.onmouseenter = () => {
          railHandle.style.background = "#26333f"; railHandle.style.color = "#c2e2f8";
          railHandle.style.borderColor = "#4e5c6e";
        };
        railHandle.onmouseleave = () => {
          railHandle.style.background = "#1b2430"; railHandle.style.color = "#7a8a9c";
          railHandle.style.borderColor = "#2b3a4e";
        };
        railGrip.appendChild(railHandle);

        const _railApply = (w, silent) => {
          const open = w > 0;
          _railCollapsed = !open;
          actionRail.style.display = open ? "flex" : "none";
          if (open) { actionRail.style.width = w + "px"; _railW = w; }
          railHandle.textContent = open ? "‹" : "›";
          railHandle.title = open ? "Collapse the Transform column" : "Show the Transform column";
          _publishRailW(open ? w : 0);
          if (!_railDragging) { if (!silent) _epePersistUi(); if (open) _epeGrowToMin(); }
        };
        const _railOpenW = () =>
          Math.min(RAIL_MAX_W, Math.max(RAIL_DEFAULT_W, _railNatural()));

        const _railOnMove = (e) => {
          if (!_railDragging) return;
          const w = _railStartW + (e.clientX - _railStartX);   // drag right → wider
          _railApply(Math.max(0, Math.min(RAIL_MAX_W, w)));
          e.preventDefault();
        };
        const _railOnUp = (e) => {
          if (!_railDragging) return;
          _railDragging = false;
          railGrip.style.background = "#1c2431";
          window.removeEventListener("pointermove", _railOnMove, true);
          window.removeEventListener("pointerup", _railOnUp, true);
          window.removeEventListener("pointercancel", _railOnUp, true);
          try { railGrip.releasePointerCapture(e && e.pointerId); } catch (_e) {}
          _epePersistUi();
        };
        const _railEndDrag = () => { try { _railOnUp({}); } catch (_e) {} };
        railGrip.addEventListener("pointerdown", (e) => {
          if (e.target === railHandle) return;
          _railDragging = true;
          _railStartX = e.clientX;
          _railStartW = _railCollapsed ? 0 : actionRail.getBoundingClientRect().width;
          railGrip.style.background = "#4e5c6e";
          try { railGrip.setPointerCapture(e.pointerId); } catch (_e) {}
          window.addEventListener("pointermove", _railOnMove, true);
          window.addEventListener("pointerup", _railOnUp, true);
          window.addEventListener("pointercancel", _railOnUp, true);
          e.preventDefault(); e.stopPropagation();
        });
        railGrip.addEventListener("mousedown", (e) => e.stopPropagation());
        railGrip.addEventListener("dblclick", (e) => {
          _railApply(_railOpenW());
          e.preventDefault(); e.stopPropagation();
        });
        railHandle.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
        railHandle.addEventListener("mousedown",   (e) => { e.stopPropagation(); });
        railHandle.addEventListener("dblclick",    (e) => { e.preventDefault(); e.stopPropagation(); });
        railHandle.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          _railApply(_railCollapsed ? _railOpenW() : 0);
        });
        bodyWrap.insertBefore(railGrip, leftPane);
        _publishRailW(RAIL_DEFAULT_W);   // rail starts expanded; seed the signal

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
              'Tip: results appear in the editor for review — keep one with <b>Use this</b>, add it to what you had with <b>Append</b>, or reject it with <b>Discard</b>, which puts your prompt back exactly as it was.' +
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
              'You can also run <b>Image to Prompt</b> or <b>Video to Prompt</b> directly on any search result from Civitai or Genur.art, or just run an <b>Enhance</b> on the image prompt itself — click on/open a search result and use the button in its detail panel.' +
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
              '<li>Use the <b>✎</b> row above the toolbar to change your prompt in plain language — e.g. "change the lighting to golden hour" or "make her hair red". Press <b>Apply Edit</b> and the rewrite streams into the editor.</li>' +
              '<li>The edit ripples coherently: changing a subject\'s age, species, or the season also updates related details.</li>' +
              '<li>Chain edits together — each one builds on the last, and nothing is committed until you accept it with <b>Use this</b>. <b>Discard</b> puts the prompt back the way it was.</li>' +
              '<li>Later instructions can refer to earlier ones ("dial that back", "warmer than that") because the whole direction thread goes to the model. The <b>steps</b> chip beside the ✎ row opens the thread.</li>' +
              '<li><b>☆ Save sequence</b> keeps a chain of edits as a reusable recipe — replay it on any other prompt and it runs step by step.</li>' +
              '</ul>' +
              '</div>' +
              '<div style="margin-top:10px;padding:8px 10px;background:rgba(109,184,232,0.06);border:1px solid rgba(109,184,232,0.15);border-radius:7px;color:#8ba5be;font-size:10px;">' +
              'Tip: <b>↶</b> (Ctrl+Z) steps back one instruct edit at a time, so you can walk a chain backwards without discarding all of it.' +
              '</div>',
          },
          {
            id: "editortools",
            label: "Editor tools",
            html:
              '<div style="line-height:1.8;">' +
              '<b>Tabs</b> — up to 10 prompts side by side, saved with your workflow.<br>' +
              '<b>File ▾</b> — save to Favorites/Snippets, clear, import/export text.<br>' +
              '<b>Undo/Redo</b> — Ctrl+Z / Ctrl+Y; also recalls the prompt from before an AI result.<br>' +
              '<b>Find</b>, <b>Aa</b> (case/sort), <b>Clean</b> (strip markdown/weights), <b>Synonyms</b>, <b>Flag words</b> (weak words → replacements), <b>Wrap</b>.' +
              '</div>' +
              '<div style="line-height:1.8;margin-top:10px;">' +
              '<b>Collapsible layout</b> — the node is three columns and you choose how many are open. Click the tab on <b>Style tuning</b> or on the <b>Library</b> rail to fold that column away, or drag its grip to resize. The node\'s minimum width tracks whatever is open, so collapsing both leaves a plain editor that takes almost no room on the canvas.' +
              '</div>',
          },
          {
            id: "library",
            label: "Library",
            html:
              '<div style="line-height:1.8;">' +
              'Search prompts from <b>Civitai</b> and <b>Genur.art</b> — type a term and scroll to load more. Image/video previews included.' +
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
          // Exposed so dispose can end a drag the mouseup never finished. Both
          // handlers are on `document`, so a stranded pair also fires on every
          // mouse move anywhere on the page, for the life of the tab.
          helpOverlay._epeEndResize = up;
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
          helpOverlay._epeEndMove = onUp;
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
      // A muted (2) or bypassed (4) subgraph wrapper switches off everything
      // inside it — including any EPE node. Recursing anyway made muting
      // the wrapper a no-op for injection.
      if (n.mode === 2 || n.mode === 4) continue;
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
        // Muted (2) or bypassed (4). This node has no graph I/O, so muting
        // is the only way to switch it off — and it kept injecting anyway,
        // overwriting whatever the user had typed straight into the target.
        // The target picker already skips muted nodes; only this path did not.
        if (n.mode === 2 || n.mode === 4) return;
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

// ONE registration per page, whichever copy of this file gets there first.
//
// A registry install and a git clone can both be present — ComfyUI resolves
// them as two packs with different directory names — and each contributes a
// WEB_DIRECTORY, so the browser fetches and executes this module twice. The
// second `app.registerExtension` with the same name throws, ComfyUI swallows
// it into a console.error nobody reads, and one copy's module-level state
// (the shared Ollama registry, the picker overlay slot, the abort sets) is
// orphaned while its DOM handlers stay live.
//
// Announced rather than swallowed: two copies is a real installation problem
// and the fix is to remove one of them.
if (window.__epeExtensionRegistered) {
  console.warn("[EPE] epe_node.js loaded twice — a second copy of the "
    + "Enhanced Prompt Editor is installed (a registry install and a git "
    + "clone, most likely). This copy is standing down; remove one of the "
    + "two folders from custom_nodes to clear this.");
} else {
  window.__epeExtensionRegistered = true;
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
        // Record what the INCOMING payload carried, before anything merges it.
        //
        // Three destructive operations ask "is this a real configure, or are
        // properties arriving in pieces?" — the thread-map reset, the parked-tab
        // clear, and the per-tab undo reset. Round 59 answered it from the
        // node's OWN `properties`, and that is always yes: the editor build
        // calls `_epePersistPrompt()` before it publishes `_epeRefreshFromProps`
        // at all, so `properties.epe_prompt` is a string from the moment the
        // node exists, and `_persistTabs()` leaves `epe_tabs` non-empty. The
        // guard read as careful and was a no-op. Two independent reviews found
        // it in the same pass.
        //
        // `info.properties` is the serialised node as the workflow file has it
        // — the only thing that knows whether this configure carries a tab
        // identity. Absent or empty means "not yet": keep what is on screen.
        // Held in a CONST, not on the node.
        //
        // Round 60 wrote the answer into `self._epeCfgEvidence` here and let the
        // deferred refresh read it a macrotask later. One slot per node, one
        // pending refresh per configure — so when properties arrive in pieces
        // (the very thing this exists to detect) the LAST piece's answer stood
        // for the real configure's refresh, and it is always the weaker answer:
        // a trailing `{epe_ui: …}` says "no evidence", the refresh keeps the
        // OUTGOING workflow's threads, tabs and undo stack, and D-1, E-2 and
        // F-2 all come back at once. Driven: switch workflows, press Ctrl+Z,
        // and the previous workflow's text lands in this one's file.
        let _ev = false;
        try {
          const _ip = (info && info.properties) || null;
          _ev = !!(_ip &&
            ((Array.isArray(_ip.epe_tabs) && _ip.epe_tabs.length) ||
             typeof _ip.epe_prompt === "string"));
        } catch (_e2) { _ev = false; }
        // ONE configure, one whole bag, one onConfigure. Verified, not assumed.
        //
        // Rounds 59-62 built an accumulator and a sequence guard on top of the
        // assertion "properties arrive in pieces, which ComfyUI does" — written
        // here in round 59 and never sourced. It is false. In the frontend this
        // install runs (comfyui-frontend-package 1.49.6) and in the 1.53.1
        // source:
        //
        //   LGraphNode.configure(info) copies the WHOLE info.properties bag in
        //     one loop and then calls this.onConfigure?.(info) once, as its
        //     last statement;
        //   LGraphNode.serialize() writes the whole properties object or
        //     nothing — there is no subset form;
        //   LGraph.configure() does `this._nodes = []` and rebuilds every node
        //     through createNode -> onNodeCreated -> configure.
        //
        // So `info.properties` is always the complete saved node, this hook
        // fires exactly once for it, and the editor already exists when it
        // does. Driven: 3,000 production-shaped node lifetimes give
        // byte-identical results with the machinery and without it.
        //
        // What is left is the part that is real: did THIS FILE carry a tab
        // identity? A workflow can name an EPE node without naming its tabs,
        // and the restore must not treat that as "wipe what is on screen".
        //
        // Defer a tick: properties are applied around configure time; this makes
        // sure epe_wireless_targets / epe_prompt are present before we refresh.
        // The editor's hooks are published from onNodeCreated, which LiteGraph
        // runs BEFORE configure, so the retry below should never fire — it is
        // kept as cheap insurance for a frontend that builds the editor later.
        let _tries = 0;
        const _tryRefresh = () => {
          _tries++;
          try {
            if (self._epeRefreshFromProps) {
              // This configure's own answer, published at the moment its
              // refresh runs rather than when it landed — so a second node's
              // configure, or a second workflow load, cannot answer for it.
              self._epeCfgEvidence = _ev;
              self._epeRefreshFromProps();
              return;
            }
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

      // S-1. This node now owns a `document` listener and two `document.body`
      // children, and ComfyUI will not always tell us when it dies — see the
      // registry's comment at the top of the file.
      //
      // The outermost dispose layer, so it wraps every layer
      // `_epeOpenEPEStandalone` built up. Exactly-once: the sweep and a later
      // `onRemoved` can both reach the same node, and running the chain twice
      // is not something each layer was written for.
      {
        const _epeRegNode = this;
        const _epeRegPrev = _epeRegNode._epeDispose;
        let _epeRegDone = false;
        _epeRegNode._epeDispose = () => {
          if (_epeRegDone) return;
          _epeRegDone = true;
          try { _epeLiveEditors.delete(_epeRegNode); } catch (_e) {}
          try { _epeRegPrev && _epeRegPrev(); } catch (_e) {}
        };
        _epeLiveEditors.add(_epeRegNode);
        // Excluded by identity: LiteGraph runs onNodeCreated BEFORE graph.add,
        // so this node is legitimately in no graph yet.
        _epeSweepDeadEditors(_epeRegNode);
      }

      const _node = this;
      const _epeFullW = 980;
      // Floor = the editor's own minimum plus whichever side columns are open.
      // Collapse both and the node can get down to _EPE_EDITOR_MIN_W.
      //
      // A floor that moves used to snap the node: reopening a column raised the
      // minimum above the node's current width, and the next unrelated drag
      // yanked the node out to meet it. The fix is not to freeze the floor but
      // to never let it rise silently — every expand calls _epeGrowToMin below,
      // so the node widens at the moment you expand, as a visible consequence
      // of that click, and no later drag has a raised floor to snap against.
      const _EPE_EDITOR_MIN_W = 320;
      const _epeMinW = () => {
        const lw = (epeEl && typeof epeEl._epeLibW  === "number") ? epeEl._epeLibW  : 0;
        const rw = (epeEl && typeof epeEl._epeRailW === "number") ? epeEl._epeRailW : 0;
        return _EPE_EDITOR_MIN_W + lw + rw;
      };
      const _epeFullH = 640;
      const _titleH = LiteGraph.NODE_TITLE_HEIGHT ?? 30;

      // Embed via addDOMWidget.
      // getMinHeight drives the DOM widget container height.
      // floatingWin is height:100% so it always fills whatever the container gets.
      const _epeMinH = 200; // fixed floor — never tracks current size
      const _epeWidget = this.addDOMWidget("epe_editor", "EPE", epeEl, {
        getMinHeight: () => _epeMinH,
        getMinWidth:  () => _epeMinW(),
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

      // Called by the editor immediately after a column expands. Widening here
      // — right when the user clicks — is what keeps the moving floor honest:
      // the node is never left narrower than its own minimum, so there is no
      // stored-up correction for a later drag to apply as a snap.
      epeEl._epeGrowToMin = () => {
        try {
          const min = _epeMinW();
          if (_node.size[0] < min) {
            _node.size[0] = min;
            app.graph.setDirtyCanvas(true, true);
          }
        } catch (_e) {}
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
          const w = Math.max(_epeMinW(), _rgW + (e.clientX - _rgX));
          const h = Math.max(200, _rgH + (e.clientY - _rgY));
          _applySize(w, h);
        };
        const _rgUp = () => {
          _rgDrag = false;
          window.removeEventListener("mousemove", _rgMove);
          window.removeEventListener("mouseup", _rgUp);
        };
        // Registered ON THE NODE, because this grip is built in onNodeCreated
        // and dispose lives inside the editor closure — two different
        // functions, no shared binding. The node object is what both hold.
        // _rgMove closes over _applySize
        // -> _node -> the whole editor, so a drag the mouseup never ended —
        // a workflow-tab switch under a held button, a release outside the
        // viewport — pinned the entire editor for the life of the page. The
        // three divider drags have been ended from dispose since round 30;
        // this one and the help window's two were never added.
        _node._epeEndGripDrag = _rgUp;
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
}  // end of the load-twice guard opened above app.registerExtension
