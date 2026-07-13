import { D3GraphNode, MindmapGraph } from './mindmap.model';
import {
  buildGraph,
  classifyShape,
  computeRadialPositions,
  computeVisibleGraph,
  cycleOutgoingEdge,
  NODE_RADII,
  nodeRadius,
  resolveEntryNode,
} from './mindmap-layout';

// Pure functions — no TestBed/component instance needed to exercise them.
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
};

describe('buildGraph', () => {
  it('builds D3GraphNode/D3GraphEdge arrays with resolved object references', () => {
    const { nodes, edges } = buildGraph(sampleGraph);

    expect(nodes.map((n) => n.id).sort()).toEqual(['a', 'a1', 'a2', 'b', 'root']);
    expect(edges).toHaveLength(4);

    const rootToA = edges.find((e) => e.id === 'root->a')!;
    expect(rootToA.source.id).toBe('root');
    expect(rootToA.target.id).toBe('a');
    // source/target are the *same* object instances as in `nodes`, not copies.
    expect(rootToA.source).toBe(nodes.find((n) => n.id === 'root'));
  });

  it('defaults collapsed to false and depth to undefined for every node', () => {
    const { nodes } = buildGraph(sampleGraph);
    for (const n of nodes) {
      expect(n.collapsed).toBe(false);
      expect(n.depth).toBeUndefined();
    }
  });

  it('defaults an edge id to `${source}->${target}` when not given', () => {
    const { edges } = buildGraph(sampleGraph);
    expect(edges.map((e) => e.id).sort()).toEqual(['a->a1', 'a->a2', 'root->a', 'root->b']);
  });

  it('uses an explicit edge id when given', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }],
      edges: [{ id: 'custom-edge', source: 'x', target: 'y' }],
    };
    const { edges } = buildGraph(graph);
    expect(edges[0].id).toBe('custom-edge');
  });

  it('throws a clear error when an edge references an unknown node id', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'x', label: 'X' }],
      edges: [{ source: 'x', target: 'missing' }],
    };
    expect(() => buildGraph(graph)).toThrow(/unknown node id "missing"/i);
  });

  it('throws a clear error on a duplicate node id', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'x', label: 'X' }, { id: 'x', label: 'X again' }],
      edges: [],
    };
    expect(() => buildGraph(graph)).toThrow(/duplicate node id "x"/i);
  });

  it('throws a clear error on a self-loop edge', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'x', label: 'X' }],
      edges: [{ source: 'x', target: 'x' }],
    };
    expect(() => buildGraph(graph)).toThrow(/self-loop/i);
  });

  it('silently dedupes a duplicate edge (same source+target, no explicit id)', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }],
      edges: [{ source: 'x', target: 'y' }, { source: 'x', target: 'y' }],
    };
    const { edges } = buildGraph(graph);
    expect(edges).toHaveLength(1);
  });

  it('reuses x/y from a previous D3GraphNode with the same id via previousById', () => {
    const first = buildGraph(sampleGraph);
    const a = first.nodes.find((n) => n.id === 'a')!;
    a.x = 111;
    a.y = 222;

    const previousById = new Map(first.nodes.map((n) => [n.id, n]));
    const second = buildGraph(sampleGraph, previousById);

    const secondA = second.nodes.find((n) => n.id === 'a')!;
    expect(secondA.x).toBe(111);
    expect(secondA.y).toBe(222);
  });

  it('assigns a fresh random position (unchanged spawn range) to a node absent from previousById', () => {
    const { nodes } = buildGraph(sampleGraph, new Map());
    for (const n of nodes) {
      expect(n.x).toBeDefined();
      expect(Math.abs(n.x!)).toBeLessThanOrEqual(30);
    }
  });
});

