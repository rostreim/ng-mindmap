# Mind-map layout modes: force / radial / hybrid

**Status:** Approved (design), pending implementation
**Component:** `mindmap-app/src/app/mindmap/` (`mindmap.ts`, `mindmap.spec.ts`)

## Goal

Resolve the force-directed-vs-deterministic-layout tension flagged in an earlier audit — not by picking a winner, but by making the layout algorithm a configurable, reactive input. The current force-directed behavior (visually modeled on Obsidian's graph view, per `CLAUDE.md`) stays the default and is otherwise untouched. Two new modes are added: a fully deterministic radial tree layout, and a hybrid that uses the same deterministic base positions with a brief settle-in animation.

## Non-goals

- No change to the default (`'force'`) behavior or its visual identity.
- No horizontal/vertical tree orientation — radial only, per the visual comparison (closest to how the existing force layout already tends to settle, and closest to how dedicated mind-mapping tools like XMind/MindMeister lay things out).
- No new ARIA/keyboard work — the keyboard-accessibility work already shipped is entirely position-agnostic (operates on node identity and `flattenVisible()` order, never on `x`/`y`), so it needs no changes for this feature.
- No depth guard on `buildTree()` — pre-existing note, out of scope here too.

## The `layoutMode` input

```ts
export type MindmapLayout = 'force' | 'radial' | 'hybrid';
@Input() layoutMode: MindmapLayout = 'force';
```

Reactive, following the existing pattern (`theme`/`width`/`height` are already reactive via `ngOnChanges`) — changing it live re-lays-out the current node set without a data reload.

- **`'force'`** (default): today's behavior, byte-for-byte unchanged. Non-breaking for every existing consumer.
- **`'radial'`**: fully deterministic. Root at center, children fan outward by depth ring. No simulation runs at all — same input always produces the same layout for a given visible set.
- **`'hybrid'`**: the same deterministic radial positions used as a *base*, then a short, weak force pass (collision-avoidance only, not link/charge-driven structure) runs once to resolve accidental overlaps and gives a soft settle-in. Converges near the base and stops — no continuous drift once settled.

## Radial layout algorithm

Standard d3 technique (the same approach behind d3's classic "Radial Tree" examples), not experimental:

1. `d3.hierarchy(this.rootNode)` — its default children-accessor (`d => d.children`) already matches `D3Node.children` directly, no adapter needed.
2. `d3.tree().size([2π, maxRadius])(hierarchy)` — `maxRadius` scales with the tree's max visible depth (a ring-spacing constant × depth, same style as the existing `LINK_DISTANCE_BASE`/`LINK_DISTANCE_PER_DEPTH` constants), so the whole tree always fits a fixed radius regardless of node count. Sibling angular spacing uses d3's default separation function (proportional to subtree size) — a tunable knob for implementation, not a design decision.
3. Convert each result's polar coordinate to Cartesian and write it onto the corresponding `D3Node`:
   ```
   x = radius * cos(angle - π/2)
   y = radius * sin(angle - π/2)
   ```

**Architecture:** `buildTree()` stays a pure structural transform, unaware of layout mode. `redraw()` gains a layout step that runs after `flattenVisible()` and before the existing simulation/tick code:
- `'radial'`: computes final `x`/`y` directly on each visible node, renders once via the existing `tick()`, and animates the position change with a D3 transition (since there's no simulation to smooth a possibly-large jump after collapse/expand — same transition pattern already used by `zoomToFit()`).
- `'hybrid'`: writes those same coordinates as the *starting* `x`/`y` (replacing today's random jitter, which stays exclusive to `'force'` mode), then runs a short simulation with collision-avoidance only, reusing the existing `REDRAW_ALPHA` reheat/settle mechanism already built for `'force'` mode.
- `'force'`: unchanged code path.

Extract the radial math into a standalone method (e.g. `computeRadialPositions(nodes: D3Node[]): void`) — it's pure data transformation (`d3-hierarchy`/`d3-tree`, no DOM, no `d3-zoom`), so it's directly unit-testable without the `jsdom`/`getBBox()` limitation noted in the keyboard-accessibility work.

## Interaction with existing features

- **Keyboard focus/navigation:** no changes. Roving tabindex, ARIA attributes, and arrow-key tree traversal all operate on node identity and `flattenVisible()` order, never on position.
- **Dragging:** `dragBehavior()`'s drag handler currently relies on the always-running force simulation to re-tick the view during a drag. Since `'radial'` mode runs no simulation, the drag handler must call `tick()` directly on every drag-move event regardless of layout mode, so a node still visually follows the pointer. After release, `'radial'` has no forces to snap the node back — it stays wherever dropped until the next `redraw()` (collapse/expand, data change, or mode switch) recomputes clean positions. Expected behavior, not a bug: local nudges survive until the next structural change resets them.
- **Zoom/pan:** already layout-agnostic (operates on the `<g>` transform). Switching `layoutMode` live moves everything at once, so the component calls `zoomToFit()` automatically right after a mode-switch redraw completes.
- **Collapse/expand under `'radial'`/`'hybrid'`:** since d3.tree's angular allotment depends on total visible leaf count, collapsing a sibling subtree can shift *other* unrelated nodes' angles too. This is normal tree-layout behavior, not a bug — "deterministic" means deterministic for a given visible set, not globally fixed across every collapse state. `'hybrid'`'s settle-on-redraw animation smooths this naturally; `'radial'`'s D3 transition (above) covers it too.

## Testing

- Unit test `computeRadialPositions()` directly (pure, no DOM): root lands at the origin, children land at the expected per-depth radius, siblings get distinct angles, a single-node tree doesn't divide-by-zero or crash — same style as the existing `buildTree`/`flattenVisible` tests.
- Manual in-browser verification for everything DOM/interaction-dependent: live mode switching, `zoomToFit()`-on-switch, dragging under `'radial'`, the collapse/expand transition in each mode, and a full regression pass confirming `'force'` mode is pixel-for-pixel unaffected.

## Edge cases

- Single-node tree: root at `(0,0)`, no crash, in both `'radial'` and `'hybrid'`.
- Very deep trees: `maxRadius` grows unboundedly with depth — pre-existing, out of scope.
- Mode switch mid-drag or mid-collapse-animation: no special-casing needed, `redraw()` is already the single reentrant-safe "recompute everything" entry point.
