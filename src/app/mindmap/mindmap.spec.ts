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
});
