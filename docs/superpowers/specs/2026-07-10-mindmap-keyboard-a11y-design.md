# Keyboard accessibility for the mind-map component

**Status:** Approved (design), pending implementation
**Component:** `mindmap-app/src/app/mindmap/` (`mindmap.ts`, `mindmap.html`, `mindmap.scss`, `mindmap.model.ts`)

## Goal

Make the mind-map component fully operable by keyboard — navigate the tree, expand/collapse nodes, activate a node's click behavior, and open/operate the right-click context menu — without a mouse. This targets "solid, practical keyboard support" (proper ARIA roles, visible focus, correct behavior), not a formal WCAG conformance audit.

## Non-goals

- No formal WCAG 2.1 AA conformance testing / screen-reader test matrix.
- No `role="group"`/DOM-nested tree structure — see [ARIA structure](#aria-structure) for why.
- No custom live-region announcements — native AT behavior from real focus + ARIA state attributes covers this; see [Live regions](#live-regions).
- No changes to mouse/pointer behavior, force-simulation layout, or the existing public API beyond one additive input (`ariaLabel`).

## Focus model: roving tabindex

A single roving tabindex across the graph, per the ARIA treeview pattern:

- Exactly one node `<g class="node">` has `tabindex="0"` (the **active** node) at any time; all others have `tabindex="-1"`.
- `Tab`/`Shift+Tab` move focus into/out of the graph as a single stop in the page's tab order — not one stop per node.
- The active node is tracked internally (e.g. `private focusedNodeId: string | null`), defaulting to the root node on first render.
- Because `updateNodes()` already patches the DOM via D3 `join()` (nodes keep their DOM element identity across a redraw unless they're actually added/removed), the currently-focused element — and therefore native browser focus — survives a redraw untouched **unless** the focused node itself is removed (its ancestor just collapsed over it). In that case, before `redraw()` runs, move `focusedNodeId` to the nearest surviving ancestor and update `tabindex` accordingly, so focus never gets silently dropped.
- Each node `<g>` becomes a real interactive element (`tabindex`, `role`, one delegated `keydown` handler attached once in `enterNodes()`, consistent with how `click`/`contextmenu`/`mouseover` are already wired there).

## ARIA structure

- `<svg>`: `role="tree"`, `aria-label` — see [new `ariaLabel` input](#public-api-change).
- Each node `<g class="node">`: `role="treeitem"`, `aria-label` (the node's label text, set explicitly rather than relying on the nested SVG `<text>`'s implicit accessible name, which computes inconsistently across screen readers for SVG), `aria-level` (`depth + 1`, ARIA levels are 1-based), `aria-expanded` (`"true"`/`"false"`, present only on nodes that have children at all — i.e. `d.children.length || d._children?.length`), `aria-setsize`/`aria-posinset` (position among visible siblings, cheap to compute while flattening).
- **Deliberate simplification:** the textbook ARIA treeview pattern nests child `treeitem`s inside a `role="group"` under their parent. Here all nodes are flat siblings under one `<g class="nodes">`, positioned by the force simulation — there's no parent-child DOM nesting, and restructuring the D3 rendering to introduce it isn't worth the churn. `aria-level` alone conveys hierarchy; this is the standard pragmatic pattern for flat/virtualized tree UIs and is well supported by NVDA/JAWS/VoiceOver.
- No `aria-selected`: the component doesn't own a "selection" concept — that's a consumer concern via `nodeClickFn` (see the demo app's `selectedNode` signal). Adding one here would be inventing state the component doesn't actually have.

## Keyboard map — tree

| Key | Behavior |
|---|---|
| `Tab` / `Shift+Tab` | Move focus into/out of the graph (roving tabindex) |
| `↓` | Move focus to the next visible node, in the same depth-first order used for rendering (`flattenVisible`'s traversal order) |
| `↑` | Move focus to the previous visible node in that order |
| `→` | Collapsed node with hidden children: expand it, focus stays on the same node. Already-expanded node: move focus to its first child. Leaf: no-op |
| `←` | Expanded node: collapse it, focus stays on the same node. Already-collapsed node or leaf: move focus to its parent. Root: no-op |
| `Enter` / `Space` | Activate — invokes the exact same handler as a mouse click (`nodeClickFn` first; if it doesn't return `true`, `toggleCollapse`). Keyboard and mouse stay behaviorally identical |
| `Home` / `End` | Jump to the first (root) / last visible node in tree order |
| `Shift+F10` / `ContextMenu` key | Open the context menu, anchored to the focused node's position (not a pointer position, since there may be none) |

`→`/`←` are dedicated to expand/collapse/parent-child; sibling movement is `↓`/`↑` only, per the standard treeview convention.

## Context menu keyboard operability

The menu template (`mindmap.html`) already has `role="menu"`/`role="menuitem"` markup and submenu support (`MenuEntry.children`), but is currently mouse-only (`(click)` handlers only). Making it keyboard-operable is in scope for this pass, since a Shift+F10 trigger is pointless if the resulting menu can't be driven by keyboard:

| Key | Behavior |
|---|---|
| `↓` / `↑` | Move focus between menu items, skipping separators/topics/disabled items |
| `→` | If the focused item has a submenu, open it and move focus to its first item |
| `←` | If inside a submenu, close it and return focus to the parent item |
| `Enter` / `Space` | Activate the focused item (same as click) |
| `Home` / `End` | First / last item |
| `Escape` | Close the menu, return focus to the node that opened it (already-existing global Escape handler needs this focus-return added) |

This is effectively a second, self-contained roving-tabindex widget, separate from the tree's.

## Live regions

No custom live region. Real DOM focus (roving tabindex) plus `aria-expanded`/`aria-level`/`aria-setsize`/`aria-posinset` already gets announced natively by screen readers the moment focus lands or a watched attribute changes (e.g. NVDA announces "Frontend, treeitem, expanded, level 1, 2 of 3" on its own). Adding a custom live region on top would double-announce and add noise, which runs against the "solid support, not a compliance checklist" scope for this pass.

## Styling: focus-visible

`:focus-visible` on `.node[tabindex]` gets a themed outline ring (colors following the existing `:host([data-theme=...])` pattern already in `mindmap.scss`), rather than the browser's default ring, which won't read well against the dark canvas background. The context menu's `.mm-item` already has an unused `:focus-visible` rule (`outline: 2px solid currentColor`) — it activates as soon as menu items are actually made focusable.

## Public API change

One new optional input on `MindmapComponent`:

```ts
@Input() ariaLabel = 'Mind map';
```

Used as the `<svg>`'s `aria-label`. Additive, non-breaking, has a sensible default.

No other public API changes. Focus management is entirely internal (no new public methods needed beyond the existing `resetView()`/`zoomToFit()`).

## Implementation architecture

Following the project's existing convention (`CLAUDE.md`: single standalone component, no services), keyboard handling stays as private methods on `MindmapComponent`, organized under the same `── Section ──` comment-banner style already used throughout the file.

Tree navigation is implemented as small pure helpers, separated from the DOM-touching code that actually moves focus/`tabindex` — mirroring the existing `buildTree`/`flattenVisible` split:

- `nextVisible(d: D3Node): D3Node | null`
- `previousVisible(d: D3Node): D3Node | null`
- `firstVisible(): D3Node | null` (root)
- `lastVisible(): D3Node | null` (last in tree order)
- `firstChild(d: D3Node): D3Node | null`
- (parent is already available via `D3Node.parent`)

These operate on the same flattened `nodes: D3Node[]` array produced by `flattenVisible()` during `redraw()`, so they don't need to re-walk the tree independently.

## Testing plan

Unit test the pure tree-navigation helpers the same way `buildTree`/`flattenVisible`/`toggleCollapse` are already tested (`mindmap.spec.ts`, no DOM/D3-zoom involved, so no `jsdom`/`getBBox()` issues):

- `nextVisible`/`previousVisible` across siblings, into/out of collapsed subtrees, at the first/last node boundary
- `firstChild` on leaf vs. branch nodes
- `firstVisible`/`lastVisible` on a representative tree

Menu keyboard navigation (skip separators/disabled items, submenu open/close) is also unit-testable as a pure "given items + current index + key, what's the next index" helper, following the same pattern.

Full keyboard-driven end-to-end behavior (focus actually moving, ARIA attributes updating on the live DOM) gets verified manually in-browser, the same way the D3 join()/simulation-reheat work was verified earlier in this project — real SVG focus/keyboard behavior isn't something jsdom can faithfully exercise.

## Edge cases

- **Empty/undefined `data`:** no nodes exist, so there's nothing to focus — the graph is simply not in the tab order (no focusable elements). No special-casing needed beyond what already exists.
- **Single node (root only, no children):** all tree-navigation keys are no-ops except `Enter`/`Space`; `Home`/`End` land on the same node.
- **Very deep trees:** `↓`/`↑` traverse the full flattened order regardless of depth — no special handling needed, but this reinforces the existing (pre-existing, out of scope here) note that `buildTree` has no depth guard.
- **Collapsing the focused node's ancestor:** handled explicitly — see [Focus model](#focus-model-roving-tabindex).
- **Rapid re-render (data swap via `render()`, not just collapse):** the whole tree is rebuilt from scratch (existing behavior, unrelated to this change), so `focusedNodeId` resets to the new tree's root, same as first render.
