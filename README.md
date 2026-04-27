# Mindmap

An Angular component that renders interactive force-directed mindmaps, styled after Obsidian's graph view. Built with D3.js v7 and Angular 21 standalone components.

## Features

- Force-directed layout via D3 simulation — nodes repel and settle organically
- Zoom (scroll) and pan (drag canvas) via D3 zoom
- Drag individual nodes to reposition them
- Click any node to collapse or expand its subtree; a badge dot marks hidden children
- Right-click context menu with async item population, sub-menus, icons, and intent styling
- Optional node click handler to intercept clicks and suppress default collapse/expand
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
  [theme]="'dark'"
  [contextMenuFn]="nodeContextMenu"
  [nodeClickFn]="nodeClickFn"
/>
```

### Inputs

| Input | Type | Default | Description |
|---|---|---|---|
| `data` | `MindmapNode` | — | Root node of the tree (required) |
| `width` | `number` | `900` | SVG width in px |
| `height` | `number` | `650` | SVG height in px |
| `theme` | `'dark' \| 'light'` | `'dark'` | Colour theme |
| `contextMenuFn` | `ContextMenuFn` | — | Returns menu entries for a right-clicked node |
| `nodeClickFn` | `NodeClickFn` | — | Intercepts node clicks; return `true` to suppress collapse/expand |

### Input data shape

```ts
interface MindmapNode {
  id: string;
  label: string;
  children?: MindmapNode[];
}
```

### Context menu

Provide an async `contextMenuFn` to populate a right-click menu for any node:

```ts
import { ContextMenuFn, MenuEntry } from './mindmap/mindmap.model';

readonly nodeContextMenu: ContextMenuFn = (node) =>
  Promise.resolve([
    { type: 'topic', label: node.label },
    { type: 'separator' },
    { type: 'item', icon: '✏', label: 'Rename…', action: () => rename(node) },
    { type: 'item', icon: '🗑', label: 'Delete',  action: () => remove(node), intent: 'danger' },
  ]);
```

#### `MenuEntry` types

| Type | Fields | Description |
|---|---|---|
| `item` | `label`, `action`, `icon?`, `disabled?`, `intent?`, `children?` | Clickable action; `children` opens a sub-menu |
| `topic` | `label` | Non-interactive group label, full-width, muted |
| `separator` | — | Horizontal rule |

#### `intent` values

| Value | Colour |
|---|---|
| `'danger'` | Red — for destructive actions |
| `'warning'` | Yellow/amber — for caution actions |

### Node click handler

Provide a `nodeClickFn` to intercept node clicks. Return `true` to suppress the default collapse/expand:

```ts
import { NodeClickFn } from './mindmap/mindmap.model';

readonly nodeClickFn: NodeClickFn = (node) => {
  if (!node.children?.length) {
    this.selectedNode.set(node);
    return true;  // suppress collapse/expand
  }
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
