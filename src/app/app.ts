import { Component, signal } from '@angular/core';
import { MindmapComponent, MindmapTheme } from './mindmap/mindmap';
import { MindmapNode, MenuEntry, NodeClickFn } from './mindmap/mindmap.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [MindmapComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly theme = signal<MindmapTheme>('dark');
  readonly selectedNode = signal<MindmapNode | null>(null);

  toggleTheme(): void {
    this.theme.update((t) => (t === 'dark' ? 'light' : 'dark'));
  }

  readonly nodeClickFn: NodeClickFn = (node: MindmapNode): boolean | void => {
    if (!node.children?.length) {
      this.selectedNode.set(node);
      return true;
    }
  };

  readonly nodeContextMenu = (node: MindmapNode): Promise<MenuEntry[]> => {
    const hasChildren = !!node.children?.length;
    return Promise.resolve([
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
      { type: 'item', icon: '✕', label: 'Delete node', action: () => console.log('delete', node.id) },
    ]);
  };

  readonly graph: MindmapNode = {
    id: 'root',
    label: 'Household',
    children: [
      {
        id: 'frontend',
        label: 'Frontend',
        children: [
          { id: 'angular', label: 'Angular', children: [
            { id: 'signals', label: 'Signals' },
            { id: 'standalone', label: 'Standalone' },
          ]},
          { id: 'react', label: 'React', children: [
            { id: 'hooks', label: 'Hooks' },
            { id: 'suspense', label: 'Suspense' },
          ]},
          { id: 'd3', label: 'D3.js' },
        ],
      },
      {
        id: 'backend',
        label: 'Backend',
        children: [
          { id: 'node', label: 'Node.js', children: [
            { id: 'express', label: 'Express' },
            { id: 'fastify', label: 'Fastify' },
          ]},
          { id: 'go', label: 'Go' },
          { id: 'rust', label: 'Rust' },
        ],
      },
      {
        id: 'data',
        label: 'Data',
        children: [
          { id: 'postgres', label: 'PostgreSQL' },
          { id: 'redis', label: 'Redis' },
          { id: 'kafka', label: 'Kafka' },
        ],
      },
      {
        id: 'devops',
        label: 'DevOps',
        children: [
          { id: 'docker', label: 'Docker' },
          { id: 'k8s', label: 'Kubernetes' },
          { id: 'ci', label: 'CI / CD' },
        ],
      },
    ],
  };
}
