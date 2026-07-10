# Mind-map keyboard accessibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mind-map component (`mindmap-app/src/app/mindmap/`) fully operable by keyboard: tree navigation, expand/collapse, node activation, and a keyboard-operable context menu.

**Architecture:** Roving-tabindex tree navigation with ARIA treeview semantics on the existing D3-rendered SVG nodes; a parallel roving-tabindex model (signal-driven, not D3-driven) for the Angular-template-rendered context menu. Pure navigation-index helpers are unit tested; DOM/focus integration is verified manually in-browser (the project's existing pattern, since `jsdom` can't run `d3-zoom`/SVG geometry — see `mindmap.spec.ts`).

**Tech Stack:** Angular 21 standalone component, D3 v7 (selection/force/zoom), Vitest.

**Design spec:** `docs/superpowers/specs/2026-07-10-mindmap-keyboard-a11y-design.md`

## Global Constraints

- No new public API beyond one additive input: `@Input() ariaLabel = 'Mind map';`
- No `role="group"`/DOM-nested tree structure — flat DOM, `aria-level` conveys hierarchy (see spec).
- No custom live regions — rely on native AT announcement from real focus + ARIA state changes.
- Keep all new logic as private methods on `MindmapComponent`, under `── Section ──` comment banners matching the existing file style.
- Every task must pass `npx tsc --noEmit` and `npm test` before committing.
- Each task's commit goes on branch `feat/mindmap-keyboard-a11y` (create once, in Task 1) — never commit to `master` directly.

---

### Task 1: Branch setup + tree-navigation pure helpers

**Files:**
- Modify: `mindmap-app/src/app/mindmap/mindmap.ts`
- Test: `mindmap-app/src/app/mindmap/mindmap.spec.ts`

**Interfaces:**
- Produces: `private visibleNodes: D3Node[]` (field, populated in `redraw()`), `private nextVisible(nodes: D3Node[], id: string): D3Node | null`, `private previousVisible(nodes: D3Node[], id: string): D3Node | null`, `private firstVisible(nodes: D3Node[]): D3Node | null`, `private lastVisible(nodes: D3Node[]): D3Node | null`, `private firstChild(d: D3Node): D3Node | null`, `private isDescendantOf(node: D3Node, ancestor: D3Node): boolean`

- [ ] **Step 1: Create the feature branch**

```bash
git checkout master
git pull origin master
git checkout -b feat/mindmap-keyboard-a11y
```

- [ ] **Step 2: Write the failing tests**

Add to `mindmap-app/src/app/mindmap/mindmap.spec.ts`, inside the existing top-level `describe('MindmapComponent data functions', ...)` block (after the `toggleCollapse` describe block, before the final closing `});`):

```ts
  describe('nextVisible / previousVisible / firstVisible / lastVisible', () => {
    it('walks the flattened tree order forward and backward', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const nodes: D3Node[] = [];
      const links: D3Link[] = [];
      (component as any).flattenVisible(tree, nodes, links);
      // order: root, a, a1, a2, b

      expect((component as any).nextVisible(nodes, 'root').id).toBe('a');
      expect((component as any).nextVisible(nodes, 'a').id).toBe('a1');
      expect((component as any).nextVisible(nodes, 'b')).toBeNull();

      expect((component as any).previousVisible(nodes, 'b').id).toBe('a2');
      expect((component as any).previousVisible(nodes, 'a1').id).toBe('a');
      expect((component as any).previousVisible(nodes, 'root')).toBeNull();

      expect((component as any).firstVisible(nodes).id).toBe('root');
      expect((component as any).lastVisible(nodes).id).toBe('b');
    });

    it('returns null for an id not present in the array, and null first/last for an empty array', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const nodes: D3Node[] = [];
      const links: D3Link[] = [];
      (component as any).flattenVisible(tree, nodes, links);

      expect((component as any).nextVisible(nodes, 'missing')).toBeNull();
      expect((component as any).previousVisible(nodes, 'missing')).toBeNull();
      expect((component as any).firstVisible([])).toBeNull();
      expect((component as any).lastVisible([])).toBeNull();
    });
  });

  describe('firstChild', () => {
    it('returns the first visible child, or null for a leaf', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const a = tree.children![0];
      const b = tree.children![1];

      expect((component as any).firstChild(a).id).toBe('a1');
      expect((component as any).firstChild(b)).toBeNull();
    });

    it('returns null when children have been collapsed into _children', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const a = tree.children![0];
      a._children = a.children;
      a.children = [];

      expect((component as any).firstChild(a)).toBeNull();
    });
  });

  describe('isDescendantOf', () => {
    it('returns true for a direct or transitive descendant, false otherwise', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const a = tree.children![0];
      const a1 = a.children![0];
      const b = tree.children![1];

      expect((component as any).isDescendantOf(a1, a)).toBe(true);
      expect((component as any).isDescendantOf(a1, tree)).toBe(true);
      expect((component as any).isDescendantOf(a, a1)).toBe(false);
      expect((component as any).isDescendantOf(b, a)).toBe(false);
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx ng test`
Expected: FAIL — `TypeError: (intermediate value).nextVisible is not a function` (and similar for the other new helpers), since they don't exist yet.