describe('classifyShape', () => {
  it('classifies a single-rooted tree as \'tree\'', () => {
    const { nodes, edges } = buildGraph(sampleGraph);
    expect(classifyShape(nodes, edges)).toBe('tree');
  });

  it('classifies a DAG with a two-parent node as \'graph\'', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'shared', label: 'Shared' }],
      edges: [{ source: 'a', target: 'shared' }, { source: 'b', target: 'shared' }],
    };
    const { nodes, edges } = buildGraph(graph);
    expect(classifyShape(nodes, edges)).toBe('graph');
  });

  it('classifies a cyclic graph as \'graph\'', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
    };
    const { nodes, edges } = buildGraph(graph);
    expect(classifyShape(nodes, edges)).toBe('graph');
  });

  it('classifies two disconnected trees (a forest) as \'graph\'', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'a', label: 'A' }, { id: 'a1', label: 'A1' }, { id: 'b', label: 'B' }, { id: 'b1', label: 'B1' }],
      edges: [{ source: 'a', target: 'a1' }, { source: 'b', target: 'b1' }],
    };
    const { nodes, edges } = buildGraph(graph);
    expect(classifyShape(nodes, edges)).toBe('graph');
  });

  it('does not crash on an empty graph', () => {
    const { nodes, edges } = buildGraph({ nodes: [], edges: [] });
    expect(['tree', 'graph']).toContain(classifyShape(nodes, edges));
  });

  it('classifies a single node with no edges as \'tree\'', () => {
    const { nodes, edges } = buildGraph({ nodes: [{ id: 'solo', label: 'Solo' }], edges: [] });
    expect(classifyShape(nodes, edges)).toBe('tree');
  });
});

describe('computeVisibleGraph', () => {
  const sharedGraph: MindmapGraph = {
    nodes: [
      { id: 'p1', label: 'Parent 1' },
      { id: 'p2', label: 'Parent 2' },
      { id: 'shared', label: 'Shared' },
      { id: 'shared-child', label: 'Shared Child' },
    ],
    edges: [
      { source: 'p1', target: 'shared' },
      { source: 'p2', target: 'shared' },
      { source: 'shared', target: 'shared-child' },
    ],
  };

  it('shows every node when nothing is collapsed, in either mode', () => {
    const { nodes, edges } = buildGraph(sharedGraph);
    for (const mode of ['global', 'per-edge'] as const) {
      const { visibleNodes } = computeVisibleGraph(nodes, edges, mode);
      expect(visibleNodes.map((n) => n.id).sort()).toEqual(['p1', 'p2', 'shared', 'shared-child']);
    }
  });

  it('global mode: collapsing one parent hides the shared node everywhere, even via the other parent', () => {
    const { nodes, edges } = buildGraph(sharedGraph);
    nodes.find((n) => n.id === 'p1')!.collapsed = true;

    const { visibleNodes } = computeVisibleGraph(nodes, edges, 'global');
    expect(visibleNodes.map((n) => n.id).sort()).toEqual(['p1', 'p2']);
  });

  it('per-edge mode: collapsing one parent keeps the shared node visible via the other parent', () => {
    const { nodes, edges } = buildGraph(sharedGraph);
    nodes.find((n) => n.id === 'p1')!.collapsed = true;

    const { visibleNodes } = computeVisibleGraph(nodes, edges, 'per-edge');
    expect(visibleNodes.map((n) => n.id).sort()).toEqual(['p1', 'p2', 'shared', 'shared-child']);
  });

  it('per-edge mode: collapsing both parents hides the shared node', () => {
    const { nodes, edges } = buildGraph(sharedGraph);
    nodes.find((n) => n.id === 'p1')!.collapsed = true;
    nodes.find((n) => n.id === 'p2')!.collapsed = true;

    const { visibleNodes } = computeVisibleGraph(nodes, edges, 'per-edge');
    expect(visibleNodes.map((n) => n.id).sort()).toEqual(['p1', 'p2']);
  });

  it('a visible edge always has both endpoints visible', () => {
    const { nodes, edges } = buildGraph(sharedGraph);
    nodes.find((n) => n.id === 'p1')!.collapsed = true;

    const { visibleNodes, visibleEdges } = computeVisibleGraph(nodes, edges, 'global');
    const visibleIds = new Set(visibleNodes.map((n) => n.id));
    for (const e of visibleEdges) {
      expect(visibleIds.has(e.source.id)).toBe(true);
      expect(visibleIds.has(e.target.id)).toBe(true);
    }
  });

  it('renders a fully cyclic component with no zero-indegree node (seeds from one arbitrary node)', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' }],
    };
    const { nodes, edges } = buildGraph(graph);
    const { visibleNodes } = computeVisibleGraph(nodes, edges, 'global');
    expect(visibleNodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('renders two disconnected components independently', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'a', label: 'A' }, { id: 'a1', label: 'A1' }, { id: 'b', label: 'B' }, { id: 'b1', label: 'B1' }],
      edges: [{ source: 'a', target: 'a1' }, { source: 'b', target: 'b1' }],
    };
    const { nodes, edges } = buildGraph(graph);
    nodes.find((n) => n.id === 'a')!.collapsed = true;

    const { visibleNodes } = computeVisibleGraph(nodes, edges, 'global');
    expect(visibleNodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'b1']);
  });

  it('global mode: prunes a shared descendant reached only through a non-collapsed intermediate node', () => {
    // r -> m -> shared, p2 -> shared, shared -> child. `m` has a single parent (r) and is
    // never collapsed itself, so Phase 1 never marks it visible once `r` is collapsed. The
    // Phase 2 pruning walk must still traverse through `m` to reach and hide `shared` and
    // `child`, even though `m` itself was never in `visible`.
    const graph: MindmapGraph = {
      nodes: [
        { id: 'r', label: 'Root' },
        { id: 'm', label: 'Middle' },
        { id: 'p2', label: 'Parent 2' },
        { id: 'shared', label: 'Shared' },
        { id: 'child', label: 'Child' },
      ],
      edges: [
        { source: 'r', target: 'm' },
        { source: 'm', target: 'shared' },
        { source: 'p2', target: 'shared' },
        { source: 'shared', target: 'child' },
      ],
    };
    const { nodes, edges } = buildGraph(graph);
    nodes.find((n) => n.id === 'r')!.collapsed = true;

    const { visibleNodes } = computeVisibleGraph(nodes, edges, 'global');
    expect(visibleNodes.map((n) => n.id).sort()).toEqual(['p2', 'r']);
  });
});

