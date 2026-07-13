import {
  Component,
  DestroyRef,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges,
  ViewChild,
  ChangeDetectionStrategy,
  NgZone,
  signal,
} from '@angular/core';
import * as d3 from 'd3';
import { MindmapNode, D3Node, D3Link, MenuEntry, ContextMenuFn, NodeClickFn } from './mindmap.model';

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

/** Node radius in px, indexed by depth; last entry repeats for any deeper level. */
const NODE_RADII = [18, 12, 8];

/** Minimum pointer travel (px) before a drag suppresses the following click, so a small drag doesn't also toggle collapse. */
const DRAG_CLICK_DISTANCE = 4;

/** Duration (ms) of the edge highlight transition on node hover/unhover. */
const HOVER_TRANSITION_MS = 150;

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
  templateUrl: './mindmap.html',
  styleUrl: './mindmap.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[attr.data-theme]': 'theme',
  },
})
export class MindmapComponent implements OnInit, OnChanges, OnDestroy {
  @Input() data!: MindmapNode;
  @Input() width = 900;
  @Input() height = 650;
  @Input() theme: MindmapTheme = 'dark';
  @Input() contextMenuFn?: ContextMenuFn;
  @Input() nodeClickFn?: NodeClickFn;
  @Input() ariaLabel = 'Mind map';
  @Input() layoutMode: MindmapLayout = 'force';

  @ViewChild('svgContainer', { static: true }) svgRef!: ElementRef<SVGSVGElement>;

  // ── Context menu state ────────────────────────────────────────────────────

  readonly menuOpen = signal(false);
  readonly menuX = signal(0);
  readonly menuY = signal(0);
  readonly menuEntries = signal<MenuEntry[]>([]);
  private menuOpenerNodeId: string | null = null;
  readonly menuFocusIndex = signal(0);
  readonly submenuOpenIndex = signal<number | null>(null);

  @ViewChild('menuRoot') menuRootRef?: ElementRef<HTMLDivElement>;

  // Attached outside the Angular zone (see constructor) so a click/keydown anywhere in the
  // document doesn't schedule change detection unless the menu is actually open.
  private readonly onDocumentClick = (): void => {
    if (this.menuOpen()) this.zone.run(() => this.menuOpen.set(false));
  };

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

  onMenuItemClick(event: MouseEvent, entry: MenuEntry & { type: 'item' }): void {
    event.stopPropagation();
    if (entry.disabled || entry.children?.length) return;
    entry.action();
    this.menuOpen.set(false);
  }

  isMenuItemActive(index: number, isSubmenu: boolean, parentIndex?: number): boolean {
    if (isSubmenu) {
      return this.submenuOpenIndex() === parentIndex && this.menuFocusIndex() === index;
    }
    return this.submenuOpenIndex() === null && this.menuFocusIndex() === index;
  }

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

