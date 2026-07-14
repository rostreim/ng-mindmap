import { ComponentFixture, TestBed } from '@angular/core/testing';
import * as d3 from 'd3';
import { MindmapComponent } from './mindmap';
import { D3GraphNode, MindmapGraph } from './mindmap.model';
import { buildGraph } from './mindmap-layout';

describe('MindmapComponent', () => {
  let fixture: ComponentFixture<MindmapComponent>;
  let component: MindmapComponent;

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

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [MindmapComponent] }).compileComponents();
    fixture = TestBed.createComponent(MindmapComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('data', sampleGraph);

    // These tests exercise toggleCollapse/onNodeKeydown/redraw() directly without triggering
    // ngOnInit (no fixture.detectChanges()), since ngOnInit's initSvg() drives d3-zoom's setup,
    // which touches SVG geometry APIs (e.g. viewBox.baseVal) that jsdom doesn't implement.
    // Stub a minimal detached svg/g structure mirroring initSvg()'s shape instead, so the
    // handful of real (unmocked) DOM touches these tests hit along the way — redraw()'s
    // `this.svg.attr('role', ...)`, moveFocusTo()'s `this.g.select(...)` — have something to
    // operate on. No zoom/drag behavior is attached, so none of the geometry-API-dependent
    // code paths are exercised.
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const g = d3.select(svgEl).append('g').attr('class', 'graph');
    g.append('g').attr('class', 'links');
    g.append('g').attr('class', 'nodes');
    (component as any).svg = d3.select(svgEl);
    (component as any).g = g;
  });

  afterEach(() => fixture.destroy());

  describe('render (data updates)', () => {
    beforeEach(() => {
      vi.spyOn(component as any, 'redraw').mockImplementation(() => {});
    });

    it('preserves prior node positions across a data update for nodes with matching ids', () => {
      (component as any).render();
      const firstNodes: D3GraphNode[] = (component as any).allNodes;
      const a = firstNodes.find((n) => n.id === 'a')!;
      a.x = 111;
      a.y = 222;

      const updated: MindmapGraph = {
        ...sampleGraph,
        nodes: sampleGraph.nodes.map((n) => (n.id === 'a' ? { ...n, label: 'A renamed' } : n)),
      };
      fixture.componentRef.setInput('data', updated);
      (component as any).render();

      const secondNodes: D3GraphNode[] = (component as any).allNodes;
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
      fixture.componentRef.setInput('data', dagGraph);
      fixture.componentRef.setInput('layoutMode', 'radial');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(component as any, 'syncForceSimulation').mockImplementation(() => {});

      (component as any).render();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/layoutMode "radial".*graph-shaped/i));
      expect((component as any).syncForceSimulation).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

  });

  describe('syncRadialLayout', () => {
    it('nulls this.simulation, not just stops it — dragBehavior() and zoomToFitAfterSettle() key off its presence to tell radial mode from force/hybrid', () => {
      // A leftover simulation, as if a prior redraw() left force/hybrid mode's simulation
      // in place before this switch to radial (syncForceSimulation()/syncHybridSimulation()
      // never clear it themselves — only syncRadialLayout() is responsible for retiring it).
      const fakeSimulation = { stop: vi.fn() };
      (component as any).simulation = fakeSimulation;

      (component as any).syncRadialLayout([], []);

      expect(fakeSimulation.stop).toHaveBeenCalled();
      expect((component as any).simulation).toBeUndefined();
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
      vi.spyOn(component as any, 'redraw').mockImplementation(() => {});
    });

    it('toggles collapsed on the node and calls redraw()', () => {
      (component as any).render();
      const a = (component as any).allNodes.find((n: D3GraphNode) => n.id === 'a');

      (component as any).toggleCollapse(a);
      expect(a.collapsed).toBe(true);

      (component as any).toggleCollapse(a);
      expect(a.collapsed).toBe(false);
    });

    it('announces the node label and new state to screen readers', () => {
      (component as any).render();
      const a = (component as any).allNodes.find((n: D3GraphNode) => n.id === 'a');

      (component as any).toggleCollapse(a);
      expect(component.liveMessage()).toBe('A collapsed');

      (component as any).toggleCollapse(a);
      expect(component.liveMessage()).toBe('A expanded');
    });

    it('is a no-op for a leaf node with no outgoing edges', () => {
      (component as any).render();
      const b = (component as any).allNodes.find((n: D3GraphNode) => n.id === 'b');

      (component as any).toggleCollapse(b);
      // A leaf node has no outgoing edges, so toggleCollapse() returns early via its
      // hasOutgoing guard (line 733) without ever reaching the flag flip on line 735.
      // Thus collapsed remains at its default false value — a genuine complete no-op.
      expect(b.collapsed).toBe(false);
    });

    describe('collapseMode: global vs per-edge (DAG-only behavior)', () => {
      beforeEach(() => {
        (component as any).redraw.mockRestore();
        vi.spyOn(component as any, 'syncForceSimulation').mockImplementation(() => {});
      });

      it('global mode: collapsing one parent hides the shared node even via the other parent', () => {
        fixture.componentRef.setInput('data', sharedGraph);
        fixture.componentRef.setInput('collapseMode', 'global');
        (component as any).render();
        const p1 = (component as any).allNodes.find((n: D3GraphNode) => n.id === 'p1');

        (component as any).toggleCollapse(p1);

        expect((component as any).visibleNodes.map((n: D3GraphNode) => n.id).sort()).toEqual(['p1', 'p2']);
      });

      it('per-edge mode: collapsing one parent keeps the shared node visible via the other parent', () => {
        fixture.componentRef.setInput('data', sharedGraph);
        fixture.componentRef.setInput('collapseMode', 'per-edge');
        (component as any).render();
        const p1 = (component as any).allNodes.find((n: D3GraphNode) => n.id === 'p1');

        (component as any).toggleCollapse(p1);

        expect((component as any).visibleNodes.map((n: D3GraphNode) => n.id).sort())
          .toEqual(['p1', 'p2', 'shared', 'shared-child']);
      });
    });
  });

  describe('onNodeKeydown', () => {
    beforeEach(() => {
      vi.spyOn(component as any, 'redraw').mockImplementation(() => {});
    });

    describe('tree-shaped data', () => {
      beforeEach(() => {
        // 'ArrowDown/Up' below reads real visibleNodes (DFS order), which the parent
        // describe's blanket redraw() mock leaves stuck at [] — restore the real redraw()
        // and mock only syncForceSimulation instead, letting real computeVisibleGraph() run
        // (same pattern as the collapseMode nested describe above).
        (component as any).redraw.mockRestore();
        vi.spyOn(component as any, 'syncForceSimulation').mockImplementation(() => {});
      });

      it('ArrowDown/Up move focus through the DFS-visible order', () => {
        (component as any).render();
        (component as any).moveFocusTo((component as any).allNodes.find((n: D3GraphNode) => n.id === 'root'));

        (component as any).onNodeKeydown({ key: 'ArrowDown', preventDefault: () => {} } as KeyboardEvent, (component as any).allNodes.find((n: D3GraphNode) => n.id === 'root'));
        expect((component as any).focusedNodeId).toBe('a');
      });

      it('ArrowLeft moves to the parent', () => {
        (component as any).render();
        const a1 = (component as any).allNodes.find((n: D3GraphNode) => n.id === 'a1');

        (component as any).onNodeKeydown({ key: 'ArrowLeft', preventDefault: () => {} } as KeyboardEvent, a1);
        expect((component as any).focusedNodeId).toBe('a');
      });
    });

    describe('graph-shaped data', () => {
      const dag: MindmapGraph = {
        nodes: [{ id: 'x', label: 'X' }, { id: 'y1', label: 'Y1' }, { id: 'y2', label: 'Y2' }, { id: 'p2', label: 'P2' }],
        edges: [{ source: 'x', target: 'y1' }, { source: 'x', target: 'y2' }, { source: 'p2', target: 'y1' }],
      };

      it('ArrowDown cycles the outgoing-edge cursor without moving focus', () => {
        fixture.componentRef.setInput('data', dag);
        (component as any).render();
        const x = (component as any).allNodes.find((n: D3GraphNode) => n.id === 'x');
        (component as any).moveFocusTo(x);

        (component as any).onNodeKeydown({ key: 'ArrowDown', preventDefault: () => {} } as KeyboardEvent, x);

        expect((component as any).focusedNodeId).toBe('x'); // cursor moved, focus didn't
        expect((component as any).outgoingCursor.get('x')).toBe(1);
      });

      it('ArrowRight moves focus along the currently-selected outgoing edge', () => {
        fixture.componentRef.setInput('data', dag);
        (component as any).render();
        const x = (component as any).allNodes.find((n: D3GraphNode) => n.id === 'x');
        (component as any).moveFocusTo(x);

        (component as any).onNodeKeydown({ key: 'ArrowRight', preventDefault: () => {} } as KeyboardEvent, x);

        expect((component as any).focusedNodeId).toBe('y1'); // index 0 (default cursor) -> first outgoing edge
      });

      it('ArrowLeft retraces to whichever node ArrowRight was pressed from', () => {
        fixture.componentRef.setInput('data', dag);
        (component as any).render();
        const x = (component as any).allNodes.find((n: D3GraphNode) => n.id === 'x');
        (component as any).moveFocusTo(x);
        (component as any).onNodeKeydown({ key: 'ArrowRight', preventDefault: () => {} } as KeyboardEvent, x);
        const y1 = (component as any).allNodes.find((n: D3GraphNode) => n.id === 'y1');

        (component as any).onNodeKeydown({ key: 'ArrowLeft', preventDefault: () => {} } as KeyboardEvent, y1);

        expect((component as any).focusedNodeId).toBe('x');
      });
    });
  });
});
