# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands are run from `mindmap-app/`.

```bash
npm start          # dev server at http://localhost:4200 (use --port N if 4200 is taken)
npm run build      # production build → dist/mindmap-app/
npm run watch      # dev build in watch mode (no server)
npm test           # Karma unit tests
npx tsc --noEmit   # type-check without emitting
```

## Architecture

The app is a single Angular 21 standalone component with no routing and no services.

### Data flow

```
MindmapNode (input tree)
  └─ buildTree()  → D3Node tree (parent/children refs, collapse state)
       └─ flattenVisible()  → flat nodes[] + links[] arrays
            └─ D3 force simulation  → SVG tick loop
```

`MindmapNode` (`mindmap.model.ts`) is the public API — a plain recursive `{ id, label, children? }` tree. It is converted once into a `D3Node` tree that carries simulation state (`x`, `y`, `fx`, `fy`, `collapsed`, `_children`). `D3Link` holds `source`/`target` as live `D3Node` references (not id strings), which is required for D3's force-link.

### Component internals (`mindmap.ts`)

- **`initSvg()`** — called once in `ngOnInit`; sets up the SVG, dark background rect, zoom/pan behavior, and the root `<g class="graph">` container.
- **`render()`** — called on first init and on `data` input changes; rebuilds the full `D3Node` tree from scratch.
- **`redraw()`** — called after every collapse/expand; clears the graph, re-flattens visible nodes, and restarts the simulation.
- **`startSimulation()`** — runs *outside Angular's zone* via `NgZone.runOutsideAngular` so the D3 tick loop never triggers change detection. Collapse/expand re-enters the zone via `zone.run()`.
- **`toggleCollapse()`** — swaps `children ↔ _children` on the clicked node, then calls `redraw()`.

### Performance contract

`ChangeDetectionStrategy.OnPush` + `NgZone.runOutsideAngular` means D3's 60 fps tick loop is invisible to Angular. Only structural changes (input swap, collapse) trigger Angular work.

### Styling

The dark theme is hardcoded (`#1e1e2e` SVG background, `#181825` page background) to match Obsidian's graph view palette. Node colours are assigned by depth via a D3 `scaleOrdinal` in `MindmapComponent.colorScale`.

## TypeScript config

`strict: true` plus `noImplicitOverride`, `noImplicitReturns`, and `strictTemplates` are all on. The `module: "preserve"` setting is required for Angular's esbuild pipeline.