  private focusActiveMenuItem(): void {
    // setTimeout (a macrotask), not queueMicrotask: Angular's zone-triggered change detection
    // runs on the microtask queue, so a microtask here can race ahead of the DOM update that
    // creates/moves the tabindex="0" item. A macrotask is guaranteed to run after CD settles.
    setTimeout(() => {
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

  // ── D3 internals ─────────────────────────────────────────────────────────

  private svg!: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g!: d3.Selection<SVGGElement, unknown, null, undefined>;
  private zoomBehavior!: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private simulation!: d3.Simulation<D3Node, D3Link>;
  private rootNode!: D3Node;

  private get tc(): ThemeConfig {
    return THEMES[this.theme];
  }

  private colorScale!: d3.ScaleOrdinal<number, string>;
  private strokeColorByDepth: string[] = [];
  private visibleNodes: D3Node[] = [];
  private focusedNodeId: string | null = null;

  constructor(private zone: NgZone, private destroyRef: DestroyRef) {
    this.zone.runOutsideAngular(() => {
      document.addEventListener('click', this.onDocumentClick);
      document.addEventListener('keydown', this.onDocumentKeydown);
    });
    this.destroyRef.onDestroy(() => {
      document.removeEventListener('click', this.onDocumentClick);
      document.removeEventListener('keydown', this.onDocumentKeydown);
    });
  }

  ngOnInit(): void {
    this.initSvg();
    if (this.data) this.render();
  }

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

  ngOnDestroy(): void {
    this.simulation?.stop();
  }

  // ── SVG bootstrap ──────────────────────────────────────────────────────────

  private initSvg(): void {
    this.svg = d3.select(this.svgRef.nativeElement)
      .attr('width', this.width)
      .attr('height', this.height)
      .attr('role', 'tree')
      .attr('aria-label', this.ariaLabel);

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

    // Attached outside the Angular zone so every wheel/pan tick doesn't schedule
    // a full app-wide change-detection pass — see the constructor for the same pattern.
    this.zone.runOutsideAngular(() => {
      this.svg.call(this.zoomBehavior);
      this.svg.call(this.zoomBehavior.transform, d3.zoomIdentity.translate(this.width / 2, this.height / 2));
    });
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
      .call(this.zoomBehavior.transform, d3.zoomIdentity.translate(this.width / 2, this.height / 2));
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

  /**
   * Calls zoomToFit() once the current layout has actually settled, rather than
   * immediately (which would measure a stale/mid-flight bounding box): waits for the
   * simulation's 'end' event in force/hybrid mode, or for the position transition's
   * duration to elapse in radial mode (which runs no simulation at all).
   */
  private zoomToFitAfterSettle(): void {
    if (this.layoutMode === 'radial') {
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

  private strokeColorFor(d: D3Node): string {
    return this.strokeColorByDepth[d.depth % this.strokeColorByDepth.length];
  }

  // ── Data → D3 node tree ────────────────────────────────────────────────────

  /**
   * `ancestors` tracks only the current root-to-node path (added on entry, removed on
   * exit), not every node ever visited — so a MindmapNode legitimately reused across two
   * sibling branches isn't flagged, only a node that is its own ancestor (a real cycle,
   * which would otherwise recurse forever and stack-overflow instead of failing clearly).
   */
  private buildTree(raw: MindmapNode, parent: D3Node | null, depth: number, ancestors = new Set<MindmapNode>()): D3Node {
    if (ancestors.has(raw)) {
      throw new Error(`mindmap: cyclic MindmapNode graph detected at id "${raw.id}" — buildTree() requires a tree, not a graph`);
    }
    ancestors.add(raw);

    const node: D3Node = {
      id: raw.id,
      label: raw.label,
      depth,
      collapsed: false,
      _children: null,
      children: null,
      parent,
      sourceNode: raw,
      x: (Math.random() - 0.5) * 60,
      y: (Math.random() - 0.5) * 60,
    };
    node.children = (raw.children ?? []).map((c) => this.buildTree(c, node, depth + 1, ancestors));

    ancestors.delete(raw);
    return node;
  }

  private flattenVisible(node: D3Node, nodes: D3Node[], links: D3Link[]): void {
    nodes.push(node);
    (node.children ?? []).forEach((c) => {
      links.push({ source: node, target: c });
      this.flattenVisible(c, nodes, links);
    });
  }

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

  private applyTabindex(selection: d3.Selection<SVGGElement, D3Node, SVGGElement, unknown>): void {
    selection.attr('tabindex', (d) => (d.id === this.focusedNodeId ? 0 : -1));
  }

  private moveFocusTo(d: D3Node): void {
    this.focusedNodeId = d.id;
    const nodeSelection = this.g.select<SVGGElement>('.nodes').selectAll<SVGGElement, D3Node>('g.node');
    this.applyTabindex(nodeSelection);
    nodeSelection.filter((n) => n.id === d.id).node()?.focus();
  }

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

  // ── Render / re-render ─────────────────────────────────────────────────────

  private render(): void {
    this.rootNode = this.buildTree(this.data, null, 0);
    this.focusedNodeId = this.rootNode.id;
    this.redraw();
  }

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

    const duration = this.prefersReducedMotion() ? 0 : RADIAL_TRANSITION_MS;

    this.g.select<SVGGElement>('.nodes').selectAll<SVGGElement, D3Node>('g.node')
      .transition().duration(duration)
      .attr('transform', (d) => `translate(${d.x},${d.y})`);

    this.g.select<SVGGElement>('.links').selectAll<SVGLineElement, D3Link>('line')
      .transition().duration(duration)
      .attr('x1', (d) => d.source.x!)
      .attr('y1', (d) => d.source.y!)
      .attr('x2', (d) => d.target.x!)
      .attr('y2', (d) => d.target.y!);
  }

  // ── Glow SVG filter ────────────────────────────────────────────────────────

  private buildGlowFilter(): void {
    const defs = this.svg.select<SVGDefsElement>('defs').empty()
      ? this.svg.insert('defs', ':first-child')
      : this.svg.select<SVGDefsElement>('defs');

    if (!defs.select('#mm-glow').empty()) return;

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

  // ── Drawing ────────────────────────────────────────────────────────────────

  private updateEdges(links: D3Link[]): void {
    this.g.select<SVGGElement>('.links')
      .selectAll<SVGLineElement, D3Link>('line')
      .data(links, (d) => `${d.source.id}→${d.target.id}`)
      .join('line')
      .attr('stroke', this.tc.edgeStroke)
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', this.tc.edgeOpacity);
  }

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
    this.applyNodeAria(merged);
    this.applyTabindex(merged);
  }

  private openContextMenu(d: D3Node, x: number, y: number): void {
    if (!this.contextMenuFn) return;
    this.contextMenuFn(d.sourceNode)
      .then((entries) => {
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
      })
      .catch((err) => console.error('mindmap: contextMenuFn rejected, menu not opened', err));
  }

  private openContextMenuForNode(d: D3Node): void {
    const el = this.g.select<SVGGElement>('.nodes').selectAll<SVGGElement, D3Node>('g.node')
      .filter((n) => n.id === d.id).node();
    const rect = el?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : 0;
    const y = rect ? rect.top + rect.height / 2 : 0;
    this.openContextMenu(d, x, y);
  }

  /** Structural setup for newly-entering nodes only: DOM shape + interaction handlers. */
  private enterNodes(
    enter: d3.Selection<d3.EnterElement, D3Node, SVGGElement, unknown>,
  ): d3.Selection<SVGGElement, D3Node, SVGGElement, unknown> {
    const nodeGroup = enter.append('g')
      .attr('class', 'node')
      .call(this.dragBehavior())
      .on('click', (_event, d) => this.zone.run(() => {
        if (this.nodeClickFn?.(d.sourceNode) === true) return;
        this.toggleCollapse(d);
      }))
      .on('contextmenu', (event: MouseEvent, d: D3Node) => {
        event.preventDefault();
        event.stopPropagation();
        this.openContextMenu(d, event.clientX, event.clientY);
      })
      .on('mouseover', (_event, d) => {
        this.g.select('.links').selectAll<SVGLineElement, D3Link>('line')
          .transition().duration(HOVER_TRANSITION_MS)
          .attr('stroke-opacity', (link) =>
            link.source.id === d.id || link.target.id === d.id ? 1 : 0.15)
          .attr('stroke-width', (link) =>
            link.source.id === d.id || link.target.id === d.id ? 2 : 1.5)
          .attr('stroke', (link) =>
            link.source.id === d.id || link.target.id === d.id
              ? this.colorScale(d.depth)
              : this.tc.edgeStroke);
      })
      .on('mouseout', () => {
        this.g.select('.links').selectAll<SVGLineElement, D3Link>('line')
          .transition().duration(HOVER_TRANSITION_MS)
          .attr('stroke-opacity', this.tc.edgeOpacity)
          .attr('stroke-width', 1.5)
          .attr('stroke', this.tc.edgeStroke);
      })
      .on('keydown', (event: KeyboardEvent, d: D3Node) => this.zone.run(() => this.onNodeKeydown(event, d)));

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
  private applyNodeTheme(selection: d3.Selection<SVGGElement, D3Node, SVGGElement, unknown>): void {
    selection.select<SVGCircleElement>('circle.halo')
      .attr('r', (d) => this.nodeRadius(d) + 5)
      .attr('fill', 'none')
      .attr('stroke', (d) => this.colorScale(d.depth))
      .attr('stroke-opacity', this.tc.haloOpacity)
      .attr('stroke-width', 7);

    selection.select<SVGCircleElement>('circle.body')
      .attr('r', (d) => this.nodeRadius(d))
      .attr('fill', (d) => this.colorScale(d.depth))
      .attr('fill-opacity', this.theme === 'light' ? 1 : 0.92)
      .attr('stroke', (d) => this.strokeColorFor(d))
      .attr('stroke-width', 1.5);

    selection.select<SVGTextElement>('text')
      .text((d) => d.label)
      .attr('dy', (d) => this.nodeRadius(d) + 13)
      .attr('fill', this.tc.labelFill)
      .attr('font-size', (d) => (d.depth === 0 ? 13 : 11))
      .attr('font-weight', (d) => (d.depth === 0 ? '600' : '400'));

    selection.select<SVGCircleElement>('circle.badge')
      .attr('cx', (d) => this.nodeRadius(d))
      .attr('cy', (d) => -this.nodeRadius(d))
      .attr('fill', this.tc.badgeFill)
      .attr('opacity', (d) => (d._children && d._children.length ? 1 : 0));
  }

  /** ARIA treeitem semantics — role/level/expanded/setsize/posinset. Flat DOM (see design doc). */
  private applyNodeAria(selection: d3.Selection<SVGGElement, D3Node, SVGGElement, unknown>): void {
    selection
      .attr('role', 'treeitem')
      .attr('aria-label', (d) => d.label)
      .attr('aria-level', (d) => d.depth + 1)
      .attr('aria-setsize', (d) => (d.parent ? (d.parent.children?.length ?? 1) : 1))
      .attr('aria-posinset', (d) => (d.parent ? (d.parent.children?.indexOf(d) ?? 0) + 1 : 1))
      .attr('aria-expanded', (d) => {
        const hasChildren = !!(d.children?.length || d._children?.length);
        return hasChildren ? String(!!d.children?.length) : null;
      });
  }

  private nodeRadius(d: D3Node): number {
    return NODE_RADII[Math.min(d.depth, NODE_RADII.length - 1)];
  }

  // ── Tick ───────────────────────────────────────────────────────────────────

  private tick(): void {
    this.g.select('.links').selectAll<SVGLineElement, D3Link>('line')
      .attr('x1', (d) => d.source.x!)
      .attr('y1', (d) => d.source.y!)
      .attr('x2', (d) => d.target.x!)
      .attr('y2', (d) => d.target.y!);

    this.g.select('.nodes').selectAll<SVGGElement, D3Node>('g.node')
      .attr('transform', (d) => `translate(${d.x},${d.y})`);
  }

  // ── Collapse / expand ──────────────────────────────────────────────────────

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

  // ── Drag ───────────────────────────────────────────────────────────────────

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
}
