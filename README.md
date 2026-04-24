# Mindmap

An Angular component that renders interactive force-directed mindmaps, styled after Obsidian's graph view. Built with D3.js v7 and Angular 21 standalone components.

## Features

- Force-directed layout via D3 simulation — nodes repel and settle organically
- Zoom (scroll) and pan (drag canvas) via D3 zoom
- Drag individual nodes to reposition them
- Click any node to collapse or expand its subtree; a badge dot marks hidden children
- **Dark theme** — Obsidian-inspired purple/green palette
- **Light theme** — nFocus design-system tokens (Inter/Public Sans, Kendo series palette, `#f9fbfc` surface)
- Theme toggle button; all transitions are animated

## Getting started

```bash
npm install
npm start          # http://localhost:4200
```

## Usage

```ts
import { MindmapComponent } from './mindmap/mindmap';
import { MindmapNode } from './mindmap/mindmap.model';
```

```html
<app-mindmap
  [data]="tree"
  [width]="960"
  [height]="680"
  [theme]="'dark'"   <!-- 'dark' | 'light' -->
/>
```

### Input data shape

```ts
interface MindmapNode {
  id: string;
  label: string;
  children?: MindmapNode[];
}
```

Example:

```ts
readonly tree: MindmapNode = {
  id: 'root',
  label: 'My Map',
  children: [
    {
      id: 'a',
      label: 'Topic A',
      children: [
        { id: 'a1', label: 'Subtopic A1' },
        { id: 'a2', label: 'Subtopic A2' },
      ],
    },
    { id: 'b', label: 'Topic B' },
  ],
};
```

## Commands

```bash
npm start            # dev server (port 4200)
npm run build        # production build → dist/
npm run watch        # dev build, watch mode
npm test             # Karma unit tests
npx tsc --noEmit     # type-check only
```

## Tech

| | |
|---|---|
| Framework | Angular 21, standalone components |
| Visualisation | D3.js v7 (force simulation, zoom, drag) |
| Styles | SCSS, `ChangeDetectionStrategy.OnPush`, `NgZone.runOutsideAngular` |
| Language | TypeScript 5.9, strict mode |