- [ ] **Step 4: Implement the helpers**

In `mindmap-app/src/app/mindmap/mindmap.ts`, add a `private visibleNodes: D3Node[] = [];` field next to the other D3-internal fields:

```ts
  private colorScale!: d3.ScaleOrdinal<number, string>;
  private strokeColorByDepth: string[] = [];
  private visibleNodes: D3Node[] = [];
```

Update `redraw()` to populate it (find the existing method and add the marked line):

```ts
  private redraw(): void {
    this.buildColorScale();
    const nodes: D3Node[] = [];
    const links: D3Link[] = [];
    this.flattenVisible(this.rootNode, nodes, links);
    this.visibleNodes = nodes; // ADDED
    this.zone.runOutsideAngular(() => this.syncSimulation(nodes, links));
  }
```

Add a new section after `flattenVisible` (before the `── Render / re-render ──` banner):

```ts
  // ── Tree navigation (keyboard) ──────────────────────────────────────────────

  private nextVisible(nodes: D3Node[], id: string): D3Node | null {
    const i = nodes.findIndex((n) => n.id === id);
    if (i === -1 || i === nodes.length - 1) return null;
    return nodes[i + 1];
  }

  private previousVisible(nodes: D3Node[], id: string): D3Node | null {
    const i = nodes.findIndex((n) => n.id === id);
    if (i <= 0) return null;
    return nodes[i - 1];
  }

  private firstVisible(nodes: D3Node[]): D3Node | null {
    return nodes[0] ?? null;
  }

  private lastVisible(nodes: D3Node[]): D3Node | null {
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  private firstChild(d: D3Node): D3Node | null {
    return d.children && d.children.length ? d.children[0] : null;
  }

  private isDescendantOf(node: D3Node, ancestor: D3Node): boolean {
    let cur = node.parent;
    while (cur) {
      if (cur.id === ancestor.id) return true;
      cur = cur.parent;
    }
    return false;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx ng test`
Expected: PASS — all tests including the new ones.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add mindmap-app/src/app/mindmap/mindmap.ts mindmap-app/src/app/mindmap/mindmap.spec.ts
git commit -m "feat: add pure tree-navigation helpers for keyboard support"
```

---

### Task 2: ARIA structure on the tree

**Files:**
- Modify: `mindmap-app/src/app/mindmap/mindmap.ts`

**Interfaces:**
- Consumes: `D3Node` (from Task 1's context, unchanged shape)
- Produces: `@Input() ariaLabel: string`, `private applyNodeAria(selection: d3.Selection<SVGGElement, D3Node, SVGGElement, unknown>): void`

- [ ] **Step 1: Add the `ariaLabel` input**

In `mindmap-app/src/app/mindmap/mindmap.ts`, add next to the other `@Input()`s:

```ts
  @Input() ariaLabel = 'Mind map';