describe('resolveEntryNode', () => {
  it('returns the node matching an explicit valid entryNodeId', () => {
    const { nodes, edges } = buildGraph(sampleGraph);
    expect(resolveEntryNode(nodes, edges, 'a')?.id).toBe('a');
  });

  it('warns and falls back when entryNodeId does not match any node', () => {
    const { nodes, edges } = buildGraph(sampleGraph);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = resolveEntryNode(nodes, edges, 'nonexistent');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/entryNodeId "nonexistent"/i));
    expect(result?.id).toBe('root'); // the tree's zero-indegree, most-connected node
    warnSpy.mockRestore();
  });

  it('falls back to the zero-indegree node with the most outgoing edges when entryNodeId is omitted', () => {
    const { nodes, edges } = buildGraph(sampleGraph);
    expect(resolveEntryNode(nodes, edges)?.id).toBe('root');
  });

  it('picks the zero-indegree node with more outgoing edges when multiple roots exist', () => {
    const graph: MindmapGraph = {
      nodes: [
        { id: 'x', label: 'X' },
        { id: 'y', label: 'Y' },
        { id: 'x1', label: 'X1' },
        { id: 'y1', label: 'Y1' },
        { id: 'y2', label: 'Y2' },
      ],
      edges: [
        { source: 'x', target: 'x1' },     // x has 1 outgoing edge
        { source: 'y', target: 'y1' },     // y has 2 outgoing edges
        { source: 'y', target: 'y2' },
      ],
    };
    const { nodes, edges } = buildGraph(graph);
    // Both x and y have zero incoming edges (both are roots), but y has more outgoing edges.
    expect(resolveEntryNode(nodes, edges)?.id).toBe('y');
  });

  it('falls back to the most-connected node when no zero-indegree node exists (fully cyclic)', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' }, { source: 'c', target: 'b' }, { source: 'b', target: 'a' }],
    };
    const { nodes, edges } = buildGraph(graph);
    // 'b' has 2 incoming (a->b, c->b) + 2 outgoing (b->c, b->a) = 4 total, the most of any node.
    expect(resolveEntryNode(nodes, edges)?.id).toBe('b');
  });

  it('returns null for an empty graph', () => {
    const { nodes, edges } = buildGraph({ nodes: [], edges: [] });
    expect(resolveEntryNode(nodes, edges)).toBeNull();
  });
});

