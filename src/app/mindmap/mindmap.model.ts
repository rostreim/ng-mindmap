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
}

export interface D3Link extends SimulationLinkDatum<D3Node> {
  source: D3Node;
  target: D3Node;
}

// ── Context menu ─────────────────────────────────────────────────────────────

export type MenuEntry =
  | { type: 'item'; label: string; action: () => void; disabled?: boolean; children?: MenuEntry[] }
  | { type: 'separator' };

export type ContextMenuFn = (node: MindmapNode) => Promise<MenuEntry[]>;
