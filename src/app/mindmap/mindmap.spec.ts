import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MindmapComponent } from './mindmap';
import { D3Link, D3Node, MenuEntry, MindmapNode } from './mindmap.model';

// These tests exercise buildTree/flattenVisible/toggleCollapse directly without triggering
// ngOnInit (no fixture.detectChanges()), since ngOnInit sets up the D3 zoom/SVG pipeline,
// which needs real SVG geometry APIs (e.g. viewBox.baseVal) that jsdom doesn't implement.
describe('MindmapComponent data functions', () => {
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
    component.data = sampleData;
  });

  afterEach(() => {
    fixture.destroy();
  });

  describe('buildTree', () => {
    it('converts a MindmapNode tree into a D3Node tree, preserving structure and depth', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);

      expect(tree.id).toBe('root');
      expect(tree.depth).toBe(0);
      expect(tree.parent).toBeNull();
      expect(tree.children?.length).toBe(2);

      const [a, b] = tree.children!;
      expect(a.id).toBe('a');
      expect(a.depth).toBe(1);
      expect(a.parent).toBe(tree);
      expect(a.children?.map((c) => c.id)).toEqual(['a1', 'a2']);
      expect(a.children![0].depth).toBe(2);
      expect(a.children![0].parent).toBe(a);

      expect(b.id).toBe('b');
      expect(b.children).toEqual([]);
    });

    it('initializes fresh collapse state regardless of any prior state on the source node', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);

      expect(tree.collapsed).toBe(false);
      expect(tree._children).toBeNull();
    });
  });

  describe('flattenVisible', () => {
    it('flattens the visible tree into parallel nodes and links arrays', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const nodes: D3Node[] = [];
      const links: D3Link[] = [];
      (component as any).flattenVisible(tree, nodes, links);

      expect(nodes.map((n) => n.id)).toEqual(['root', 'a', 'a1', 'a2', 'b']);
      expect(links.map((l) => `${l.source.id}->${l.target.id}`)).toEqual([
        'root->a',
        'a->a1',
        'a->a2',
        'root->b',
      ]);
    });

    it('excludes a collapsed subtree from the flattened output', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const a = tree.children![0];
      a._children = a.children;
      a.children = [];

      const nodes: D3Node[] = [];
      const links: D3Link[] = [];
      (component as any).flattenVisible(tree, nodes, links);

      expect(nodes.map((n) => n.id)).toEqual(['root', 'a', 'b']);
      expect(links.map((l) => `${l.source.id}->${l.target.id}`)).toEqual(['root->a', 'root->b']);
    });
  });

  describe('toggleCollapse', () => {
    beforeEach(() => {
      // toggleCollapse always ends by calling redraw(), which drives the D3/SVG pipeline.
      // That's exercised separately in the browser; here we isolate the children/_children
      // state transition, which is the part of toggleCollapse worth unit testing.
      vi.spyOn(component as any, 'redraw').mockImplementation(() => {});
    });

    it('moves visible children into _children and marks the node collapsed', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      (component as any).rootNode = tree;
      const a = tree.children![0];

      (component as any).toggleCollapse(a);

      expect(a.collapsed).toBe(true);
      expect(a.children).toEqual([]);
      expect(a._children?.map((c) => c.id)).toEqual(['a1', 'a2']);
    });

    it('restores _children back into children and clears collapsed state on the next toggle', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      (component as any).rootNode = tree;
      const a = tree.children![0];

      (component as any).toggleCollapse(a);
      (component as any).toggleCollapse(a);

      expect(a.collapsed).toBe(false);
      expect(a._children).toBeNull();
      expect(a.children?.map((c) => c.id)).toEqual(['a1', 'a2']);
    });

    it('is a no-op for a leaf node with no children in either direction', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      (component as any).rootNode = tree;
      const b = tree.children![1];

      (component as any).toggleCollapse(b);

      expect(b.collapsed).toBe(false);
      expect(b.children).toEqual([]);
      expect(b._children).toBeNull();
    });
  });

  describe('nextVisible / previousVisible / firstVisible / lastVisible', () => {
    it('walks the flattened tree order forward and backward', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const nodes: D3Node[] = [];
      const links: D3Link[] = [];
      (component as any).flattenVisible(tree, nodes, links);
      // order: root, a, a1, a2, b

      expect((component as any).nextVisible(nodes, 'root').id).toBe('a');
      expect((component as any).nextVisible(nodes, 'a').id).toBe('a1');
      expect((component as any).nextVisible(nodes, 'b')).toBeNull();

      expect((component as any).previousVisible(nodes, 'b').id).toBe('a2');
      expect((component as any).previousVisible(nodes, 'a1').id).toBe('a');
      expect((component as any).previousVisible(nodes, 'root')).toBeNull();

      expect((component as any).firstVisible(nodes).id).toBe('root');
      expect((component as any).lastVisible(nodes).id).toBe('b');
    });

    it('returns null for an id not present in the array, and null first/last for an empty array', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const nodes: D3Node[] = [];
      const links: D3Link[] = [];
      (component as any).flattenVisible(tree, nodes, links);

      expect((component as any).nextVisible(nodes, 'missing')).toBeNull();
      expect((component as any).previousVisible(nodes, 'missing')).toBeNull();
      expect((component as any).firstVisible([])).toBeNull();
      expect((component as any).lastVisible([])).toBeNull();
    });
  });

  describe('firstChild', () => {
    it('returns the first visible child, or null for a leaf', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const a = tree.children![0];
      const b = tree.children![1];

      expect((component as any).firstChild(a).id).toBe('a1');
      expect((component as any).firstChild(b)).toBeNull();
    });

    it('returns null when children have been collapsed into _children', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const a = tree.children![0];
      a._children = a.children;
      a.children = [];

      expect((component as any).firstChild(a)).toBeNull();
    });
  });

  describe('isDescendantOf', () => {
    it('returns true for a direct or transitive descendant, false otherwise', () => {
      const tree: D3Node = (component as any).buildTree(sampleData, null, 0);
      const a = tree.children![0];
      const a1 = a.children![0];
      const b = tree.children![1];

      expect((component as any).isDescendantOf(a1, a)).toBe(true);
      expect((component as any).isDescendantOf(a1, tree)).toBe(true);
      expect((component as any).isDescendantOf(a, a1)).toBe(false);
      expect((component as any).isDescendantOf(b, a)).toBe(false);
    });
  });

  describe('menu navigation index helpers', () => {
    const entries: MenuEntry[] = [
      { type: 'topic', label: 'Actions' },
      { type: 'item', label: 'Expand all', action: () => {} },
      { type: 'separator' },
      { type: 'item', label: 'Disabled item', action: () => {}, disabled: true },
      { type: 'item', label: 'Delete', action: () => {} },
    ];

    it('isFocusableMenuEntry is true only for enabled items', () => {
      expect((component as any).isFocusableMenuEntry(entries[0])).toBe(false); // topic
      expect((component as any).isFocusableMenuEntry(entries[1])).toBe(true); // item
      expect((component as any).isFocusableMenuEntry(entries[2])).toBe(false); // separator
      expect((component as any).isFocusableMenuEntry(entries[3])).toBe(false); // disabled item
      expect((component as any).isFocusableMenuEntry(entries[4])).toBe(true); // item
    });

    it('nextMenuIndex skips non-focusable entries and wraps around', () => {
      expect((component as any).nextMenuIndex(entries, 1, 1)).toBe(4); // skips separator + disabled
      expect((component as any).nextMenuIndex(entries, 4, 1)).toBe(1); // wraps to start, skips topic
      expect((component as any).nextMenuIndex(entries, 4, -1)).toBe(1); // skips disabled + separator
      expect((component as any).nextMenuIndex(entries, 1, -1)).toBe(4); // wraps to end
    });

    it('firstMenuIndex / lastMenuIndex find the first and last focusable entries', () => {
      expect((component as any).firstMenuIndex(entries)).toBe(1);
      expect((component as any).lastMenuIndex(entries)).toBe(4);
    });

    it('falls back to index 0 when no entry is focusable', () => {
      const allDisabled: MenuEntry[] = [
        { type: 'topic', label: 'Actions' },
        { type: 'separator' },
      ];
      expect((component as any).firstMenuIndex(allDisabled)).toBe(0);
      expect((component as any).lastMenuIndex(allDisabled)).toBe(0);
    });
  });
});
