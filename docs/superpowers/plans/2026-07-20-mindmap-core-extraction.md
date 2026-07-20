# Extract Framework-Agnostic Mindmap Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract `MindmapComponent`'s D3/rendering/layout logic into a standalone `MindmapCore` class with zero Angular imports, so it can later be consumed as a plain JS bundle by a non-Angular project — with zero behavior change to the existing Angular component, and a standalone bundle + demo proving the core works outside Angular.

**Architecture:** New `src/app/mindmap/mindmap-core.ts` holds the extracted class (constructed against a raw `SVGSVGElement`, driven by explicit setter methods and callback-hook options instead of Angular's `input()`/`effect()`/`signal()`). `mindmap.ts` shrinks to a thin Angular wrapper delegating to it. `mindmap-layout.ts`/`mindmap.model.ts` are consumed unchanged. `context-menu.ts` is untouched — it stays Angular-only, wired to the core via a callback hook.

**Tech Stack:** Same as the existing app (TypeScript, D3 v7, Vitest/jsdom, Playwright), plus esbuild (new devDependency) for the standalone bundle.

## Global Constraints

- No behavior change from a consumer's perspective — every existing input, output, and interaction (drag, zoom, collapse, keyboard nav, context menu, theme/layout-mode switching) must work identically to before.
- `context-menu.ts`/`ContextMenuComponent` stays Angular-only and untouched.
- `mindmap-layout.ts`/`mindmap.model.ts` stay unchanged (already framework-agnostic).
- The core's reactivity-shaped inputs (`collapseMode`, `edgeDirection`, `contextMenuFn`, `nodeClickFn`) have **no dedicated Angular `effect()` today** (confirmed: `CLAUDE.md` explicitly notes `collapseMode` "has no dedicated reactive trigger of its own" — the same is true of the other three, which are read live via signal-function-calls at point of use, not watched). The port must preserve this exact semantic via live-read getter callbacks (`getCollapseMode`, `getEdgeDirection`, `getContextMenuFn`, `getNodeClickFn`) passed once at construction — not cached fields, not new dedicated setters that would change reactivity behavior that doesn't exist today.
- `width`/`height`/`theme`/`layoutMode`/`data` DO have dedicated `effect()`s today — these become explicit setter methods (`setSize`, `setTheme`, `setLayoutMode`, `setData`) the wrapper's own (unchanged) effects call.
- No new library-build tooling beyond esbuild (no `ng-packagr`, no Vite lib mode) — this repo has no existing library-build target to extend.
- Existing Playwright e2e tests must pass unchanged — they exercise the fully-assembled component and don't care about the internal split.

---

### Task 1: Extract `MindmapCore`, thin the Angular wrapper, relocate tests

**Files:**
- Create: `src/app/mindmap/mindmap-core.ts`
- Create: `src/app/mindmap/mindmap-core.spec.ts`
- Modify: `src/app/mindmap/mindmap.ts`
- Modify: `src/app/mindmap/mindmap.spec.ts`

**Interfaces:**
- Consumes: `MindmapGraph`, `D3GraphNode`, `D3GraphEdge`, `MenuEntry`, `ContextMenuFn`, `NodeClickFn` from `./mindmap.model` (unchanged). `buildGraph`, `classifyShape`, `computeRadialPositions`, `computeVisibleGraph`, `cycleOutgoingEdge`, `nodeRadius`, `resolveEntryNode` from `./mindmap-layout` (unchanged). `ContextMenuCloseReason` (type-only) and `ContextMenuComponent` from `./context-menu` (unchanged).
- Produces: `MindmapCore` class and `MindmapCoreOptions` interface, exported from `mindmap-core.ts` — consumed by `mindmap.ts` in this same task, and later by Task 2's bundle build. `MindmapComponent` keeps its existing public surface (`data`, `width`, `height`, `theme`, `contextMenuFn`, `nodeClickFn`, `ariaLabel`, `layoutMode`, `collapseMode`, `edgeDirection` inputs; `resetView()`, `zoomToFit()`, `onContextMenuClosed()`, `menuOpen`/`menuX`/`menuY`/`menuEntries`/`liveMessage` signals) — exported from `mindmap.ts` at the same path, so `app.ts`'s `import { MindmapComponent, MindmapLayout, MindmapTheme } from './mindmap/mindmap'` needs no changes.

- [ ] **Step 1: Read the current files in full to confirm exact content**

Read `src/app/mindmap/mindmap.ts`, `src/app/mindmap/mindmap.spec.ts`, `src/app/mindmap/mindmap.model.ts`, and `src/app/mindmap/context-menu.ts` (just enough of the latter to confirm the exact `ContextMenuCloseReason` type export) before making any changes, since this plan's diffs assume today's exact content and a stale assumption here would produce a subtly wrong result.

- [ ] **Step 2: Create `mindmap-core.ts`**

Create `src/app/mindmap/mindmap-core.ts` with this exact content:

```typescript
import * as d3 from 'd3';
import {
  MindmapGraph,
  D3GraphNode,
  D3GraphEdge,
  MenuEntry,
  ContextMenuFn,
  NodeClickFn,
} from './mindmap.model';
import {
  buildGraph,
  classifyShape,
  computeRadialPositions,
  computeVisibleGraph,
  cycleOutgoingEdge,
  nodeRadius,
  resolveEntryNode,
} from './mindmap-layout';
import type { ContextMenuCloseReason } from './context-menu';

export type MindmapTheme = 'dark' | 'light';
export type MindmapLayout = 'force' | 'radial' | 'hybrid';

interface ThemeConfig {
  background: string;
  edgeStroke: string;
  edgeOpacity: number;
  labelFill: string;
  badgeFill: string;
  glowStdDeviation: number;
  haloOpacity: number;
  nodeColors: string[];
}

// ── Force-simulation tuning ─────────────────────────────────────────────────

const LINK_DISTANCE_BASE = 70;
const LINK_DISTANCE_PER_DEPTH = 12;
const CHARGE_STRENGTH = -350;
const COLLISION_PADDING = 14;
const ALPHA_DECAY = 0.028;
const REDRAW_ALPHA = 0.3;

const ZOOM_SCALE_EXTENT: [number, number] = [0.1, 5];

const DRAG_CLICK_DISTANCE = 4;

const HOVER_TRANSITION_MS = 150;

const FIT_PADDING = 60;
const FIT_TRANSITION_MS = 400;

const RADIAL_TRANSITION_MS = 400;
const HYBRID_POSITION_STRENGTH = 0.3;
const HYBRID_ALPHA = 0.6;

const THEMES: Record<MindmapTheme, ThemeConfig> = {
  dark: {
    background: '#1e1e2e',
    edgeStroke: '#3b3b5c',
    edgeOpacity: 0.75,
    labelFill: '#cdd6f4',
    badgeFill: '#f38ba8',
    glowStdDeviation: 3.5,
    haloOpacity: 0.2,
    nodeColors: ['#7c6af7', '#a78bfa', '#c4b5fd', '#6ee7b7', '#86efac', '#4ade80'],
  },
  light: {
    background: '#f9fbfc',
    edgeStroke: '#d5d7da',
    edgeOpacity: 0.9,
    labelFill: '#414651',
    badgeFill: '#d4044b',
    glowStdDeviation: 2.5,
    haloOpacity: 0.15,
    nodeColors: ['#4d458e', '#00a6fb', '#53a2be', '#fe883a', '#90c544', '#dd3559'],
  },
};

/**
 * Constructor options for MindmapCore. width/height/theme/layoutMode mirror the Angular
 * wrapper's inputs that have a dedicated effect() today (see setSize/setTheme/setLayoutMode/
 * setData below). getCollapseMode/getEdgeDirection/getContextMenuFn/getNodeClickFn are live-
 * read getters, not cached values or dedicated setters -- this exactly mirrors today's
 * behavior, where these four inputs are read directly via signal-function-calls at point of
 * use with no watching effect (see CLAUDE.md's note on collapseMode having "no dedicated
 * reactive trigger of its own" -- the same was true pre-extraction for the other three).
 */
export interface MindmapCoreOptions {
  width: number;
  height: number;
  theme: MindmapTheme;
  layoutMode: MindmapLayout;
  ariaLabel: string;
  getCollapseMode: () => 'global' | 'per-edge';
  getEdgeDirection: () => 'arrow' | 'plain' | undefined;
  getContextMenuFn: () => ContextMenuFn | undefined;
  getNodeClickFn: () => NodeClickFn | undefined;
  onOpenContextMenu?: (entries: MenuEntry[], x: number, y: number) => void;
  onLiveMessage?: (message: string) => void;
}

/**
 * Framework-agnostic mindmap renderer -- the D3/SVG core extracted from the Angular
 * MindmapComponent (see docs/superpowers/specs/2026-07-20-mindmap-core-extraction-design.md).
 * Owns the SVG DOM, the force simulation, and all layout/interaction logic. A consumer
 * (Angular wrapper, or a plain script) constructs one against an <svg> element, calls the
 * setters below when its own reactive inputs change, and reads nothing back except via the
 * callback hooks in MindmapCoreOptions.
 */
export class MindmapCore {
  private data: MindmapGraph;
  private width: number;
  private height: number;
  private theme: MindmapTheme;
  private layoutMode: MindmapLayout;

  private svg!: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g!: d3.Selection<SVGGElement, unknown, null, undefined>;
  private zoomBehavior!: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private simulation: d3.Simulation<D3GraphNode, D3GraphEdge> | undefined;
  private allNodes: D3GraphNode[] = [];
  private allEdges: D3GraphEdge[] = [];
  private shape: 'tree' | 'graph' = 'tree';
  private entryNode: D3GraphNode | null = null;
  private structuralRoot: D3GraphNode | null = null;

  private colorScale!: d3.ScaleOrdinal<number, string>;
  private strokeColorByDepth: string[] = [];
  private visibleNodes: D3GraphNode[] = [];
  private focusedNodeId: string | null = null;
  private outgoingCursor = new Map<string, number>();
  private arrivedVia = new Map<string, string>();
  private linksByNode = new Map<string, D3GraphEdge[]>();

  private menuOpenerNodeId: string | null = null;

  private get tc(): ThemeConfig {
    return THEMES[this.theme];
  }

  constructor(
    svgElement: SVGSVGElement,
    data: MindmapGraph,
    private readonly options: MindmapCoreOptions,
  ) {
    this.data = data;
    this.width = options.width;
    this.height = options.height;
    this.theme = options.theme;
    this.layoutMode = options.layoutMode;
    this.initSvg(svgElement, options.ariaLabel);
    this.render();
  }

  // ── Public setters (replace the Angular wrapper's effect() bodies) ────────

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.svg.attr('width', width).attr('height', height);
  }

  setTheme(theme: MindmapTheme): void {
    this.theme = theme;
    this.applyThemeToBackground();
    if (this.allNodes.length) this.redraw();
  }

  setLayoutMode(mode: MindmapLayout): void {
    this.layoutMode = mode;
    if (this.allNodes.length) {
      this.redraw();
      this.zoomToFitAfterSettle();
    }
  }

  setData(data: MindmapGraph): void {
    this.data = data;
    this.render();
  }

  notifyMenuClosed(reason: ContextMenuCloseReason): void {
    if (reason === 'escape') {
      const opener = this.menuOpenerNodeId
        ? this.visibleNodes.find((n) => n.id === this.menuOpenerNodeId)
        : null;
      if (opener) this.moveFocusTo(opener);
    }
    this.menuOpenerNodeId = null;
  }

  destroy(): void {
    this.simulation?.stop();
  }

  // ── SVG bootstrap ──────────────────────────────────────────────────────────

  private initSvg(svgElement: SVGSVGElement, ariaLabel: string): void {
    this.svg = d3.select(svgElement)
      .attr('width', this.width)
      .attr('height', this.height)
      .attr('aria-label', ariaLabel);

    this.svg.append('rect')
      .attr('class', 'mm-bg')
      .attr('width', '100%').attr('height', '100%')
      .attr('fill', this.tc.background);

    this.g = this.svg.append('g').attr('class', 'graph');
    this.g.append('g').attr('class', 'links');
    this.g.append('g').attr('class', 'nodes');

    this.zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent(ZOOM_SCALE_EXTENT)
      .on('zoom', (event) => this.g.attr('transform', event.transform));

    this.svg.call(this.zoomBehavior);
    this.svg.call(this.zoomBehavior.transform, d3.zoomIdentity.translate(this.width / 2, this.height / 2));
  }

  private applyThemeToBackground(): void {
    this.svg.select('rect.mm-bg').attr('fill', this.tc.background);
    this.svg.select('defs').select('#mm-glow').remove();
  }

  private prefersReducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // ── View controls ────────────────────────────────────────────────────────

  resetView(): void {
    if (!this.svg) return;
    this.svg.transition().duration(this.prefersReducedMotion() ? 0 : FIT_TRANSITION_MS)
      .call(this.zoomBehavior.transform, d3.zoomIdentity.translate(this.width / 2, this.height / 2));
  }

  zoomToFit(): void {
    if (!this.svg || !this.g.node()) return;
    const bounds = this.g.node()!.getBBox();
    if (bounds.width === 0 || bounds.height === 0) return;

    const scale = Math.min(
      ZOOM_SCALE_EXTENT[1],
      Math.max(
        ZOOM_SCALE_EXTENT[0],
        Math.min(
          (this.width - FIT_PADDING * 2) / bounds.width,
          (this.height - FIT_PADDING * 2) / bounds.height,
        ),
      ),
    );
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;

    const transform = d3.zoomIdentity
      .translate(this.width / 2, this.height / 2)
      .scale(scale)
      .translate(-cx, -cy);

    this.svg.transition().duration(this.prefersReducedMotion() ? 0 : FIT_TRANSITION_MS)
      .call(this.zoomBehavior.transform, transform);
  }

  private zoomToFitAfterSettle(): void {
    if (!this.simulation) {
      setTimeout(() => this.zoomToFit(), this.prefersReducedMotion() ? 0 : RADIAL_TRANSITION_MS);
      return;
    }
    this.simulation?.on('end.layoutSwitch', () => {
      this.simulation?.on('end.layoutSwitch', null);
      this.zoomToFit();
    });
  }

  // ── Colour scale ───────────────────────────────────────────────────────────

  private buildColorScale(): void {
    this.colorScale = d3.scaleOrdinal<number, string>()
      .domain([0, 1, 2, 3, 4, 5])
      .range(this.tc.nodeColors);

    const brighterBy = this.theme === 'light' ? 0.4 : 0.6;
    this.strokeColorByDepth = this.tc.nodeColors.map((color) =>
      (d3.color(color) as d3.RGBColor).brighter(brighterBy).formatHex());
  }

  private strokeColorFor(d: D3GraphNode): string {
    return this.strokeColorByDepth[(d.depth ?? 0) % this.strokeColorByDepth.length];
  }

  private applyTabindex(selection: d3.Selection<SVGGElement, D3GraphNode, SVGGElement, unknown>): void {
    selection.attr('tabindex', (d) => (d.id === this.focusedNodeId ? 0 : -1));
  }

  private moveFocusTo(d: D3GraphNode): void {
    this.focusedNodeId = d.id;
    const nodeSelection = this.g.select<SVGGElement>('.nodes').selectAll<SVGGElement, D3GraphNode>('g.node');
    this.applyTabindex(nodeSelection);
    nodeSelection.filter((n) => n.id === d.id).node()?.focus();
  }

  private onNodeKeydown(event: KeyboardEvent, d: D3GraphNode): void {
    if (this.shape === 'tree') {
      this.onNodeKeydownTree(event, d);
    } else {
      this.onNodeKeydownGraph(event, d);
    }
  }

  private onNodeKeydownTree(event: KeyboardEvent, d: D3GraphNode): void {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const i = this.visibleNodes.findIndex((n) => n.id === d.id);
        if (i !== -1 && i < this.visibleNodes.length - 1) this.moveFocusTo(this.visibleNodes[i + 1]);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const i = this.visibleNodes.findIndex((n) => n.id === d.id);
        if (i > 0) this.moveFocusTo(this.visibleNodes[i - 1]);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (d.collapsed) {
          this.toggleCollapse(d);
        } else {
          const child = this.allEdges.find((e) => e.source.id === d.id)?.target;
          if (child) this.moveFocusTo(child);
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        const hasOutgoing = this.allEdges.some((e) => e.source.id === d.id);
        const parentEdge = this.allEdges.find((e) => e.target.id === d.id);
        if (hasOutgoing && !d.collapsed) {
          this.toggleCollapse(d);
        } else if (parentEdge) {
          this.moveFocusTo(parentEdge.source);
        }
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (this.options.getNodeClickFn()?.(d.sourceNode) === true) {
          this.options.onLiveMessage?.(`${d.label} activated`);
          return;
        }
        this.toggleCollapse(d);
        break;
      }
      case 'Home': {
        event.preventDefault();
        if (this.visibleNodes.length) this.moveFocusTo(this.visibleNodes[0]);
        break;
      }
      case 'End': {
        event.preventDefault();
        if (this.visibleNodes.length) this.moveFocusTo(this.visibleNodes[this.visibleNodes.length - 1]);
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

  private onNodeKeydownGraph(event: KeyboardEvent, d: D3GraphNode): void {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const { index } = cycleOutgoingEdge(d, this.allEdges, this.outgoingCursor.get(d.id) ?? 0, 1);
        this.outgoingCursor.set(d.id, index);
        this.highlightOutgoingCursor(d);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const { index } = cycleOutgoingEdge(d, this.allEdges, this.outgoingCursor.get(d.id) ?? 0, -1);
        this.outgoingCursor.set(d.id, index);
        this.highlightOutgoingCursor(d);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        const { edge } = cycleOutgoingEdge(d, this.allEdges, (this.outgoingCursor.get(d.id) ?? 0) - 1, 1);
        if (edge) {
          this.arrivedVia.set(edge.target.id, d.id);
          this.moveFocusTo(edge.target);
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        const previousId = this.arrivedVia.get(d.id);
        const previous = previousId ? this.allNodes.find((n) => n.id === previousId) : undefined;
        if (previous) this.moveFocusTo(previous);
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (this.options.getNodeClickFn()?.(d.sourceNode) === true) {
          this.options.onLiveMessage?.(`${d.label} activated`);
          return;
        }
        this.toggleCollapse(d);
        break;
      }
      case 'Home': {
        event.preventDefault();
        if (this.entryNode) this.moveFocusTo(this.entryNode);
        else if (this.visibleNodes.length) this.moveFocusTo(this.visibleNodes[0]);
        break;
      }
      case 'End': {
        event.preventDefault();
        if (this.visibleNodes.length) this.moveFocusTo(this.visibleNodes[this.visibleNodes.length - 1]);
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

  private highlightOutgoingCursor(node: D3GraphNode): void {
    const { edge } = cycleOutgoingEdge(node, this.allEdges, (this.outgoingCursor.get(node.id) ?? 0) - 1, 1);
    this.g.select('.links').selectAll<SVGLineElement, D3GraphEdge>('line')
      .transition().duration(HOVER_TRANSITION_MS)
      .attr('stroke-opacity', (link) => (link.id === edge?.id ? 1 : 0.15))
      .attr('stroke-width', (link) => (link.id === edge?.id ? 2 : 1.5))
      .attr('stroke', (link) => (link.id === edge?.id ? this.colorScale(0) : this.tc.edgeStroke));
  }

  // ── Render / re-render ─────────────────────────────────────────────────────

  private effectiveEdgeDirection(): 'arrow' | 'plain' {
    return this.options.getEdgeDirection() ?? (this.shape === 'graph' ? 'arrow' : 'plain');
  }

  private render(): void {
    const previousById = new Map(this.allNodes.map((n) => [n.id, n]));
    const built = buildGraph(this.data, previousById);
    this.allNodes = built.nodes;
    this.allEdges = built.edges;
    this.shape = classifyShape(this.allNodes, this.allEdges);
    if (this.shape === 'tree') {
      const hasIncoming = new Set(this.allEdges.map((e) => e.target.id));
      this.structuralRoot = this.allNodes.find((n) => !hasIncoming.has(n.id)) ?? null;
    } else {
      this.structuralRoot = null;
    }
    this.entryNode = resolveEntryNode(this.allNodes, this.allEdges, this.data.entryNodeId);
    this.outgoingCursor.clear();
    this.arrivedVia.clear();
    this.focusedNodeId = this.entryNode?.id ?? null;

    if (this.shape === 'tree' && this.structuralRoot) {
      const depthById = new Map<string, number>([[this.structuralRoot.id, 0]]);
      const stack = [this.structuralRoot];
      while (stack.length) {
        const n = stack.pop()!;
        for (const e of this.allEdges.filter((edge) => edge.source.id === n.id)) {
          depthById.set(e.target.id, (depthById.get(n.id) ?? 0) + 1);
          stack.push(e.target);
        }
      }
      for (const n of this.allNodes) n.depth = depthById.get(n.id);
    } else {
      for (const n of this.allNodes) n.depth = undefined;
    }

    this.redraw();
  }

  private redraw(): void {
    this.buildColorScale();
    this.svg.attr('role', this.shape === 'tree' ? 'tree' : 'application');
    const { visibleNodes, visibleEdges } = computeVisibleGraph(this.allNodes, this.allEdges, this.options.getCollapseMode());
    this.visibleNodes = visibleNodes;

    let effectiveLayoutMode = this.layoutMode;
    if (effectiveLayoutMode !== 'force' && this.shape === 'graph') {
      console.warn(`mindmap: layoutMode "${effectiveLayoutMode}" requires tree-shaped data but the current data is graph-shaped — falling back to "force"`);
      effectiveLayoutMode = 'force';
    } else if (effectiveLayoutMode !== 'force' && this.structuralRoot === null) {
      effectiveLayoutMode = 'force';
    }

    if (effectiveLayoutMode === 'force') {
      this.syncForceSimulation(visibleNodes, visibleEdges);
      return;
    }

    computeRadialPositions(this.structuralRoot!, visibleNodes, visibleEdges);
    if (effectiveLayoutMode === 'hybrid') {
      this.syncHybridSimulation(visibleNodes, visibleEdges);
    } else {
      this.syncRadialLayout(visibleNodes, visibleEdges);
    }
  }

  private syncForceSimulation(nodes: D3GraphNode[], links: D3GraphEdge[]): void {
    this.buildGlowFilter();

    if (this.simulation) {
      this.simulation.nodes(nodes);
      this.simulation.force('link', d3.forceLink<D3GraphNode, D3GraphEdge>(links)
        .id((d) => d.id)
        .distance((d) => LINK_DISTANCE_BASE + (d.target.depth ?? 0) * LINK_DISTANCE_PER_DEPTH));
      this.simulation.force('charge', d3.forceManyBody().strength(CHARGE_STRENGTH));
      this.simulation.force('center', d3.forceCenter(0, 0));
      this.simulation.force('collision', d3.forceCollide<D3GraphNode>((d) => nodeRadius(d) + COLLISION_PADDING));
      this.simulation.force('x', null);
      this.simulation.force('y', null);
      this.simulation.alpha(REDRAW_ALPHA).restart();
    } else {
      this.simulation = d3.forceSimulation<D3GraphNode>(nodes)
        .force('link', d3.forceLink<D3GraphNode, D3GraphEdge>(links)
          .id((d) => d.id)
          .distance((d) => LINK_DISTANCE_BASE + (d.target.depth ?? 0) * LINK_DISTANCE_PER_DEPTH))
        .force('charge', d3.forceManyBody().strength(CHARGE_STRENGTH))
        .force('center', d3.forceCenter(0, 0))
        .force('collision', d3.forceCollide<D3GraphNode>((d) => nodeRadius(d) + COLLISION_PADDING))
        .alphaDecay(ALPHA_DECAY)
        .on('tick', () => this.tick());
    }

    this.updateEdges(links);
    this.updateNodes(nodes);
  }

  private syncHybridSimulation(nodes: D3GraphNode[], links: D3GraphEdge[]): void {
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
      this.simulation.force('x', d3.forceX<D3GraphNode>((d) => d.targetX ?? 0).strength(HYBRID_POSITION_STRENGTH));
      this.simulation.force('y', d3.forceY<D3GraphNode>((d) => d.targetY ?? 0).strength(HYBRID_POSITION_STRENGTH));
      this.simulation.force('collision', d3.forceCollide<D3GraphNode>((d) => nodeRadius(d) + COLLISION_PADDING));
      this.simulation.alpha(HYBRID_ALPHA).restart();
    } else {
      this.simulation = d3.forceSimulation<D3GraphNode>(nodes)
        .force('x', d3.forceX<D3GraphNode>((d) => d.targetX ?? 0).strength(HYBRID_POSITION_STRENGTH))
        .force('y', d3.forceY<D3GraphNode>((d) => d.targetY ?? 0).strength(HYBRID_POSITION_STRENGTH))
        .force('collision', d3.forceCollide<D3GraphNode>((d) => nodeRadius(d) + COLLISION_PADDING))
        .alphaDecay(ALPHA_DECAY)
        .on('tick', () => this.tick());
    }

    this.updateEdges(links);
    this.updateNodes(nodes);
  }

  private syncRadialLayout(nodes: D3GraphNode[], links: D3GraphEdge[]): void {
    this.simulation?.stop();
    this.simulation = undefined;
    this.buildGlowFilter();

    for (const n of nodes) {
      n.x = n.targetX;
      n.y = n.targetY;
    }

    this.updateEdges(links);
    this.updateNodes(nodes);

    const duration = this.prefersReducedMotion() ? 0 : RADIAL_TRANSITION_MS;

    this.g.select<SVGGElement>('.nodes').selectAll<SVGGElement, D3GraphNode>('g.node')
      .transition().duration(duration)
      .attr('transform', (d) => `translate(${d.x},${d.y})`);

    this.g.select<SVGGElement>('.links').selectAll<SVGLineElement, D3GraphEdge>('line')
      .transition().duration(duration)
      .attr('x1', (d) => d.source.x!)
      .attr('y1', (d) => d.source.y!)
      .attr('x2', (d) => this.shortenedEndpoint(d, this.effectiveEdgeDirection()).x)
      .attr('y2', (d) => this.shortenedEndpoint(d, this.effectiveEdgeDirection()).y);
  }

  // ── Glow SVG filter ────────────────────────────────────────────────────────

  private buildGlowFilter(): void {
    const defs = this.svg.select<SVGDefsElement>('defs').empty()
      ? this.svg.insert('defs', ':first-child')
      : this.svg.select<SVGDefsElement>('defs');

    if (defs.select('#mm-glow').empty()) {
      const f = defs.append('filter').attr('id', 'mm-glow')
        .attr('x', '-60%').attr('y', '-60%')
        .attr('width', '220%').attr('height', '220%');
      f.append('feGaussianBlur')
        .attr('in', 'SourceGraphic')
        .attr('stdDeviation', String(this.tc.glowStdDeviation))
        .attr('result', 'blur');
      const merge = f.append('feMerge');
      merge.append('feMergeNode').attr('in', 'blur');
      merge.append('feMergeNode').attr('in', 'SourceGraphic');
    }

    if (defs.select('#mm-arrow').empty()) {
      defs.append('marker').attr('id', 'mm-arrow')
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 9).attr('refY', 5)
        .attr('markerWidth', 6).attr('markerHeight', 6)
        .attr('orient', 'auto-start-reverse')
        .append('path')
        .attr('d', 'M 0 0 L 10 5 L 0 10 z')
        .attr('fill', this.tc.edgeStroke);
    }
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  private updateEdges(edges: D3GraphEdge[]): void {
    const direction = this.effectiveEdgeDirection();

    this.g.select<SVGGElement>('.links')
      .selectAll<SVGLineElement, D3GraphEdge>('line')
      .data(edges, (d) => d.id)
      .join('line')
      .attr('stroke', this.tc.edgeStroke)
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', this.tc.edgeOpacity)
      .attr('marker-end', direction === 'arrow' ? 'url(#mm-arrow)' : null);

    this.linksByNode.clear();
    for (const edge of edges) {
      for (const id of [edge.source.id, edge.target.id]) {
        const incident = this.linksByNode.get(id);
        if (incident) incident.push(edge);
        else this.linksByNode.set(id, [edge]);
      }
    }
  }

  private updateNodes(nodes: D3GraphNode[]): void {
    const merged = this.g.select<SVGGElement>('.nodes')
      .selectAll<SVGGElement, D3GraphNode>('g.node')
      .data(nodes, (d) => d.id)
      .join(
        (enter) => this.enterNodes(enter),
        (update) => update,
        (exit) => exit.remove(),
      );

    this.applyNodeTheme(merged);
    this.applyNodeAria(merged);
    this.applyTabindex(merged);
  }

  private openContextMenu(d: D3GraphNode, x: number, y: number): void {
    const contextMenuFn = this.options.getContextMenuFn();
    if (!contextMenuFn) return;
    contextMenuFn(d.sourceNode)
      .then((entries) => {
        this.menuOpenerNodeId = d.id;
        this.options.onOpenContextMenu?.(entries, x, y);
      })
      .catch((err) => console.error('mindmap: contextMenuFn rejected, menu not opened', err));
  }

  private openContextMenuForNode(d: D3GraphNode): void {
    const el = this.g.select<SVGGElement>('.nodes').selectAll<SVGGElement, D3GraphNode>('g.node')
      .filter((n) => n.id === d.id).node();
    const rect = el?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : 0;
    const y = rect ? rect.top + rect.height / 2 : 0;
    this.openContextMenu(d, x, y);
  }

  private enterNodes(
    enter: d3.Selection<d3.EnterElement, D3GraphNode, SVGGElement, unknown>,
  ): d3.Selection<SVGGElement, D3GraphNode, SVGGElement, unknown> {
    const nodeGroup = enter.append('g')
      .attr('class', 'node')
      .call(this.dragBehavior())
      .on('click', (event: MouseEvent, d) => {
        if (event.ctrlKey) return;
        if (this.options.getNodeClickFn()?.(d.sourceNode) === true) {
          this.options.onLiveMessage?.(`${d.label} activated`);
          return;
        }
        this.toggleCollapse(d);
      })
      .on('contextmenu', (event: MouseEvent, d: D3GraphNode) => {
        event.preventDefault();
        event.stopPropagation();
        this.openContextMenu(d, event.clientX, event.clientY);
      })
      .on('mouseover', (_event, d) => {
        const incident = new Set(this.linksByNode.get(d.id));
        this.g.select('.links').selectAll<SVGLineElement, D3GraphEdge>('line')
          .transition().duration(HOVER_TRANSITION_MS)
          .attr('stroke-opacity', (link) => (incident.has(link) ? 1 : 0.15))
          .attr('stroke-width', (link) => (incident.has(link) ? 2 : 1.5))
          .attr('stroke', (link) => (incident.has(link) ? this.colorScale(d.depth ?? 0) : this.tc.edgeStroke));
      })
      .on('mouseout', () => {
        this.g.select('.links').selectAll<SVGLineElement, D3GraphEdge>('line')
          .transition().duration(HOVER_TRANSITION_MS)
          .attr('stroke-opacity', this.tc.edgeOpacity)
          .attr('stroke-width', 1.5)
          .attr('stroke', this.tc.edgeStroke);
      })
      .on('keydown', (event: KeyboardEvent, d: D3GraphNode) => this.onNodeKeydown(event, d));

    const inner = nodeGroup.append('g').attr('class', 'node-scale');
    inner.append('circle').attr('class', 'halo').attr('filter', 'url(#mm-glow)');
    inner.append('circle').attr('class', 'body').attr('cursor', 'pointer');
    inner.append('text')
      .attr('text-anchor', 'middle')
      .attr('font-family', '"Inter", "Public Sans", "Segoe UI", system-ui, sans-serif')
      .attr('pointer-events', 'none');
    inner.append('circle').attr('class', 'badge').attr('r', 4).attr('pointer-events', 'none');

    return nodeGroup;
  }

  private applyNodeTheme(selection: d3.Selection<SVGGElement, D3GraphNode, SVGGElement, unknown>): void {
    selection.select<SVGCircleElement>('circle.halo')
      .attr('r', (d) => nodeRadius(d) + 5)
      .attr('fill', 'none')
      .attr('stroke', (d) => this.colorScale(d.depth ?? 0))
      .attr('stroke-opacity', this.tc.haloOpacity)
      .attr('stroke-width', 7);

    selection.select<SVGCircleElement>('circle.body')
      .attr('r', (d) => nodeRadius(d))
      .attr('fill', (d) => this.colorScale(d.depth ?? 0))
      .attr('fill-opacity', this.theme === 'light' ? 1 : 0.92)
      .attr('stroke', (d) => this.strokeColorFor(d))
      .attr('stroke-width', 1.5);

    selection.select<SVGTextElement>('text')
      .text((d) => d.label)
      .attr('dy', (d) => nodeRadius(d) + 13)
      .attr('fill', this.tc.labelFill)
      .attr('font-size', (d) => (d.depth === 0 ? 13 : 11))
      .attr('font-weight', (d) => (d.depth === 0 ? '600' : '400'));

    selection.select<SVGCircleElement>('circle.badge')
      .attr('cx', (d) => nodeRadius(d))
      .attr('cy', (d) => -nodeRadius(d))
      .attr('fill', this.tc.badgeFill)
      .attr('opacity', (d) => (d.collapsed ? 1 : 0));
  }

  private applyNodeAria(selection: d3.Selection<SVGGElement, D3GraphNode, SVGGElement, unknown>): void {
    const hasOutgoing = (d: D3GraphNode) => this.allEdges.some((e) => e.source.id === d.id);

    if (this.shape === 'tree') {
      selection
        .attr('role', 'treeitem')
        .attr('aria-label', (d) => d.label)
        .attr('aria-level', (d) => (d.depth ?? 0) + 1)
        .attr('aria-setsize', (d) => {
          const parentEdge = this.allEdges.find((e) => e.target.id === d.id);
          if (!parentEdge) return 1;
          return this.allEdges.filter((e) => e.source.id === parentEdge.source.id).length;
        })
        .attr('aria-posinset', (d) => {
          const parentEdge = this.allEdges.find((e) => e.target.id === d.id);
          if (!parentEdge) return 1;
          const siblings = this.allEdges.filter((e) => e.source.id === parentEdge.source.id).map((e) => e.target.id);
          return siblings.indexOf(d.id) + 1;
        })
        .attr('aria-expanded', (d) => (hasOutgoing(d) ? String(!d.collapsed) : null));
    } else {
      selection
        .attr('role', 'button')
        .attr('aria-label', (d) => d.label)
        .attr('aria-expanded', (d) => (hasOutgoing(d) ? String(!d.collapsed) : null));
    }
  }

  // ── Tick ───────────────────────────────────────────────────────────────────

  private tick(): void {
    const direction = this.effectiveEdgeDirection();
    this.g.select('.links').selectAll<SVGLineElement, D3GraphEdge>('line')
      .attr('x1', (d) => d.source.x!)
      .attr('y1', (d) => d.source.y!)
      .attr('x2', (d) => this.shortenedEndpoint(d, direction).x)
      .attr('y2', (d) => this.shortenedEndpoint(d, direction).y);

    this.g.select('.nodes').selectAll<SVGGElement, D3GraphNode>('g.node')
      .attr('transform', (d) => `translate(${d.x},${d.y})`);
  }

  private shortenedEndpoint(d: D3GraphEdge, direction: 'arrow' | 'plain'): { x: number; y: number } {
    if (direction === 'plain') return { x: d.target.x!, y: d.target.y! };

    const dx = d.target.x! - d.source.x!;
    const dy = d.target.y! - d.source.y!;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x: d.target.x!, y: d.target.y! };

    const radius = nodeRadius(d.target);
    const ratio = (len - radius) / len;
    return { x: d.source.x! + dx * ratio, y: d.source.y! + dy * ratio };
  }

  // ── Collapse / expand ──────────────────────────────────────────────────────

  private toggleCollapse(d: D3GraphNode): void {
    const hasOutgoing = this.allEdges.some((e) => e.source.id === d.id);
    if (!hasOutgoing) return;

    d.collapsed = !d.collapsed;
    this.options.onLiveMessage?.(`${d.label} ${d.collapsed ? 'collapsed' : 'expanded'}`);
    this.redraw();

    if (this.focusedNodeId && !this.visibleNodes.some((n) => n.id === this.focusedNodeId)) {
      this.moveFocusTo(d);
    }
  }

  // ── Drag ───────────────────────────────────────────────────────────────────

  private dragBehavior(): d3.DragBehavior<SVGGElement, D3GraphNode, D3GraphNode | d3.SubjectPosition> {
    return d3.drag<SVGGElement, D3GraphNode>()
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
}
```

- [ ] **Step 3: Rewrite `mindmap.ts` as a thin wrapper**

Replace the full content of `src/app/mindmap/mindmap.ts` with:

```typescript
import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  ChangeDetectionStrategy,
  effect,
  input,
  signal,
} from '@angular/core';
import { MindmapGraph, MenuEntry, ContextMenuFn, NodeClickFn } from './mindmap.model';
import { MindmapCore, MindmapCoreOptions, MindmapTheme, MindmapLayout } from './mindmap-core';
import { ContextMenuCloseReason, ContextMenuComponent } from './context-menu';

export type { MindmapTheme, MindmapLayout };

@Component({
  selector: 'app-mindmap',
  standalone: true,
  imports: [ContextMenuComponent],
  templateUrl: './mindmap.html',
  styleUrl: './mindmap.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-theme]': 'theme()',
  },
})
export class MindmapComponent implements OnInit, OnDestroy {
  readonly data = input.required<MindmapGraph>();
  readonly width = input(900);
  readonly height = input(650);
  readonly theme = input<MindmapTheme>('dark');
  readonly contextMenuFn = input<ContextMenuFn>();
  readonly nodeClickFn = input<NodeClickFn>();
  readonly ariaLabel = input('Mind map');
  readonly layoutMode = input<MindmapLayout>('force');
  readonly collapseMode = input<'global' | 'per-edge'>('global');
  readonly edgeDirection = input<'arrow' | 'plain' | undefined>(undefined);

  @ViewChild('svgContainer', { static: true }) svgRef!: ElementRef<SVGSVGElement>;

  readonly menuOpen = signal(false);
  readonly menuX = signal(0);
  readonly menuY = signal(0);
  readonly menuEntries = signal<MenuEntry[]>([]);

  readonly liveMessage = signal('');

  private core!: MindmapCore;

  onContextMenuClosed(reason: ContextMenuCloseReason): void {
    this.menuOpen.set(false);
    this.core.notifyMenuClosed(reason);
  }

  constructor() {
    let widthHeightFirstRun = true;
    effect(() => {
      const width = this.width();
      const height = this.height();
      if (widthHeightFirstRun) { widthHeightFirstRun = false; return; }
      this.core.setSize(width, height);
    });

    let themeFirstRun = true;
    effect(() => {
      const theme = this.theme();
      if (themeFirstRun) { themeFirstRun = false; return; }
      this.core.setTheme(theme);
    });

    let layoutModeFirstRun = true;
    effect(() => {
      const layoutMode = this.layoutMode();
      if (layoutModeFirstRun) { layoutModeFirstRun = false; return; }
      this.core.setLayoutMode(layoutMode);
    });

    let dataFirstRun = true;
    effect(() => {
      const data = this.data();
      if (dataFirstRun) { dataFirstRun = false; return; }
      this.core.setData(data);
    });
  }

  ngOnInit(): void {
    const options: MindmapCoreOptions = {
      width: this.width(),
      height: this.height(),
      theme: this.theme(),
      layoutMode: this.layoutMode(),
      ariaLabel: this.ariaLabel(),
      getCollapseMode: () => this.collapseMode(),
      getEdgeDirection: () => this.edgeDirection(),
      getContextMenuFn: () => this.contextMenuFn(),
      getNodeClickFn: () => this.nodeClickFn(),
      onOpenContextMenu: (entries, x, y) => {
        this.menuEntries.set(entries);
        this.menuX.set(x);
        this.menuY.set(y);
        this.menuOpen.set(true);
      },
      onLiveMessage: (message) => this.liveMessage.set(message),
    };
    this.core = new MindmapCore(this.svgRef.nativeElement, this.data(), options);
  }

  ngOnDestroy(): void {
    this.core?.destroy();
  }

  resetView(): void {
    this.core.resetView();
  }

  zoomToFit(): void {
    this.core.zoomToFit();
  }
}
```

`mindmap.html` and `mindmap.scss` need **no changes** — every public field/method name they bind to (`resetView()`, `zoomToFit()`, `menuOpen`, `menuX`, `menuY`, `menuEntries`, `onContextMenuClosed()`, `liveMessage`, `theme()`) is unchanged; only their internal implementation moved to delegate to `core`.

- [ ] **Step 4: Create `mindmap-core.spec.ts`**

Create `src/app/mindmap/mindmap-core.spec.ts` with this content — the D3/layout-behavior tests migrated from the pre-extraction `mindmap.spec.ts`, driving `MindmapCore` directly. Instances are constructed via `Object.create(MindmapCore.prototype)` rather than `new MindmapCore(...)`, deliberately bypassing the real constructor (which calls `initSvg()` — d3-zoom setup touches SVG geometry APIs, e.g. `viewBox.baseVal`, that jsdom doesn't implement) and instead stubbing a minimal detached `svg`/`g` structure directly — the exact same technique the pre-extraction `mindmap.spec.ts` used to bypass `ngOnInit`'s `initSvg()` call, just applied to the new host object:

```typescript
import * as d3 from 'd3';
import { MindmapCore, MindmapCoreOptions } from './mindmap-core';
import { D3GraphNode, MindmapGraph } from './mindmap.model';

describe('MindmapCore', () => {
  let core: MindmapCore;
  let liveMessages: string[];

  const sampleGraph: MindmapGraph = {
    nodes: [
      { id: 'root', label: 'Root' },
      { id: 'a', label: 'A' },
      { id: 'a1', label: 'A1' },
      { id: 'a2', label: 'A2' },
      { id: 'b', label: 'B' },
    ],
    edges: [
      { source: 'root', target: 'a' },
      { source: 'a', target: 'a1' },
      { source: 'a', target: 'a2' },
      { source: 'root', target: 'b' },
    ],
    entryNodeId: 'root',
  };

  function makeOptions(overrides: Partial<MindmapCoreOptions> = {}): MindmapCoreOptions {
    return {
      width: 900,
      height: 650,
      theme: 'dark',
      layoutMode: 'force',
      ariaLabel: 'Mind map',
      getCollapseMode: () => 'global',
      getEdgeDirection: () => undefined,
      getContextMenuFn: () => undefined,
      getNodeClickFn: () => undefined,
      onLiveMessage: (message) => liveMessages.push(message),
      ...overrides,
    };
  }

  function createDetachedCore(data: MindmapGraph, overrides: Partial<MindmapCoreOptions> = {}): MindmapCore {
    const instance = Object.create(MindmapCore.prototype) as MindmapCore;
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const g = d3.select(svgEl).append('g').attr('class', 'graph');
    g.append('g').attr('class', 'links');
    g.append('g').attr('class', 'nodes');
    (instance as any).svg = d3.select(svgEl);
    (instance as any).g = g;
    (instance as any).options = makeOptions(overrides);
    (instance as any).allNodes = [];
    (instance as any).allEdges = [];
    (instance as any).visibleNodes = [];
    (instance as any).outgoingCursor = new Map();
    (instance as any).arrivedVia = new Map();
    (instance as any).linksByNode = new Map();
    (instance as any).data = data;
    (instance as any).width = 900;
    (instance as any).height = 650;
    (instance as any).theme = 'dark';
    (instance as any).layoutMode = 'force';
    return instance;
  }

  beforeEach(() => {
    liveMessages = [];
    core = createDetachedCore(sampleGraph);
  });

  describe('render (data updates)', () => {
    beforeEach(() => {
      vi.spyOn(core as any, 'redraw').mockImplementation(() => {});
    });

    it('preserves prior node positions across a data update for nodes with matching ids', () => {
      (core as any).render();
      const firstNodes: D3GraphNode[] = (core as any).allNodes;
      const a = firstNodes.find((n) => n.id === 'a')!;
      a.x = 111;
      a.y = 222;

      const updated: MindmapGraph = {
        ...sampleGraph,
        nodes: sampleGraph.nodes.map((n) => (n.id === 'a' ? { ...n, label: 'A renamed' } : n)),
      };
      (core as any).data = updated;
      (core as any).render();

      const secondNodes: D3GraphNode[] = (core as any).allNodes;
      const secondA = secondNodes.find((n) => n.id === 'a')!;
      expect(secondA.x).toBe(111);
      expect(secondA.y).toBe(222);
      expect(secondA.label).toBe('A renamed');
    });
  });

  describe('layout-mode gating', () => {
    it('falls back to force with a console.warn when layoutMode is radial on graph-shaped data', () => {
      const dagGraph: MindmapGraph = {
        nodes: [{ id: 'p1', label: 'P1' }, { id: 'p2', label: 'P2' }, { id: 'shared', label: 'Shared' }],
        edges: [{ source: 'p1', target: 'shared' }, { source: 'p2', target: 'shared' }],
      };
      core = createDetachedCore(dagGraph);
      (core as any).layoutMode = 'radial';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(core as any, 'syncForceSimulation').mockImplementation(() => {});

      (core as any).render();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/layoutMode "radial".*graph-shaped/i));
      expect((core as any).syncForceSimulation).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('syncRadialLayout', () => {
    it('nulls this.simulation, not just stops it — dragBehavior() and zoomToFitAfterSettle() key off its presence to tell radial mode from force/hybrid', () => {
      const fakeSimulation = { stop: vi.fn() };
      (core as any).simulation = fakeSimulation;

      (core as any).syncRadialLayout([], []);

      expect(fakeSimulation.stop).toHaveBeenCalled();
      expect((core as any).simulation).toBeUndefined();
    });
  });

  describe('toggleCollapse', () => {
    const sharedGraph: MindmapGraph = {
      nodes: [
        { id: 'p1', label: 'P1' }, { id: 'p2', label: 'P2' },
        { id: 'shared', label: 'Shared' }, { id: 'shared-child', label: 'Shared Child' },
      ],
      edges: [
        { source: 'p1', target: 'shared' }, { source: 'p2', target: 'shared' },
        { source: 'shared', target: 'shared-child' },
      ],
    };

    beforeEach(() => {
      vi.spyOn(core as any, 'redraw').mockImplementation(() => {});
    });

    it('toggles collapsed on the node and calls redraw()', () => {
      (core as any).render();
      const a = (core as any).allNodes.find((n: D3GraphNode) => n.id === 'a');

      (core as any).toggleCollapse(a);
      expect(a.collapsed).toBe(true);

      (core as any).toggleCollapse(a);
      expect(a.collapsed).toBe(false);
    });

    it('announces the node label and new state to screen readers', () => {
      (core as any).render();
      const a = (core as any).allNodes.find((n: D3GraphNode) => n.id === 'a');

      (core as any).toggleCollapse(a);
      expect(liveMessages.at(-1)).toBe('A collapsed');

      (core as any).toggleCollapse(a);
      expect(liveMessages.at(-1)).toBe('A expanded');
    });

    it('is a no-op for a leaf node with no outgoing edges', () => {
      (core as any).render();
      const b = (core as any).allNodes.find((n: D3GraphNode) => n.id === 'b');

      (core as any).toggleCollapse(b);
      expect(b.collapsed).toBe(false);
    });

    describe('collapseMode: global vs per-edge (DAG-only behavior)', () => {
      it('global mode: collapsing one parent hides the shared node even via the other parent', () => {
        core = createDetachedCore(sharedGraph, { getCollapseMode: () => 'global' });
        vi.spyOn(core as any, 'syncForceSimulation').mockImplementation(() => {});
        (core as any).render();
        const p1 = (core as any).allNodes.find((n: D3GraphNode) => n.id === 'p1');

        (core as any).toggleCollapse(p1);

        expect((core as any).visibleNodes.map((n: D3GraphNode) => n.id).sort()).toEqual(['p1', 'p2']);
      });

      it('per-edge mode: collapsing one parent keeps the shared node visible via the other parent', () => {
        core = createDetachedCore(sharedGraph, { getCollapseMode: () => 'per-edge' });
        vi.spyOn(core as any, 'syncForceSimulation').mockImplementation(() => {});
        (core as any).render();
        const p1 = (core as any).allNodes.find((n: D3GraphNode) => n.id === 'p1');

        (core as any).toggleCollapse(p1);

        expect((core as any).visibleNodes.map((n: D3GraphNode) => n.id).sort())
          .toEqual(['p1', 'p2', 'shared', 'shared-child']);
      });
    });
  });

  describe('onNodeKeydown', () => {
    beforeEach(() => {
      vi.spyOn(core as any, 'redraw').mockImplementation(() => {});
    });

    describe('tree-shaped data', () => {
      beforeEach(() => {
        (core as any).redraw.mockRestore();
        vi.spyOn(core as any, 'syncForceSimulation').mockImplementation(() => {});
      });

      it('ArrowDown/Up move focus through the DFS-visible order', () => {
        (core as any).render();
        (core as any).moveFocusTo((core as any).allNodes.find((n: D3GraphNode) => n.id === 'root'));

        (core as any).onNodeKeydown({ key: 'ArrowDown', preventDefault: () => {} } as KeyboardEvent, (core as any).allNodes.find((n: D3GraphNode) => n.id === 'root'));
        expect((core as any).focusedNodeId).toBe('a');
      });

      it('ArrowLeft moves to the parent', () => {
        (core as any).render();
        const a1 = (core as any).allNodes.find((n: D3GraphNode) => n.id === 'a1');

        (core as any).onNodeKeydown({ key: 'ArrowLeft', preventDefault: () => {} } as KeyboardEvent, a1);
        expect((core as any).focusedNodeId).toBe('a');
      });
    });

    describe('graph-shaped data', () => {
      const dag: MindmapGraph = {
        nodes: [{ id: 'x', label: 'X' }, { id: 'y1', label: 'Y1' }, { id: 'y2', label: 'Y2' }, { id: 'p2', label: 'P2' }],
        edges: [{ source: 'x', target: 'y1' }, { source: 'x', target: 'y2' }, { source: 'p2', target: 'y1' }],
      };

      // No inner beforeEach here (matches the pre-extraction test exactly): these tests
      // inherit the outer describe's redraw() no-op mock on the existing `core` instance
      // rather than restoring it, since none of onNodeKeydownGraph's branches read
      // visibleNodes (only the tree-mode handlers do) -- render() populating
      // allNodes/allEdges (from the swapped-in dag data) is all these tests need.
      it('ArrowDown cycles the outgoing-edge cursor without moving focus', () => {
        (core as any).data = dag;
        (core as any).render();
        const x = (core as any).allNodes.find((n: D3GraphNode) => n.id === 'x');
        (core as any).moveFocusTo(x);

        (core as any).onNodeKeydown({ key: 'ArrowDown', preventDefault: () => {} } as KeyboardEvent, x);

        expect((core as any).focusedNodeId).toBe('x');
        expect((core as any).outgoingCursor.get('x')).toBe(1);
      });

      it('ArrowRight moves focus along the currently-selected outgoing edge', () => {
        (core as any).data = dag;
        (core as any).render();
        const x = (core as any).allNodes.find((n: D3GraphNode) => n.id === 'x');
        (core as any).moveFocusTo(x);

        (core as any).onNodeKeydown({ key: 'ArrowRight', preventDefault: () => {} } as KeyboardEvent, x);

        expect((core as any).focusedNodeId).toBe('y1');
      });

      it('ArrowLeft retraces to whichever node ArrowRight was pressed from', () => {
        (core as any).data = dag;
        (core as any).render();
        const x = (core as any).allNodes.find((n: D3GraphNode) => n.id === 'x');
        (core as any).moveFocusTo(x);
        (core as any).onNodeKeydown({ key: 'ArrowRight', preventDefault: () => {} } as KeyboardEvent, x);
        const y1 = (core as any).allNodes.find((n: D3GraphNode) => n.id === 'y1');

        (core as any).onNodeKeydown({ key: 'ArrowLeft', preventDefault: () => {} } as KeyboardEvent, y1);

        expect((core as any).focusedNodeId).toBe('x');
      });
    });
  });
});
```

- [ ] **Step 5: Replace `mindmap.spec.ts` with a thin wiring-smoke suite**

Replace the full content of `src/app/mindmap/mindmap.spec.ts` with:

```typescript
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MindmapComponent } from './mindmap';
import { MindmapGraph } from './mindmap.model';
import { MindmapCore } from './mindmap-core';

vi.mock('./mindmap-core', () => {
  const MindmapCore = vi.fn().mockImplementation(function (this: any, _svg: unknown, _data: unknown, options: unknown) {
    this.setSize = vi.fn();
    this.setTheme = vi.fn();
    this.setLayoutMode = vi.fn();
    this.setData = vi.fn();
    this.resetView = vi.fn();
    this.zoomToFit = vi.fn();
    this.notifyMenuClosed = vi.fn();
    this.destroy = vi.fn();
    this._options = options;
  });
  return { MindmapCore };
});

describe('MindmapComponent (wiring)', () => {
  let fixture: ComponentFixture<MindmapComponent>;
  let component: MindmapComponent;

  const sampleGraph: MindmapGraph = {
    nodes: [{ id: 'root', label: 'Root' }],
    edges: [],
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [MindmapComponent] }).compileComponents();
    fixture = TestBed.createComponent(MindmapComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('data', sampleGraph);
    fixture.detectChanges(); // safe: MindmapCore is mocked above, no real D3/SVG work happens
  });

  afterEach(() => fixture.destroy());

  it('constructs a MindmapCore against the svg element with the initial input values', () => {
    expect(MindmapCore).toHaveBeenCalledWith(
      expect.any(SVGSVGElement),
      sampleGraph,
      expect.objectContaining({ width: 900, height: 650, theme: 'dark' }),
    );
  });

  it('forwards a width/height change to core.setSize', () => {
    fixture.componentRef.setInput('width', 1000);
    fixture.componentRef.setInput('height', 700);
    fixture.detectChanges();
    expect((component as any).core.setSize).toHaveBeenCalledWith(1000, 700);
  });

  it('forwards a theme change to core.setTheme', () => {
    fixture.componentRef.setInput('theme', 'light');
    fixture.detectChanges();
    expect((component as any).core.setTheme).toHaveBeenCalledWith('light');
  });

  it('forwards a layoutMode change to core.setLayoutMode', () => {
    fixture.componentRef.setInput('layoutMode', 'radial');
    fixture.detectChanges();
    expect((component as any).core.setLayoutMode).toHaveBeenCalledWith('radial');
  });

  it('forwards a data change to core.setData', () => {
    const updated: MindmapGraph = { nodes: [{ id: 'x', label: 'X' }], edges: [] };
    fixture.componentRef.setInput('data', updated);
    fixture.detectChanges();
    expect((component as any).core.setData).toHaveBeenCalledWith(updated);
  });

  it('resetView()/zoomToFit() delegate to the core', () => {
    component.resetView();
    component.zoomToFit();
    expect((component as any).core.resetView).toHaveBeenCalled();
    expect((component as any).core.zoomToFit).toHaveBeenCalled();
  });

  it('onOpenContextMenu populates the menu signals', () => {
    const options = (component as any).core._options;
    options.onOpenContextMenu([{ type: 'topic', label: 'X' }], 10, 20);
    expect(component.menuOpen()).toBe(true);
    expect(component.menuX()).toBe(10);
    expect(component.menuY()).toBe(20);
    expect(component.menuEntries()).toEqual([{ type: 'topic', label: 'X' }]);
  });

  it('onLiveMessage forwards to the liveMessage signal', () => {
    const options = (component as any).core._options;
    options.onLiveMessage('A collapsed');
    expect(component.liveMessage()).toBe('A collapsed');
  });

  it('onContextMenuClosed closes the menu and delegates to core.notifyMenuClosed', () => {
    component.onContextMenuClosed('escape');
    expect(component.menuOpen()).toBe(false);
    expect((component as any).core.notifyMenuClosed).toHaveBeenCalledWith('escape');
  });

  it('ngOnDestroy calls core.destroy', () => {
    (component as any).ngOnDestroy();
    expect((component as any).core.destroy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Type-check**

Run (from the repo root, `/Users/rostreim/dev/ng-mindmap` — the whole repo IS the app; there is no `mindmap-app/` subdirectory, `CLAUDE.md`'s "run from `mindmap-app/`" refers to the project's package name, not a path): `npx tsc -b --noEmit`
Expected: no errors. If there are errors, they most likely indicate a mismatch between `MindmapCoreOptions`'s fields and how `mindmap.ts`'s `ngOnInit` constructs them, or a stray reference to a removed field — fix by comparing against the exact interfaces above, don't guess.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all pass — `mindmap-core.spec.ts` (new), `mindmap.spec.ts` (thinned), `context-menu.spec.ts` (unchanged), `mindmap-layout.spec.ts` (unchanged).

- [ ] **Step 8: Run the Playwright e2e suite**

Run: `npm run e2e`
Expected: all pass. This is the strongest evidence that real interactive behavior (drag, zoom, keyboard nav in real Chromium) is unchanged — it exercises the fully-assembled component through a real browser and doesn't care about the internal core/wrapper split.

- [ ] **Step 9: Commit**

```bash
git add src/app/mindmap/mindmap-core.ts src/app/mindmap/mindmap-core.spec.ts src/app/mindmap/mindmap.ts src/app/mindmap/mindmap.spec.ts
git commit -m "refactor: extract framework-agnostic MindmapCore from MindmapComponent"
```

---

### Task 2: Proof-of-portability bundle + demo

**Files:**
- Create: `esbuild.core.mjs` (repo root, sibling to `demo/`)
- Create: `demo/index.html`
- Modify: `package.json` (repo root — the whole repo is a single package named `mindmap-app`, there is no `mindmap-app/` subdirectory)

**Interfaces:**
- Consumes: `MindmapCore` from `src/app/mindmap/mindmap-core.ts` (Task 1), `MindmapGraph` shape from `mindmap.model.ts` (unchanged).
- Produces: nothing consumed by a later task in this plan — this is the last implementation task before manual verification.

- [ ] **Step 1: Add esbuild as a devDependency**

Run (from the repo root, `/Users/rostreim/dev/ng-mindmap`): `npm install --save-dev esbuild`

- [ ] **Step 2: Write the bundle build script**

Create `esbuild.core.mjs` at the repo root:

```javascript
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/app/mindmap/mindmap-core.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'MindmapCoreBundle',
  outfile: 'demo/mindmap-core.bundle.js',
  target: 'es2020',
});

