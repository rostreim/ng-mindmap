# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands are run from `mindmap-app/`.

```bash
npm start          # dev server at http://localhost:4200 (use --port N if 4200 is taken)
npm run build      # production build → dist/mindmap-app/
npm run watch      # dev build in watch mode (no server)
npm test           # Vitest unit tests (via @angular/build:unit-test, jsdom environment)
npm run e2e        # Playwright tests in a real Chromium (drag, zoom, keyboard nav — what jsdom can't do)
npx tsc -b --noEmit  # type-check without emitting
```

`npx tsc --noEmit` (without `-b`) is a **silent no-op** in this project: the root `tsconfig.json` has `"files": []` and only `"references"` (the standard Angular CLI multi-project layout — `tsconfig.app.json`/`tsconfig.spec.json` hold the real `include`s), and plain non-build-mode `tsc` doesn't follow `references`. It exits 0 with zero files checked regardless of actual errors. Always use `-b` (build mode, follows references) to actually type-check.

## Architecture

The app is a single Angular 21 standalone component with no routing and no services.

### Data flow

```
MindmapGraph (input: flat nodes[] + edges[])
  └─ buildGraph()  → D3GraphNode[] / D3GraphEdge[] (id refs resolved to live object refs)
       └─ classifyShape()  → 'tree' | 'graph' (auto-detected, not an input)
            └─ computeVisibleGraph()  → visible nodes[] + edges[] (collapse-aware)
                 └─ D3 force simulation (or computeRadialPositions(), tree-only) → SVG tick loop
```

