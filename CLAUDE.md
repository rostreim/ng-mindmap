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
MindmapNode (input tree)
  └─ buildTree()  → D3Node tree (parent/children refs, collapse state)
       └─ flattenVisible()  → flat nodes[] + links[] arrays
            └─ D3 force simulation  → SVG tick loop
```

`MindmapNode` (`mindmap.model.ts`) is the public API — a plain recursive `{ id, label, children? }` tree. It is converted once into a `D3Node` tree that carries simulation state (`x`, `y`, `fx`, `fy`, `collapsed`, `_children`). `D3Link` holds `source`/`target` as live `D3Node` references (not id strings), which is required for D3's force-link.

### Component internals (`mindmap.ts`)

- **`initSvg()`** — called once in `ngOnInit`; sets up the SVG, dark background rect, zoom/pan behavior, and the root `<g class="graph">` container.
- **`render()`** — called on first init and on `data` input changes; rebuilds the full `D3Node` tree via `buildTree()`, reusing each still-present node's settled `x`/`y` from the previous tree (matched by id, via `flattenAll()`) instead of re-scattering the whole graph to fresh random spawn points.
- **`redraw()`** — called after every collapse/expand, theme change, or `layoutMode` change; re-flattens visible nodes and dispatches to one of three sync methods based on `layoutMode`.
- **`syncForceSimulation()` / `syncHybridSimulation()` / `syncRadialLayout()`** — patch the DOM and (where applicable) the D3 force simulation via `join()` rather than tearing down and re-appending everything, so unaffected nodes keep their element identity across a redraw. See Performance contract below for why none of this needs any explicit zone handling.
- **`computeRadialPositions()`** — pure `d3-hierarchy`/`d3-tree` math (no DOM), used by `'radial'` and `'hybrid'` layout modes to compute deterministic target positions.
- **`toggleCollapse()`** — swaps `children ↔ _children` on the clicked node, then calls `redraw()`. Also pushes a message onto `liveMessage`, an `aria-live="polite"` signal bound in `mindmap.html` that announces the new state to screen readers. The click/keydown handlers push their own `liveMessage` when `nodeClickFn()` intercepts instead (node "activated" rather than collapsed/expanded).

### Layout modes

`layoutMode: 'force' | 'radial' | 'hybrid'` (default `'force'`, reactive) controls how node positions are computed:

- **`force`** — today's original behavior: a continuously-running D3 force simulation (link/charge/center/collision), Obsidian-graph-view style.
- **`radial`** — fully deterministic radial tree layout, no simulation.
- **`hybrid`** — deterministic radial base positions with a brief, weak collision-only settle animation.

### Performance contract

`ChangeDetectionStrategy.OnPush` keeps this component's re-renders scoped to structural changes (input swap, collapse, layout mode switch). The D3 tick loop, drag handler, pan/zoom callbacks, and DOM event listeners (in `mindmap.ts` and `context-menu.ts`) never write to a signal or call an `output()`, so none of them schedule change detection on their own — regardless of zone.

This app has no `zone.js` installed (Angular 21 runs zoneless by default without it) and neither `MindmapComponent` nor `ContextMenuComponent` inject `NgZone` — there's nothing to escape or re-enter. Change detection here is entirely signal-driven: a `signal.set()`/`output().emit()` schedules it, and D3's own DOM mutations (tick, drag, pan/zoom) are invisible to Angular simply because they never touch either.

### Styling

The dark theme is hardcoded (`#1e1e2e` SVG background, `#181825` page background) to match Obsidian's graph view palette. Node colours are assigned by depth via a D3 `scaleOrdinal` in `MindmapComponent.colorScale`.

## TypeScript config

`strict: true` plus `noImplicitOverride`, `noImplicitReturns`, and `strictTemplates` are all on. The `module: "preserve"` setting is required for Angular's esbuild pipeline.
