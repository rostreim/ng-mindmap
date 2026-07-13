import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MindmapComponent } from './mindmap';
import { D3Node, MindmapNode } from './mindmap.model';
import { buildTree } from './mindmap-layout';

// These tests exercise toggleCollapse/menu-navigation directly without triggering ngOnInit
// (no fixture.detectChanges()), since ngOnInit sets up the D3 zoom/SVG pipeline, which needs
// real SVG geometry APIs (e.g. viewBox.baseVal) that jsdom doesn't implement. Pure tree/layout
// functions (buildTree, flattenVisible, computeRadialPositions, etc.) are tested directly
// against mindmap-layout.ts in mindmap-layout.spec.ts — no component/TestBed needed there.
describe('MindmapComponent', () => {
  let fixture: ComponentFixture<MindmapComponent>;
  let component: MindmapComponent;

  const sampleData: MindmapNode = {
    id: 'root',
    label: 'Root',
    children: [
      {
        id: 'a',
        label: 'A',
        children: [
          { id: 'a1', label: 'A1' },
          { id: 'a2', label: 'A2' },
        ],
      },
      { id: 'b', label: 'B' },
    ],
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MindmapComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(MindmapComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('data', sampleData);
  });

  afterEach(() => {
    fixture.destroy();
  });

  describe('toggleCollapse', () => {
    beforeEach(() => {
      // toggleCollapse always ends by calling redraw(), which drives the D3/SVG pipeline.
      // That's exercised separately in the browser; here we isolate the children/_children
      // state transition, which is the part of toggleCollapse worth unit testing.
      vi.spyOn(component as any, 'redraw').mockImplementation(() => {});
    });

    it('moves visible children into _children and marks the node collapsed', () => {
      const tree: D3Node = buildTree(sampleData, null, 0);
      (component as any).rootNode = tree;
      const a = tree.children![0];

      (component as any).toggleCollapse(a);

      expect(a.collapsed).toBe(true);
      expect(a.children).toEqual([]);
      expect(a._children?.map((c) => c.id)).toEqual(['a1', 'a2']);
    });

    it('restores _children back into children and clears collapsed state on the next toggle', () => {
      const tree: D3Node = buildTree(sampleData, null, 0);
      (component as any).rootNode = tree;
      const a = tree.children![0];

      (component as any).toggleCollapse(a);
      (component as any).toggleCollapse(a);

      expect(a.collapsed).toBe(false);
      expect(a._children).toBeNull();
      expect(a.children?.map((c) => c.id)).toEqual(['a1', 'a2']);
    });

    it('is a no-op for a leaf node with no children in either direction', () => {
      const tree: D3Node = buildTree(sampleData, null, 0);
      (component as any).rootNode = tree;
      const b = tree.children![1];

      (component as any).toggleCollapse(b);

      expect(b.collapsed).toBe(false);
      expect(b.children).toEqual([]);
      expect(b._children).toBeNull();
    });

    it('announces the node label and new state to screen readers on collapse and expand', () => {
      const tree: D3Node = buildTree(sampleData, null, 0);
      (component as any).rootNode = tree;
      const a = tree.children![0];

      (component as any).toggleCollapse(a);
      expect(component.liveMessage()).toBe('A collapsed');

      (component as any).toggleCollapse(a);
      expect(component.liveMessage()).toBe('A expanded');
    });

    it('leaves the announcement unchanged for a no-op toggle on a leaf', () => {
      const tree: D3Node = buildTree(sampleData, null, 0);
      (component as any).rootNode = tree;
      const b = tree.children![1];

      (component as any).toggleCollapse(b);

      expect(component.liveMessage()).toBe('');
    });
  });

  describe('onNodeKeydown (Enter/Space) and nodeClickFn interception', () => {
    it('announces activation and does not toggle when nodeClickFn returns true', () => {
      const tree: D3Node = buildTree(sampleData, null, 0);
      (component as any).rootNode = tree;
      const a1 = tree.children![0].children![0];
      fixture.componentRef.setInput('nodeClickFn', () => true);

      const event = { key: 'Enter', preventDefault: () => {} } as unknown as KeyboardEvent;
      (component as any).onNodeKeydown(event, a1);

      expect(component.liveMessage()).toBe('A1 activated');
    });

    it('falls through to the normal collapse/expand toggle when nodeClickFn returns false', () => {
      vi.spyOn(component as any, 'redraw').mockImplementation(() => {});
      const tree: D3Node = buildTree(sampleData, null, 0);
      (component as any).rootNode = tree;
      const a = tree.children![0];
      fixture.componentRef.setInput('nodeClickFn', () => false);

      const event = { key: 'Enter', preventDefault: () => {} } as unknown as KeyboardEvent;
      (component as any).onNodeKeydown(event, a);

      expect(a.collapsed).toBe(true);
      expect(component.liveMessage()).toBe('A collapsed');
    });
  });

  describe('render (data updates)', () => {
    beforeEach(() => {
      vi.spyOn(component as any, 'redraw').mockImplementation(() => {});
    });

    it('preserves prior node positions across a data update for nodes with matching ids', () => {
      (component as any).render();
      const firstRoot: D3Node = (component as any).rootNode;
      firstRoot.children![0].x = 111;
      firstRoot.children![0].y = 222;

      const updated: MindmapNode = {
        ...sampleData,
        children: [
          { ...sampleData.children![0], label: 'A renamed' },
          sampleData.children![1],
        ],
      };
      fixture.componentRef.setInput('data', updated);

      (component as any).render();

      const secondRoot: D3Node = (component as any).rootNode;
      expect(secondRoot.children![0].x).toBe(111);
      expect(secondRoot.children![0].y).toBe(222);
      expect(secondRoot.children![0].label).toBe('A renamed');
    });
  });
});
