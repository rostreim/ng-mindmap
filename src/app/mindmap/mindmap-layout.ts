import * as d3 from 'd3';
import { D3GraphEdge, D3GraphNode, MindmapGraph } from './mindmap.model';

/** Node radius in px, indexed by depth; last entry repeats for any deeper level. */
export const NODE_RADII = [18, 12, 8];

/** Radial distance (px) between consecutive depth rings in 'radial'/'hybrid' layout mode. */
export const RADIAL_RING_SPACING = 100;

// ── Graph construction ──────────────────────────────────────────────────────

/**
 * Builds the internal D3GraphNode/D3GraphEdge structures from a MindmapGraph, resolving
 * string id references into live object references (required for D3's force-link).
 * Validates structurally before anything else touches the data — see the three throw
 * sites below — so a bad edge fails clearly and immediately rather than surfacing as a
 * cryptic D3 or classifyShape() error downstream.
 */
export function buildGraph(
  graph: MindmapGraph,
  previousById?: Map<string, D3GraphNode>,
): { nodes: D3GraphNode[]; edges: D3GraphEdge[] } {
  const nodesById = new Map<string, D3GraphNode>();

  for (const raw of graph.nodes) {
    if (nodesById.has(raw.id)) {
      throw new Error(`mindmap: duplicate node id "${raw.id}" — every node id must be unique`);
    }
    const previous = previousById?.get(raw.id);
    nodesById.set(raw.id, {
      id: raw.id,
      label: raw.label,
      collapsed: false,
      sourceNode: raw,
      x: previous?.x ?? (Math.random() - 0.5) * 60,
      y: previous?.y ?? (Math.random() - 0.5) * 60,
    });
  }

  const edgesById = new Map<string, D3GraphEdge>();

  for (const raw of graph.edges) {
    if (raw.source === raw.target) {
      throw new Error(`mindmap: self-loop edge at node "${raw.source}" is not supported`);
    }
    const source = nodesById.get(raw.source);
    if (!source) {
      throw new Error(`mindmap: edge references unknown node id "${raw.source}"`);
    }
    const target = nodesById.get(raw.target);
    if (!target) {
      throw new Error(`mindmap: edge references unknown node id "${raw.target}"`);
    }

    const id = raw.id ?? `${raw.source}->${raw.target}`;
    if (edgesById.has(id)) continue; // silent dedup — see mindmap-layout.spec.ts

    edgesById.set(id, { id, source, target });
  }

  return { nodes: [...nodesById.values()], edges: [...edgesById.values()] };
}

/**
 * 'tree' iff every node has at most one incoming edge, there is no cycle, and every node
 * is reachable from exactly one root (the node with zero incoming edges) — so a forest of
 * otherwise tree-shaped disconnected components is 'graph', not 'tree', since there's no
 * single root to hang a radial/hybrid layout or DFS keyboard order off of.
 *
 * Cycle detection is a side effect of the checks above, not the DFS below: the multi-parent
 * check (in-degree > 1 → 'graph') and the unique-root check together already exclude every
 * *reachable* cycle before the DFS loop runs — re-entering a cycle from the root means the
 * entry node has two incoming edges (one from the root-ward path, one from within the cycle),
 * which the multi-parent check catches first. An *unreachable* cycle (disconnected from the
 * root) is instead caught after the loop by `visited.size === nodes.length`, since none of its
 * nodes are ever pushed onto `stack`. That leaves the `visited.has(n.id)` check inside the DFS
 * loop below with nothing left to catch under the current invariants — it is a defensive
 * fallback, not the primary cycle-detection mechanism. Keep it (and keep the multi-parent and
 * root-count checks it depends on): removing either of those earlier checks on the theory that
 * "DFS already handles cycles" would silently reintroduce false-'tree' classifications for
 * root-reachable cycles.
 */
export function classifyShape(nodes: D3GraphNode[], edges: D3GraphEdge[]): 'tree' | 'graph' {
  if (nodes.length === 0) return 'tree';

  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const childrenOf = new Map<string, D3GraphNode[]>();
  for (const e of edges) {
    inDegree.set(e.target.id, (inDegree.get(e.target.id) ?? 0) + 1);
    if (inDegree.get(e.target.id)! > 1) return 'graph'; // multi-parent
    const kids = childrenOf.get(e.source.id) ?? [];
    kids.push(e.target);
    childrenOf.set(e.source.id, kids);
  }

  const roots = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  if (roots.length !== 1) return 'graph'; // no root, or a forest of several

  const visited = new Set<string>();
  const stack = [roots[0]];
  while (stack.length) {
    const n = stack.pop()!;
    // Defensive fallback: under the invariants established above (in-degree <= 1 for every
    // node, exactly one root), this can't currently fire — see the classifyShape() docstring.
    if (visited.has(n.id)) return 'graph'; // cycle
    visited.add(n.id);
    stack.push(...(childrenOf.get(n.id) ?? []));
  }

  return visited.size === nodes.length ? 'tree' : 'graph';
}

