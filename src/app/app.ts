import { Component, computed, signal } from '@angular/core';
import { MindmapComponent, MindmapLayout, MindmapTheme } from './mindmap/mindmap';
import { MindmapGraph, MindmapGraphNode, MenuEntry, NodeClickFn } from './mindmap/mindmap.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [MindmapComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly theme = signal<MindmapTheme>('dark');
  readonly layoutMode = signal<MindmapLayout>('force');
  readonly selectedNode = signal<MindmapGraphNode | null>(null);

  private readonly layoutModes: MindmapLayout[] = ['force', 'radial', 'hybrid'];

  toggleTheme(): void {
    this.theme.update((t) => (t === 'dark' ? 'light' : 'dark'));
  }

  cycleLayoutMode(): void {
    if (this.dataMode() === 'dag') {
      this.layoutMode.set('force');
      return;
    }
    const i = this.layoutModes.indexOf(this.layoutMode());
    this.layoutMode.set(this.layoutModes[(i + 1) % this.layoutModes.length]);
  }

  readonly nodeClickFn: NodeClickFn = (node: MindmapGraphNode): boolean | void => {
    const hasChildren = this.graph().edges.some((e) => e.source === node.id);
    if (!hasChildren) {
      this.selectedNode.set(node);
      return true;
    }
  };

  readonly nodeContextMenu = (node: MindmapGraphNode): Promise<MenuEntry[]> => {
    const hasChildren = this.graph().edges.some((e) => e.source === node.id);
    return Promise.resolve([
      { type: 'topic', label: `${node.label}` },
      { type: 'separator' },
      { type: 'item', icon: '⊕', label: 'Expand all',   action: () => console.log('expand all', node.id),   disabled: !hasChildren },
      { type: 'item', icon: '⊖', label: 'Collapse all', action: () => console.log('collapse all', node.id), disabled: !hasChildren },
      { type: 'separator' },
      {
        type: 'item',
        icon: '+',
        label: 'Add child',
        action: () => {},
        children: [
          { type: 'item', icon: '📄', label: 'Add note',  action: () => console.log('add note', node.id) },
          { type: 'item', icon: '🔗', label: 'Add link',  action: () => console.log('add link', node.id) },
          { type: 'item', icon: '🖼', label: 'Add image', action: () => console.log('add image', node.id) },
        ],
      },
      { type: 'separator' },
      { type: 'item', icon: '✏', label: 'Rename…',     action: () => console.log('rename', node.id) },
      { type: 'item', icon: '✕', label: 'Delete node', intent: 'danger', action: () => console.log('delete', node.id) },
    ]);
  };

  readonly dataMode = signal<'tree' | 'dag'>('tree');

  readonly treeGraph: MindmapGraph = {
    entryNodeId: 'root',
    nodes: [
      { id: 'root', label: 'Household' },
      { id: 'frontend', label: 'Frontend' },
      { id: 'angular', label: 'Angular' },
      { id: 'signals', label: 'Signals' },
      { id: 'standalone', label: 'Standalone' },
      { id: 'react', label: 'React' },
      { id: 'hooks', label: 'Hooks' },
      { id: 'suspense', label: 'Suspense' },
      { id: 'd3', label: 'D3.js' },
      { id: 'backend', label: 'Backend' },
      { id: 'node', label: 'Node.js' },
      { id: 'express', label: 'Express' },
      { id: 'fastify', label: 'Fastify' },
      { id: 'go', label: 'Go' },
      { id: 'rust', label: 'Rust' },
      { id: 'data', label: 'Data' },
      { id: 'postgres', label: 'PostgreSQL' },
      { id: 'redis', label: 'Redis' },
      { id: 'kafka', label: 'Kafka' },
      { id: 'devops', label: 'DevOps' },
      { id: 'docker', label: 'Docker' },
      { id: 'k8s', label: 'Kubernetes' },
      { id: 'ci', label: 'CI / CD' },
    ],
    edges: [
      { source: 'root', target: 'frontend' }, { source: 'root', target: 'backend' },
      { source: 'root', target: 'data' }, { source: 'root', target: 'devops' },
      { source: 'frontend', target: 'angular' }, { source: 'frontend', target: 'react' }, { source: 'frontend', target: 'd3' },
      { source: 'angular', target: 'signals' }, { source: 'angular', target: 'standalone' },
      { source: 'react', target: 'hooks' }, { source: 'react', target: 'suspense' },
      { source: 'backend', target: 'node' }, { source: 'backend', target: 'go' }, { source: 'backend', target: 'rust' },
      { source: 'node', target: 'express' }, { source: 'node', target: 'fastify' },
      { source: 'data', target: 'postgres' }, { source: 'data', target: 'redis' }, { source: 'data', target: 'kafka' },
      { source: 'devops', target: 'docker' }, { source: 'devops', target: 'k8s' }, { source: 'devops', target: 'ci' },
    ],
  };

  /** Same content, but 'd3' is shared between 'frontend' and 'backend' (Node.js visualization tooling), and 'ci' also depends on 'docker' — a small, deliberately non-tree DAG to exercise collapseMode/edgeDirection. */
  readonly dagGraph: MindmapGraph = {
    entryNodeId: 'root',
    nodes: this.treeGraph.nodes,
    edges: [
      ...this.treeGraph.edges,
      { source: 'backend', target: 'd3' },   // 'd3' now has two parents: frontend, backend
      { source: 'ci', target: 'docker' },     // creates a cross-link, still no cycle
    ],
  };

  readonly graph = computed(() => (this.dataMode() === 'tree' ? this.treeGraph : this.dagGraph));

  readonly collapseMode = signal<'global' | 'per-edge'>('global');

  toggleDataMode(): void {
    this.dataMode.update((m) => (m === 'tree' ? 'dag' : 'tree'));
  }

  toggleCollapseMode(): void {
    this.collapseMode.update((m) => (m === 'global' ? 'per-edge' : 'global'));
  }
}
