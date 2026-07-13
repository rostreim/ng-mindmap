import * as d3 from 'd3';
import { D3GraphEdge, D3GraphNode, D3Link, D3Node, MindmapGraph, MindmapNode } from './mindmap.model';

/** Node radius in px, indexed by depth; last entry repeats for any deeper level. */
export const NODE_RADII = [18, 12, 8];

/** Radial distance (px) between consecutive depth rings in 'radial'/'hybrid' layout mode. */
export const RADIAL_RING_SPACING = 100;

/**
 * `ancestors` tracks only the current root-to-node path (added on entry, removed on
 * exit), not every node ever visited — so a MindmapNode legitimately reused across two
 * sibling branches isn't flagged, only a node that is its own ancestor (a real cycle,
 * which would otherwise recurse forever and stack-overflow instead of failing clearly).
 */
/**
 * `previousById`, when given, carries x/y forward from a prior D3Node tree for any node
 * whose id still exists — so a `data` update (e.g. a label edit or one new leaf) doesn't
 * re-scatter every already-settled node to a fresh random spawn position.
 */
export function buildTree(
  raw: MindmapNode,
  parent: D3Node | null,
  depth: number,
  ancestors = new Set<MindmapNode>(),
  previousById?: Map<string, D3Node>,
): D3Node {
  if (ancestors.has(raw)) {
    throw new Error(`mindmap: cyclic MindmapNode graph detected at id "${raw.id}" — buildTree() requires a tree, not a graph`);
  }
  ancestors.add(raw);

  const previous = previousById?.get(raw.id);

  const node: D3Node = {
    id: raw.id,
    label: raw.label,
    depth,
    collapsed: false,
    _children: null,
    children: null,
    parent,
    sourceNode: raw,
    x: previous?.x ?? (Math.random() - 0.5) * 60,
    y: previous?.y ?? (Math.random() - 0.5) * 60,
  };
  node.children = (raw.children ?? []).map((c) => buildTree(c, node, depth + 1, ancestors, previousById));

  ancestors.delete(raw);
  return node;
}

export function flattenVisible(node: D3Node, nodes: D3Node[], links: D3Link[]): void {
  nodes.push(node);
  (node.children ?? []).forEach((c) => {
    links.push({ source: node, target: c });
    flattenVisible(c, nodes, links);
  });
}

/** Collects every node by id, both currently visible (`children`) and collapsed-away (`_children`). */
export function flattenAll(node: D3Node, map: Map<string, D3Node>): void {
  map.set(node.id, node);
  (node.children ?? []).forEach((c) => flattenAll(c, map));
  (node._children ?? []).forEach((c) => flattenAll(c, map));
}

// ── Graph construction ──────────────────────────────────────────────────────

/**
 * Builds the internal D3GraphNode/D3GraphEdge structures from a MindmapGraph, resolving
 * string id references into live object references (required for D3's force-link, same
 * reason D3Link does this for the tree model). Validates structurally before anything else
 * touches the data — see the three throw sites below — so a bad edge fails clearly and
 * immediately rather than surfacing as a cryptic D3 or classifyShape() error downstream.
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

// ── Tree navigation (keyboard) ──────────────────────────────────────────────

export function nextVisible(nodes: D3Node[], id: string): D3Node | null {
  const i = nodes.findIndex((n) => n.id === id);
  if (i === -1 || i === nodes.length - 1) return null;
  return nodes[i + 1];
}

export function previousVisible(nodes: D3Node[], id: string): D3Node | null {
  const i = nodes.findIndex((n) => n.id === id);
  if (i <= 0) return null;
  return nodes[i - 1];
}

export function firstVisible(nodes: D3Node[]): D3Node | null {
  return nodes[0] ?? null;
}

export function lastVisible(nodes: D3Node[]): D3Node | null {
  return nodes.length ? nodes[nodes.length - 1] : null;
}

export function firstChild(d: D3Node): D3Node | null {
  return d.children && d.children.length ? d.children[0] : null;
}

export function isDescendantOf(node: D3Node, ancestor: D3Node): boolean {
  let cur = node.parent;
  while (cur) {
    if (cur.id === ancestor.id) return true;
    cur = cur.parent;
  }
  return false;
}

export function nodeRadius(d: D3Node): number {
  return NODE_RADII[Math.min(d.depth, NODE_RADII.length - 1)];
}

// ── Radial layout ────────────────────────────────────────────────────────────

/** Computes deterministic radial-tree target positions for the visible subtree (d3-hierarchy + d3-tree, mapped through polar coordinates). Writes targetX/targetY onto each visible node; does not touch x/y. */
export function computeRadialPositions(rootNode: D3Node): void {
  const hierarchyRoot = d3.hierarchy<D3Node>(rootNode);
  const maxRadius = hierarchyRoot.height * RADIAL_RING_SPACING;
  const layout = d3.tree<D3Node>().size([2 * Math.PI, maxRadius]);

  layout(hierarchyRoot).each((node) => {
    const angle = node.x - Math.PI / 2;
    const radius = node.y;
    node.data.targetX = radius * Math.cos(angle);
    node.data.targetY = radius * Math.sin(angle);
  });
}
