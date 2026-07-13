import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3';

export interface MindmapNode {
  id: string;
  label: string;
  children?: MindmapNode[];
}

export interface D3Node extends SimulationNodeDatum {
  id: string;
  label: string;
  depth: number;
  collapsed: boolean;
  _children: D3Node[] | null;
  children: D3Node[] | null;
  parent: D3Node | null;
  sourceNode: MindmapNode;
  targetX?: number;
  targetY?: number;
}

export interface D3Link extends SimulationLinkDatum<D3Node> {
  source: D3Node;
  target: D3Node;
}

// ── Graph data model ──────────────────────────────────────────────────────

export interface MindmapGraphNode {
  id: string;
  label: string;
}

export interface MindmapGraphEdge {
  /** Defaults to `${source}->${target}` if omitted — see buildGraph(). */
  id?: string;
  source: string;
  target: string;
}

export interface MindmapGraph {
  nodes: MindmapGraphNode[];
  edges: MindmapGraphEdge[];
  /** Optional; initial focus/camera + Home key fallback. Unrelated to layout math — see mindmap-layout.ts computeRadialPositions(). */
  entryNodeId?: string;
}

export interface D3GraphNode extends SimulationNodeDatum {
  id: string;
  label: string;
  /** BFS distance from the tree root; only set when classifyShape() === 'tree'. Undefined for graph-shaped data. */
  depth?: number;
  collapsed: boolean;
  sourceNode: MindmapGraphNode;
  targetX?: number;
  targetY?: number;
}

export interface D3GraphEdge extends SimulationLinkDatum<D3GraphNode> {
  id: string;
  source: D3GraphNode;
  target: D3GraphNode;
}

// ── Context menu ─────────────────────────────────────────────────────────────

export type MenuItemIntent = 'danger' | 'warning';

export type MenuEntry =
  | { type: 'item'; label: string; action: () => void; disabled?: boolean; icon?: string; intent?: MenuItemIntent; children?: MenuEntry[] }
  | { type: 'topic'; label: string }
  | { type: 'separator' };

export type ContextMenuFn = (node: MindmapNode) => Promise<MenuEntry[]>;

// Return true to suppress the default collapse/expand behaviour.
export type NodeClickFn = (node: MindmapNode) => boolean | void;
