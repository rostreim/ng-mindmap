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
    if (visited.has(n.id)) return 'graph'; // cycle
    visited.add(n.id);
    stack.push(...(childrenOf.get(n.id) ?? []));
  }

  return visited.size === nodes.length ? 'tree' : 'graph';
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
