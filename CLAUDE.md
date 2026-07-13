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
- **`syncForceSimulation()` / `syncHybridSimulation()` / `syncRadialLayout()`** — patch the DOM and (where applicable) the D3 force simulation via `join()` rather than tearing down and re-appending everything, so unaffected nodes keep their element identity across a redraw. All three are wrapped in `NgZone.runOutsideAngular()` — see Performance contract below for what that actually buys in this zoneless app.
- **`computeRadialPositions()`** — pure `d3-hierarchy`/`d3-tree` math (no DOM), used by `'radial'` and `'hybrid'` layout modes to compute deterministic target positions.
- **`toggleCollapse()`** — swaps `children ↔ _children` on the clicked node, then calls `redraw()`. Also pushes a message onto `liveMessage`, an `aria-live="polite"` signal bound in `mindmap.html` that announces the new state to screen readers. The click/keydown handlers push their own `liveMessage` when `nodeClickFn()` intercepts instead (node "activated" rather than collapsed/expanded).

### Layout modes

`layoutMode: 'force' | 'radial' | 'hybrid'` (default `'force'`, reactive) controls how node positions are computed:

- **`force`** — today's original behavior: a continuously-running D3 force simulation (link/charge/center/collision), Obsidian-graph-view style.
- **`radial`** — fully deterministic radial tree layout, no simulation.
- **`hybrid`** — deterministic radial base positions with a brief, weak collision-only settle animation.

### Performance contract

`ChangeDetectionStrategy.OnPush` keeps this component's re-renders scoped to structural changes (input swap, collapse, layout mode switch). The D3 tick loop, drag handler, and pan/zoom callbacks (in `force`/`hybrid` modes) never write to a signal, so none of them schedule change detection — regardless of zone.

Note: this app has no `zone.js` installed (Angular 21 runs zoneless by default without it), so the `NgZone.runOutsideAngular()`/`.run()` calls in `mindmap.ts` and `context-menu.ts` are effectively no-ops here — they're kept for correctness in case zone.js is ever reintroduced, not because they're what makes the tick loop cheap today. The actual mechanism is that those callbacks simply never touch a signal.

### Styling

The dark theme is hardcoded (`#1e1e2e` SVG background, `#181825` page background) to match Obsidian's graph view palette. Node colours are assigned by depth via a D3 `scaleOrdinal` in `MindmapComponent.colorScale`.

## TypeScript config

`strict: true` plus `noImplicitOverride`, `noImplicitReturns`, and `strictTemplates` are all on. The `module: "preserve"` setting is required for Angular's esbuild pipeline.