/**
 * Seeds the visibility walk from every zero-indegree node (one seed per disconnected
 * component's natural root), then adds one arbitrary unreached node per still-unreached
 * component as an extra seed — covers a fully cyclic component with no "outside-in" edge
 * at all, so a self-contained cycle still renders instead of being permanently invisible.
 */
function findVisibilitySeeds(nodes: D3GraphNode[], edges: D3GraphEdge[]): D3GraphNode[] {
  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) inDegree.set(e.target.id, (inDegree.get(e.target.id) ?? 0) + 1);

  const seeds = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  const reached = new Set<string>();
  const outgoing = new Map<string, D3GraphNode[]>();
  for (const e of edges) outgoing.set(e.source.id, [...(outgoing.get(e.source.id) ?? []), e.target]);

  const walk = (start: D3GraphNode) => {
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (reached.has(n.id)) continue;
      reached.add(n.id);
      stack.push(...(outgoing.get(n.id) ?? []));
    }
  };
  seeds.forEach(walk);

  for (const n of nodes) {
    if (!reached.has(n.id)) {
      seeds.push(n);
      walk(n);
    }
  }
  return seeds;
}

/**
 * Two-phase, not two independent branches. Phase 1 is one forward walk from the seeds —
 * identical for both modes — that already gives 'per-edge' semantics: a node is visible if
 * reachable via any path that never passes through a collapsed node (so a shared node stays
 * visible via a non-collapsed parent even while another parent is collapsed). Phase 2 runs
 * only for 'global' mode: a pruning pass that removes anything downstream of a collapsed
 * node *unconditionally*, even if some other path also reaches it — this is what makes
 * collapsing one parent hide a shared descendant everywhere, the behavior 'per-edge' must
 * NOT have. Both phases are O(V+E); fully recomputed each call, no incremental patching,
 * same philosophy as the old flattenVisible().
 */
export function computeVisibleGraph(
  nodes: D3GraphNode[],
  edges: D3GraphEdge[],
  collapseMode: 'global' | 'per-edge',
): { visibleNodes: D3GraphNode[]; visibleEdges: D3GraphEdge[] } {
  const outgoing = new Map<string, D3GraphEdge[]>();
  for (const e of edges) outgoing.set(e.source.id, [...(outgoing.get(e.source.id) ?? []), e]);
  const seeds = findVisibilitySeeds(nodes, edges);
  const seedIds = new Set(seeds.map((s) => s.id));

  // Phase 1: forward walk, stopping at (but including) any collapsed node.
  const visible = new Set<string>();
  const stack = [...seeds];
  while (stack.length) {
    const n = stack.pop()!;
    if (visible.has(n.id)) continue;
    visible.add(n.id);
    if (n.collapsed) continue; // never descend past a collapsed node, in either mode
    for (const e of outgoing.get(n.id) ?? []) stack.push(e.target);
  }

  // Phase 2 ('global' only): unconditionally prune everything downstream of a collapsed
  // node, even if another path also reaches it.
  if (collapseMode === 'global') {
    const collapsedIds = new Set(nodes.filter((n) => n.collapsed).map((n) => n.id));
    // `pruned` tracks "already traversed in this downstream walk," independent of `visible`
    // membership — it's what lets the walk continue through a node that Phase 1 never marked
    // visible (e.g. an intermediate node whose only path in was through a collapsed ancestor)
    // while still guarding against infinite loops on cycles.
    const pruned = new Set<string>();
    for (const collapsedId of collapsedIds) {
      const substack = [...(outgoing.get(collapsedId) ?? []).map((e) => e.target)];
      while (substack.length) {
        const n = substack.pop()!;
        if (pruned.has(n.id)) continue; // already traversed in this pass — cycle guard
        pruned.add(n.id);
        if (seedIds.has(n.id)) continue; // a seed is never hidden, and the walk stops there
        visible.delete(n.id); // unconditional: no-op if n was never visible to begin with
        for (const e of outgoing.get(n.id) ?? []) substack.push(e.target);
      }
    }
  }

  const visibleNodes = nodes.filter((n) => visible.has(n.id));
  const visibleEdges = edges.filter((e) => visible.has(e.source.id) && visible.has(e.target.id));
  return { visibleNodes, visibleEdges };
}

/**
 * Fallback chain: explicit entryNodeId if valid → the zero-indegree node with the most
 * outgoing edges → (no zero-indegree node at all, e.g. fully cyclic) the most-connected
 * node overall → null for an empty graph. A missing/invalid entryNodeId warns rather than
 * throwing — it's a hint, not a structural requirement (see mindmap-layout.spec.ts).
 */