describe('nodeRadius', () => {
  it('returns NODE_RADII[depth] for a node with a defined depth', () => {
    const node = { depth: 2 } as D3GraphNode;
    expect(nodeRadius(node)).toBe(NODE_RADII[2]);
  });

  it('returns NODE_RADII[0] for a node with an undefined depth', () => {
    const node = { depth: undefined } as D3GraphNode;
    expect(nodeRadius(node)).toBe(NODE_RADII[0]);
  });

  it('clamps to the last NODE_RADII entry for a depth deeper than the table', () => {
    const node = { depth: 99 } as D3GraphNode;
    expect(nodeRadius(node)).toBe(NODE_RADII[NODE_RADII.length - 1]);
  });
});

describe('computeRadialPositions', () => {
  it('places a lone root at the origin without dividing by zero', () => {
    const { nodes, edges } = buildGraph({ nodes: [{ id: 'solo', label: 'Solo' }], edges: [] });
    computeRadialPositions(nodes[0], nodes, edges);
    expect(nodes[0].targetX).toBeCloseTo(0);
    expect(nodes[0].targetY).toBeCloseTo(0);
  });

  it('places nodes at increasing radius by depth, with distinct angles for siblings', () => {
    const { nodes, edges } = buildGraph(sampleGraph);
    const root = nodes.find((n) => n.id === 'root')!;
    computeRadialPositions(root, nodes, edges);

    const dist = (n: D3GraphNode) => Math.sqrt(n.targetX! ** 2 + n.targetY! ** 2);
    const a = nodes.find((n) => n.id === 'a')!;
    const b = nodes.find((n) => n.id === 'b')!;
    const a1 = nodes.find((n) => n.id === 'a1')!;

    expect(dist(root)).toBeCloseTo(0);
    expect(dist(a)).toBeGreaterThan(0);
    expect(dist(a)).toBeCloseTo(dist(b), 5);
    expect(dist(a1)).toBeGreaterThan(dist(a));
  });

  it('only positions the nodes passed in visibleNodes', () => {
    const { nodes, edges } = buildGraph(sampleGraph);
    const root = nodes.find((n) => n.id === 'root')!;
    const a = nodes.find((n) => n.id === 'a')!;
    const b = nodes.find((n) => n.id === 'b')!;
    const visibleEdges = edges.filter((e) => e.source.id !== 'a'); // drop a->a1, a->a2, as if 'a' were collapsed
    computeRadialPositions(root, [root, a, b], visibleEdges); // a1/a2 excluded

    const a1 = nodes.find((n) => n.id === 'a1')!;
    expect(a1.targetX).toBeUndefined();
  });
});

describe('cycleOutgoingEdge', () => {
  const graph: MindmapGraph = {
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }],
    edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }, { source: 'a', target: 'd' }],
  };

  it('advances forward through outgoing edges in order, wrapping at the end', () => {
    const { nodes, edges } = buildGraph(graph);
    const a = nodes.find((n) => n.id === 'a')!;

    const first = cycleOutgoingEdge(a, edges, 0, 1);
    expect(first.edge?.target.id).toBe('c');
    expect(first.index).toBe(1);

    const wrapped = cycleOutgoingEdge(a, edges, 2, 1);
    expect(wrapped.edge?.target.id).toBe('b');
    expect(wrapped.index).toBe(0);
  });

  it('advances backward, wrapping at the start', () => {
    const { nodes, edges } = buildGraph(graph);
    const a = nodes.find((n) => n.id === 'a')!;

    const back = cycleOutgoingEdge(a, edges, 0, -1);
    expect(back.edge?.target.id).toBe('d');
    expect(back.index).toBe(2);
  });

  it('returns a null edge and index 0 for a node with no outgoing edges', () => {
    const { nodes, edges } = buildGraph(graph);
    const leaf = nodes.find((n) => n.id === 'b')!;

    const result = cycleOutgoingEdge(leaf, edges, 0, 1);
    expect(result.edge).toBeNull();
    expect(result.index).toBe(0);
  });
});