console.log('Built demo/mindmap-core.bundle.js');
```

Change the repo-root `package.json`'s `"scripts"` block from:

```json
  "scripts": {
    "ng": "ng",
    "start": "ng serve",
    "build": "ng build",
    "watch": "ng build --watch --configuration development",
    "test": "ng test",
    "e2e": "playwright test"
  },
```

to:

```json
  "scripts": {
    "ng": "ng",
    "start": "ng serve",
    "build": "ng build",
    "watch": "ng build --watch --configuration development",
    "test": "ng test",
    "e2e": "playwright test",
    "build:core-bundle": "node esbuild.core.mjs"
  },
```

- [ ] **Step 3: Verify the bundle builds**

Run: `npm run build:core-bundle`
Expected: `Built demo/mindmap-core.bundle.js` printed, and the file exists at `demo/mindmap-core.bundle.js` relative to the repo root.

- [ ] **Step 4: Write the demo page**

Create `demo/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MindmapCore — standalone demo (no Angular)</title>
<style>
  body { margin: 0; background: #181825; color: #cdd6f4; font-family: system-ui, sans-serif; }
  header { position: fixed; top: 0; left: 0; right: 0; padding: 12px 16px; font-size: 13px; z-index: 1; }
  svg { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<header>MindmapCore standalone demo — zero Angular loaded. Drag to pan, scroll to zoom, drag a node, click a node to collapse/expand.</header>
<svg id="mm"></svg>
<script src="mindmap-core.bundle.js"></script>
<script>
  const { MindmapCore } = MindmapCoreBundle;

  const data = {
    entryNodeId: 'root',
    nodes: [
      { id: 'root', label: 'ARC #89621684' },
      { id: 'applicant', label: 'Jane Applicant' },
      { id: 'status', label: 'Approved' },
      { id: 'cite1', label: "CC&R's Paragraph A.7" },
      { id: 'cite2', label: 'PP&G Outbuildings' },
      { id: 'disc1', label: 'Compliance Review' },
    ],
    edges: [
      { source: 'root', target: 'applicant' },
      { source: 'root', target: 'status' },
      { source: 'root', target: 'disc1' },
      { source: 'disc1', target: 'cite1' },
      { source: 'disc1', target: 'cite2' },
    ],
  };

  const svgEl = document.getElementById('mm');
  new MindmapCore(svgEl, data, {
    width: window.innerWidth,
    height: window.innerHeight,
    theme: 'dark',
    layoutMode: 'force',
    ariaLabel: 'Mind map demo',
    getCollapseMode: () => 'global',
    getEdgeDirection: () => undefined,
    getContextMenuFn: () => undefined,
    getNodeClickFn: () => undefined,
    onLiveMessage: (message) => console.log('[live]', message),
  });
</script>
</body>
</html>
```

- [ ] **Step 5: Commit**

```bash
git add esbuild.core.mjs package.json demo/index.html demo/mindmap-core.bundle.js
git commit -m "feat: add standalone MindmapCore bundle build + non-Angular demo"
```

Note: whether `demo/mindmap-core.bundle.js` (a build artifact) should actually be committed, vs. `.gitignore`d and built on demand, is worth a quick judgment call at commit time — check whether this repo's `.gitignore` already excludes `dist/`-style build output and follow that existing convention rather than introducing a new one ad hoc.

---

### Task 3: Manual verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: `npm start` (Angular demo app), `demo/index.html` (standalone bundle demo) — both from Tasks 1-2.
- Produces: nothing — this task confirms the previous two tasks work end-to-end. Requires a browser; do it interactively.

- [ ] **Step 1: Run the Angular demo app and re-verify every existing interaction**

Run (from the repo root): `npm start`, open `http://localhost:4200` (or the port it picks).
Expected: identical behavior to before this refactor — drag nodes, zoom/pan, click a node to collapse/expand, right-click for the context menu, keyboard nav (Tab to a node, arrow keys, Enter/Space, Shift+F10), theme toggle, layout-mode cycle (force → radial → hybrid), tree vs. DAG data-mode toggle. Nothing should look, feel, or behave differently.

- [ ] **Step 2: Open the standalone demo with zero Angular**

Open `demo/index.html` directly in a browser (e.g. `open demo/index.html` on macOS, or serve it with any static file server if the browser blocks `file://` script loading — the bundle is loaded via a relative `<script src="mindmap-core.bundle.js">`, not a CDN URL, so it should load fine either way).
Expected: the sample ARC-request mindmap renders, force-simulates into place, and responds to drag/zoom/click-to-collapse — with no Angular, no Node runtime, present anywhere on the page. This is the actual proof the extraction achieved its purpose.

No commit for this task — it's verification only, not a code change.
