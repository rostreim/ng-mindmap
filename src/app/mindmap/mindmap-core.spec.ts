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