```

- [ ] **Step 2: Set `role`/`aria-label` on the `<svg>`**

In `initSvg()`, add the two `.attr()` calls to the existing `this.svg = d3.select(...)` chain:

```ts
  private initSvg(): void {
    this.svg = d3.select(this.svgRef.nativeElement)
      .attr('width', this.width)
      .attr('height', this.height)
      .attr('role', 'tree')
      .attr('aria-label', this.ariaLabel);
```

- [ ] **Step 3: Add `applyNodeAria` and wire it into `updateNodes`**

Add a new method right after `applyNodeTheme` in the `── Drawing ──` section:

```ts
  /** ARIA treeitem semantics — role/level/expanded/setsize/posinset. Flat DOM (see design doc). */
  private applyNodeAria(selection: d3.Selection<SVGGElement, D3Node, SVGGElement, unknown>): void {
    selection
      .attr('role', 'treeitem')
      .attr('aria-label', (d) => d.label)
      .attr('aria-level', (d) => d.depth + 1)
      .attr('aria-setsize', (d) => (d.parent ? (d.parent.children?.length ?? 1) : 1))
      .attr('aria-posinset', (d) => (d.parent ? (d.parent.children?.indexOf(d) ?? 0) + 1 : 1))
      .each((d, i, groups) => {
        const el = groups[i] as SVGGElement;
        const hasChildren = !!(d.children?.length || d._children?.length);
        if (hasChildren) {
          el.setAttribute('aria-expanded', String(!!d.children?.length));
        } else {
          el.removeAttribute('aria-expanded');
        }
      });
  }
```

Update `updateNodes()` to call it (find the existing method and add the marked line):

```ts
  private updateNodes(nodes: D3Node[]): void {
    const merged = this.g.select<SVGGElement>('.nodes')
      .selectAll<SVGGElement, D3Node>('g.node')
      .data(nodes, (d) => d.id)
      .join(
        (enter) => this.enterNodes(enter),
        (update) => update,
        (exit) => exit.remove(),
      );

    this.applyNodeTheme(merged);
    this.applyNodeAria(merged); // ADDED
  }
```

- [ ] **Step 4: Type-check and run tests**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx ng test`
Expected: PASS (no new tests in this task — DOM/ARIA output is verified manually next).

- [ ] **Step 5: Manual verification in-browser**

```bash
npm start -- --port 4300
```

Open `http://localhost:4300`, open DevTools → Elements, inspect an expanded node's `<g class="node">`: confirm `role="treeitem"`, `aria-label`, `aria-level`, `aria-expanded="true"`, `aria-setsize`, `aria-posinset` are present with correct values. Collapse it (click) and re-inspect: `aria-expanded` should flip to `"false"`. Inspect the `<svg>` root: confirm `role="tree"` and `aria-label="Mind map"`.

Stop the dev server (`Ctrl+C`) when done.

- [ ] **Step 6: Commit**

```bash
git add mindmap-app/src/app/mindmap/mindmap.ts
git commit -m "feat: add ARIA treeitem semantics to mind-map nodes"
```

---

### Task 3: Roving tabindex + focus-visible styling

**Files:**
- Modify: `mindmap-app/src/app/mindmap/mindmap.ts`
- Modify: `mindmap-app/src/app/mindmap/mindmap.scss`

**Interfaces:**
- Consumes: `applyNodeAria`/`applyNodeTheme` call sites in `updateNodes` (Task 2)
- Produces: `private focusedNodeId: string | null`, `private applyTabindex(selection: d3.Selection<SVGGElement, D3Node, SVGGElement, unknown>): void`, `private moveFocusTo(d: D3Node): void`

- [ ] **Step 1: Add focus-tracking field and helpers**

In `mindmap-app/src/app/mindmap/mindmap.ts`, add next to `visibleNodes`:

```ts
  private visibleNodes: D3Node[] = [];
  private focusedNodeId: string | null = null;
```

Add to the `── Tree navigation (keyboard) ──` section (after `isDescendantOf`):

```ts
  private applyTabindex(selection: d3.Selection<SVGGElement, D3Node, SVGGElement, unknown>): void {
    selection.attr('tabindex', (d) => (d.id === this.focusedNodeId ? 0 : -1));
  }

  private moveFocusTo(d: D3Node): void {
    this.focusedNodeId = d.id;
    const nodeSelection = this.g.select<SVGGElement>('.nodes').selectAll<SVGGElement, D3Node>('g.node');
    this.applyTabindex(nodeSelection);
    nodeSelection.filter((n) => n.id === d.id).node()?.focus();
  }
```

- [ ] **Step 2: Wire `applyTabindex` into `updateNodes` and set the default focus on render**

Update `updateNodes()`:

```ts
    this.applyNodeTheme(merged);
    this.applyNodeAria(merged);
    this.applyTabindex(merged); // ADDED
  }
```

Update `render()` to default focus to the root node:

```ts
  private render(): void {
    this.rootNode = this.buildTree(this.data, null, 0);
    this.focusedNodeId = this.rootNode.id; // ADDED
    this.redraw();
  }
```

- [ ] **Step 3: Add focus-visible CSS**

In `mindmap-app/src/app/mindmap/mindmap.scss`, inside the existing `:host ::ng-deep { ... }` block (the one containing `.node-scale`), add:

```scss
  .node:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 3px;
    border-radius: 50%;
  }
```

And theme the outline color — add to both theme blocks near the top of the file:

```scss
:host([data-theme='dark']) ::ng-deep .node:focus-visible {
  outline-color: #f38ba8;
}

:host([data-theme='light']) ::ng-deep .node:focus-visible {
  outline-color: #d4044b;
}
```

(These match each theme's existing `badgeFill` accent color from `THEMES` in `mindmap.ts`, so the focus ring reads as an intentional accent, not a mismatched default.)

- [ ] **Step 4: Type-check and run tests**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx ng test`
Expected: PASS.

- [ ] **Step 5: Manual verification in-browser**

```bash
npm start -- --port 4300
```

Open `http://localhost:4300`, click into the page background then press `Tab` repeatedly: confirm the graph becomes reachable as a single tab stop (focus lands on the root node, visibly outlined), and a further `Tab` moves past the whole graph to the next page element (not into individual nodes one at a time). Inspect `tabindex` in DevTools on a couple of nodes: exactly one should be `"0"`, the rest `"-1"`.

Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add mindmap-app/src/app/mindmap/mindmap.ts mindmap-app/src/app/mindmap/mindmap.scss
git commit -m "feat: add roving tabindex and focus-visible styling to mind-map nodes"
```

---

### Task 4: Tree keyboard navigation

**Files:**
- Modify: `mindmap-app/src/app/mindmap/mindmap.ts`

**Interfaces:**
- Consumes: `nextVisible`, `previousVisible`, `firstVisible`, `lastVisible`, `firstChild`, `isDescendantOf` (Task 1), `moveFocusTo` (Task 3)
- Produces: `private onNodeKeydown(event: KeyboardEvent, d: D3Node): void`; modifies `toggleCollapse` to preserve focus when an ancestor collapses over it

- [ ] **Step 1: Add the keydown handler**

Add to the `── Tree navigation (keyboard) ──` section, after `moveFocusTo`:

```ts
  private onNodeKeydown(event: KeyboardEvent, d: D3Node): void {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = this.nextVisible(this.visibleNodes, d.id);
        if (next) this.moveFocusTo(next);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = this.previousVisible(this.visibleNodes, d.id);
        if (prev) this.moveFocusTo(prev);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (d._children && d._children.length) {
          this.toggleCollapse(d);
        } else {
          const child = this.firstChild(d);
          if (child) this.moveFocusTo(child);
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (d.children && d.children.length) {
          this.toggleCollapse(d);
        } else if (d.parent) {
          this.moveFocusTo(d.parent);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (this.nodeClickFn?.(d.sourceNode) === true) return;
        this.toggleCollapse(d);
        break;
      }
      case 'Home': {
        event.preventDefault();
        const first = this.firstVisible(this.visibleNodes);
        if (first) this.moveFocusTo(first);
        break;
      }
      case 'End': {
        event.preventDefault();
        const last = this.lastVisible(this.visibleNodes);
        if (last) this.moveFocusTo(last);
        break;
      }
    }
  }
```

- [ ] **Step 2: Wire the handler onto each node**

In `enterNodes()`, add `.on('keydown', ...)` to the existing handler chain (after `.on('mouseout', ...)`):

```ts
      .on('mouseout', () => {
        this.g.select('.links').selectAll<SVGLineElement, D3Link>('line')
          .transition().duration(150)
          .attr('stroke-opacity', this.tc.edgeOpacity)
          .attr('stroke-width', 1.5)
          .attr('stroke', this.tc.edgeStroke);
      })
      .on('keydown', (event: KeyboardEvent, d: D3Node) => this.zone.run(() => this.onNodeKeydown(event, d)));
```

(Note: the trailing `;` moves from the old last call to the new one — the previous `.on('mouseout', ...)` block now ends with `})` followed by this new `.on(...)`.)

- [ ] **Step 3: Preserve focus when an ancestor collapses over the focused node**

Replace `toggleCollapse` with:

```ts
  private toggleCollapse(d: D3Node): void {
    const hasVisible = d.children && d.children.length > 0;
    const hasHidden = d._children && d._children.length > 0;
    if (!hasVisible && !hasHidden) return;

    let refocusTarget: D3Node | null = null;

    if (hasVisible) {
      if (this.focusedNodeId && this.focusedNodeId !== d.id) {
        const focused = this.visibleNodes.find((n) => n.id === this.focusedNodeId);
        if (focused && this.isDescendantOf(focused, d)) {
          refocusTarget = d;
        }
      }
      d._children = d.children;
      d.children = [];
      d.collapsed = true;
    } else {
      d.children = d._children;
      d._children = null;
      d.collapsed = false;
    }

    this.redraw();

    if (refocusTarget) {
      this.moveFocusTo(refocusTarget);
    }
  }
