import * as d3 from 'd3';
import { D3Link, D3Node, MindmapNode } from './mindmap.model';

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
export function buildTree(
  raw: MindmapNode,
  parent: D3Node | null,
  depth: number,
  ancestors = new Set<MindmapNode>(),
): D3Node {
  if (ancestors.has(raw)) {
    throw new Error(`mindmap: cyclic MindmapNode graph detected at id "${raw.id}" — buildTree() requires a tree, not a graph`);
  }
  ancestors.add(raw);

  const node: D3Node = {
    id: raw.id,
    label: raw.label,
    depth,
    collapsed: false,
    _children: null,
    children: null,
    parent,
    sourceNode: raw,
    x: (Math.random() - 0.5) * 60,
    y: (Math.random() - 0.5) * 60,
  };
  node.children = (raw.children ?? []).map((c) => buildTree(c, node, depth + 1, ancestors));

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
