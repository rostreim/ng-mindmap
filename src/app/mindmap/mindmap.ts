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
import * as d3 from 'd3';
import { MindmapGraph, D3GraphNode, D3GraphEdge, MenuEntry, ContextMenuFn, NodeClickFn } from './mindmap.model';
import { buildGraph, classifyShape, computeRadialPositions, computeVisibleGraph, cycleOutgoingEdge, nodeRadius, resolveEntryNode } from './mindmap-layout';
import { ContextMenuCloseReason, ContextMenuComponent } from './context-menu';

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
/** alpha kick used to reheat the simulation after a redraw (collapse/expand, data swap) */
const REDRAW_ALPHA = 0.3;

const ZOOM_SCALE_EXTENT: [number, number] = [0.1, 5];

/** Minimum pointer travel (px) before a drag suppresses the following click, so a small drag doesn't also toggle collapse. */
const DRAG_CLICK_DISTANCE = 4;

/** Duration (ms) of the edge highlight transition on node hover/unhover. */
const HOVER_TRANSITION_MS = 150;

/** Empty margin (px) kept around the graph's bounding box by zoomToFit(). */
const FIT_PADDING = 60;
const FIT_TRANSITION_MS = 400;

/** Duration (ms) of the position transition when 'radial' mode redraws (no simulation to smooth it otherwise). */
const RADIAL_TRANSITION_MS = 400;
/** Pull strength (0-1) of 'hybrid' mode's forceX/forceY toward each node's computed radial target. */
const HYBRID_POSITION_STRENGTH = 0.3;
/** Alpha kick used to (re)settle 'hybrid' mode after a redraw. */
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

  // ── Context menu state ────────────────────────────────────────────────────
  // Rendering/keyboard-nav/focus-management for the menu itself lives in
  // ContextMenuComponent; MindmapComponent only owns what's specific to the
  // graph: fetching entries via contextMenuFn(), positioning, and refocusing
  // the SVG node that opened the menu once it closes.

  readonly menuOpen = signal(false);
  readonly menuX = signal(0);
  readonly menuY = signal(0);
  readonly menuEntries = signal<MenuEntry[]>([]);
  private menuOpenerNodeId: string | null = null;

  /**
   * Bound to an aria-live region in the template. Announces expand/collapse
   * (toggleCollapse()) and node activation — when nodeClickFn() intercepts a
   * click/Enter/Space and suppresses the default toggle, e.g. a consumer treating a
   * leaf click as "select this node" — to screen readers.
   */
  readonly liveMessage = signal('');

  onContextMenuClosed(reason: ContextMenuCloseReason): void {
    this.menuOpen.set(false);
    if (reason === 'escape') {
      const opener = this.menuOpenerNodeId
        ? this.visibleNodes.find((n) => n.id === this.menuOpenerNodeId)
        : null;
      if (opener) this.moveFocusTo(opener);
    }
    this.menuOpenerNodeId = null;
  }

  // ── D3 internals ─────────────────────────────────────────────────────────

  private svg!: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g!: d3.Selection<SVGGElement, unknown, null, undefined>;
  private zoomBehavior!: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private simulation: d3.Simulation<D3GraphNode, D3GraphEdge> | undefined;
  private allNodes: D3GraphNode[] = [];
  private allEdges: D3GraphEdge[] = [];
  private shape: 'tree' | 'graph' = 'tree';
  private entryNode: D3GraphNode | null = null;
  /** The tree's actual structural root (zero-indegree node) — drives radial layout + depth origin, decoupled from entryNode (focus/camera). Null for graph-shaped or empty data. */
  private structuralRoot: D3GraphNode | null = null;

  private get tc(): ThemeConfig {
    return THEMES[this.theme()];
  }

  private colorScale!: d3.ScaleOrdinal<number, string>;
  private strokeColorByDepth: string[] = [];
  private visibleNodes: D3GraphNode[] = [];
  private focusedNodeId: string | null = null;
  /** Graph-mode only: "currently selected outgoing edge" cursor per node, for ArrowUp/Down. Reset on data change. */
  private outgoingCursor = new Map<string, number>();
  /** Graph-mode only: which node ArrowRight was pressed from to reach this node, for ArrowLeft. Reset on data change. */
  private arrivedVia = new Map<string, string>();

  /** Rebuilt once per updateEdges() call so node hover only touches its own incident links, not every link in the graph. */
  private linksByNode = new Map<string, D3GraphEdge[]>();

  constructor() {
    // Each effect's first run happens once ngOnInit's own initSvg()/render() have already
    // set up the initial state, so it's skipped here — mirrors the old ngOnChanges'
    // `!changes[...].firstChange` checks, just per-input instead of via a single dispatcher.
    let widthHeightFirstRun = true;
    effect(() => {
      const width = this.width();
      const height = this.height();
      if (widthHeightFirstRun) { widthHeightFirstRun = false; return; }
      this.svg.attr('width', width).attr('height', height);
    });

    let themeFirstRun = true;
    effect(() => {
      this.theme();
      if (themeFirstRun) { themeFirstRun = false; return; }
      this.applyThemeToBackground();
      if (this.allNodes.length) this.redraw();
    });

    let layoutModeFirstRun = true;
    effect(() => {
      this.layoutMode();
      if (layoutModeFirstRun) { layoutModeFirstRun = false; return; }
      if (this.allNodes.length) {
        this.redraw();
        this.zoomToFitAfterSettle();
      }
    });

    let dataFirstRun = true;
    effect(() => {
      this.data();
      if (dataFirstRun) { dataFirstRun = false; return; }
      this.render();
    });
  }

  ngOnInit(): void {
    this.initSvg();
    this.render();
  }

  ngOnDestroy(): void {
    this.simulation?.stop();
  }

  // ── SVG bootstrap ──────────────────────────────────────────────────────────

  private initSvg(): void {
    this.svg = d3.select(this.svgRef.nativeElement)
      .attr('width', this.width())
      .attr('height', this.height())
      .attr('aria-label', this.ariaLabel());

    this.svg.append('rect')
      .attr('class', 'mm-bg')
      .attr('width', '100%').attr('height', '100%')
      .attr('fill', this.tc.background);

    this.g = this.svg.append('g').attr('class', 'graph');
    // Links group must precede nodes group in the DOM so edges paint underneath nodes.
    this.g.append('g').attr('class', 'links');
    this.g.append('g').attr('class', 'nodes');

    this.zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent(ZOOM_SCALE_EXTENT)
      .on('zoom', (event) => this.g.attr('transform', event.transform));

    this.svg.call(this.zoomBehavior);
    this.svg.call(this.zoomBehavior.transform, d3.zoomIdentity.translate(this.width() / 2, this.height() / 2));
  }

  private applyThemeToBackground(): void {
    this.svg.select('rect.mm-bg').attr('fill', this.tc.background);
    this.svg.select('defs').select('#mm-glow').remove();
  }

  /**
   * These D3-driven transitions move the viewport/graph itself (pan, zoom, layout-switch
   * repositioning) rather than fading a color/opacity, so — unlike the CSS transitions in
   * mindmap.scss, which already key off the same media query — they're gated here too.
   */
  private prefersReducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // ── View controls ────────────────────────────────────────────────────────

  /** Re-centers the graph at scale 1, undoing any pan/zoom. */
  resetView(): void {
    if (!this.svg) return;
    this.svg.transition().duration(this.prefersReducedMotion() ? 0 : FIT_TRANSITION_MS)
      .call(this.zoomBehavior.transform, d3.zoomIdentity.translate(this.width() / 2, this.height() / 2));
  }

  /** Pans/scales so every visible node fits in the viewport, within the configured zoom bounds. */
  zoomToFit(): void {
    if (!this.svg || !this.g.node()) return;
    const bounds = this.g.node()!.getBBox();
    if (bounds.width === 0 || bounds.height === 0) return;

    const scale = Math.min(
      ZOOM_SCALE_EXTENT[1],
      Math.max(
        ZOOM_SCALE_EXTENT[0],
        Math.min(
          (this.width() - FIT_PADDING * 2) / bounds.width,
          (this.height() - FIT_PADDING * 2) / bounds.height,
        ),
      ),
    );
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;

    const transform = d3.zoomIdentity
      .translate(this.width() / 2, this.height() / 2)
      .scale(scale)
      .translate(-cx, -cy);

    this.svg.transition().duration(this.prefersReducedMotion() ? 0 : FIT_TRANSITION_MS)
      .call(this.zoomBehavior.transform, transform);
  }

  /**
   * Calls zoomToFit() once the current layout has actually settled, rather than
   * immediately (which would measure a stale/mid-flight bounding box): waits for the
   * simulation's 'end' event in force/hybrid mode, or for the position transition's
   * duration to elapse in radial mode (which runs no simulation at all).
   */
  private zoomToFitAfterSettle(): void {
    // this.simulation, not layoutMode(): graph-shaped/rootless data falls back to 'force' in
    // redraw() (called just before this, in the same effect) even while the layoutMode() input
    // still says 'radial' — and that fallback does leave a real simulation to wait on, which
    // this.simulation's presence reflects directly (syncRadialLayout() nulls it; the other two
    // sync methods always leave it set).
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

    const brighterBy = this.theme() === 'light' ? 0.4 : 0.6;
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

  /** Ported unchanged from the old tree-only implementation — visibleNodes is already in DFS order for tree-shaped data, since computeVisibleGraph()'s walk is a DFS from the single root. */
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
        if (this.nodeClickFn()?.(d.sourceNode) === true) {
          this.liveMessage.set(`${d.label} activated`);
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

  /** New graph-mode scheme: Up/Down cycle an outgoing-edge cursor (no focus move); Right commits to it; Left retraces via arrivedVia. */
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
        if (this.nodeClickFn()?.(d.sourceNode) === true) {
          this.liveMessage.set(`${d.label} activated`);
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

  /** Visual affordance for the graph-mode outgoing-edge keyboard cursor — reuses the hover incident-edge styling. */
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
    return this.edgeDirection() ?? (this.shape === 'graph' ? 'arrow' : 'plain');
  }

  private render(): void {
    const previousById = new Map(this.allNodes.map((n) => [n.id, n]));
    const built = buildGraph(this.data(), previousById);
    this.allNodes = built.nodes;
    this.allEdges = built.edges;
    this.shape = classifyShape(this.allNodes, this.allEdges);
    if (this.shape === 'tree') {
      const hasIncoming = new Set(this.allEdges.map((e) => e.target.id));
      this.structuralRoot = this.allNodes.find((n) => !hasIncoming.has(n.id)) ?? null;
    } else {
      this.structuralRoot = null;
    }
    this.entryNode = resolveEntryNode(this.allNodes, this.allEdges, this.data().entryNodeId);
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
    const { visibleNodes, visibleEdges } = computeVisibleGraph(this.allNodes, this.allEdges, this.collapseMode());
    this.visibleNodes = visibleNodes;

    let effectiveLayoutMode = this.layoutMode();
    if (effectiveLayoutMode !== 'force' && this.shape === 'graph') {
      console.warn(`mindmap: layoutMode "${effectiveLayoutMode}" requires tree-shaped data but the current data is graph-shaped — falling back to "force"`);
      effectiveLayoutMode = 'force';
    } else if (effectiveLayoutMode !== 'force' && this.structuralRoot === null) {
      // Empty graph (or no discoverable structural root) — nothing for computeRadialPositions()
      // to walk, so fall back to the force path, which safely no-ops on empty arrays and still
      // clears any stale DOM via updateEdges([])/updateNodes([]).
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

  /**
   * Patches the DOM and simulation to match `nodes`/`links` via D3 join() instead of
   * tearing down and re-appending everything, so unaffected nodes keep their element
   * identity (and any in-flight CSS transition) across a collapse/expand or data swap.
   * The simulation is reheated in place rather than recreated, preserving velocity.
   */
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

  /**
   * Uses the same computeRadialPositions() targets as 'radial' mode, but as a starting
   * point for a weak, collision-only simulation instead of a final position — giving a
   * soft settle-in that resolves accidental overlaps without any link/charge-driven
   * structure. Reuses the same alpha-reheat-on-redraw mechanism as force mode.
   */
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

  /**
   * No simulation at all: sets each visible node's final x/y directly from its
   * computeRadialPositions() target, then animates the DOM to it with a D3 transition
   * (there's no running simulation to smooth a position jump otherwise, e.g. after a
   * collapse/expand that shifts other nodes' angles).
   */
  private syncRadialLayout(nodes: D3GraphNode[], links: D3GraphEdge[]): void {
    // Nulled, not just stopped: this.simulation's presence is how dragBehavior() and
    // zoomToFitAfterSettle() tell whether a force/hybrid simulation is actually active,
    // without needing to separately track/consult the effective layout mode themselves.
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
    const contextMenuFn = this.contextMenuFn();
    if (!contextMenuFn) return;
    contextMenuFn(d.sourceNode)
      .then((entries) => {
        this.menuEntries.set(entries);
        this.menuX.set(x);
        this.menuY.set(y);
        this.menuOpenerNodeId = d.id;
        this.menuOpen.set(true);
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

  /** Structural setup for newly-entering nodes only: DOM shape + interaction handlers. */
  private enterNodes(
    enter: d3.Selection<d3.EnterElement, D3GraphNode, SVGGElement, unknown>,
  ): d3.Selection<SVGGElement, D3GraphNode, SVGGElement, unknown> {
    const nodeGroup = enter.append('g')
      .attr('class', 'node')
      .call(this.dragBehavior())
      .on('click', (event: MouseEvent, d) => {
        // WebKit dispatches a synthetic `click` (button 0, ctrlKey true) alongside `contextmenu`
        // for a trackpad/Ctrl+click secondary click — Chromium dispatches only `contextmenu`.
        // Ignoring ctrlKey here mirrors dragBehavior()'s own filter, which excludes it for the
        // same reason ("should open the context menu").
        if (event.ctrlKey) return;
        if (this.nodeClickFn()?.(d.sourceNode) === true) {
          this.liveMessage.set(`${d.label} activated`);
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
        // linksByNode.get(d.id) returns object references from the same links array
        // bound to these DOM elements this redraw, so reference identity via Set.has()
        // works directly — no need to re-derive a string key per link per attr call.
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

  /** Depth/theme/collapse-state-dependent attrs, reapplied to entered + existing nodes alike. */
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
      .attr('fill-opacity', this.theme() === 'light' ? 1 : 0.92)
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

  /** ARIA semantics — treeitem (tree-shaped) or button (graph-shaped). Flat DOM (see design doc). */
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

  /** For 'arrow' mode, pulls the line's endpoint back along the source→target vector by the target's radius, so the arrowhead marker lands on the node's boundary instead of inside it. No-op for 'plain' mode. */
  private shortenedEndpoint(d: D3GraphEdge, direction: 'arrow' | 'plain'): { x: number; y: number } {
    if (direction === 'plain') return { x: d.target.x!, y: d.target.y! };

    const dx = d.target.x! - d.source.x!;
    const dy = d.target.y! - d.source.y!;
    const len = Math.hypot(dx, dy);
    if (len === 0) return { x: d.target.x!, y: d.target.y! }; // buildGraph() already rejects true self-loops; this guards a coincident-position edge case during simulation settle

    const radius = nodeRadius(d.target);
    const ratio = (len - radius) / len;
    return { x: d.source.x! + dx * ratio, y: d.source.y! + dy * ratio };
  }

  // ── Collapse / expand ──────────────────────────────────────────────────────

  private toggleCollapse(d: D3GraphNode): void {
    const hasOutgoing = this.allEdges.some((e) => e.source.id === d.id);
    if (!hasOutgoing) return;

    d.collapsed = !d.collapsed;
    this.liveMessage.set(`${d.label} ${d.collapsed ? 'collapsed' : 'expanded'}`);
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
        // this.simulation is undefined in radial mode (syncRadialLayout() nulls it, not just
        // .stop()s it) — so this is a safe no-op there, without needing to separately check
        // layoutMode(): restarting a stale force/hybrid simulation would otherwise drift nodes
        // away from their deterministic radial positions after the drag ends.
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
