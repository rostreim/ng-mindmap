import { D3Link, D3Node, MindmapNode } from './mindmap.model';
import {
  buildTree,
  computeRadialPositions,
  firstChild,
  firstVisible,
  flattenAll,
  flattenVisible,
  isDescendantOf,
  lastVisible,
  nextVisible,
  previousVisible,
} from './mindmap-layout';

// Pure functions — no TestBed/component instance needed to exercise them.
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

describe('buildTree', () => {
  it('converts a MindmapNode tree into a D3Node tree, preserving structure and depth', () => {
    const tree: D3Node = buildTree(sampleData, null, 0);

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
    const tree: D3Node = buildTree(sampleData, null, 0);

    expect(tree.collapsed).toBe(false);
    expect(tree._children).toBeNull();
  });

  it('throws a clear error instead of stack-overflowing on a cyclic MindmapNode graph', () => {
    const cyclic: MindmapNode = { id: 'root', label: 'Root', children: [] };
    cyclic.children = [cyclic];

    expect(() => buildTree(cyclic, null, 0)).toThrow(/cyclic/i);
  });

  it('does not flag non-cyclic shared substructure (same object reused across sibling branches)', () => {
    const shared: MindmapNode = { id: 'shared', label: 'Shared' };
    const tree: MindmapNode = {
      id: 'root',
      label: 'Root',
      children: [
        { id: 'a', label: 'A', children: [shared] },
        { id: 'b', label: 'B', children: [shared] },
      ],
    };

    expect(() => buildTree(tree, null, 0)).not.toThrow();
  });

  it('reuses x/y from a previous D3Node with the same id instead of randomizing', () => {
    const previousById = new Map<string, D3Node>();
    previousById.set('a', { ...buildTree(sampleData, null, 0).children![0], x: 123, y: 456 });

    const rebuilt: D3Node = buildTree(sampleData, null, 0, undefined, previousById);

    expect(rebuilt.children![0].x).toBe(123);
    expect(rebuilt.children![0].y).toBe(456);
  });

  it('assigns a fresh random position (unchanged spawn range) to a node absent from previousById', () => {
    const tree: D3Node = buildTree(sampleData, null, 0, undefined, new Map());

    expect(tree.x).toBeDefined();
    expect(Math.abs(tree.x!)).toBeLessThanOrEqual(30);
  });
});

describe('flattenAll', () => {
  it('collects every node by id, including ones hidden behind a collapse (_children)', () => {
    const tree: D3Node = buildTree(sampleData, null, 0);
    const a = tree.children![0];
    a._children = a.children;
    a.children = [];

    const map = new Map<string, D3Node>();
    flattenAll(tree, map);

    expect([...map.keys()].sort()).toEqual(['a', 'a1', 'a2', 'b', 'root']);
    expect(map.get('a1')).toBe(a._children![0]);
  });
});

describe('flattenVisible', () => {
  it('flattens the visible tree into parallel nodes and links arrays', () => {
    const tree: D3Node = buildTree(sampleData, null, 0);
    const nodes: D3Node[] = [];
    const links: D3Link[] = [];
    flattenVisible(tree, nodes, links);

    expect(nodes.map((n) => n.id)).toEqual(['root', 'a', 'a1', 'a2', 'b']);
    expect(links.map((l) => `${l.source.id}->${l.target.id}`)).toEqual([
      'root->a',
      'a->a1',
      'a->a2',
      'root->b',
    ]);
  });

  it('excludes a collapsed subtree from the flattened output', () => {
    const tree: D3Node = buildTree(sampleData, null, 0);
    const a = tree.children![0];
    a._children = a.children;
    a.children = [];

    const nodes: D3Node[] = [];
    const links: D3Link[] = [];
    flattenVisible(tree, nodes, links);

    expect(nodes.map((n) => n.id)).toEqual(['root', 'a', 'b']);
    expect(links.map((l) => `${l.source.id}->${l.target.id}`)).toEqual(['root->a', 'root->b']);
  });
});

