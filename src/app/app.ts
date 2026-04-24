import { Component, signal } from '@angular/core';
import { MindmapComponent, MindmapTheme } from './mindmap/mindmap';
import { MindmapNode } from './mindmap/mindmap.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [MindmapComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly theme = signal<MindmapTheme>('dark');

  toggleTheme(): void {
    this.theme.update((t) => (t === 'dark' ? 'light' : 'dark'));
  }

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
