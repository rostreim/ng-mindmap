# Mind-map graph data support

**Status:** Approved (design), pending implementation
**Component:** `mindmap-app/src/app/mindmap/` (`mindmap.ts`, `mindmap.model.ts`, `mindmap-layout.ts`, `context-menu.ts`, `mindmap.html`, `app.ts`)

## Goal

Generalize the component's input from a strict single-rooted tree (`MindmapNode`, nested `children`) to an arbitrary graph — DAGs (multi-parent, no cycles) and fully general graphs (cycles allowed, no obvious root). `MindmapNode` is replaced outright, not kept as a parallel/compat format. Tree-shaped data (the common case, including the demo app) keeps its exact current visual and interaction behavior; graph-shaped data gets new, appropriately different behavior where the tree assumptions don't apply.

## Non-goals

- No `MindmapNode` compatibility shim. `app.ts` and all tests migrate to the new format as part of this work.
- No selective per-child collapse (collapsing a node still collapses *all* of its outgoing edges together, same granularity as today) — only how a collapsed ancestor's effect *propagates to a shared descendant* is configurable (see Collapse/expand below).
- No new layout algorithm for non-tree data. `'radial'`/`'hybrid'` stay exactly what they are today (tree-only); graph-shaped data always uses `'force'`.
- No edge types/labels/weights — an edge is just `{ id?, source, target }`. Typed edges are a future extension, not part of this work.
- No multi-edge (parallel edge) UI — two edges between the same pair with no explicit distinguishing `id` are deduped, not rendered twice.

## Data model

```ts
export interface MindmapGraphNode {
  id: string;
  label: string;
}

export interface MindmapGraphEdge {
  id?: string;       // defaults to `${source}->${target}` if omitted
  source: string;     // node id
  target: string;     // node id
}

export interface MindmapGraph {
  nodes: MindmapGraphNode[];
  edges: MindmapGraphEdge[];
  entryNodeId?: string;  // optional; initial focus/camera + Home key fallback (End is unrelated — see Keyboard nav)
}
```

This is the one public `data` input for every consumer, tree-shaped or not. There is no `dataMode` input. A new pure function, `classifyShape(nodes, edges): 'tree' | 'graph'`, inspects the actual edges (every node has ≤1 incoming edge, reachable from one root, no cycles → `'tree'`; otherwise `'graph'`) and that classification — not a flag a consumer has to set and keep in sync with their data — drives layout-mode availability, ARIA pattern, and keyboard-nav strategy. It runs once per `data` change (not per redraw; classification depends only on `nodes`/`edges`, never on collapse state), so it's cheap.

`buildTree()`'s current behavior of throwing on a cycle is gone — cycles are legitimate input now. Structural *validation* (see Error handling) replaces it as a distinct, earlier concern from shape *classification*.

## Internal model

`D3Node`'s tree-specific fields (`parent`, `children`, `_children`) are replaced by an adjacency-based `D3GraphNode { id, label, x, y, collapsed, ... }` + `D3GraphEdge { source, target }` (structurally close to today's `D3Link`). `buildTree()`/`flattenVisible()` are replaced by `buildGraph(nodes, edges)`, which constructs this structure directly from the flat input — there's no nesting to walk anymore.

## Layout & rendering

- **Mode gating.** `'force'` is always available. `'radial'`/`'hybrid'` are offered only when `classifyShape()` returns `'tree'`. If a consumer sets `layoutMode` to one of those on graph-shaped data, it silently falls back to `'force'` plus a `console.warn` (same spirit as the existing `contextMenuFn` rejection handling) — this is a data-driven constraint, not an error condition.
- **`computeRadialPositions()`** is unchanged; its root is always the tree's actual structural root (the one node with zero incoming edges — guaranteed unique for tree-shaped data). `entryNodeId` does *not* override this — it's a separate, narrower concept (initial focus/camera, Home fallback) that's decoupled from layout math. Setting `entryNodeId` to a non-root node on tree-shaped data is valid (it just changes where keyboard focus/camera start) and has no effect on the radial positions computed.
- **Force simulation link distance** currently scales by `d.target.depth` (`LINK_DISTANCE_PER_DEPTH`), which is meaningless for graph-shaped data — falls back to flat `LINK_DISTANCE_BASE`. Tree-shaped data is unaffected.
- **Edge direction.** New `edgeDirection: 'arrow' | 'plain'` input. Default is shape-dependent, to avoid a gratuitous visual change for existing tree consumers: graph-shaped data defaults to `'arrow'` (new SVG `<marker>`, same pattern as the existing glow `<filter>`), tree-shaped data defaults to today's plain lines (`'plain'`). The input overrides either default in either mode. Implementation note: the arrow tip must stop at the target node's circle boundary — the line's rendered endpoint is shortened along the source→target vector by the target's radius (see self-loop handling below for why this requires a non-zero vector).

## Collapse/expand