describe('nextVisible / previousVisible / firstVisible / lastVisible', () => {
  it('walks the flattened tree order forward and backward', () => {
    const tree: D3Node = buildTree(sampleData, null, 0);
    const nodes: D3Node[] = [];
    const links: D3Link[] = [];
    flattenVisible(tree, nodes, links);
    // order: root, a, a1, a2, b

    expect(nextVisible(nodes, 'root')?.id).toBe('a');
    expect(nextVisible(nodes, 'a')?.id).toBe('a1');
    expect(nextVisible(nodes, 'b')).toBeNull();

    expect(previousVisible(nodes, 'b')?.id).toBe('a2');
    expect(previousVisible(nodes, 'a1')?.id).toBe('a');
    expect(previousVisible(nodes, 'root')).toBeNull();

    expect(firstVisible(nodes)?.id).toBe('root');
    expect(lastVisible(nodes)?.id).toBe('b');
  });

  it('returns null for an id not present in the array, and null first/last for an empty array', () => {
    const tree: D3Node = buildTree(sampleData, null, 0);
    const nodes: D3Node[] = [];
    const links: D3Link[] = [];
    flattenVisible(tree, nodes, links);

    expect(nextVisible(nodes, 'missing')).toBeNull();
    expect(previousVisible(nodes, 'missing')).toBeNull();
    expect(firstVisible([])).toBeNull();
    expect(lastVisible([])).toBeNull();
  });
});

describe('firstChild', () => {
  it('returns the first visible child, or null for a leaf', () => {
    const tree: D3Node = buildTree(sampleData, null, 0);
    const a = tree.children![0];
    const b = tree.children![1];

    expect(firstChild(a)?.id).toBe('a1');
    expect(firstChild(b)).toBeNull();
  });

  it('returns null when children have been collapsed into _children', () => {
    const tree: D3Node = buildTree(sampleData, null, 0);
    const a = tree.children![0];
    a._children = a.children;
    a.children = [];

    expect(firstChild(a)).toBeNull();
  });
});

describe('isDescendantOf', () => {
  it('returns true for a direct or transitive descendant, false otherwise', () => {
    const tree: D3Node = buildTree(sampleData, null, 0);
    const a = tree.children![0];
    const a1 = a.children![0];
    const b = tree.children![1];

    expect(isDescendantOf(a1, a)).toBe(true);
    expect(isDescendantOf(a1, tree)).toBe(true);
    expect(isDescendantOf(a, a1)).toBe(false);
    expect(isDescendantOf(b, a)).toBe(false);
  });
});

describe('computeRadialPositions', () => {
  it('places a lone root at the origin without dividing by zero', () => {
    const lone: MindmapNode = { id: 'solo', label: 'Solo' };
    const tree: D3Node = buildTree(lone, null, 0);

    computeRadialPositions(tree);

    expect(tree.targetX).toBeCloseTo(0);
    expect(tree.targetY).toBeCloseTo(0);
    expect(Number.isFinite(tree.targetX)).toBe(true);
    expect(Number.isFinite(tree.targetY)).toBe(true);
  });

  it('places nodes at increasing radius by depth, with distinct angles for siblings', () => {
    const tree: D3Node = buildTree(sampleData, null, 0);

    computeRadialPositions(tree);

    const dist = (n: D3Node) => Math.sqrt(n.targetX! ** 2 + n.targetY! ** 2);
    const a = tree.children![0];
    const b = tree.children![1];
    const [a1, a2] = a.children!;

    expect(dist(tree)).toBeCloseTo(0);
    expect(dist(a)).toBeGreaterThan(0);
    expect(dist(a)).toBeCloseTo(dist(b), 5); // same depth => same radius
    expect(dist(a1)).toBeGreaterThan(dist(a)); // deeper => farther out
    expect(a1.targetX !== a2.targetX || a1.targetY !== a2.targetY).toBe(true); // distinct angles
  });

  it('only positions the visible subtree, matching flattenVisible', () => {
    const tree: D3Node = buildTree(sampleData, null, 0);
    const a = tree.children![0];
    a._children = a.children;
    a.children = [];

    computeRadialPositions(tree);

    expect(a.targetX).toBeDefined();
    const [a1, a2] = a._children!;
    expect(a1.targetX).toBeUndefined();
    expect(a2.targetX).toBeUndefined();
  });
});
