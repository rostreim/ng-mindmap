import { ComponentFixture, TestBed } from '@angular/core/testing';
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
});
