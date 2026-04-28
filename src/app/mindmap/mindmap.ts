import {
  Component,
  ElementRef,
  HostListener,
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

const DIM_OPACITY = 0.15;

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

  @ViewChild('svgContainer', { static: true }) svgRef!: ElementRef<SVGSVGElement>;

  // ── Context menu state ────────────────────────────────────────────────────

  readonly menuOpen = signal(false);
  readonly menuX = signal(0);
  readonly menuY = signal(0);
  readonly menuEntries = signal<MenuEntry[]>([]);

  @HostListener('document:click')
  @HostListener('document:keydown.escape')
  closeMenu(): void {
    this.menuOpen.set(false);
  }

  onMenuItemClick(event: MouseEvent, entry: MenuEntry & { type: 'item' }): void {
    event.stopPropagation();
    if (entry.disabled || entry.children?.length) return;
    entry.action();
    this.menuOpen.set(false);
  }

  // ── D3 internals ─────────────────────────────────────────────────────────

  private svg!: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g!: d3.Selection<SVGGElement, unknown, null, undefined>;
  private simulation!: d3.Simulation<D3Node, D3Link>;
  private rootNode!: D3Node;

  private get tc(): ThemeConfig {
    return THEMES[this.theme];
  }

  private colorScale!: d3.ScaleOrdinal<number, string>;

  constructor(private zone: NgZone) {}

  ngOnInit(): void {
    this.initSvg();
    if (this.data) this.render();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.svg) return;

    if (changes['theme']) {
      this.applyThemeToBackground();
      if (this.rootNode) this.redraw();
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
      .attr('height', this.height);

    this.svg.append('rect')
      .attr('class', 'mm-bg')
      .attr('width', '100%').attr('height', '100%')
      .attr('fill', this.tc.background);

    this.g = this.svg.append('g').attr('class', 'graph');

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .on('zoom', (event) => this.g.attr('transform', event.transform));

    this.svg.call(zoom);
    this.svg.call(zoom.transform, d3.zoomIdentity.translate(this.width / 2, this.height / 2));
  }

  private applyThemeToBackground(): void {
    this.svg.select('rect.mm-bg').attr('fill', this.tc.background);
    this.svg.select('defs').select('#mm-glow').remove();
  }

  // ── Colour scale ───────────────────────────────────────────────────────────

  private buildColorScale(): void {
    this.colorScale = d3.scaleOrdinal<number, string>()
      .domain([0, 1, 2, 3, 4, 5])
      .range(this.tc.nodeColors);
  }

  // ── Data → D3 node tree ────────────────────────────────────────────────────

  private buildTree(raw: MindmapNode, parent: D3Node | null, depth: number): D3Node {
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
    node.children = (raw.children ?? []).map((c) => this.buildTree(c, node, depth + 1));
    return node;
  }

  private flattenVisible(node: D3Node, nodes: D3Node[], links: D3Link[]): void {
    nodes.push(node);
    (node.children ?? []).forEach((c) => {
      links.push({ source: node, target: c });
      this.flattenVisible(c, nodes, links);
    });
  }

  // ── Render / re-render ─────────────────────────────────────────────────────

  private render(): void {
    this.rootNode = this.buildTree(this.data, null, 0);
    this.redraw();
  }

  private redraw(): void {
    this.clearGraph();
    this.buildColorScale();
    const nodes: D3Node[] = [];
    const links: D3Link[] = [];
    this.flattenVisible(this.rootNode, nodes, links);
    this.zone.runOutsideAngular(() => this.startSimulation(nodes, links));
  }

  private clearGraph(): void {
    this.simulation?.stop();
    this.g.selectAll('*').remove();
  }

  private startSimulation(nodes: D3Node[], links: D3Link[]): void {
    this.simulation = d3.forceSimulation<D3Node>(nodes)
      .force('link', d3.forceLink<D3Node, D3Link>(links)
        .id((d) => d.id)
        .distance((d) => 70 + d.target.depth * 12))
      .force('charge', d3.forceManyBody().strength(-350))
      .force('center', d3.forceCenter(0, 0))
      .force('collision', d3.forceCollide<D3Node>((d) => this.nodeRadius(d) + 14))
      .alphaDecay(0.028);

    this.buildGlowFilter();
    this.drawEdges(links);
    this.drawNodes(nodes);
    this.simulation.on('tick', () => this.tick());
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

  private drawEdges(links: D3Link[]): void {
    this.g.append('g').attr('class', 'links')
      .selectAll<SVGLineElement, D3Link>('line')
      .data(links)
      .join('line')
      .attr('stroke', this.tc.edgeStroke)
      .attr('stroke-width', 1.5)
      .attr('stroke-opacity', this.tc.edgeOpacity);
  }

  private drawNodes(nodes: D3Node[]): void {
    const nodeGroup = this.g.append('g').attr('class', 'nodes')
      .selectAll<SVGGElement, D3Node>('g.node')
      .data(nodes, (d) => d.id)
      .join('g')
      .attr('class', 'node')
      .call(this.dragBehavior())
      .on('click', (_event, d) => this.zone.run(() => {
        if (this.nodeClickFn?.(d.sourceNode) === true) return;
        this.toggleCollapse(d);
      }))
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
      .on('mouseover', (_event, d) => {
        this.g.select('.links').selectAll<SVGLineElement, D3Link>('line')
          .transition().duration(150)
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
          .transition().duration(150)
          .attr('stroke-opacity', this.tc.edgeOpacity)
          .attr('stroke-width', 1.5)
          .attr('stroke', this.tc.edgeStroke);
      });
//   .on('mouseenter', (_event, d) => {
//     const allNodes = this.g.select('.nodes').selectAll<SVGGElement, D3Node>('g.node');
//     const allEdges = this.g.select('.links').selectAll<SVGLineElement, D3Link>('line');
//     allNodes.classed('mm-restoring', false)
//       .style('opacity', (n) => (n === d ? '1' : String(DIM_OPACITY)));
//     allEdges.classed('mm-restoring', false)
//       .style('opacity', String(DIM_OPACITY));
//   })
//   .on('mouseleave', () => {
//     const allNodes = this.g.select('.nodes').selectAll<SVGGElement, D3Node>('g.node');
//     const allEdges = this.g.select('.links').selectAll<SVGLineElement, D3Link>('line');
//     allNodes.classed('mm-restoring', true).style('opacity', '1');
//     allEdges.classed('mm-restoring', true).style('opacity', String(this.tc.edgeOpacity));
//   });

    const inner = nodeGroup.append('g').attr('class', 'node-scale');

    inner.append('circle')
      .attr('class', 'halo')
      .attr('r', (d) => this.nodeRadius(d) + 5)
      .attr('fill', 'none')
      .attr('stroke', (d) => this.colorScale(d.depth))
      .attr('stroke-opacity', this.tc.haloOpacity)
      .attr('stroke-width', 7)
      .attr('filter', 'url(#mm-glow)');

    inner.append('circle')
      .attr('class', 'body')
      .attr('r', (d) => this.nodeRadius(d))
      .attr('fill', (d) => this.colorScale(d.depth))
      .attr('fill-opacity', this.theme === 'light' ? 1 : 0.92)
      .attr('stroke', (d) => (d3.color(this.colorScale(d.depth)) as d3.RGBColor).brighter(this.theme === 'light' ? 0.4 : 0.6).formatHex())
      .attr('stroke-width', 1.5)
      .attr('cursor', 'pointer');

    inner.append('text')
      .text((d) => d.label)
      .attr('dy', (d) => this.nodeRadius(d) + 13)
      .attr('text-anchor', 'middle')
      .attr('fill', this.tc.labelFill)
      .attr('font-size', (d) => (d.depth === 0 ? 13 : 11))
      .attr('font-weight', (d) => (d.depth === 0 ? '600' : '400'))
      .attr('font-family', '"Inter", "Public Sans", "Segoe UI", system-ui, sans-serif')
      .attr('pointer-events', 'none');

    inner.append('circle')
      .attr('class', 'badge')
      .attr('r', 4)
      .attr('cx', (d) => this.nodeRadius(d))
      .attr('cy', (d) => -this.nodeRadius(d))
      .attr('fill', this.tc.badgeFill)
      .attr('pointer-events', 'none')
      .attr('opacity', 0);
  }

  private nodeRadius(d: D3Node): number {
    return d.depth === 0 ? 18 : d.depth === 1 ? 12 : 8;
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

    if (hasVisible) {
      d._children = d.children;
      d.children = [];
      d.collapsed = true;
    } else {
      d.children = d._children;
      d._children = null;
      d.collapsed = false;
    }

    this.redraw();
    requestAnimationFrame(() => this.updateBadges());
  }

  private updateBadges(): void {
    this.g.select('.nodes').selectAll<SVGCircleElement, D3Node>('circle.badge')
      .attr('opacity', (d) => (d._children && d._children.length ? 1 : 0));
  }

  // ── Drag ───────────────────────────────────────────────────────────────────

  private dragBehavior(): d3.DragBehavior<SVGGElement, D3Node, D3Node | d3.SubjectPosition> {
    return d3.drag<SVGGElement, D3Node>()
      .on('start', (event, d) => {
        if (!event.active) this.simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) this.simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
  }
}