```

- [ ] **Step 4: Type-check and run tests**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx ng test`
Expected: PASS.

- [ ] **Step 5: Manual verification in-browser**

```bash
npm start -- --port 4300
```

With the graph focused (root node, from Task 3's Tab test): press `↓`/`↑` and confirm focus moves between visible nodes in a sensible order, with the DevTools-visible focus ring following. Press `→` on a collapsed node with a badge: confirm it expands (badge/children appear) and focus stays put; press `→` again: focus moves to its first child. Press `←` on an expanded node: confirm it collapses, focus stays put; press `←` again (now a leaf-ish/collapsed state): focus moves to parent. Press `Enter`/`Space` on a node: confirm it collapses/expands exactly like a mouse click would (and if `nodeClickFn` intercepts — the demo's leaf nodes set `selectedNode` — confirm the node-detail panel appears the same as a mouse click). Press `Home`/`End`: focus jumps to root / last visible node. Then: focus a deeply-nested visible node, use `←` repeatedly to walk back to its ancestor, then collapse that ancestor with `Enter` — confirm focus visibly lands on the now-collapsed ancestor rather than disappearing.

Stop the dev server when done.

- [ ] **Step 6: Commit**

```bash
git add mindmap-app/src/app/mindmap/mindmap.ts
git commit -m "feat: add tree keyboard navigation (arrows/home/end/enter/space)"
```

---

### Task 5: Keyboard-triggered context menu, anchored to the focused node

**Files:**
- Modify: `mindmap-app/src/app/mindmap/mindmap.ts`