State stays exactly where it is today: a `collapsed: boolean` per node, not per edge — clicking a node toggles *all* of its own outgoing edges together, in both modes below. What's new is a `collapseMode: 'global' | 'per-edge'` input (default `'global'`) controlling how a collapsed node's effect propagates to a shared (multi-parent) descendant:

- **`'global'`** — visibility is computed each redraw via a graph walk from the entry point(s) that refuses to descend past any `collapsed` node. A shared node disappears the moment *any* ancestor collapses it, even if reachable via another, non-collapsed parent.
- **`'per-edge'`** — same walk, but a node is visible if *any* non-collapsed path reaches it from an entry point. A shared node stays visible via its other parent even while one parent is collapsed.

Both are a single O(V+E) traversal per toggle, fully recomputed (no incremental patching) — same philosophy as today's `flattenVisible()`.

## Keyboard nav

- **Tree-shaped data:** unchanged. DFS-flattened Up/Down, parent/child Left/Right — a tree-shaped graph still has exactly one incoming edge per node, so "the parent" is still well-defined.
- **Graph-shaped data:** new edge-traversal scheme. Each focused node tracks a transient "currently selected outgoing edge" cursor (Up/Down cycle it round-robin; visually indicated by reusing the existing hover incident-edge highlight styling, which doubles as a sighted-user affordance and a testable hook). ArrowRight commits to that edge and moves focus to its target. ArrowLeft retraces however this node was actually reached — a small transient `arrivedVia` map (node id → the node ArrowRight was pressed from to get here), not a full history stack. Home jumps to `entryNodeId` (or the first node in the array if unset); End goes to the last node in the array — there's no meaningful "last" node in a graph, so this is a deterministic-but-arbitrary fallback.

## ARIA

- **Tree-shaped data:** unchanged — `role="tree"` on the SVG, `role="treeitem"` per node, full `aria-level`/`aria-setsize`/`aria-posinset`/`aria-expanded`.
- **Graph-shaped data:** `role="application"` on the SVG, each node group is `role="button"`. `aria-label` and `aria-expanded` (for nodes with outgoing edges) carry over since both still make sense; `level`/`setsize`/`posinset` are dropped — no graph equivalent.
- **`liveMessage`/`aria-live`** announcements (`toggleCollapse`, `nodeClickFn` activation) are unchanged and shape-agnostic in both modes.

## Error handling & edge cases

`buildGraph()` validates structurally, before `classifyShape()` or anything touches D3, failing fast with a message naming the offending node/edge — the same philosophy as today's cycle-detection error:

- **Edge references an unknown node id** — new failure mode, impossible in the old nested-tree shape, very possible in flat `nodes[]`/`edges[]`.
- **Duplicate node ids.**
- **Self-loop edges** (`source === target`) — disallowed outright. Not just a UX call: the arrowhead line-shortening math normalizes the source→target vector, and a self-loop is a zero-length vector (divide-by-zero).

Two things degrade gracefully instead of throwing:

- **Duplicate edges** (same source+target, no explicit `id`) — deduped silently, since the default `id` (`${source}->${target}`) would otherwise collide as a D3 `join()` key. A caller wanting parallel edges must give them distinct explicit `id`s.
- **`entryNodeId` referencing a nonexistent node** — `console.warn`, then fall back to auto-selection (first node, or the most-connected node — the same fallback used when there's no natural root at all, e.g. a fully cyclic graph with no in-degree-0 node).
- **Empty `nodes: []`** renders a blank canvas, no error — same graceful handling as today's trivial-data cases.
- **Disconnected components** are allowed in both tree-shaped-detection (they simply make the data `'graph'`-shaped, since there's no single root) and rendering (force layout separates them into visual clusters via charge repulsion, no special-casing needed).

## Testing

- **Unit (jsdom):** every new pure function in `mindmap-layout.ts` — `classifyShape`, `buildGraph` (all validation errors above), the visibility walk under both `collapseMode`s (fixture: a small DAG with one two-parent shared node), entry-node fallback selection, and the graph-mode keyboard-nav helpers (outgoing-edge cursor, `arrivedVia` lookback). Component-level tests follow the existing `redraw()`-mocked pattern for `toggleCollapse` under both modes and `onNodeKeydown`'s graph branch.
- **E2e (Playwright):** a small DAG fixture confirming radial/hybrid buttons disable for graph-shaped data; collapsing a shared node and asserting the `global`/`per-edge` visibility difference; arrowhead presence/absence (`marker-end`) by shape and by `edgeDirection` override; graph-mode keyboard traversal via the reused hover-highlight affordance. The full existing tree-mode e2e suite must continue to pass unchanged against `app.ts`'s migrated data — regression proof that tree behavior is pixel-for-pixel identical to today.

## Migration

`app.ts`'s demo `graph: MindmapNode` becomes a `MindmapGraph` (`nodes`/`edges` derived from the same content, `entryNodeId: 'root'`). All existing `mindmap.spec.ts`/`mindmap-layout.spec.ts`/`context-menu.spec.ts`/e2e fixtures move to the new shape. No consumer keeps passing the old nested format.