`MindmapGraph` (`mindmap.model.ts`) is the public API — a flat `{ nodes: MindmapGraphNode[], edges: MindmapGraphEdge[], entryNodeId? }` structure; edges reference nodes by string id (`source`/`target`), not by nesting. `buildGraph()` resolves those ids into live `D3GraphNode` object refs once (required for D3's force-link) and validates structurally as it goes — duplicate node ids, self-loops, and edges pointing at unknown ids all throw immediately rather than surfacing as a downstream D3 or `classifyShape()` error. `classifyShape()` then inspects the built graph and auto-detects whether it's `'tree'`-shaped (single root, no node with more than one incoming edge, no cycle) or `'graph'`-shaped — there's no explicit mode input; a consumer just hands over nodes/edges and the component figures out which behavior applies. `resolveEntryNode()` picks the initial focus/camera node: the explicit `entryNodeId` if it resolves, else the best zero-indegree node, else (fully cyclic data) the most-connected node overall.

### Component internals (`mindmap.ts`)

- **`initSvg()`** — called once in `ngOnInit`; sets up the SVG, dark background rect, zoom/pan behavior, and the root `<g class="graph">` container.
- **`render()`** — called on first init and on `data` input changes; rebuilds `allNodes`/`allEdges` via `buildGraph()` (reusing each still-present node's settled `x`/`y` from the previous build, matched by id, instead of re-scattering the whole graph to fresh random spawn points), re-derives `shape` via `classifyShape()`, re-resolves the entry node via `resolveEntryNode()`, and — tree-shaped data only — computes per-node `depth` with a BFS from the entry node; `depth` stays `undefined` for graph-shaped data.
- **`redraw()`** — called after every collapse/expand, theme change, `collapseMode` change, or `layoutMode` change; recomputes visible nodes/edges via `computeVisibleGraph()` and dispatches to one of three sync methods based on the *effective* layout mode (see Layout modes below for the graph-shaped gating).
- **`syncForceSimulation()` / `syncHybridSimulation()` / `syncRadialLayout()`** — patch the DOM and (where applicable) the D3 force simulation via `join()` rather than tearing down and re-appending everything, so unaffected nodes keep their element identity across a redraw. See Performance contract below for why none of this needs any explicit zone handling.
- **`computeRadialPositions()`** — pure `d3-hierarchy`/`d3-tree` math (no DOM), used by `'radial'` and `'hybrid'` layout modes to compute deterministic target positions; builds its hierarchy from `visibleEdges` (an adjacency function) rather than a nested `.children` property, since `D3GraphNode` is flat.
- **`toggleCollapse()`** — flips `collapsed` on the clicked `D3GraphNode`, then calls `redraw()`, which re-derives visibility via `computeVisibleGraph()`. Also pushes a message onto `liveMessage`, an `aria-live="polite"` signal bound in `mindmap.html` that announces the new state to screen readers. The click/keydown handlers push their own `liveMessage` when `nodeClickFn()` intercepts instead (node "activated" rather than collapsed/expanded).

### Layout modes

`layoutMode: 'force' | 'radial' | 'hybrid'` (default `'force'`, reactive) controls how node positions are computed:

- **`force`** — today's original behavior: a continuously-running D3 force simulation (link/charge/center/collision), Obsidian-graph-view style.
- **`radial`** — fully deterministic radial tree layout, no simulation.
- **`hybrid`** — deterministic radial base positions with a brief, weak collision-only settle animation.

`radial`/`hybrid` are tree-only — both need a single root to hang `computeRadialPositions()`'s d3-hierarchy off of. If `classifyShape()` reports `'graph'`, `redraw()` silently falls back to `'force'` for that render and logs a console warning rather than throwing.

### Collapse propagation (`collapseMode` input)

`collapseMode: 'global' | 'per-edge'` (default `'global'`) only matters for graph-shaped data with a shared (multi-parent) node — trees have no shared nodes, so both modes behave identically there. `computeVisibleGraph()` implements this as two phases: a forward walk from every root/seed that never descends past a collapsed node (this alone already gives `'per-edge'` semantics — a shared node stays visible via any non-collapsed parent), followed by a `'global'`-only pruning pass that unconditionally hides everything downstream of a collapsed node even if another path also reaches it.

### Keyboard nav and ARIA — tree vs. graph

`onNodeKeydown()` branches on `shape` (set by `classifyShape()` in `render()`) into `onNodeKeydownTree()` or `onNodeKeydownGraph()`, and `applyNodeAria()` follows the same split:

- **Tree-shaped:** `role="tree"` on the SVG, `role="treeitem"` per node (`aria-level`/`aria-setsize`/`aria-posinset`). ArrowUp/Down move focus through `visibleNodes` (DFS order); ArrowRight/Left expand/collapse or move to child/parent.
- **Graph-shaped:** `role="application"` on the SVG, `role="button"` per node (no tree-position ARIA — a DAG node's "position" isn't well-defined). ArrowUp/Down cycle a per-node outgoing-edge cursor (`cycleOutgoingEdge()`) without moving focus; ArrowRight commits to the cursored edge and records it in `arrivedVia` so ArrowLeft can retrace it, since there's no DFS order to walk back through instead.

Both branches share Enter/Space (activate via `nodeClickFn()`, or toggle-collapse), Home/End, and the context-menu keys (`Shift+F10`, `ContextMenu`).

### Edge direction (`edgeDirection` input)

`edgeDirection: 'arrow' | 'plain' | undefined` (default `undefined`, meaning "pick by shape": `'arrow'` for graph-shaped data, `'plain'` for tree-shaped). Arrow mode adds an SVG marker and shortens each line's endpoint back along the source→target vector by the target node's radius, so the arrowhead lands on the node's boundary instead of inside it.

### Performance contract

`ChangeDetectionStrategy.OnPush` keeps this component's re-renders scoped to structural changes (input swap, collapse, layout mode switch). The D3 tick loop, drag handler, pan/zoom callbacks, and DOM event listeners (in `mindmap.ts` and `context-menu.ts`) never write to a signal or call an `output()`, so none of them schedule change detection on their own — regardless of zone.

This app has no `zone.js` installed (Angular 21 runs zoneless by default without it) and neither `MindmapComponent` nor `ContextMenuComponent` inject `NgZone` — there's nothing to escape or re-enter. Change detection here is entirely signal-driven: a `signal.set()`/`output().emit()` schedules it, and D3's own DOM mutations (tick, drag, pan/zoom) are invisible to Angular simply because they never touch either.

### Styling

The dark theme is hardcoded (`#1e1e2e` SVG background, `#181825` page background) to match Obsidian's graph view palette. Node colours are assigned by depth via a D3 `scaleOrdinal` in `MindmapComponent.colorScale`.

## TypeScript config

`strict: true` plus `noImplicitOverride`, `noImplicitReturns`, and `strictTemplates` are all on. The `module: "preserve"` setting is required for Angular's esbuild pipeline.