**Interfaces:**
- Consumes: `onNodeKeydown` (Task 4, extended), existing `menuEntries`/`menuX`/`menuY`/`menuOpen` signals, `onDocumentKeydown`
- Produces: `private menuOpenerNodeId: string | null`, `private openContextMenu(d: D3Node, x: number, y: number): void`, `private openContextMenuForNode(d: D3Node): void`

- [ ] **Step 1: Add `menuOpenerNodeId` and extract a shared `openContextMenu`**

Add the field next to the other menu-state signals:

```ts
  readonly menuEntries = signal<MenuEntry[]>([]);
  private menuOpenerNodeId: string | null = null;
```

Add a new method in the `── Drawing ──` section, just before `enterNodes`:

```ts
  private openContextMenu(d: D3Node, x: number, y: number): void {
    if (!this.contextMenuFn) return;
    this.contextMenuFn(d.sourceNode).then((entries) => {
      this.zone.run(() => {
        this.menuEntries.set(entries);
        this.menuX.set(x);
        this.menuY.set(y);
        this.menuOpen.set(true);
        this.menuOpenerNodeId = d.id;
      });
    });
  }

  private openContextMenuForNode(d: D3Node): void {
    const el = this.g.select<SVGGElement>('.nodes').selectAll<SVGGElement, D3Node>('g.node')
      .filter((n) => n.id === d.id).node();
    const rect = el?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : 0;
    const y = rect ? rect.top + rect.height / 2 : 0;
    this.openContextMenu(d, x, y);
  }
```

- [ ] **Step 2: Replace the existing mouse `contextmenu` handler to use the shared method**

In `enterNodes()`, replace:

```ts
      .on('contextmenu', (event: MouseEvent, d: D3Node) => {
        event.preventDefault();
        event.stopPropagation();
        if (!this.contextMenuFn) return;
        const x = event.clientX;
        const y = event.clientY;
        this.contextMenuFn(d.sourceNode).then((entries) => {
          this.zone.run(() => {
            this.menuEntries.set(entries);
            this.menuX.set(x);
            this.menuY.set(y);
            this.menuOpen.set(true);
          });
        });
      })
```

with:

```ts
      .on('contextmenu', (event: MouseEvent, d: D3Node) => {
        event.preventDefault();
        event.stopPropagation();
        this.openContextMenu(d, event.clientX, event.clientY);
      })
```

- [ ] **Step 3: Add `Shift+F10`/`ContextMenu` key handling to `onNodeKeydown`**

Replace the whole `onNodeKeydown` method (added in Task 4) with this version, which adds `'F10'` and `'ContextMenu'` cases after the existing `'End'` case:

```ts
  private onNodeKeydown(event: KeyboardEvent, d: D3Node): void {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = this.nextVisible(this.visibleNodes, d.id);
        if (next) this.moveFocusTo(next);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = this.previousVisible(this.visibleNodes, d.id);
        if (prev) this.moveFocusTo(prev);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (d._children && d._children.length) {
          this.toggleCollapse(d);
        } else {
          const child = this.firstChild(d);
          if (child) this.moveFocusTo(child);
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (d.children && d.children.length) {
          this.toggleCollapse(d);
        } else if (d.parent) {
          this.moveFocusTo(d.parent);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (this.nodeClickFn?.(d.sourceNode) === true) return;
        this.toggleCollapse(d);
        break;
      }
      case 'Home': {
        event.preventDefault();
        const first = this.firstVisible(this.visibleNodes);
        if (first) this.moveFocusTo(first);
        break;
      }
      case 'End': {
        event.preventDefault();
        const last = this.lastVisible(this.visibleNodes);
        if (last) this.moveFocusTo(last);
        break;
      }
      case 'F10': {
        if (!event.shiftKey) return;
        event.preventDefault();
        this.openContextMenuForNode(d);
        break;
      }
      case 'ContextMenu': {
        event.preventDefault();
        this.openContextMenuForNode(d);
        break;
      }
    }
  }
```

- [ ] **Step 4: Return focus to the opener node on Escape**

Replace `onDocumentKeydown`:

```ts
  private readonly onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.menuOpen()) {
      this.zone.run(() => this.menuOpen.set(false));
      const opener = this.menuOpenerNodeId
        ? this.visibleNodes.find((n) => n.id === this.menuOpenerNodeId)
        : null;
      if (opener) this.moveFocusTo(opener);
      this.menuOpenerNodeId = null;
    }
  };
```

