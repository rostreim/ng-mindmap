import * as d3 from 'd3';
import { MindmapCore, MindmapCoreOptions } from './mindmap-core';
import {
  D3GraphEdge,
  D3GraphNode,
  MindmapGraph,
  MindmapGraphNode,
  NodeColorFn,
  NodeEmphasisFn,
} from './mindmap.model';

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

  describe('depth computation (per connected component)', () => {
    it('computes tree depth as before for single-root data', () => {
      core = createDetachedCore(sampleGraph);
      vi.spyOn(core as any, 'redraw').mockImplementation(() => {});

      (core as any).render();

      const byId = new Map((core as any).allNodes.map((n: D3GraphNode) => [n.id, n.depth]));
      expect(byId.get('root')).toBe(0);
      expect(byId.get('a')).toBe(1);
      expect(byId.get('b')).toBe(1);
      expect(byId.get('a1')).toBe(2);
      expect(byId.get('a2')).toBe(2);
    });

    it('computes depth per-component for a forest of disconnected trees', () => {
      const forest: MindmapGraph = {
        nodes: [
          { id: 's1', label: 'Street 1' },
          { id: 's1-r1', label: 'Req 1' },
          { id: 's2', label: 'Street 2' },
          { id: 's2-r1', label: 'Req 1' },
          { id: 's2-r2', label: 'Req 2' },
        ],
        edges: [
          { source: 's1', target: 's1-r1' },
          { source: 's2', target: 's2-r1' },
          { source: 's2', target: 's2-r2' },
        ],
      };
      core = createDetachedCore(forest);
      vi.spyOn(core as any, 'redraw').mockImplementation(() => {});

      (core as any).render();

      const byId = new Map((core as any).allNodes.map((n: D3GraphNode) => [n.id, n.depth]));
      expect(byId.get('s1')).toBe(0);
      expect(byId.get('s1-r1')).toBe(1);
      expect(byId.get('s2')).toBe(0);
      expect(byId.get('s2-r1')).toBe(1);
      expect(byId.get('s2-r2')).toBe(1);
    });

    it('leaves depth undefined for a node unreachable from any root (a pure cycle)', () => {
      const cyclic: MindmapGraph = {
        nodes: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }],
        edges: [
          { source: 'x', target: 'y' },
          { source: 'y', target: 'x' },
        ],
      };
      core = createDetachedCore(cyclic);
      vi.spyOn(core as any, 'redraw').mockImplementation(() => {});

      (core as any).render();

      const byId = new Map((core as any).allNodes.map((n: D3GraphNode) => [n.id, n.depth]));
      expect(byId.get('x')).toBeUndefined();
      expect(byId.get('y')).toBeUndefined();
    });
  });

  describe('detail-glyph rendering', () => {
    function glyphText(id: string): string {
      return (core as any).g.select('.nodes').selectAll('g.node')
        .filter((d: D3GraphNode) => d.id === id)
        .select('text.detail-glyph')
        .text();
    }

    it('renders the glyph character only for nodes where getNodeHasDetailFn returns true', () => {
      core = createDetachedCore(sampleGraph, {
        getNodeHasDetailFn: () => (node) => node.id === 'a1',
      });

      (core as any).render();

      expect(glyphText('a1')).toBe('ⓘ');
      expect(glyphText('a2')).toBe('');
      expect(glyphText('root')).toBe('');
    });

    it('leaves the glyph text empty on every node when getNodeHasDetailFn is omitted', () => {
      core = createDetachedCore(sampleGraph);

      expect(() => (core as any).render()).not.toThrow();

      expect(glyphText('a1')).toBe('');
    });

    it('suppresses the glyph on a node with children even if getNodeHasDetailFn returns true for it', () => {
      // 'a' has children (a1, a2) -- circle.badge owns this corner for 'a', regardless of
      // what a (careless or buggy) getNodeHasDetailFn implementation returns for it.
      core = createDetachedCore(sampleGraph, {
        getNodeHasDetailFn: () => () => true,
      });

      (core as any).render();

      expect(glyphText('a')).toBe('');
      expect(glyphText('a1')).toBe('ⓘ');
    });
  });

  describe('semantic node colors', () => {
    it('uses a valid callback color for body, halo, and outline', () => {
      const graph: MindmapGraph = {
        nodes: [{ id: 'root', label: 'Root', metadata: { kind: 'arc_request' } }],
        edges: [],
      };
      core = createDetachedCore(graph, {
        getNodeColorFn: () => (node) =>
          node.metadata?.['kind'] === 'arc_request' ? '#E46632' : undefined,
      });

      (core as any).render();

      const node = (core as any).g.select('g.node');
      expect(node.select('circle.body').attr('fill')).toBe('#e46632');
      expect(node.select('circle.halo').attr('stroke')).toBe('#e46632');
      expect(node.select('circle.body').attr('stroke')).toBe('#ff7e3e');
    });

    const fallbackCallbacks: [string, NodeColorFn | undefined][] = [
      ['missing', undefined],
      ['undefined-returning', () => undefined],
      ['invalid', () => 'not-a-color'],
      ['throwing', () => { throw new Error('consumer failure'); }],
    ];

    it.each(fallbackCallbacks)('falls back to depth color for a %s callback', (_case, colorFn) => {
      core = createDetachedCore(sampleGraph, {
        getNodeColorFn: colorFn ? () => colorFn as NodeColorFn : undefined,
      });
      (core as any).render();
      expect((core as any).g.select('g.node circle.body').attr('fill')).toBe('#7c6af7');
    });

    it('keeps a callback color after setData and setTheme redraws', () => {
      const graph: MindmapGraph = {
        nodes: [{ id: 'root', label: 'Root', metadata: { kind: 'arc_request' } }],
        edges: [],
      };
      core = createDetachedCore(graph, {
        getNodeColorFn: () => (node) =>
          node.metadata?.['kind'] === 'arc_request' ? '#E46632' : undefined,
      });

      (core as any).render();
      core.setData({
        ...graph,
        nodes: [{ ...graph.nodes[0], label: 'Renamed root' }],
      });
      core.setTheme('light');

      const node = (core as any).g.select('g.node');
      expect(node.select('circle.body').attr('fill')).toBe('#e46632');
      expect(node.select('circle.halo').attr('stroke')).toBe('#e46632');
    });

    it('uses the callback color for incident links on hover', () => {
      vi.useFakeTimers();
      const graph: MindmapGraph = {
        nodes: [
          { id: 'root', label: 'Root', metadata: { kind: 'arc_request' } },
          { id: 'child', label: 'Child' },
        ],
        edges: [{ source: 'root', target: 'child' }],
      };
      core = createDetachedCore(graph, {
        getNodeColorFn: () => (node) =>
          node.metadata?.['kind'] === 'arc_request' ? '#E46632' : undefined,
      });

      (core as any).render();
      const transitionSpy = vi.spyOn(d3.selection.prototype, 'transition')
        .mockImplementation(function (this: d3.Selection<d3.BaseType, unknown, null, undefined>) {
          return { duration: () => this } as any;
        });

      const root = (core as any).g.selectAll('g.node')
        .filter((node: D3GraphNode) => node.id === 'root')
        .node() as SVGGElement;

      try {
        root.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        vi.advanceTimersByTime(150);

        expect((core as any).g.select('line').attr('stroke')).toBe('#e46632');
      } finally {
        transitionSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe('node emphasis', () => {
    const emphasisGraph: MindmapGraph = {
      nodes: [
        { id: 'root', label: 'Root', metadata: { kind: 'arc_request' } },
        { id: 'fact', label: 'Fact', metadata: { kind: 'request_fact' } },
        { id: 'attachment', label: 'Attachment', metadata: { kind: 'attachment' } },
      ],
      edges: [
        { source: 'root', target: 'fact' },
        { source: 'root', target: 'attachment' },
      ],
      entryNodeId: 'root',
    };
    const factPredicate: NodeEmphasisFn =
      (node: MindmapGraphNode) => node.metadata?.['kind'] === 'request_fact';
    let transitionSpy: ReturnType<typeof vi.spyOn>;
    let transitionDurations: number[];

    function nodeSelection(id: string): d3.Selection<SVGGElement, D3GraphNode, SVGGElement, unknown> {
      const graph = (core as any).g as d3.Selection<SVGGElement, unknown, null, undefined>;
      return graph.select<SVGGElement>('.nodes')
        .selectAll<SVGGElement, D3GraphNode>('g.node')
        .filter((node: D3GraphNode) => node.id === id);
    }

    function edgeSelection(id: string): d3.Selection<SVGLineElement, D3GraphEdge, SVGGElement, unknown> {
      const graph = (core as any).g as d3.Selection<SVGGElement, unknown, null, undefined>;
      return graph.select<SVGGElement>('.links')
        .selectAll<SVGLineElement, D3GraphEdge>('line')
        .filter((edge) => edge.id === id);
    }

    function nodeOpacity(id: string): string {
      return nodeSelection(id).attr('opacity');
    }

    function edgeAttr(id: string, name: string): string {
      return edgeSelection(id).attr(name);
    }

    function allNodeOpacities(): string[] {
      return (core as any).g.select('.nodes').selectAll('g.node').nodes()
        .map((node: Element) => node.getAttribute('opacity') ?? '');
    }

    function allEdgeOpacities(): string[] {
      return (core as any).g.select('.links').selectAll('line').nodes()
        .map((edge: Element) => edge.getAttribute('stroke-opacity') ?? '');
    }

    beforeEach(() => {
      vi.useFakeTimers();
      transitionDurations = [];
      transitionSpy = vi.spyOn(d3.selection.prototype, 'transition')
        .mockImplementation(function (this: d3.Selection<d3.BaseType, unknown, null, undefined>) {
          return {
            duration: (duration: number) => {
              transitionDurations.push(duration);
              return this;
            },
          } as any;
        });
      core = createDetachedCore(emphasisGraph, {
        getNodeColorFn: () => (node) =>
          node.metadata?.['kind'] === 'request_fact' ? '#2E8B57' : undefined,
      });
      (core as any).render();
    });

    afterEach(() => {
      core.destroy();
      transitionSpy.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('emphasizes matching nodes and incident edges, then restores theme opacity when cleared', () => {
      core.setNodeEmphasis(factPredicate);
      vi.advanceTimersByTime(150);

      expect(nodeOpacity('fact')).toBe('1');
      expect(nodeOpacity('root')).toBe('0.15');
      expect(nodeOpacity('attachment')).toBe('0.15');
      expect(edgeAttr('root->fact', 'stroke-opacity')).toBe(String((core as any).tc.edgeOpacity));
      expect(edgeAttr('root->attachment', 'stroke-opacity')).toBe('0.08');

      core.setNodeEmphasis(undefined);
      vi.advanceTimersByTime(150);

      expect(allNodeOpacities()).toEqual(['1', '1', '1']);
      expect(allEdgeOpacities()).toEqual([
        String((core as any).tc.edgeOpacity),
        String((core as any).tc.edgeOpacity),
      ]);
    });

    it('dims every node and edge when the emphasis predicate matches no nodes', () => {
      core.setNodeEmphasis(() => false);
      vi.advanceTimersByTime(150);

      expect(allNodeOpacities()).toEqual(['0.15', '0.15', '0.15']);
      expect(allEdgeOpacities()).toEqual(['0.08', '0.08']);
    });

    it('treats a throwing emphasis predicate as a non-match', () => {
      core.setNodeEmphasis(() => {
        throw new Error('consumer failure');
      });

      expect(allNodeOpacities()).toEqual(['0.15', '0.15', '0.15']);
      expect(allEdgeOpacities()).toEqual(['0.08', '0.08']);
    });

    it('is safe before the first render', () => {
      const unrendered = createDetachedCore(emphasisGraph);

      expect(() => unrendered.setNodeEmphasis(factPredicate)).not.toThrow();
    });

    it('preserves emphasis across setData and setTheme redraws', () => {
      core.setNodeEmphasis(factPredicate);

      core.setData({
        ...emphasisGraph,
        nodes: emphasisGraph.nodes.map((node) => ({ ...node, label: `${node.label} updated` })),
      });
      expect(nodeOpacity('fact')).toBe('1');
      expect(nodeOpacity('root')).toBe('0.15');
      expect(nodeOpacity('attachment')).toBe('0.15');

      core.setTheme('light');
      expect(nodeOpacity('fact')).toBe('1');
      expect(nodeOpacity('root')).toBe('0.15');
      expect(nodeOpacity('attachment')).toBe('0.15');
    });

    it('does not change focus, node positions, or invoke camera APIs', () => {
      const nodes: D3GraphNode[] = (core as any).allNodes;
      nodes[0].x = 11;
      nodes[0].y = 22;
      nodes[1].x = 33;
      nodes[1].y = 44;
      const positions = nodes.map(({ id, x, y }) => ({ id, x, y }));
      const focusedNodeId = (core as any).focusedNodeId;
      const moveFocusSpy = vi.spyOn(core as any, 'moveFocusTo');
      const resetViewSpy = vi.spyOn(core, 'resetView');
      const zoomToFitSpy = vi.spyOn(core, 'zoomToFit');
      const zoomToNodeSpy = vi.spyOn(core, 'zoomToNode');

      core.setNodeEmphasis(factPredicate);

      expect((core as any).focusedNodeId).toBe(focusedNodeId);
      expect(nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(positions);
      expect(moveFocusSpy).not.toHaveBeenCalled();
      expect(resetViewSpy).not.toHaveBeenCalled();
      expect(zoomToFitSpy).not.toHaveBeenCalled();
      expect(zoomToNodeSpy).not.toHaveBeenCalled();
    });

    it('composes matching-node hover with included and excluded edge styles', () => {
      core.setNodeEmphasis(factPredicate);
      const fact = nodeSelection('fact').node()!;

      fact.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(150);

      expect(edgeAttr('root->fact', 'stroke-opacity')).toBe('1');
      expect(edgeAttr('root->fact', 'stroke-width')).toBe('2');
      expect(edgeAttr('root->fact', 'stroke')).toBe('#2e8b57');
      expect(edgeAttr('root->attachment', 'stroke-opacity')).toBe('0.08');

      fact.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      vi.advanceTimersByTime(150);

      expect(edgeAttr('root->fact', 'stroke-opacity')).toBe(String((core as any).tc.edgeOpacity));
      expect(edgeAttr('root->attachment', 'stroke-opacity')).toBe('0.08');
    });

    it('keeps an excluded edge dim when its non-matching node is hovered', () => {
      core.setNodeEmphasis(factPredicate);
      const attachment = nodeSelection('attachment').node()!;

      attachment.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(150);

      expect(edgeAttr('root->attachment', 'stroke-opacity')).toBe('0.08');
      expect(edgeAttr('root->attachment', 'stroke-width')).toBe('1.5');
      expect(edgeAttr('root->fact', 'stroke-opacity')).toBe('0.15');
    });

    it('keeps excluded edges dim while ArrowDown and ArrowUp change the outgoing edge cursor', () => {
      const root = (core as any).allNodes.find((node: D3GraphNode) => node.id === 'root');
      (core as any).shape = 'graph';
      core.setNodeEmphasis(factPredicate);

      (core as any).onNodeKeydown({ key: 'ArrowDown', preventDefault: () => {} } as KeyboardEvent, root);
      vi.advanceTimersByTime(150);

      expect(edgeAttr('root->attachment', 'stroke-opacity')).toBe('0.08');
      expect(edgeAttr('root->attachment', 'stroke-width')).toBe('1.5');
      expect(edgeAttr('root->fact', 'stroke-opacity')).toBe('0.15');

      (core as any).onNodeKeydown({ key: 'ArrowUp', preventDefault: () => {} } as KeyboardEvent, root);
      vi.advanceTimersByTime(150);

      expect(edgeAttr('root->fact', 'stroke-opacity')).toBe('1');
      expect(edgeAttr('root->fact', 'stroke-width')).toBe('2');
      expect(edgeAttr('root->fact', 'stroke')).toBe('#7c6af7');
      expect(edgeAttr('root->attachment', 'stroke-opacity')).toBe('0.08');
    });

    it('retains existing hover behavior when no emphasis predicate is active', () => {
      const fact = nodeSelection('fact').node()!;

      fact.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(150);

      expect(edgeAttr('root->fact', 'stroke-opacity')).toBe('1');
      expect(edgeAttr('root->fact', 'stroke-width')).toBe('2');
      expect(edgeAttr('root->attachment', 'stroke-opacity')).toBe('0.15');

      fact.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      vi.advanceTimersByTime(150);

      expect(allEdgeOpacities()).toEqual([
        String((core as any).tc.edgeOpacity),
        String((core as any).tc.edgeOpacity),
      ]);
    });

    it('uses zero-duration interaction transitions when reduced motion is preferred', () => {
      vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
      transitionDurations = [];

      core.setNodeEmphasis(factPredicate);

      expect(transitionDurations).toEqual([0, 0]);
    });

    it('does not interrupt radial position transitions when reapplying styles after redraw', async () => {
      transitionSpy.mockRestore();
      vi.useRealTimers();
      core.destroy();
      (core as any).layoutMode = 'radial';
      const originalTransform = Object.getOwnPropertyDescriptor(SVGElement.prototype, 'transform');
      Object.defineProperty(SVGElement.prototype, 'transform', {
        configurable: true,
        get: function (this: SVGElement) {
          const element = this;
          return {
            baseVal: {
              consolidate: () => {
                const match = /^translate\(([^,]+),([^)]+)\)$/.exec(element.getAttribute('transform') ?? '');
                if (!match) return null;
                return {
                  matrix: {
                    a: 1, b: 0, c: 0, d: 1,
                    e: Number(match[1]), f: Number(match[2]),
                  },
                };
              },
            },
          };
        },
      });

      try {
        core.setNodeEmphasis(factPredicate);
        (core as any).redraw();
        await new Promise((resolve) => setTimeout(resolve, 450));

        const fact = (core as any).visibleNodes.find((node: D3GraphNode) => node.id === 'fact');
        expect(nodeSelection('fact').attr('transform')).toBe(`translate(${fact.targetX}, ${fact.targetY})`);
        expect(edgeAttr('root->fact', 'x2')).toBe(String(fact.targetX));
        expect(edgeAttr('root->fact', 'y2')).toBe(String(fact.targetY));
      } finally {
        if (originalTransform) {
          Object.defineProperty(SVGElement.prototype, 'transform', originalTransform);
        } else {
          delete (SVGElement.prototype as any).transform;
        }
      }
    });
  });

  describe('zoomToNode', () => {
    it('calls zoomBehavior.transform when the node is found', () => {
      (core as any).allNodes = [{ id: 'a', x: 100, y: 200 }];
      const transformSpy = vi.fn();
      (core as any).zoomBehavior = { transform: transformSpy };

      core.zoomToNode('a');

      expect(transformSpy).toHaveBeenCalled();
    });

    it('is a no-op when the node id is not found', () => {
      (core as any).allNodes = [];
      const transformSpy = vi.fn();
      (core as any).zoomBehavior = { transform: transformSpy };

      expect(() => core.zoomToNode('missing')).not.toThrow();
      expect(transformSpy).not.toHaveBeenCalled();
    });

    it('is a no-op when the node is found but has no x/y yet', () => {
      (core as any).allNodes = [{ id: 'a' }];
      const transformSpy = vi.fn();
      (core as any).zoomBehavior = { transform: transformSpy };

      expect(() => core.zoomToNode('a')).not.toThrow();
      expect(transformSpy).not.toHaveBeenCalled();
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
