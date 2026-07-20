# Extract a Framework-Agnostic Mindmap Core — Design

*Date: 2026-07-20*
*Status: approved*

## Purpose

`MindmapComponent` (`src/app/mindmap/mindmap.ts`, ~956 lines) is an Angular
component, but a scoping pass found that almost none of its logic is
actually Angular-specific — the D3 force/zoom/drag setup, all three
layout-mode sync methods, the node/edge join/render logic, keyboard nav, and
collapse toggling have no framework dependency at all; only a thin layer of
`input()`/`effect()`/`signal()` reactivity and lifecycle hooks wraps them.
This phase extracts that logic into a standalone `MindmapCore` class with
zero Angular imports, so it can eventually be consumed by a separate
project (a Python/FastAPI app, `pccpoa-mcp`) as a plain JS bundle loaded via
a `<script>` tag — no Angular, no Node runtime required at that project's
deploy time.

This is the first of two phases. This phase stays entirely within
`ng-mindmap`: extract the core, re-verify `MindmapComponent` still works
unchanged wrapping it, and produce a standalone bundle + demo proving the
core works outside Angular. Wiring the core into `pccpoa-mcp` is a separate,
later phase, out of scope here.

## `MindmapCore`

New file `src/app/mindmap/mindmap-core.ts`, alongside the existing
`mindmap-layout.ts`/`mindmap.model.ts` (both consumed unchanged — they
already have zero Angular imports). A plain class:

- **Constructor** takes the raw `SVGSVGElement` directly (replacing
  `ElementRef`/`@ViewChild`) plus an options object mirroring today's
  inputs: `width`, `height`, `theme`, `layoutMode`, `collapseMode`,
  `edgeDirection`, `ariaLabel`.
- **Setter methods** (`setData`, `setTheme`, `setLayoutMode`, `setSize`,
  `setCollapseMode`, `setEdgeDirection`) — each is the exact body of
  today's corresponding `effect()` in `mindmap.ts`'s constructor, called
  explicitly instead of reactively. Everything `render()`/`redraw()`/
  `initSvg()`/`toggleCollapse()` and below (the D3/SVG internals) moves
  over verbatim.
- **Callback hooks**: `contextMenuFn?: ContextMenuFn` and
  `nodeClickFn?: NodeClickFn` (already plain callback types, unchanged).
  Two new ones replace what today flows through Angular signals:
  `onOpenContextMenu?: (entries: MenuEntry[], x: number, y: number) => void`
  (core calls this instead of setting `menuOpen`/`menuX`/`menuY`/
  `menuEntries` signals) and `onLiveMessage?: (message: string) => void`
  (replaces the `liveMessage` signal, used for aria-live announcements on
  collapse/expand/activate).
- **`notifyMenuClosed(reason)`** stays a core method — it needs
  `visibleNodes`/`moveFocusTo`, both core-internal, to refocus the opener
  node on Escape. The Angular wrapper's `onContextMenuClosed` template
  handler becomes a one-line delegate to it.
- **Public methods**: `resetView()`, `zoomToFit()`, `destroy()` (stops the
  D3 simulation) — same behavior as today.

`context-menu.ts`/`ContextMenuComponent` is untouched — it stays an
Angular-only, optional UI layer that the wrapper renders in response to
`onOpenContextMenu`. A non-Angular consumer can ignore that hook entirely
or implement its own popup.

## `MindmapComponent` (thin wrapper)

Shrinks to: hold a `MindmapCore` instance (constructed in `ngOnInit` against
`this.svgRef.nativeElement`), translate each `input()`/`effect()` into the
matching core setter call, implement `onOpenContextMenu`/`onLiveMessage` by
writing to its own signals (the existing template's bindings to
`ContextMenuComponent` and the `aria-live` region don't change), and
delegate `resetView()`/`zoomToFit()`/`onContextMenuClosed()` straight
through to the core. `ngOnDestroy` calls `core.destroy()`.

No behavior change from a consumer's perspective — every existing input,
output, and interaction (drag, zoom, collapse, keyboard nav, context menu,
theme/layout-mode switching) must work identically to before.

## Test migration

New `mindmap-core.spec.ts` gets the D3/layout-behavior assertions currently
in `mindmap.spec.ts`: render/redraw, layout-mode gating and the
graph-shaped fallback-to-force warning, collapse toggling and its
interaction with `computeVisibleGraph`, keyboard nav (tree vs. graph
branches), radial/hybrid sync, edge-direction/arrow rendering — each
rewritten to instantiate `MindmapCore` directly against a real `<svg>`
element created in jsdom (same Vitest/jsdom setup already in use, no new
test infrastructure). `mindmap.spec.ts` shrinks to a thin wiring-smoke
suite: confirms each input change calls the matching core setter, confirms
`onOpenContextMenu` populates the menu signals and renders
`ContextMenuComponent`, confirms `onContextMenuClosed`/Escape correctly
refocuses. `context-menu.spec.ts` is untouched. Playwright e2e tests are
untouched — they exercise the fully-assembled component regardless of how
its internals are split.

## Proof-of-portability bundle + demo

A new, separate build step using esbuild (no existing library-build tooling
in this repo to build on — `ng-packagr`/Vite-lib-mode would be new
tooling for one file; esbuild is a single lightweight dependency and
sufficient): bundles `mindmap-core.ts` + `mindmap-layout.ts` +
`mindmap.model.ts` + `d3` into one IIFE file, with `d3` bundled in (not
externalized) so the artifact is a genuine single-file drop-in — no
separate CDN coordination required by a consumer. A small demo page
(`demo/index.html`, outside the Angular app's build) loads that bundle
against sample graph data and renders it with zero Angular present, using
the real ported `MindmapCore` — this is what actually proves the premise
before any `pccpoa-mcp` work begins, as opposed to the earlier hand-written
sketch that only approximated the real logic.

## Out of scope (deferred to the later pccpoa-mcp integration phase)

- Any changes to `pccpoa-mcp` itself.
- Publishing the bundle anywhere (npm, a CDN, etc.) — the demo consumes a
  locally-built file directly.
- Designing the actual data shape `pccpoa-mcp` would feed the core (ARC
  request relations, discussion threads, citations) — that's real product
  design work for the later phase, not needed to prove portability here.
- Any UI shell (toolbar, layout-mode switcher) for the demo beyond what's
  needed to show the core rendering and responding to interaction.

## Testing

Existing Playwright e2e suite must pass unchanged (it doesn't care about
the internal split). New `mindmap-core.spec.ts` covers the migrated
behavior tests. Thinned `mindmap.spec.ts` covers wiring only. Manual
verification: run the Angular demo app (`npm start`) and confirm all
existing interactions (drag, zoom, collapse, keyboard nav, context menu,
theme/layout switching) still work identically; open the new
non-Angular `demo/index.html` in a browser and confirm the bundle renders
and responds to drag/zoom/collapse with zero Angular loaded.

## Open questions

None outstanding — all decisions (core API shape, context-menu handling,
test-migration approach, bundle/demo inclusion) were resolved during
brainstorming and are reflected above.
