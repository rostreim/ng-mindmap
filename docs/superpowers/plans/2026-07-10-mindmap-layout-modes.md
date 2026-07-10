# Mind-map layout modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reactive `layoutMode: 'force' | 'radial' | 'hybrid'` input to the mind-map component, so the existing force-directed behavior stays the default while consumers can opt into a deterministic radial tree layout or a hybrid (deterministic base + light settle-in jostle).

**Architecture:** `buildTree()`/`flattenVisible()` stay untouched (pure structural transforms). A new `computeRadialPositions()` method (pure `d3-hierarchy`/`d3-tree` math, no DOM) writes `targetX`/`targetY` onto each visible `D3Node`. `redraw()` branches by `layoutMode` into one of three sync methods: the existing force simulation (renamed `syncForceSimulation`), a new `syncHybridSimulation` (collision-only force pulling toward the computed targets), or a new `syncRadialLayout` (no simulation, direct position set + D3 transition).

**Tech Stack:** Angular 21, D3 v7 (`d3-hierarchy`, `d3-tree`, already bundled in the `d3` package — no new dependency), Vitest.

## Global Constraints

- `'force'` mode must remain byte-for-byte the existing behavior — default value, non-breaking for current consumers.
- No horizontal/vertical tree orientation — radial only (per the approved design).
- No changes to the keyboard-accessibility work (roving tabindex, ARIA, tree navigation) — it's already position-agnostic and needs no touches.
- Every task must pass `npx tsc --noEmit` and `npm test` before committing.
- Work happens on a feature branch off `master` (create in Task 1) — never commit to `master` directly.

---

### Task 1: `computeRadialPositions()` — pure layout math + unit tests

**Files:**
- Modify: `mindmap-app/src/app/mindmap/mindmap.model.ts`
- Modify: `mindmap-app/src/app/mindmap/mindmap.ts`
- Test: `mindmap-app/src/app/mindmap/mindmap.spec.ts`

