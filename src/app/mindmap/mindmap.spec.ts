import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MindmapComponent } from './mindmap';
import { D3Node, MenuEntry, MindmapNode } from './mindmap.model';
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