export function resolveEntryNode(
  nodes: D3GraphNode[],
  edges: D3GraphEdge[],
  entryNodeId?: string,
): D3GraphNode | null {
  if (nodes.length === 0) return null;

  if (entryNodeId) {
    const match = nodes.find((n) => n.id === entryNodeId);
    if (match) return match;
    console.warn(`mindmap: entryNodeId "${entryNodeId}" does not match any node id; falling back to auto-selection`);
  }

  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const outDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    inDegree.set(e.target.id, (inDegree.get(e.target.id) ?? 0) + 1);
    outDegree.set(e.source.id, (outDegree.get(e.source.id) ?? 0) + 1);
  }

  const roots = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  if (roots.length > 0) {
    return roots.reduce((best, n) => ((outDegree.get(n.id) ?? 0) > (outDegree.get(best.id) ?? 0) ? n : best));
  }

  return nodes.reduce((best, n) => {
    const total = (inDegree.get(n.id) ?? 0) + (outDegree.get(n.id) ?? 0);
    const bestTotal = (inDegree.get(best.id) ?? 0) + (outDegree.get(best.id) ?? 0);
    return total > bestTotal ? n : best;
  });
}

/**
 * Advances the "currently selected outgoing edge" cursor for graph-mode ArrowUp/Down —
 * mindmap.ts owns the actual per-node index (transient UI state, not graph structure).
 * Edge order is insertion order (the order edges appear in the built D3GraphEdge array).
 */
export function cycleOutgoingEdge(
  node: D3GraphNode,
  edges: D3GraphEdge[],
  currentIndex: number,
  direction: 1 | -1,
): { edge: D3GraphEdge | null; index: number } {
  const outgoing = edges.filter((e) => e.source.id === node.id);
  if (outgoing.length === 0) return { edge: null, index: 0 };

  const index = (currentIndex + direction + outgoing.length) % outgoing.length;
  return { edge: outgoing[index], index };
}

// Tree navigation (nextVisible/previousVisible/firstVisible/lastVisible/firstChild/
// isDescendantOf) was removed here in Task 7 along with D3Node — it was typed against the
// deleted tree-only D3Node and had no D3GraphNode equivalent yet. The DFS tree-walk helpers
// are ported onto the flat visibleNodes array directly in Task 10 (see mindmap.ts's
// onNodeKeydown()). nodeRadius/computeRadialPositions are rebuilt against D3GraphNode/
// D3GraphEdge below, in Task 12.

const AVG_CHAR_WIDTH_FACTOR = 0.55;

/** Font size in px for a node's label, matching applyNodeTheme's rendering --
 * depth 0 (a tree's root; also every node in graph/forest-shaped data, since
 * depth is never set there) renders larger than everything else. */
export function fontSizeFor(d: { depth?: number }): number {
  return d.depth === 0 ? 13 : 11;
}

/** Rough half-width estimate of a node's rendered label, in px -- no real
 * text measurement (no getBBox/getComputedTextLength, which jsdom doesn't
 * support -- mindmap-core.ts's zoomToFit is the one place that already
 * needs a real browser for exactly this reason, and is e2e-only). Cheap
 * enough to fold directly into a force simulation's per-tick collision
 * radius callback. */
export function labelHalfWidth(d: { label: string; depth?: number }): number {
  return (d.label.length * fontSizeFor(d) * AVG_CHAR_WIDTH_FACTOR) / 2;
}

/** Node radius in px, indexed by depth (undefined for graph-shaped data, treated as depth 0); last NODE_RADII entry repeats for any deeper level. */
export function nodeRadius(d: D3GraphNode): number {
  return NODE_RADII[Math.min(d.depth ?? 0, NODE_RADII.length - 1)];
}

/**
 * Computes deterministic radial-tree target positions for `visibleNodes` (a subset of the
 * full node set, e.g. with a collapsed subtree excluded), rooted at `root`. Builds a d3
 * hierarchy from `visibleEdges` rather than walking a nested `.children` (D3GraphNode is
 * flat — see mindmap.model.ts) — same d3-hierarchy/d3-tree math as before, just fed an
 * adjacency function instead of a property accessor.
 */
export function computeRadialPositions(root: D3GraphNode, visibleNodes: D3GraphNode[], visibleEdges: D3GraphEdge[]): void {
  const visibleIds = new Set(visibleNodes.map((n) => n.id));
  const childrenById = new Map<string, D3GraphNode[]>();
  for (const e of visibleEdges) {
    childrenById.set(e.source.id, [...(childrenById.get(e.source.id) ?? []), e.target]);
  }

  const hierarchyRoot = d3.hierarchy(root, (n) => childrenById.get(n.id) ?? []);
  const maxRadius = hierarchyRoot.height * RADIAL_RING_SPACING;
  const layout = d3.tree<D3GraphNode>().size([2 * Math.PI, maxRadius]);

  layout(hierarchyRoot).each((node) => {
    if (!visibleIds.has(node.data.id)) return;
    const angle = node.x - Math.PI / 2;
    const radius = node.y;
    node.data.targetX = radius * Math.cos(angle);
    node.data.targetY = radius * Math.sin(angle);
  });
}