- [ ] **Step 5: Type-check and run tests**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx ng test`
Expected: PASS.

- [ ] **Step 6: Manual verification in-browser**

```bash
npm start -- --port 4300
```

Mouse right-click a node: confirm the context menu still opens exactly as before (regression check on the refactor). Focus a node by keyboard (Tab, then arrow keys) and press `Shift+F10`: confirm the menu opens, positioned near that node rather than at a stale/zero pointer position. Press `Escape`: confirm the menu closes and the visible focus ring returns to the node that opened it.

Stop the dev server when done.

- [ ] **Step 7: Commit**

```bash
git add mindmap-app/src/app/mindmap/mindmap.ts
git commit -m "feat: add keyboard trigger for the context menu, anchored to the focused node"
```

---

### Task 6: Menu navigation pure helpers + unit tests

**Files:**
- Modify: `mindmap-app/src/app/mindmap/mindmap.ts`
- Test: `mindmap-app/src/app/mindmap/mindmap.spec.ts`

**Interfaces:**
- Consumes: `MenuEntry` (from `mindmap.model.ts`, unchanged)
- Produces: `private isFocusableMenuEntry(entry: MenuEntry): boolean`, `private nextMenuIndex(entries: MenuEntry[], from: number, direction: 1 | -1): number`, `private firstMenuIndex(entries: MenuEntry[]): number`, `private lastMenuIndex(entries: MenuEntry[]): number`

- [ ] **Step 1: Write the failing tests**

Add to `mindmap-app/src/app/mindmap/mindmap.spec.ts`, after the `isDescendantOf` describe block:

```ts
  describe('menu navigation index helpers', () => {
    const entries: MenuEntry[] = [
      { type: 'topic', label: 'Actions' },
      { type: 'item', label: 'Expand all', action: () => {} },
      { type: 'separator' },
      { type: 'item', label: 'Disabled item', action: () => {}, disabled: true },
      { type: 'item', label: 'Delete', action: () => {} },
    ];

    it('isFocusableMenuEntry is true only for enabled items', () => {
      expect((component as any).isFocusableMenuEntry(entries[0])).toBe(false); // topic
      expect((component as any).isFocusableMenuEntry(entries[1])).toBe(true); // item
      expect((component as any).isFocusableMenuEntry(entries[2])).toBe(false); // separator
      expect((component as any).isFocusableMenuEntry(entries[3])).toBe(false); // disabled item
      expect((component as any).isFocusableMenuEntry(entries[4])).toBe(true); // item
    });

    it('nextMenuIndex skips non-focusable entries and wraps around', () => {
      expect((component as any).nextMenuIndex(entries, 1, 1)).toBe(4); // skips separator + disabled
      expect((component as any).nextMenuIndex(entries, 4, 1)).toBe(1); // wraps to start, skips topic
      expect((component as any).nextMenuIndex(entries, 4, -1)).toBe(1); // skips disabled + separator
      expect((component as any).nextMenuIndex(entries, 1, -1)).toBe(4); // wraps to end
    });

    it('firstMenuIndex / lastMenuIndex find the first and last focusable entries', () => {
      expect((component as any).firstMenuIndex(entries)).toBe(1);
      expect((component as any).lastMenuIndex(entries)).toBe(4);
    });

    it('falls back to index 0 when no entry is focusable', () => {
      const allDisabled: MenuEntry[] = [
        { type: 'topic', label: 'Actions' },
        { type: 'separator' },
      ];
      expect((component as any).firstMenuIndex(allDisabled)).toBe(0);
      expect((component as any).lastMenuIndex(allDisabled)).toBe(0);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx ng test`
Expected: FAIL — the new helper methods don't exist yet.

- [ ] **Step 3: Implement the helpers**

In `mindmap-app/src/app/mindmap/mindmap.ts`, add a new section after `onMenuItemClick` (still within the `── Context menu state ──` area):

```ts
  // ── Context menu keyboard navigation ────────────────────────────────────────

  private isFocusableMenuEntry(entry: MenuEntry): boolean {
    return entry.type === 'item' && !entry.disabled;
  }

  private nextMenuIndex(entries: MenuEntry[], from: number, direction: 1 | -1): number {
    const n = entries.length;
    let i = from;
    for (let step = 0; step < n; step++) {
      i = (i + direction + n) % n;
      if (this.isFocusableMenuEntry(entries[i])) return i;
    }
    return from;
  }

  private firstMenuIndex(entries: MenuEntry[]): number {
    const i = entries.findIndex((e) => this.isFocusableMenuEntry(e));
    return i === -1 ? 0 : i;
  }

  private lastMenuIndex(entries: MenuEntry[]): number {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (this.isFocusableMenuEntry(entries[i])) return i;
    }
    return 0;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx ng test`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add mindmap-app/src/app/mindmap/mindmap.ts mindmap-app/src/app/mindmap/mindmap.spec.ts
git commit -m "feat: add pure menu-navigation index helpers"
```

---

### Task 7: Wire menu keyboard navigation into the template

**Files:**
- Modify: `mindmap-app/src/app/mindmap/mindmap.ts`
- Modify: `mindmap-app/src/app/mindmap/mindmap.html`
- Modify: `mindmap-app/src/app/mindmap/mindmap.scss`

**Interfaces:**
- Consumes: `isFocusableMenuEntry`, `nextMenuIndex`, `firstMenuIndex`, `lastMenuIndex` (Task 6), `openContextMenu` (Task 5)
- Produces: `menuFocusIndex`/`submenuOpenIndex` signals, `isMenuItemActive(index: number, isSubmenu: boolean, parentIndex?: number): boolean`, `onMenuKeydown(event: KeyboardEvent): void`, `private focusActiveMenuItem(): void`

- [ ] **Step 1: Add menu focus state, `@ViewChild` ref, and `isMenuItemActive`**

Add the imports needed: in the `@angular/core` import list at the top of `mindmap.ts`, add `ViewChild` is already imported — also add nothing new there. Add `ElementRef` is already imported too.

Add signals next to `menuOpenerNodeId`:

```ts
  private menuOpenerNodeId: string | null = null;
  readonly menuFocusIndex = signal(0);
  readonly submenuOpenIndex = signal<number | null>(null);

  @ViewChild('menuRoot') menuRootRef?: ElementRef<HTMLDivElement>;
```

Add a public method (called from the template) right after `onMenuItemClick`:

```ts
  isMenuItemActive(index: number, isSubmenu: boolean, parentIndex?: number): boolean {
    if (isSubmenu) {
      return this.submenuOpenIndex() === parentIndex && this.menuFocusIndex() === index;
    }
    return this.submenuOpenIndex() === null && this.menuFocusIndex() === index;
  }
```

- [ ] **Step 2: Add `focusActiveMenuItem` and `onMenuKeydown`**

Add to the `── Context menu keyboard navigation ──` section (from Task 6), after `lastMenuIndex`:

```ts
  private focusActiveMenuItem(): void {
    queueMicrotask(() => {
      this.menuRootRef?.nativeElement.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    });
  }

  onMenuKeydown(event: KeyboardEvent): void {
    const inSubmenu = this.submenuOpenIndex() !== null;
    const entries = inSubmenu
      ? (this.menuEntries()[this.submenuOpenIndex()!] as MenuEntry & { type: 'item' }).children!
      : this.menuEntries();

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.menuFocusIndex.set(this.nextMenuIndex(entries, this.menuFocusIndex(), 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.menuFocusIndex.set(this.nextMenuIndex(entries, this.menuFocusIndex(), -1));
        break;
      case 'Home':
        event.preventDefault();
        this.menuFocusIndex.set(this.firstMenuIndex(entries));
        break;
      case 'End':
        event.preventDefault();
        this.menuFocusIndex.set(this.lastMenuIndex(entries));
        break;
      case 'ArrowRight': {
        if (inSubmenu) break;
        const current = entries[this.menuFocusIndex()];
        if (current?.type === 'item' && current.children?.length) {
          event.preventDefault();
          this.submenuOpenIndex.set(this.menuFocusIndex());
          this.menuFocusIndex.set(this.firstMenuIndex(current.children));
        }
        break;
      }
      case 'ArrowLeft': {
        if (inSubmenu) {
          event.preventDefault();
          this.menuFocusIndex.set(this.submenuOpenIndex()!);
          this.submenuOpenIndex.set(null);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        const active = entries[this.menuFocusIndex()];
        if (active?.type === 'item' && !active.disabled) {
          if (active.children?.length) {
            this.submenuOpenIndex.set(this.menuFocusIndex());
            this.menuFocusIndex.set(this.firstMenuIndex(active.children));
          } else {
            active.action();
            this.menuOpen.set(false);
          }
        }
        break;
      }
    }

    this.focusActiveMenuItem();
  }
```

- [ ] **Step 3: Reset and focus menu state when it opens**

Update `openContextMenu` (from Task 5):

```ts
  private openContextMenu(d: D3Node, x: number, y: number): void {
    if (!this.contextMenuFn) return;
    this.contextMenuFn(d.sourceNode).then((entries) => {
      this.zone.run(() => {
        this.menuEntries.set(entries);
        this.menuX.set(x);
        this.menuY.set(y);
        this.menuOpenerNodeId = d.id;
        this.submenuOpenIndex.set(null);
        this.menuFocusIndex.set(this.firstMenuIndex(entries));
        this.menuOpen.set(true);
      });
      this.focusActiveMenuItem();
    });
  }
```

- [ ] **Step 4: Update the template**

In `mindmap-app/src/app/mindmap/mindmap.html`, make these changes to the `@if (menuOpen())` block:

Add `#menuRoot` and `(keydown)` to the outer div:

```html
  <div class="mm-context-menu"
       #menuRoot
       role="menu"
       aria-label="Node actions"
       [style.left.px]="menuX()"
       [style.top.px]="menuY()"
       (click)="$event.stopPropagation()"
       (keydown)="onMenuKeydown($event)">
```

Capture the outer loop index and add tabindex/sub-open class to the top-level item. Change:

```html
      @for (entry of menuEntries(); track $index) {
```

to:

```html
      @for (entry of menuEntries(); track $index; let entryIndex = $index) {
```

Change the top-level item `<li>`:

```html
        } @else {
          <li class="mm-item"
              role="menuitem"
              [attr.aria-disabled]="entry.disabled || null"
              [attr.tabindex]="isMenuItemActive($index, false) ? 0 : -1"
              [class.mm-item--disabled]="entry.disabled"
              [class.mm-item--has-sub]="entry.children?.length"
              [class.mm-item--sub-open]="submenuOpenIndex() === $index"
              [class.mm-item--danger]="entry.intent === 'danger'"
              [class.mm-item--warning]="entry.intent === 'warning'"
              (click)="onMenuItemClick($event, entry)">
```

Change the submenu item `<li>`:

```html
                  } @else {
                    <li class="mm-item"
                        role="menuitem"
                        [attr.aria-disabled]="sub.disabled || null"
                        [attr.tabindex]="isMenuItemActive($index, true, entryIndex) ? 0 : -1"
                        [class.mm-item--disabled]="sub.disabled"
                        [class.mm-item--danger]="sub.intent === 'danger'"
                        [class.mm-item--warning]="sub.intent === 'warning'"
                        (click)="onMenuItemClick($event, sub)">
```

- [ ] **Step 5: Add keyboard-driven submenu-open styling**

In `mindmap-app/src/app/mindmap/mindmap.scss`, add next to the existing `.mm-item--has-sub:hover > .mm-submenu` rule:

```scss
.mm-item--has-sub.mm-item--sub-open > .mm-submenu {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transition: opacity 120ms ease, visibility 0s, pointer-events 0s;
}
```

- [ ] **Step 6: Type-check and run tests**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx ng test`
Expected: PASS.

- [ ] **Step 7: Manual verification in-browser**

```bash
npm start -- --port 4300
```

Right-click a node to open the menu with the mouse: confirm it still works (regression check). Then, via keyboard: focus a node, press `Shift+F10`, confirm the first enabled item gets the visible focus ring. Press `↓`/`↑`: confirm focus moves between items, skipping the topic/separator/disabled entries. Press `→` on "Add child" (has a submenu): confirm the submenu opens and focus moves to its first item. Press `←`: confirm it closes the submenu and returns focus to "Add child". Press `Enter` on a real action item (e.g. "Rename…"): confirm its action fires (check the browser console for the `console.log(...)` from `app.ts`) and the menu closes. Re-open the menu and press `Escape`: confirm it closes and focus returns to the node.

Stop the dev server when done.

- [ ] **Step 8: Commit**

```bash
git add mindmap-app/src/app/mindmap/mindmap.ts mindmap-app/src/app/mindmap/mindmap.html mindmap-app/src/app/mindmap/mindmap.scss
git commit -m "feat: add roving-tabindex keyboard navigation to the context menu"
```

---

### Task 8: Full regression pass, PR, and merge

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Full automated check**

Run, from `mindmap-app/`:

```bash
npx tsc --noEmit
npx ng test
npm run build
```

Expected: all three succeed with no errors.

- [ ] **Step 2: Full manual regression pass in-browser**

```bash
npm start -- --port 4300
```

Re-verify, in one pass: mouse click collapse/expand, mouse drag (no accidental collapse), mouse hover edge-highlight, mouse right-click menu, theme toggle (Light/Dark button), Reset/Fit buttons — none of these should have regressed. Then re-verify the full keyboard flow end to end: Tab into the graph, arrow/Home/End navigation, Enter/Space activation, Shift+F10 menu open, full menu keyboard operation, Escape-returns-focus.

Stop the dev server when done.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/mindmap-keyboard-a11y
gh pr create --title "feat: keyboard accessibility for the mind-map component" --body "$(cat <<'EOF'
## Summary
- Roving-tabindex tree navigation (arrows/Home/End/Enter/Space) with ARIA treeview semantics (role=tree/treeitem, aria-level/expanded/setsize/posinset)
- Keyboard-operable context menu (Shift+F10/ContextMenu key to open, anchored to the focused node; full arrow/Enter/Escape navigation including submenus)
- New optional `ariaLabel` input (default `'Mind map'`), additive/non-breaking
- Design: docs/superpowers/specs/2026-07-10-mindmap-keyboard-a11y-design.md
- Plan: docs/superpowers/plans/2026-07-10-mindmap-keyboard-a11y.md

## Test plan
- [x] `npx tsc --noEmit`, `npm test`, `npm run build` all pass
- [x] Manual regression pass: existing mouse interactions unaffected
- [x] Manual keyboard pass: full tree + menu navigation verified in-browser

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Merge**

After confirming the PR is mergeable (`gh pr view <number> --json mergeable,mergeStateStatus`), merge with a merge commit to match this repo's existing history style:

```bash
gh pr merge --merge --delete-branch=false
```

Then sync local `master`:

```bash
git checkout master
git pull origin master
```