**Interfaces:**
- Produces: `D3Node.targetX?: number`, `D3Node.targetY?: number` (model fields); `export type MindmapLayout = 'force' | 'radial' | 'hybrid';`, `@Input() layoutMode: MindmapLayout`, `private computeRadialPositions(): void` (reads `this.rootNode`, writes `targetX`/`targetY` onto every node reachable via `.children` — i.e. the visible subtree, matching `flattenVisible`'s own traversal)

- [ ] **Step 1: Create the feature branch**

```bash
git checkout master
git pull origin master
git checkout -b feat/mindmap-layout-modes
```

- [ ] **Step 2: Add `targetX`/`targetY` to the `D3Node` model**

In `mindmap-app/src/app/mindmap/mindmap.model.ts`, add two optional fields to the existing interface:

```ts
export interface D3Node extends SimulationNodeDatum {
  id: string;
  label: string;
  depth: number;
  collapsed: boolean;
  _children: D3Node[] | null;
  children: D3Node[] | null;
  parent: D3Node | null;
  sourceNode: MindmapNode;
  targetX?: number;
  targetY?: number;
}
```

- [ ] **Step 3: Write the failing tests**

Add to `mindmap-app/src/app/mindmap/mindmap.spec.ts`, as a new top-level `describe` block right before the final closing `});` of the file (after the `menu navigation index helpers` block):

```ts
  describe('computeRadialPositions', () => {
    it('places a lone root at the origin without dividing by zero', () => {
      const lone: MindmapNode = { id: 'solo', label: 'Solo' };
      const tree: D3Node = (component as any).buildTree(lone, null, 0);
      (component as any).rootNode = tree;

      (component as any).computeRadialPositions();

      expect(tree.targetX).toBeCloseTo(0);
      expect(tree.targetY).toBeCloseTo(0);
      expect(Number.isFinite(tree.targetX)).toBe(true);
      expect(Number.isFinite(tree.targetY)).toBe(true);
    });

    it('places nodes at increasing radius by depth, with distinct angles for siblings', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      (component as any).rootNode = tree;

      (component as any).computeRadialPositions();

      const dist = (n: D3Node) => Math.sqrt(n.targetX! ** 2 + n.targetY! ** 2);
      const a = tree.children![0];
      const b = tree.children![1];
      const [a1, a2] = a.children!;

      expect(dist(tree)).toBeCloseTo(0);
      expect(dist(a)).toBeGreaterThan(0);
      expect(dist(a)).toBeCloseTo(dist(b), 5); // same depth => same radius
      expect(dist(a1)).toBeGreaterThan(dist(a)); // deeper => farther out
      expect(a1.targetX !== a2.targetX || a1.targetY !== a2.targetY).toBe(true); // distinct angles
    });

    it('only positions the visible subtree, matching flattenVisible', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const a = tree.children![0];
      a._children = a.children;
      a.children = [];
      (component as any).rootNode = tree;

      (component as any).computeRadialPositions();

      expect(a.targetX).toBeDefined();
      const [a1, a2] = a._children!;
      expect(a1.targetX).toBeUndefined();
      expect(a2.targetX).toBeUndefined();
    });
  });
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx ng test`
Expected: FAIL — `TypeError: (intermediate value).computeRadialPositions is not a function`.

- [ ] **Step 5: Add the `layoutMode` input, constants, and `computeRadialPositions()`**

In `mindmap-app/src/app/mindmap/mindmap.ts`, add to the constants block (after `FIT_TRANSITION_MS`):

```ts
/** Empty margin (px) kept around the graph's bounding box by zoomToFit(). */
const FIT_PADDING = 60;
const FIT_TRANSITION_MS = 400;

/** Radial distance (px) between consecutive depth rings in 'radial'/'hybrid' layout mode. */
const RADIAL_RING_SPACING = 100;
/** Duration (ms) of the position transition when 'radial' mode redraws (no simulation to smooth it otherwise). */
const RADIAL_TRANSITION_MS = 400;
/** Pull strength (0-1) of 'hybrid' mode's forceX/forceY toward each node's computed radial target. */
const HYBRID_POSITION_STRENGTH = 0.3;
/** Alpha kick used to (re)settle 'hybrid' mode after a redraw. */
const HYBRID_ALPHA = 0.6;
```

Add the type export near `MindmapTheme`:

```ts
export type MindmapTheme = 'dark' | 'light';
export type MindmapLayout = 'force' | 'radial' | 'hybrid';
```

Add the input next to `ariaLabel`:

```ts
  @Input() ariaLabel = 'Mind map';
  @Input() layoutMode: MindmapLayout = 'force';
```

Add `computeRadialPositions()` as a new section, right after `isDescendantOf` in the `── Tree navigation (keyboard) ──` section... actually place it in its own new section, right before `── Render / re-render ──`:

```ts
  // ── Radial layout ────────────────────────────────────────────────────────────

  /** Computes deterministic radial-tree target positions for the visible subtree (d3-hierarchy + d3-tree, mapped through polar coordinates). Writes targetX/targetY onto each visible node; does not touch x/y. */
  private computeRadialPositions(): void {
    const hierarchyRoot = d3.hierarchy<D3Node>(this.rootNode);
    const maxRadius = hierarchyRoot.height * RADIAL_RING_SPACING;
    const layout = d3.tree<D3Node>().size([2 * Math.PI, maxRadius]);

    layout(hierarchyRoot).each((node) => {
      const angle = node.x - Math.PI / 2;
      const radius = node.y;
      node.data.targetX = radius * Math.cos(angle);
      node.data.targetY = radius * Math.sin(angle);
    });
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx ng test`
Expected: PASS — all tests including the three new ones.

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add mindmap-app/src/app/mindmap/mindmap.model.ts mindmap-app/src/app/mindmap/mindmap.ts mindmap-app/src/app/mindmap/mindmap.spec.ts
git commit -m "feat: add layoutMode input and radial layout math"
```

---

### Task 2: Branch `redraw()` by layout mode

**Files:**
- Modify: `mindmap-app/src/app/mindmap/mindmap.ts`

**Interfaces:**
- Consumes: `computeRadialPositions()` (Task 1), existing `buildGlowFilter()`, `updateEdges()`, `updateNodes()`, `tick()`
- Produces: `private syncForceSimulation(nodes: D3Node[], links: D3Link[]): void` (renamed from `syncSimulation`, now also nulls the `x`/`y` forces so switching back from hybrid mode doesn't leave them attached), `private syncHybridSimulation(nodes: D3Node[], links: D3Link[]): void`, `private syncRadialLayout(nodes: D3Node[], links: D3Link[]): void`; modifies `redraw()` to branch on `this.layoutMode`

- [ ] **Step 1: Rename `syncSimulation` to `syncForceSimulation` and make it robust to mode switches**

Replace the existing `syncSimulation` method with:

```ts
  /**
   * Patches the DOM and simulation to match `nodes`/`links` via D3 join() instead of
   * tearing down and re-appending everything, so unaffected nodes keep their element
   * identity (and any in-flight CSS transition) across a collapse/expand or data swap.
   * The simulation is reheated in place rather than recreated, preserving velocity.
   */
  private syncForceSimulation(nodes: D3Node[], links: D3Link[]): void {
    this.buildGlowFilter();

    if (this.simulation) {
      this.simulation.nodes(nodes);
      this.simulation.force('link', d3.forceLink<D3Node, D3Link>(links)
        .id((d) => d.id)
        .distance((d) => LINK_DISTANCE_BASE + d.target.depth * LINK_DISTANCE_PER_DEPTH));
      this.simulation.force('charge', d3.forceManyBody().strength(CHARGE_STRENGTH));
      this.simulation.force('center', d3.forceCenter(0, 0));
      this.simulation.force('collision', d3.forceCollide<D3Node>((d) => this.nodeRadius(d) + COLLISION_PADDING));
      this.simulation.force('x', null);
      this.simulation.force('y', null);
      this.simulation.alpha(REDRAW_ALPHA).restart();
    } else {
      this.simulation = d3.forceSimulation<D3Node>(nodes)
        .force('link', d3.forceLink<D3Node, D3Link>(links)
          .id((d) => d.id)
          .distance((d) => LINK_DISTANCE_BASE + d.target.depth * LINK_DISTANCE_PER_DEPTH))
        .force('charge', d3.forceManyBody().strength(CHARGE_STRENGTH))
        .force('center', d3.forceCenter(0, 0))
        .force('collision', d3.forceCollide<D3Node>((d) => this.nodeRadius(d) + COLLISION_PADDING))
        .alphaDecay(ALPHA_DECAY)
        .on('tick', () => this.tick());
    }

    this.updateEdges(links);
    this.updateNodes(nodes);
  }
```

(This used to only call `.links(links)` on the existing link force when reusing a simulation, assuming `'link'` was always already configured. That assumption no longer holds once `'hybrid'`/`'radial'` modes can leave a simulation without a `'link'` force, so this version always fully reconfigures the four force-mode forces and explicitly nulls the two hybrid-only ones.)

- [ ] **Step 2: Add `syncHybridSimulation`**

Add right after `syncForceSimulation`:

```ts
  /**
   * Uses the same computeRadialPositions() targets as 'radial' mode, but as a starting
   * point for a weak, collision-only simulation instead of a final position — giving a
   * soft settle-in that resolves accidental overlaps without any link/charge-driven
   * structure. Reuses the same alpha-reheat-on-redraw mechanism as force mode.
   */
  private syncHybridSimulation(nodes: D3Node[], links: D3Link[]): void {
    this.buildGlowFilter();

    for (const n of nodes) {
      n.x = n.targetX;
      n.y = n.targetY;
    }

    if (this.simulation) {
      this.simulation.nodes(nodes);
      this.simulation.force('link', null);
      this.simulation.force('charge', null);
      this.simulation.force('center', null);
      this.simulation.force('x', d3.forceX<D3Node>((d) => d.targetX ?? 0).strength(HYBRID_POSITION_STRENGTH));
      this.simulation.force('y', d3.forceY<D3Node>((d) => d.targetY ?? 0).strength(HYBRID_POSITION_STRENGTH));
      this.simulation.force('collision', d3.forceCollide<D3Node>((d) => this.nodeRadius(d) + COLLISION_PADDING));
      this.simulation.alpha(HYBRID_ALPHA).restart();
    } else {
      this.simulation = d3.forceSimulation<D3Node>(nodes)
        .force('x', d3.forceX<D3Node>((d) => d.targetX ?? 0).strength(HYBRID_POSITION_STRENGTH))
        .force('y', d3.forceY<D3Node>((d) => d.targetY ?? 0).strength(HYBRID_POSITION_STRENGTH))
        .force('collision', d3.forceCollide<D3Node>((d) => this.nodeRadius(d) + COLLISION_PADDING))
        .alphaDecay(ALPHA_DECAY)
        .on('tick', () => this.tick());
    }

    this.updateEdges(links);
    this.updateNodes(nodes);
  }
```

- [ ] **Step 3: Add `syncRadialLayout`**

Add right after `syncHybridSimulation`:

```ts
  /**
   * No simulation at all: sets each visible node's final x/y directly from its
   * computeRadialPositions() target, then animates the DOM to it with a D3 transition
   * (there's no running simulation to smooth a position jump otherwise, e.g. after a
   * collapse/expand that shifts other nodes' angles).
   */
  private syncRadialLayout(nodes: D3Node[], links: D3Link[]): void {
    this.simulation?.stop();
    this.buildGlowFilter();

    for (const n of nodes) {
      n.x = n.targetX;
      n.y = n.targetY;
    }

    this.updateEdges(links);
    this.updateNodes(nodes);

    this.g.select<SVGGElement>('.nodes').selectAll<SVGGElement, D3Node>('g.node')
      .transition().duration(RADIAL_TRANSITION_MS)
      .attr('transform', (d) => `translate(${d.x},${d.y})`);

    this.g.select<SVGGElement>('.links').selectAll<SVGLineElement, D3Link>('line')
      .transition().duration(RADIAL_TRANSITION_MS)
      .attr('x1', (d) => d.source.x!)
      .attr('y1', (d) => d.source.y!)
      .attr('x2', (d) => d.target.x!)
      .attr('y2', (d) => d.target.y!);
  }
```

- [ ] **Step 4: Branch `redraw()` by layout mode**

Replace the existing `redraw()` method with:

```ts
  private redraw(): void {
    this.buildColorScale();
    const nodes: D3Node[] = [];
    const links: D3Link[] = [];
    this.flattenVisible(this.rootNode, nodes, links);
    this.visibleNodes = nodes;

    if (this.layoutMode === 'force') {
      this.zone.runOutsideAngular(() => this.syncForceSimulation(nodes, links));
      return;
    }

    this.computeRadialPositions();
    if (this.layoutMode === 'hybrid') {
      this.zone.runOutsideAngular(() => this.syncHybridSimulation(nodes, links));
    } else {
      this.zone.runOutsideAngular(() => this.syncRadialLayout(nodes, links));
    }
  }
```

- [ ] **Step 5: Type-check and run tests**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx ng test`
Expected: PASS (no new tests in this task — DOM/simulation behavior is verified manually next).

- [ ] **Step 6: Manual verification in-browser**

```bash
npm start -- --port 4300
```

Open `http://localhost:4300`. The demo app doesn't yet expose a way to set `layoutMode` — temporarily add `[layoutMode]="'radial'"` to the `<app-mindmap>` tag in `mindmap-app/src/app/app.html` to check it (revert before committing; Task 4 wires up a real toggle). Confirm: the graph renders as a clean radial tree (root centered, rings by depth, no jitter/drift). Switch the temporary binding to `'hybrid'`: confirm it looks similar but with a brief settle animation on load. Switch back to `'force'` (or remove the binding): confirm the original physics behavior is completely unchanged — this is the most important regression check in this task.

Revert the temporary `app.html` edit before moving on. Stop the dev server when done.

- [ ] **Step 7: Commit**

```bash
git add mindmap-app/src/app/mindmap/mindmap.ts
git commit -m "feat: branch redraw() into force/radial/hybrid layout sync methods"
```

---

### Task 3: Make dragging work without a running simulation

**Files:**
- Modify: `mindmap-app/src/app/mindmap/mindmap.ts`

**Interfaces:**
- Consumes: existing `tick()` (unchanged)
- Modifies: `dragBehavior()` — drag now always calls `tick()` directly and guards `this.simulation` as optional, so dragging still works in `'radial'` mode (no simulation running to drive re-renders)

- [ ] **Step 1: Update `dragBehavior()`**

Replace the existing method with:

```ts
  private dragBehavior(): d3.DragBehavior<SVGGElement, D3Node, D3Node | d3.SubjectPosition> {
    return d3.drag<SVGGElement, D3Node>()
      .clickDistance(DRAG_CLICK_DISTANCE)
      .on('start', (event, d) => {
        if (!event.active) this.simulation?.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
        d.x = event.x;
        d.y = event.y;
        this.tick();
      })
      .on('end', (event, d) => {
        if (!event.active) this.simulation?.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
  }
```

(The explicit `d.x`/`d.y`/`this.tick()` in `'drag'` are redundant-but-harmless when a simulation is already ticking on its own during an active drag — they're what make dragging work at all when there's no simulation, i.e. `'radial'` mode.)

- [ ] **Step 2: Type-check and run tests**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx ng test`
Expected: PASS.

- [ ] **Step 3: Manual verification in-browser**

```bash
npm start -- --port 4300
```

Temporarily add `[layoutMode]="'radial'"` to `<app-mindmap>` in `mindmap-app/src/app/app.html` again. Drag a node: confirm it follows the pointer smoothly and stays where dropped after release (no snap-back, since there's no simulation pulling it anywhere). Remove the temporary binding (falls back to `'force'`): drag a node there too — confirm dragging still works exactly as before (follows pointer, gently released back into the flow of the simulation on drop, matching pre-existing behavior).

Revert the temporary `app.html` edit before moving on. Stop the dev server when done.

- [ ] **Step 4: Commit**

```bash
git add mindmap-app/src/app/mindmap/mindmap.ts
git commit -m "fix: make node dragging work without a running simulation (radial mode)"
```

---

### Task 4: Wire `layoutMode` reactivity + auto-fit on switch, expose a demo toggle

**Files:**
- Modify: `mindmap-app/src/app/mindmap/mindmap.ts`
- Modify: `mindmap-app/src/app/app.ts`
- Modify: `mindmap-app/src/app/app.html`

**Interfaces:**
- Consumes: `redraw()` (Task 2), `zoomToFit()` (existing public method)
- Produces: `private zoomToFitAfterSettle(): void`; modifies `ngOnChanges()` to react to `layoutMode` changes

- [ ] **Step 1: Add `zoomToFitAfterSettle()`**

Add right after the existing `zoomToFit()` method (in the `── View controls ──` section):

```ts
  /**
   * Calls zoomToFit() once the current layout has actually settled, rather than
   * immediately (which would measure a stale/mid-flight bounding box): waits for the
   * simulation's 'end' event in force/hybrid mode, or for the position transition's
   * duration to elapse in radial mode (which runs no simulation at all).
   */
  private zoomToFitAfterSettle(): void {
    if (this.layoutMode === 'radial') {
      setTimeout(() => this.zoomToFit(), RADIAL_TRANSITION_MS);
      return;
    }
    this.simulation?.on('end.layoutSwitch', () => {
      this.simulation?.on('end.layoutSwitch', null);
      this.zoomToFit();
    });
  }
```

- [ ] **Step 2: React to `layoutMode` changes in `ngOnChanges`**

Update `ngOnChanges` — add a new branch after the `theme` branch and before the `data` check:

```ts
  ngOnChanges(changes: SimpleChanges): void {
    if (!this.svg) return;

    if (changes['width'] || changes['height']) {
      this.svg.attr('width', this.width).attr('height', this.height);
    }

    if (changes['theme']) {
      this.applyThemeToBackground();
      if (this.rootNode) this.redraw();
      return;
    }

    if (changes['layoutMode'] && !changes['layoutMode'].firstChange) {
      if (this.rootNode) {
        this.redraw();
        this.zoomToFitAfterSettle();
      }
      return;
    }

    if (changes['data'] && !changes['data'].firstChange) {
      this.render();
    }
  }
```

- [ ] **Step 3: Type-check and run tests**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx ng test`
Expected: PASS.

- [ ] **Step 4: Add a real layout-mode toggle to the demo app**

In `mindmap-app/src/app/app.ts`, add a signal and a cycle method next to the existing `theme` signal:

```ts
  readonly theme = signal<MindmapTheme>('dark');
  readonly layoutMode = signal<MindmapLayout>('force');

  private readonly layoutModes: MindmapLayout[] = ['force', 'radial', 'hybrid'];

  cycleLayoutMode(): void {
    const i = this.layoutModes.indexOf(this.layoutMode());
    this.layoutMode.set(this.layoutModes[(i + 1) % this.layoutModes.length]);
  }
```

Update the import at the top of the same file:

```ts
import { MindmapComponent, MindmapLayout, MindmapTheme } from './mindmap/mindmap';
```

In `mindmap-app/src/app/app.html`, add a toggle button next to the existing `Reset`/`Fit`/theme buttons, and bind the input on `<app-mindmap>`:

```html
    <button class="theme-toggle" (click)="cycleLayoutMode()">⟐ {{ layoutMode() }}</button>
```

```html
  <app-mindmap #mm [data]="graph" [width]="960" [height]="680" [theme]="theme()" [layoutMode]="layoutMode()" [contextMenuFn]="nodeContextMenu" [nodeClickFn]="nodeClickFn" />
```

- [ ] **Step 5: Type-check, run tests, and build**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx ng test`
Expected: PASS.

Run: `npm run build`
Expected: clean, no new budget warnings.

- [ ] **Step 6: Manual verification in-browser**

```bash
npm start -- --port 4300
```

Click the new layout-mode button repeatedly: confirm it cycles `force → radial → hybrid → force`, the graph re-lays-out live each time without a data reload, and the view auto-recenters via `zoomToFit()` shortly after each switch (not immediately/mid-animation — should look settled, not clipped or off-center). Confirm switching back to `force` restores the familiar physics behavior. Confirm collapse/expand still works correctly in each of the three modes.

Stop the dev server when done.

- [ ] **Step 7: Commit**

```bash
git add mindmap-app/src/app/mindmap/mindmap.ts mindmap-app/src/app/app.ts mindmap-app/src/app/app.html
git commit -m "feat: make layoutMode reactive with auto-fit on switch, add demo toggle"
```

---

### Task 5: Full regression pass, docs, PR, and merge

**Files:**
- Modify: `mindmap-app/CLAUDE.md`

**Interfaces:** none

- [ ] **Step 1: Full automated check**

Run, from `mindmap-app/`:

```bash
npx tsc --noEmit
npx ng test
npm run build
```

Expected: all three succeed with no errors or new warnings.

- [ ] **Step 2: Update `CLAUDE.md`'s architecture section**

`CLAUDE.md`'s "Component internals" section still describes `startSimulation()`, which was renamed to `syncSimulation()` and now to `syncForceSimulation()` across two feature branches without ever being updated — fix it now while touching the same code. Replace the existing "Component internals (`mindmap.ts`)" and "Performance contract" sections with:

```markdown
### Component internals (`mindmap.ts`)

- **`initSvg()`** — called once in `ngOnInit`; sets up the SVG, dark background rect, zoom/pan behavior, and the root `<g class="graph">` container.
- **`render()`** — called on first init and on `data` input changes; rebuilds the full `D3Node` tree from scratch.
- **`redraw()`** — called after every collapse/expand, theme change, or `layoutMode` change; re-flattens visible nodes and dispatches to one of three sync methods based on `layoutMode`.
- **`syncForceSimulation()` / `syncHybridSimulation()` / `syncRadialLayout()`** — patch the DOM and (where applicable) the D3 force simulation via `join()` rather than tearing down and re-appending everything, so unaffected nodes keep their element identity across a redraw. All three run *outside Angular's zone* via `NgZone.runOutsideAngular`.
- **`computeRadialPositions()`** — pure `d3-hierarchy`/`d3-tree` math (no DOM), used by `'radial'` and `'hybrid'` layout modes to compute deterministic target positions.
- **`toggleCollapse()`** — swaps `children ↔ _children` on the clicked node, then calls `redraw()`.

### Layout modes

`layoutMode: 'force' | 'radial' | 'hybrid'` (default `'force'`, reactive) controls how node positions are computed:

- **`force`** — today's original behavior: a continuously-running D3 force simulation (link/charge/center/collision), Obsidian-graph-view style.
- **`radial`** — fully deterministic radial tree layout, no simulation.
- **`hybrid`** — deterministic radial base positions with a brief, weak collision-only settle animation.

### Performance contract

`ChangeDetectionStrategy.OnPush` + `NgZone.runOutsideAngular` means D3's tick loop (in `force`/`hybrid` modes) is invisible to Angular. Only structural changes (input swap, collapse, layout mode switch) trigger Angular work.
```

- [ ] **Step 3: Commit the docs fix**

```bash
git add mindmap-app/CLAUDE.md
git commit -m "docs: refresh CLAUDE.md architecture section for layout modes"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/mindmap-layout-modes
gh pr create --title "feat: configurable mind-map layout modes (force/radial/hybrid)" --body "$(cat <<'EOF'
## Summary
- New reactive `layoutMode` input (`'force' | 'radial' | 'hybrid'`, default `'force'`) — resolves the force-directed-vs-deterministic-layout question from an earlier audit by making it configurable instead of picking a winner
- `'force'` is byte-for-byte the existing behavior, default, non-breaking
- `'radial'`: fully deterministic radial tree layout (d3-hierarchy + d3-tree through polar coordinates), no simulation
- `'hybrid'`: same deterministic base positions, brief collision-only settle-in animation
- Dragging fixed to work without a running simulation (needed for `'radial'` mode)
- Demo app gets a layout-mode cycle button
- `CLAUDE.md` architecture section refreshed (was describing a method renamed two branches ago)
- Design: docs/superpowers/specs/2026-07-10-mindmap-layout-modes-design.md
- Plan: docs/superpowers/plans/2026-07-10-mindmap-layout-modes.md

## Test plan
- [x] `npx tsc --noEmit`, `npm test`, `npm run build` all pass
- [x] Unit tests for `computeRadialPositions()`: origin placement, depth-radius monotonicity, sibling angle distinctness, single-node tree, visible-subtree-only
- [x] Manual regression: `'force'` mode behavior fully unchanged (positions, drag, collapse/expand)
- [x] Manual verification: `'radial'`/`'hybrid'` render correctly, live mode switching re-lays-out and auto-fits, dragging works in all three modes, collapse/expand works in all three modes

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Merge**

After confirming the PR is mergeable (`gh pr view <number> --json mergeable,mergeStateStatus`), merge with a merge commit to match this repo's history style:

```bash
gh pr merge --merge --delete-branch=false
```

Then sync local `master`:

```bash
git checkout master
git pull origin master
```
