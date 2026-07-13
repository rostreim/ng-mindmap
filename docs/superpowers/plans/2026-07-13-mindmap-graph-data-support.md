# Mind-map Graph Data Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mind-map's strict single-rooted-tree input (`MindmapNode`) with a general graph (`MindmapGraph` — flat `nodes[]`/`edges[]`), supporting DAGs and cyclic graphs, while tree-shaped data keeps its exact current visual and interaction behavior.

**Architecture:** Two phases. **Phase A (Tasks 1–6)** is purely additive: new pure functions in `mindmap-layout.ts`, built and unit-tested against the new `MindmapGraph`/`D3GraphNode`/`D3GraphEdge` types, coexisting alongside the current `MindmapNode`/`D3Node`/`buildTree`/`flattenVisible`. Nothing in the running app changes — every existing test keeps passing after every Phase A task. **Phase B (Tasks 7–15)** is the cutover: swap `mindmap.ts`, `mindmap.model.ts`, `context-menu.ts`, `app.ts`, and every spec/e2e fixture onto the new model in dependency order, deleting the old tree-only code as each piece is replaced. No `MindmapNode` compatibility shim survives past Task 7 — this is a hard cut, per the design spec.

**Tech Stack:** Angular 21 (standalone, signals, zoneless), D3 v7 (`d3-force`, `d3-hierarchy`, `d3-tree`, `d3-zoom`, `d3-drag`), Vitest (unit, jsdom), Playwright (e2e, real Chromium).

## Global Constraints

- No `MindmapNode` compatibility shim — every consumer (including `app.ts` and all tests) moves to `MindmapGraph` (`nodes[]`/`edges[]`). (Spec: Non-goals)
- `'radial'`/`'hybrid'` layout modes are tree-only; graph-shaped data always uses `'force'`, silently falling back with a `console.warn` if a consumer explicitly requests `'radial'`/`'hybrid'` on graph-shaped data. No new layout algorithm for non-tree data. (Spec: Layout & rendering, Non-goals)
- Collapsing a node still collapses *all* of its own outgoing edges together — no selective per-child collapse. Only propagation to a *shared* (multi-parent) descendant is configurable via `collapseMode: 'global' | 'per-edge'` (default `'global'`). (Spec: Collapse/expand, Non-goals)
- Tree-shaped data (`classifyShape() === 'tree'`) must be pixel-for-pixel and behaviorally identical to today's tree-only behavior: DFS keyboard nav, `role="tree"`/`treeitem` ARIA, plain-line edges by default, depth-scaled link distance. (Spec: Layout & rendering, Keyboard nav, ARIA)
- No edge types/labels/weights, no multi-edge (parallel edge) UI — duplicate edges (same source+target, no explicit `id`) are deduped silently. (Spec: Non-goals, Error handling)
- Every new structural-validation failure (dangling edge reference, duplicate node id, self-loop edge) throws a clear error naming the offending node/edge, at `buildGraph()` time, before `classifyShape()` or D3 ever sees the data. (Spec: Error handling)
- Commands (run from repo root): `npx tsc -b --noEmit` (type-check), `npm test` (Vitest unit), `npm run e2e` (Playwright e2e — auto-starts its own dev server on port 4310).

---

## Task 1: Add `MindmapGraph` data types (additive)

**Files:**
- Modify: `src/app/mindmap/mindmap.model.ts`

**Interfaces:**
- Produces: `MindmapGraphNode { id: string; label: string }`, `MindmapGraphEdge { id?: string; source: string; target: string }`, `MindmapGraph { nodes: MindmapGraphNode[]; edges: MindmapGraphEdge[]; entryNodeId?: string }`, `D3GraphNode extends SimulationNodeDatum { id: string; label: string; depth?: number; collapsed: boolean; sourceNode: MindmapGraphNode; targetX?: number; targetY?: number }`, `D3GraphEdge extends SimulationLinkDatum<D3GraphNode> { id: string; source: D3GraphNode; target: D3GraphNode }`.

This is a pure type addition with no runtime behavior, so there's nothing to red/green — the compiler is the check. `MindmapNode`/`D3Node`/`D3Link` stay untouched for now (removed in Task 7); these new types are added alongside them.

- [ ] **Step 1: Add the new types**

Add to `src/app/mindmap/mindmap.model.ts`, right after the existing `D3Link` interface (before the `// ── Context menu ─────` section):

```ts
// ── Graph data model ──────────────────────────────────────────────────────

export interface MindmapGraphNode {
  id: string;
  label: string;
}

export interface MindmapGraphEdge {
  /** Defaults to `${source}->${target}` if omitted — see buildGraph(). */
  id?: string;
  source: string;
  target: string;
}

export interface MindmapGraph {
  nodes: MindmapGraphNode[];
  edges: MindmapGraphEdge[];
  /** Optional; initial focus/camera + Home key fallback. Unrelated to layout math — see mindmap-layout.ts computeRadialPositions(). */
  entryNodeId?: string;
}

export interface D3GraphNode extends SimulationNodeDatum {
  id: string;
  label: string;
  /** BFS distance from the tree root; only set when classifyShape() === 'tree'. Undefined for graph-shaped data. */
  depth?: number;
  collapsed: boolean;
  sourceNode: MindmapGraphNode;
  targetX?: number;
  targetY?: number;
}

export interface D3GraphEdge extends SimulationLinkDatum<D3GraphNode> {
  id: string;
  source: D3GraphNode;
  target: D3GraphNode;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -b --noEmit`
Expected: no errors (additive-only change).

- [ ] **Step 3: Commit**

```bash
git add src/app/mindmap/mindmap.model.ts
git commit -m "feat(mindmap): add MindmapGraph/D3GraphNode/D3GraphEdge types (additive)"
```

---

## Task 2: `buildGraph()` — construct the internal graph + validation

**Files:**
- Modify: `src/app/mindmap/mindmap-layout.ts`
- Test: `src/app/mindmap/mindmap-layout.spec.ts`

**Interfaces:**
- Consumes: `MindmapGraph`, `MindmapGraphNode`, `MindmapGraphEdge`, `D3GraphNode`, `D3GraphEdge` (Task 1).
- Produces: `buildGraph(graph: MindmapGraph, previousById?: Map<string, D3GraphNode>): { nodes: D3GraphNode[]; edges: D3GraphEdge[] }`. Throws `Error` on a dangling edge reference, duplicate node id, or self-loop edge. `previousById` reuses the existing position-reconciliation feature (ships today for `buildTree()`) so a `data` update still carries forward settled `x`/`y` for matching-id nodes.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/mindmap/mindmap-layout.spec.ts`, after the existing imports (add `buildGraph` to the import from `./mindmap-layout`):

```ts
import { MindmapGraph } from './mindmap.model';
import { buildGraph } from './mindmap-layout';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `buildGraph` is not exported from `./mindmap-layout` (TS compile error in the spec build).

- [ ] **Step 3: Implement `buildGraph()`**

Add to `src/app/mindmap/mindmap-layout.ts`, after the existing `buildTree()`/`flattenVisible()` functions (before the `// ── Tree navigation` section):

```ts
import { D3GraphEdge, D3GraphNode, MindmapGraph } from './mindmap.model';

// ── Graph construction ──────────────────────────────────────────────────────

/**
 * Builds the internal D3GraphNode/D3GraphEdge structures from a MindmapGraph, resolving
 * string id references into live object references (required for D3's force-link, same
 * reason D3Link does this for the tree model). Validates structurally before anything else
 * touches the data — see the three throw sites below — so a bad edge fails clearly and
 * immediately rather than surfacing as a cryptic D3 or classifyShape() error downstream.
 */
export function buildGraph(
  graph: MindmapGraph,
  previousById?: Map<string, D3GraphNode>,
): { nodes: D3GraphNode[]; edges: D3GraphEdge[] } {
  const nodesById = new Map<string, D3GraphNode>();

  for (const raw of graph.nodes) {
    if (nodesById.has(raw.id)) {
      throw new Error(`mindmap: duplicate node id "${raw.id}" — every node id must be unique`);
    }
    const previous = previousById?.get(raw.id);
    nodesById.set(raw.id, {
      id: raw.id,
      label: raw.label,
      collapsed: false,
      sourceNode: raw,
      x: previous?.x ?? (Math.random() - 0.5) * 60,
      y: previous?.y ?? (Math.random() - 0.5) * 60,
    });
  }

  const edgesById = new Map<string, D3GraphEdge>();

  for (const raw of graph.edges) {
    if (raw.source === raw.target) {
      throw new Error(`mindmap: self-loop edge at node "${raw.source}" is not supported`);
    }
    const source = nodesById.get(raw.source);
    if (!source) {
      throw new Error(`mindmap: edge references unknown node id "${raw.source}"`);
    }
    const target = nodesById.get(raw.target);
    if (!target) {
      throw new Error(`mindmap: edge references unknown node id "${raw.target}"`);
    }

    const id = raw.id ?? `${raw.source}->${raw.target}`;
    if (edgesById.has(id)) continue; // silent dedup — see mindmap-layout.spec.ts

    edgesById.set(id, { id, source, target });
  }

  return { nodes: [...nodesById.values()], edges: [...edgesById.values()] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all `buildGraph` tests green, all prior tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/app/mindmap/mindmap-layout.ts src/app/mindmap/mindmap-layout.spec.ts
git commit -m "feat(mindmap): add buildGraph() with structural validation and position reconciliation"
```

---

## Task 3: `classifyShape()` — detect tree-shaped vs. graph-shaped data

**Files:**
- Modify: `src/app/mindmap/mindmap-layout.ts`
- Test: `src/app/mindmap/mindmap-layout.spec.ts`

**Interfaces:**
- Consumes: `D3GraphNode`, `D3GraphEdge` (Task 1), output of `buildGraph()` (Task 2).
- Produces: `classifyShape(nodes: D3GraphNode[], edges: D3GraphEdge[]): 'tree' | 'graph'`.

Definition (from the spec): `'tree'` iff every node has ≤1 incoming edge, there are no cycles, and every node is reachable from one single root. Anything else — including a forest of otherwise-tree-shaped disconnected components — is `'graph'`.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/mindmap/mindmap-layout.spec.ts` (add `classifyShape` to the `./mindmap-layout` import):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `classifyShape` is not exported.

- [ ] **Step 3: Implement `classifyShape()`**

Add to `src/app/mindmap/mindmap-layout.ts`, directly after `buildGraph()`:

```ts
/**
 * 'tree' iff every node has at most one incoming edge, there is no cycle, and every node
 * is reachable from exactly one root (the node with zero incoming edges) — so a forest of
 * otherwise tree-shaped disconnected components is 'graph', not 'tree', since there's no
 * single root to hang a radial/hybrid layout or DFS keyboard order off of.
 */
export function classifyShape(nodes: D3GraphNode[], edges: D3GraphEdge[]): 'tree' | 'graph' {
  if (nodes.length === 0) return 'tree';

  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const childrenOf = new Map<string, D3GraphNode[]>();
  for (const e of edges) {
    inDegree.set(e.target.id, (inDegree.get(e.target.id) ?? 0) + 1);
    if (inDegree.get(e.target.id)! > 1) return 'graph'; // multi-parent
    const kids = childrenOf.get(e.source.id) ?? [];
    kids.push(e.target);
    childrenOf.set(e.source.id, kids);
  }

  const roots = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  if (roots.length !== 1) return 'graph'; // no root, or a forest of several

  const visited = new Set<string>();
  const stack = [roots[0]];
  while (stack.length) {
    const n = stack.pop()!;
    if (visited.has(n.id)) return 'graph'; // cycle
    visited.add(n.id);
    stack.push(...(childrenOf.get(n.id) ?? []));
  }

  return visited.size === nodes.length ? 'tree' : 'graph';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/mindmap/mindmap-layout.ts src/app/mindmap/mindmap-layout.spec.ts
git commit -m "feat(mindmap): add classifyShape() to detect tree- vs graph-shaped data"
```

---

## Task 4: `computeVisibleGraph()` — collapse-aware visibility, both `collapseMode`s

**Files:**
- Modify: `src/app/mindmap/mindmap-layout.ts`
- Test: `src/app/mindmap/mindmap-layout.spec.ts`

**Interfaces:**
- Consumes: `D3GraphNode`, `D3GraphEdge` (Task 1). Reads `node.collapsed`.
- Produces: `computeVisibleGraph(nodes: D3GraphNode[], edges: D3GraphEdge[], collapseMode: 'global' | 'per-edge'): { visibleNodes: D3GraphNode[]; visibleEdges: D3GraphEdge[] }`.

Visibility is seeded from *every* node with zero incoming edges (handles disconnected components, each contributing its own root) — not from a single "entry" node, since `entryNodeId` is a separate, focus-only concept (Task 5) and disconnected components must still render by default. If a component has no zero-in-degree node at all (a fully cyclic component with nothing pointing "in" from outside it), one arbitrary node from that component is added as an extra seed so the whole component still renders — otherwise a self-contained cycle would be permanently invisible.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/mindmap/mindmap-layout.spec.ts` (add `computeVisibleGraph` to the import):

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `computeVisibleGraph` is not exported.

- [ ] **Step 3: Implement `computeVisibleGraph()`**

Add to `src/app/mindmap/mindmap-layout.ts`, directly after `classifyShape()`:

```ts
/**
 * Seeds the visibility walk from every zero-indegree node (one seed per disconnected
 * component's natural root), then adds one arbitrary unreached node per still-unreached
 * component as an extra seed — covers a fully cyclic component with no "outside-in" edge
 * at all, so a self-contained cycle still renders instead of being permanently invisible.
 */
function findVisibilitySeeds(nodes: D3GraphNode[], edges: D3GraphEdge[]): D3GraphNode[] {
  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) inDegree.set(e.target.id, (inDegree.get(e.target.id) ?? 0) + 1);

  const seeds = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  const reached = new Set<string>();
  const outgoing = new Map<string, D3GraphNode[]>();
  for (const e of edges) outgoing.set(e.source.id, [...(outgoing.get(e.source.id) ?? []), e.target]);

  const walk = (start: D3GraphNode) => {
    const stack = [start];
    while (stack.length) {
      const n = stack.pop()!;
      if (reached.has(n.id)) continue;
      reached.add(n.id);
      stack.push(...(outgoing.get(n.id) ?? []));
    }
  };
  seeds.forEach(walk);

  for (const n of nodes) {
    if (!reached.has(n.id)) {
      seeds.push(n);
      walk(n);
    }
  }
  return seeds;
}

/**
 * Two-phase, not two independent branches. Phase 1 is one forward walk from the seeds —
 * identical for both modes — that already gives 'per-edge' semantics: a node is visible if
 * reachable via any path that never passes through a collapsed node (so a shared node stays
 * visible via a non-collapsed parent even while another parent is collapsed). Phase 2 runs
 * only for 'global' mode: a pruning pass that removes anything downstream of a collapsed
 * node *unconditionally*, even if some other path also reaches it — this is what makes
 * collapsing one parent hide a shared descendant everywhere, the behavior 'per-edge' must
 * NOT have. Both phases are O(V+E); fully recomputed each call, no incremental patching,
 * same philosophy as the old flattenVisible().
 */
export function computeVisibleGraph(
  nodes: D3GraphNode[],
  edges: D3GraphEdge[],
  collapseMode: 'global' | 'per-edge',
): { visibleNodes: D3GraphNode[]; visibleEdges: D3GraphEdge[] } {
  const outgoing = new Map<string, D3GraphEdge[]>();
  for (const e of edges) outgoing.set(e.source.id, [...(outgoing.get(e.source.id) ?? []), e]);
  const seeds = findVisibilitySeeds(nodes, edges);
  const seedIds = new Set(seeds.map((s) => s.id));

  // Phase 1: forward walk, stopping at (but including) any collapsed node.
  const visible = new Set<string>();
  const stack = [...seeds];
  while (stack.length) {
    const n = stack.pop()!;
    if (visible.has(n.id)) continue;
    visible.add(n.id);
    if (n.collapsed) continue; // never descend past a collapsed node, in either mode
    for (const e of outgoing.get(n.id) ?? []) stack.push(e.target);
  }

  // Phase 2 ('global' only): unconditionally prune everything downstream of a collapsed
  // node, even if another path also reaches it.
  if (collapseMode === 'global') {
    const collapsedIds = new Set(nodes.filter((n) => n.collapsed).map((n) => n.id));
    for (const collapsedId of collapsedIds) {
      const substack = [...(outgoing.get(collapsedId) ?? []).map((e) => e.target)];
      while (substack.length) {
        const n = substack.pop()!;
        if (!visible.has(n.id)) continue; // already excluded
        if (seedIds.has(n.id)) continue; // a seed is never hidden
        visible.delete(n.id);
        for (const e of outgoing.get(n.id) ?? []) substack.push(e.target);
      }
    }
  }

  const visibleNodes = nodes.filter((n) => visible.has(n.id));
  const visibleEdges = edges.filter((e) => visible.has(e.source.id) && visible.has(e.target.id));
  return { visibleNodes, visibleEdges };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. If the "global mode hides everywhere" or "per-edge keeps visible" tests fail, re-check the pruning pass runs *after* the initial walk and iterates from every `collapsed` node's direct children (not from the collapsed node itself, which stays visible).

- [ ] **Step 5: Commit**

```bash
git add src/app/mindmap/mindmap-layout.ts src/app/mindmap/mindmap-layout.spec.ts
git commit -m "feat(mindmap): add computeVisibleGraph() with global/per-edge collapse propagation"
```

---

## Task 5: `resolveEntryNode()` — entry-point fallback chain

**Files:**
- Modify: `src/app/mindmap/mindmap-layout.ts`
- Test: `src/app/mindmap/mindmap-layout.spec.ts`

**Interfaces:**
- Consumes: `D3GraphNode`, `D3GraphEdge` (Task 1).
- Produces: `resolveEntryNode(nodes: D3GraphNode[], edges: D3GraphEdge[], entryNodeId?: string): D3GraphNode | null`.

Fallback chain: explicit `entryNodeId` if it resolves to a real node → else (or if invalid, with a `console.warn`) the zero-indegree node with the most outgoing edges → else (no zero-indegree node at all, e.g. a fully cyclic graph) the node with the most total (in+out) edges → else (empty graph) `null`.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/mindmap/mindmap-layout.spec.ts` (add `resolveEntryNode` to the import):

```ts
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

  it('falls back to the most-connected node when no zero-indegree node exists (fully cyclic)', () => {
    const graph: MindmapGraph = {
      nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' }, { source: 'c', target: 'b' }],
    };
    const { nodes, edges } = buildGraph(graph);
    // 'b' has 2 incoming (a->b, c->b) + 1 outgoing (b->c) = 3 total, the most of any node.
    expect(resolveEntryNode(nodes, edges)?.id).toBe('b');
  });

  it('returns null for an empty graph', () => {
    const { nodes, edges } = buildGraph({ nodes: [], edges: [] });
    expect(resolveEntryNode(nodes, edges)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `resolveEntryNode` is not exported.

- [ ] **Step 3: Implement `resolveEntryNode()`**

Add to `src/app/mindmap/mindmap-layout.ts`, directly after `computeVisibleGraph()`:

```ts
/**
 * Fallback chain: explicit entryNodeId if valid → the zero-indegree node with the most
 * outgoing edges → (no zero-indegree node at all, e.g. fully cyclic) the most-connected
 * node overall → null for an empty graph. A missing/invalid entryNodeId warns rather than
 * throwing — it's a hint, not a structural requirement (see mindmap-layout.spec.ts).
 */
export function resolveEntryNode(
  nodes: D3GraphNode[],
  edges: D3GraphEdge[],
  entryNodeId?: string,
): D3GraphNode | null {
  if (nodes.length === 0) return null;

  if (entryNodeId) {
    const match = nodes.find((n) => n.id === entryNodeId);
    if (match) return match;
    console.warn(`mindmap: entryNodeId "${entryNodeId}" does not match any node id; falling back to auto-selection`);
  }

  const inDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const outDegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    inDegree.set(e.target.id, (inDegree.get(e.target.id) ?? 0) + 1);
    outDegree.set(e.source.id, (outDegree.get(e.source.id) ?? 0) + 1);
  }

  const roots = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0);
  if (roots.length > 0) {
    return roots.reduce((best, n) => ((outDegree.get(n.id) ?? 0) > (outDegree.get(best.id) ?? 0) ? n : best));
  }

  return nodes.reduce((best, n) => {
    const total = (inDegree.get(n.id) ?? 0) + (outDegree.get(n.id) ?? 0);
    const bestTotal = (inDegree.get(best.id) ?? 0) + (outDegree.get(best.id) ?? 0);
    return total > bestTotal ? n : best;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/mindmap/mindmap-layout.ts src/app/mindmap/mindmap-layout.spec.ts
git commit -m "feat(mindmap): add resolveEntryNode() fallback chain"
```

---

## Task 6: Graph-mode keyboard-nav helpers

**Files:**
- Modify: `src/app/mindmap/mindmap-layout.ts`
- Test: `src/app/mindmap/mindmap-layout.spec.ts`

**Interfaces:**
- Consumes: `D3GraphNode`, `D3GraphEdge` (Task 1).
- Produces: `cycleOutgoingEdge(node: D3GraphNode, edges: D3GraphEdge[], currentIndex: number, direction: 1 | -1): { edge: D3GraphEdge | null; index: number }`.

This is the pure cursor-advance logic behind ArrowUp/Down on graph-shaped data. `mindmap.ts` (Task 10) owns the actual per-node cursor state (a `Map<string, number>`, transient, reset on data change) and the `arrivedVia` back-link (a plain `Map<string, string>` — no helper function needed, it's a one-line `map.set(target.id, source.id)` / `map.get(node.id)`, not worth its own pure function).

- [ ] **Step 1: Write the failing tests**

Add to `src/app/mindmap/mindmap-layout.spec.ts` (add `cycleOutgoingEdge` to the import):

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `cycleOutgoingEdge` is not exported.

- [ ] **Step 3: Implement `cycleOutgoingEdge()`**

Add to `src/app/mindmap/mindmap-layout.ts`, directly after `resolveEntryNode()`:

```ts
/**
 * Advances the "currently selected outgoing edge" cursor for graph-mode ArrowUp/Down —
 * mindmap.ts owns the actual per-node index (transient UI state, not graph structure).
 * Edge order is insertion order (the order edges appear in the built D3GraphEdge array).
 */
export function cycleOutgoingEdge(
  node: D3GraphNode,
  edges: D3GraphEdge[],
  currentIndex: number,
  direction: 1 | -1,
): { edge: D3GraphEdge | null; index: number } {
  const outgoing = edges.filter((e) => e.source.id === node.id);
  if (outgoing.length === 0) return { edge: null, index: 0 };

  const index = (currentIndex + direction + outgoing.length) % outgoing.length;
  return { edge: outgoing[index], index };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/mindmap/mindmap-layout.ts src/app/mindmap/mindmap-layout.spec.ts
git commit -m "feat(mindmap): add cycleOutgoingEdge() for graph-mode keyboard nav"
```

**End of Phase A.** Every existing test still passes; `mindmap.ts`, `app.ts`, and `context-menu.ts` are untouched. Run the full check before starting Phase B:

```bash
npx tsc -b --noEmit && npm test
```

Expected: all green.

---

## Task 7: Cut over `mindmap.model.ts` — remove the old tree-only types

**Files:**
- Modify: `src/app/mindmap/mindmap.model.ts`
- Modify: `src/app/mindmap/mindmap-layout.ts`
- Modify: `src/app/mindmap/mindmap-layout.spec.ts`
- Modify: `src/app/mindmap/context-menu.ts`

**Interfaces:**
- Consumes: `MindmapGraphNode` (Task 1).
- Produces: `ContextMenuFn = (node: MindmapGraphNode) => Promise<MenuEntry[]>`, `NodeClickFn = (node: MindmapGraphNode) => boolean | void` (both were `(node: MindmapNode) => ...`).

This is the hard-cut task: `MindmapNode`, `D3Node`, `D3Link`, `buildTree()`, `flattenVisible()`, and their tests are deleted. `mindmap.ts` isn't touched yet (that's Tasks 8–12) — so **the app will not compile between this task and the end of Task 12**. That's expected and unavoidable for a foundational type rename; there's no way to keep the whole app green mid-rename without a compatibility shim, which the spec explicitly rules out. Tasks 8–12 must be executed as a contiguous block before running the full suite again.

- [ ] **Step 1: Remove `MindmapNode` and update the context-menu types**

In `src/app/mindmap/mindmap.model.ts`, delete the `MindmapNode` interface and its two usages:

```ts
// DELETE this interface:
export interface MindmapNode {
  id: string;
  label: string;
  children?: MindmapNode[];
}
```

Change:
```ts
export type ContextMenuFn = (node: MindmapNode) => Promise<MenuEntry[]>;
export type NodeClickFn = (node: MindmapNode) => boolean | void;
```
to:
```ts
export type ContextMenuFn = (node: MindmapGraphNode) => Promise<MenuEntry[]>;
export type NodeClickFn = (node: MindmapGraphNode) => boolean | void;
```

- [ ] **Step 2: Remove `D3Node` and `D3Link`**

In the same file, delete:

```ts
// DELETE:
export interface D3Node extends SimulationNodeDatum {
  id: string;
  label: string;
  depth: number;
  collapsed: boolean;
  _children: D3Node[] | null;
  children: D3Node[] | null;
  parent: D3Node | null;
  sourceNode: MindmapNode;
  targetX?: number;
  targetY?: number;
}

export interface D3Link extends SimulationLinkDatum<D3Node> {
  source: D3Node;
  target: D3Node;
}
```

`D3GraphNode`/`D3GraphEdge` (Task 1) already cover everything these provided.

- [ ] **Step 3: Type-check to find every remaining reference (expected to fail)**

Run: `npx tsc -b --noEmit`
Expected: FAIL, with errors in `mindmap-layout.ts` (references to `buildTree`, `flattenVisible`, `D3Node`, `MindmapNode`) and `mindmap.ts`/`context-menu.ts` (references to the same). This error list is the authoritative "what's left to migrate" — Tasks 8–12 clear `mindmap.ts`; this task clears `mindmap-layout.ts` and `context-menu.ts` only.

- [ ] **Step 4: Remove `buildTree()`/`flattenVisible()`/`flattenAll()` and their tests**

In `src/app/mindmap/mindmap-layout.ts`, delete the `buildTree()`, `flattenVisible()`, and `flattenAll()` functions (all three fully superseded by `buildGraph()`, whose `previousById` parameter is already a flat `Map<string, D3GraphNode>` — no tree-walking helper needed to build one) and the now-unused `MindmapNode`/`D3Node`/`D3Link` imports at the top of the file.

In `src/app/mindmap/mindmap-layout.spec.ts`, delete the `describe('buildTree', ...)`, `describe('flattenVisible', ...)`, and `describe('flattenAll', ...)` blocks (their coverage is now `describe('buildGraph', ...)` from Task 2, which tests position reconciliation directly via `buildGraph()`'s `previousById` parameter) and the now-unused `sampleData`/`MindmapNode` references — but keep `sampleGraph` (Task 2) and everything added in Tasks 2–6.

- [ ] **Step 5: Fix `context-menu.ts`'s type-only reference**

`context-menu.ts` doesn't import `MindmapNode`/`D3Node` directly — it only uses `MenuEntry`, which is unaffected. Run `npx tsc -b --noEmit` again; if `context-menu.ts` shows no new errors, this file needs no changes. (It's listed under Files because the plan's file-structure step flagged it as a consumer of the changed `ContextMenuFn`/`NodeClickFn` signatures — confirm via the type-check, don't guess.)

- [ ] **Step 6: Type-check again**

Run: `npx tsc -b --noEmit`
Expected: FAIL, now only inside `mindmap.ts` (all `mindmap-layout.ts`/`context-menu.ts`/`mindmap.model.ts` errors resolved). This confirms Tasks 8–12 are the only remaining work before the app compiles again.

- [ ] **Step 7: Run the layout unit tests in isolation**

Run: `npx vitest run src/app/mindmap/mindmap-layout.spec.ts`
Expected: PASS (this file's tests don't depend on `mindmap.ts`, so they're a valid checkpoint even mid-cutover). Note: the full `npm test` command will fail until Task 12, since it also builds `mindmap.spec.ts`/`context-menu.spec.ts`, which depend on `mindmap.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/app/mindmap/mindmap.model.ts src/app/mindmap/mindmap-layout.ts src/app/mindmap/mindmap-layout.spec.ts
git commit -m "refactor(mindmap): remove MindmapNode/D3Node/D3Link/buildTree/flattenVisible (superseded by MindmapGraph model)"
```

---

## Task 8: Cut over `mindmap.ts` data flow — `render()`/`redraw()`, layout-mode gating

**Files:**
- Modify: `src/app/mindmap/mindmap.ts`
- Modify: `src/app/mindmap/mindmap.spec.ts`

**Interfaces:**
- Consumes: `MindmapGraph`, `D3GraphNode`, `D3GraphEdge` (Task 1); `buildGraph`, `classifyShape`, `computeVisibleGraph`, `resolveEntryNode` (Tasks 2, 3, 4, 5).
- Produces: `MindmapComponent.data: InputSignal<MindmapGraph>` (was `InputSignal<MindmapNode>`); private `render()`/`redraw()` rewritten to the new model; `layoutMode` gating (falls back to `'force'` with a `console.warn` when `classifyShape()` returns `'graph'`).

This is the largest single task — it replaces the component's core data pipeline. Steps 1–2 are the failing/passing test cycle for the new `render()` behavior (position reconciliation across a `data` update, now against the graph model); Steps 3–5 are the implementation, covering `render()`, `redraw()`, and layout-mode gating together since they're one cohesive change to the same methods.

- [ ] **Step 1: Write the failing tests**

Replace `src/app/mindmap/mindmap.spec.ts`'s `sampleData`/imports and its `render (data updates)` describe block with:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/mindmap/mindmap.spec.ts`
Expected: FAIL — compile errors (`data` input still typed `MindmapGraph` isn't assignable, `allNodes` doesn't exist, `syncForceSimulation` isn't callable) since `mindmap.ts` hasn't been touched yet.

- [ ] **Step 3: Rewrite `mindmap.ts`'s data/render/redraw pipeline**

In `src/app/mindmap/mindmap.ts`:

Change the import block's `mindmap.model`/`mindmap-layout` lines to:
```ts
import { MindmapGraph, D3GraphNode, D3GraphEdge, MenuEntry, ContextMenuFn, NodeClickFn } from './mindmap.model';
import { buildGraph, classifyShape, computeVisibleGraph, resolveEntryNode } from './mindmap-layout';
```
(No `flattenAll` import — `buildGraph()`'s `previousById` reconciliation (Task 2) takes a flat `Map<string, D3GraphNode>` directly, not a tree to walk, so building it in `render()` below is just `new Map(this.allNodes.map(n => [n.id, n]))`. `flattenAll` was tree-specific with no graph equivalent; it's deleted in Task 7 Step 4 alongside `buildTree`/`flattenVisible`.)

Change the input:
```ts
readonly data = input.required<MindmapGraph>();
```

Change the collapse-mode-adjacent private fields (near `private rootNode!: D3Node;`) to:
```ts
private allNodes: D3GraphNode[] = [];
private allEdges: D3GraphEdge[] = [];
private shape: 'tree' | 'graph' = 'tree';
private entryNode: D3GraphNode | null = null;
```
(delete `private rootNode!: D3Node;`)

Replace `private render(): void { ... }`:
```ts
private render(): void {
  const previousById = new Map(this.allNodes.map((n) => [n.id, n]));
  const built = buildGraph(this.data(), previousById);
  this.allNodes = built.nodes;
  this.allEdges = built.edges;
  this.shape = classifyShape(this.allNodes, this.allEdges);
  this.entryNode = resolveEntryNode(this.allNodes, this.allEdges, this.data().entryNodeId);
  this.focusedNodeId = this.entryNode?.id ?? null;
  this.redraw();
}
```

Replace `private redraw(): void { ... }` (keep the `collapseMode` reference as `'global'` for now — the real input is added in Task 9):
```ts
private redraw(): void {
  this.buildColorScale();
  const { visibleNodes, visibleEdges } = computeVisibleGraph(this.allNodes, this.allEdges, 'global');
  this.visibleNodes = visibleNodes;

  let effectiveLayoutMode = this.layoutMode();
  if (effectiveLayoutMode !== 'force' && this.shape === 'graph') {
    console.warn(`mindmap: layoutMode "${effectiveLayoutMode}" requires tree-shaped data but the current data is graph-shaped — falling back to "force"`);
    effectiveLayoutMode = 'force';
  }

  if (effectiveLayoutMode === 'force') {
    this.syncForceSimulation(visibleNodes, visibleEdges);
    return;
  }

  computeRadialPositions(this.entryNode!, visibleNodes); // TODO(Task 12): update computeRadialPositions() call signature
  if (effectiveLayoutMode === 'hybrid') {
    this.syncHybridSimulation(visibleNodes, visibleEdges);
  } else {
    this.syncRadialLayout(visibleNodes, visibleEdges);
  }
}
```

`computeRadialPositions()`'s signature change (from taking a nested `rootNode: D3Node` to an explicit root + flat node list) is deferred to Task 12, which owns all remaining `mindmap-layout.ts` call sites in `mindmap.ts` — for this task, leave a `// TODO(Task 12): update computeRadialPositions() call signature` comment on that line instead of trying to make it compile; Task 8's own test (`layout-mode gating`, testing the `'force'` path via a graph-shaped fixture) doesn't exercise this line, so it not compiling yet is expected and resolved by Task 12. Do NOT run the full `npx tsc -b` as a pass/fail gate for this task — use `npx vitest run src/app/mindmap/mindmap.spec.ts` instead, which only needs the specific methods under test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/mindmap/mindmap.spec.ts`
Expected: the two new tests (`render (data updates)`, `layout-mode gating`) PASS. Other tests in this file will still fail — `toggleCollapse` (Task 9), keyboard nav (Task 10) — that's expected; don't try to fix them here.

- [ ] **Step 5: Commit**

```bash
git add src/app/mindmap/mindmap.ts src/app/mindmap/mindmap.spec.ts
git commit -m "refactor(mindmap): cut mindmap.ts render()/redraw() over to buildGraph/classifyShape/computeVisibleGraph"
```

---

## Task 9: Cut over collapse/expand — `collapseMode` input, `toggleCollapse()`

**Files:**
- Modify: `src/app/mindmap/mindmap.ts`
- Modify: `src/app/mindmap/mindmap.spec.ts`

**Interfaces:**
- Consumes: `computeVisibleGraph` (Task 4).
- Produces: `MindmapComponent.collapseMode: InputSignal<'global' | 'per-edge'>` (default `'global'`); `toggleCollapse(node: D3GraphNode): void` rewritten (sets `node.collapsed`, calls `redraw()`, no more `children ↔ _children` swap since there's no nested structure to swap).

- [ ] **Step 1: Write the failing tests**

Replace the `toggleCollapse` describe block in `src/app/mindmap/mindmap.spec.ts` with:

```ts
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

  it('is a no-op (still toggles collapsed, but redraw shows no visibility change) for a leaf node', () => {
    (component as any).render();
    const b = (component as any).allNodes.find((n: D3GraphNode) => n.id === 'b');

    (component as any).toggleCollapse(b);
    // A leaf's `collapsed` flag still flips (it's just a boolean on the node), but it has
    // no outgoing edges, so computeVisibleGraph() shows no visible difference either way.
    expect(b.collapsed).toBe(true);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/mindmap/mindmap.spec.ts`
Expected: FAIL — `collapseMode` input doesn't exist; `toggleCollapse` still references the old `children`/`_children`/`isDescendantOf` tree API.

- [ ] **Step 3: Rewrite `toggleCollapse()` and add `collapseMode`**

In `src/app/mindmap/mindmap.ts`, add the input alongside `layoutMode`:
```ts
readonly collapseMode = input<'global' | 'per-edge'>('global');
```

Update `redraw()`'s hardcoded `'global'` (from Task 8, Step 3) to `this.collapseMode()`:
```ts
const { visibleNodes, visibleEdges } = computeVisibleGraph(this.allNodes, this.allEdges, this.collapseMode());
```

Replace the entire `toggleCollapse()` method:
```ts
private toggleCollapse(d: D3GraphNode): void {
  const hasOutgoing = this.allEdges.some((e) => e.source.id === d.id);
  if (!hasOutgoing) return;

  d.collapsed = !d.collapsed;
  this.liveMessage.set(`${d.label} ${d.collapsed ? 'collapsed' : 'expanded'}`);
  this.redraw();
}
```

The old `refocusTarget`/`isDescendantOf` logic (re-focusing the collapsing node itself if the currently-focused node was about to be hidden inside it) is dropped here — it depended on `isDescendantOf()`, a tree-only concept. Re-added generically in Task 10 once `visibleNodes` (post-`computeVisibleGraph`) is available to check membership directly: `if (!this.visibleNodes.some(n => n.id === this.focusedNodeId)) this.moveFocusTo(d);` — add that one-line check at the end of `toggleCollapse()` now, after `this.redraw()`:
```ts
private toggleCollapse(d: D3GraphNode): void {
  const hasOutgoing = this.allEdges.some((e) => e.source.id === d.id);
  if (!hasOutgoing) return;

  d.collapsed = !d.collapsed;
  this.liveMessage.set(`${d.label} ${d.collapsed ? 'collapsed' : 'expanded'}`);
  this.redraw();

  if (this.focusedNodeId && !this.visibleNodes.some((n) => n.id === this.focusedNodeId)) {
    this.moveFocusTo(d);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/mindmap/mindmap.spec.ts`
Expected: `toggleCollapse` describe block PASSES. Keyboard-nav tests (Task 10) still fail — expected.

- [ ] **Step 5: Commit**

```bash
git add src/app/mindmap/mindmap.ts src/app/mindmap/mindmap.spec.ts
git commit -m "refactor(mindmap): rewrite toggleCollapse() for the graph model, add collapseMode input"
```

---

## Task 10: Cut over keyboard navigation — tree branch + new graph branch

**Files:**
- Modify: `src/app/mindmap/mindmap.ts`
- Modify: `src/app/mindmap/mindmap.spec.ts`

**Interfaces:**
- Consumes: `cycleOutgoingEdge` (Task 6).
- Produces: `onNodeKeydown(event: KeyboardEvent, d: D3GraphNode): void` rewritten with a `this.shape === 'tree'` branch (ports the old DFS-order logic onto the flat `visibleNodes` array, which is already in the same DFS order for tree-shaped data since `computeVisibleGraph`'s walk is a DFS from the root) and a `this.shape === 'graph'` branch (edge-cursor traversal).

- [ ] **Step 1: Write the failing tests**

Replace the keyboard-nav-related tests in `src/app/mindmap/mindmap.spec.ts` (the old `onNodeKeydown`/`nodeClickFn` describe block) with:

```ts
describe('onNodeKeydown', () => {
  beforeEach(() => {
    vi.spyOn(component as any, 'redraw').mockImplementation(() => {});
  });

  describe('tree-shaped data', () => {
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/mindmap/mindmap.spec.ts`
Expected: FAIL — `onNodeKeydown` still references `nextVisible`/`previousVisible`/`firstChild`/`d.parent`/`d._children` (tree-only API removed in Task 7), and `outgoingCursor` doesn't exist.

- [ ] **Step 3: Rewrite `onNodeKeydown()`**

In `src/app/mindmap/mindmap.ts`, add two transient Maps near `private visibleNodes: D3GraphNode[] = [];`:
```ts
/** Graph-mode only: "currently selected outgoing edge" cursor per node, for ArrowUp/Down. Reset on data change. */
private outgoingCursor = new Map<string, number>();
/** Graph-mode only: which node ArrowRight was pressed from to reach this node, for ArrowLeft. Reset on data change. */
private arrivedVia = new Map<string, string>();
```

Reset both at the top of `render()` (Task 8's method), right after `this.entryNode = resolveEntryNode(...)`:
```ts
this.outgoingCursor.clear();
this.arrivedVia.clear();
```

Replace the entire `onNodeKeydown()` method:
```ts
private onNodeKeydown(event: KeyboardEvent, d: D3GraphNode): void {
  if (this.shape === 'tree') {
    this.onNodeKeydownTree(event, d);
  } else {
    this.onNodeKeydownGraph(event, d);
  }
}

/** Ported unchanged from the old tree-only implementation — visibleNodes is already in DFS order for tree-shaped data, since computeVisibleGraph()'s walk is a DFS from the single root. */
private onNodeKeydownTree(event: KeyboardEvent, d: D3GraphNode): void {
  switch (event.key) {
    case 'ArrowDown': {
      event.preventDefault();
      const i = this.visibleNodes.findIndex((n) => n.id === d.id);
      if (i !== -1 && i < this.visibleNodes.length - 1) this.moveFocusTo(this.visibleNodes[i + 1]);
      break;
    }
    case 'ArrowUp': {
      event.preventDefault();
      const i = this.visibleNodes.findIndex((n) => n.id === d.id);
      if (i > 0) this.moveFocusTo(this.visibleNodes[i - 1]);
      break;
    }
    case 'ArrowRight': {
      event.preventDefault();
      if (d.collapsed) {
        this.toggleCollapse(d);
      } else {
        const child = this.allEdges.find((e) => e.source.id === d.id)?.target;
        if (child) this.moveFocusTo(child);
      }
      break;
    }
    case 'ArrowLeft': {
      event.preventDefault();
      const hasOutgoing = this.allEdges.some((e) => e.source.id === d.id);
      const parentEdge = this.allEdges.find((e) => e.target.id === d.id);
      if (hasOutgoing && !d.collapsed) {
        this.toggleCollapse(d);
      } else if (parentEdge) {
        this.moveFocusTo(parentEdge.source);
      }
      break;
    }
    case 'Enter':
    case ' ': {
      event.preventDefault();
      if (this.nodeClickFn()?.(d.sourceNode) === true) {
        this.liveMessage.set(`${d.label} activated`);
        return;
      }
      this.toggleCollapse(d);
      break;
    }
    case 'Home': {
      event.preventDefault();
      if (this.visibleNodes.length) this.moveFocusTo(this.visibleNodes[0]);
      break;
    }
    case 'End': {
      event.preventDefault();
      if (this.visibleNodes.length) this.moveFocusTo(this.visibleNodes[this.visibleNodes.length - 1]);
      break;
    }
    case 'F10': {
      if (!event.shiftKey) return;
      event.preventDefault();
      this.openContextMenuForNode(d);
      break;
    }
    case 'ContextMenu': {
      event.preventDefault();
      this.openContextMenuForNode(d);
      break;
    }
  }
}

/** New graph-mode scheme: Up/Down cycle an outgoing-edge cursor (no focus move); Right commits to it; Left retraces via arrivedVia. */
private onNodeKeydownGraph(event: KeyboardEvent, d: D3GraphNode): void {
  switch (event.key) {
    case 'ArrowDown': {
      event.preventDefault();
      const { index } = cycleOutgoingEdge(d, this.allEdges, this.outgoingCursor.get(d.id) ?? 0, 1);
      this.outgoingCursor.set(d.id, index);
      break;
    }
    case 'ArrowUp': {
      event.preventDefault();
      const { index } = cycleOutgoingEdge(d, this.allEdges, this.outgoingCursor.get(d.id) ?? 0, -1);
      this.outgoingCursor.set(d.id, index);
      break;
    }
    case 'ArrowRight': {
      event.preventDefault();
      const { edge } = cycleOutgoingEdge(d, this.allEdges, (this.outgoingCursor.get(d.id) ?? 0) - 1, 1);
      if (edge) {
        this.arrivedVia.set(edge.target.id, d.id);
        this.moveFocusTo(edge.target);
      }
      break;
    }
    case 'ArrowLeft': {
      event.preventDefault();
      const previousId = this.arrivedVia.get(d.id);
      const previous = previousId ? this.allNodes.find((n) => n.id === previousId) : undefined;
      if (previous) this.moveFocusTo(previous);
      break;
    }
    case 'Enter':
    case ' ': {
      event.preventDefault();
      if (this.nodeClickFn()?.(d.sourceNode) === true) {
        this.liveMessage.set(`${d.label} activated`);
        return;
      }
      this.toggleCollapse(d);
      break;
    }
    case 'Home': {
      event.preventDefault();
      if (this.entryNode) this.moveFocusTo(this.entryNode);
      else if (this.visibleNodes.length) this.moveFocusTo(this.visibleNodes[0]);
      break;
    }
    case 'End': {
      event.preventDefault();
      if (this.visibleNodes.length) this.moveFocusTo(this.visibleNodes[this.visibleNodes.length - 1]);
      break;
    }
    case 'F10': {
      if (!event.shiftKey) return;
      event.preventDefault();
      this.openContextMenuForNode(d);
      break;
    }
    case 'ContextMenu': {
      event.preventDefault();
      this.openContextMenuForNode(d);
      break;
    }
  }
}
```

Note the `ArrowRight` cursor read in `onNodeKeydownGraph`: it calls `cycleOutgoingEdge(..., (cursor ?? 0) - 1, 1)` — advancing by `+1` from `cursor - 1` lands back on `cursor` itself, i.e. it *reads* the edge at the current cursor position without advancing it (advancing is ArrowUp/Down's job). This matches the test's expectation that a fresh node (cursor defaults to `0`, never touched by ArrowDown) sends ArrowRight to the *first* outgoing edge.

Also add `cycleOutgoingEdge` to the `mindmap-layout` import (Task 8's import line):
```ts
import { buildGraph, classifyShape, computeVisibleGraph, resolveEntryNode, cycleOutgoingEdge } from './mindmap-layout';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/mindmap/mindmap.spec.ts`
Expected: PASS for both `onNodeKeydown` describe blocks.

- [ ] **Step 5: Commit**

```bash
git add src/app/mindmap/mindmap.ts src/app/mindmap/mindmap.spec.ts
git commit -m "refactor(mindmap): rewrite onNodeKeydown() — tree DFS branch ported, new graph edge-cursor branch"
```

---

## Task 11: ARIA pattern switching + keyboard-cursor visual affordance

**Files:**
- Modify: `src/app/mindmap/mindmap.ts`

**Interfaces:**
- Consumes: `this.shape` (Task 8).
- Produces: `applyNodeAria()` branches by `this.shape`; `initSvg()` sets `role="application"` instead of `role="tree"` when graph-shaped (re-applied on every `redraw()`, since shape can change across a `data` update); the graph-mode outgoing-edge cursor gets a visible highlight reusing the existing hover incident-edge styling.

This task has no new pure logic to unit-test (it's DOM attribute wiring, which — per the project's established pattern in `CLAUDE.md` — is jsdom-untestable since it needs `ngOnInit`'s real SVG setup) — verified via the e2e suite in Task 14 instead. No red/green cycle here; implement directly, verify via `npx tsc -b --noEmit` and manual review.

- [ ] **Step 1: Make the SVG `role` reactive to shape**

In `src/app/mindmap/mindmap.ts`, `initSvg()` currently sets `.attr('role', 'tree')` once. Change it to a no-op default (real value set by `redraw()`, since shape isn't known until the first `render()` call which happens right after `initSvg()` in `ngOnInit()`):

```ts
this.svg = d3.select(this.svgRef.nativeElement)
  .attr('width', this.width())
  .attr('height', this.height())
  .attr('aria-label', this.ariaLabel());
```//removed `.attr('role', 'tree')` from here

Add to the top of `redraw()` (Task 8's method), right after `this.buildColorScale();`:
```ts
this.svg.attr('role', this.shape === 'tree' ? 'tree' : 'application');
```

- [ ] **Step 2: Branch `applyNodeAria()` by shape**

Replace the `applyNodeAria()` method:
```ts
private applyNodeAria(selection: d3.Selection<SVGGElement, D3GraphNode, SVGGElement, unknown>): void {
  const hasOutgoing = (d: D3GraphNode) => this.allEdges.some((e) => e.source.id === d.id);

  if (this.shape === 'tree') {
    selection
      .attr('role', 'treeitem')
      .attr('aria-label', (d) => d.label)
      .attr('aria-level', (d) => (d.depth ?? 0) + 1)
      .attr('aria-setsize', (d) => {
        const parentEdge = this.allEdges.find((e) => e.target.id === d.id);
        if (!parentEdge) return 1;
        return this.allEdges.filter((e) => e.source.id === parentEdge.source.id).length;
      })
      .attr('aria-posinset', (d) => {
        const parentEdge = this.allEdges.find((e) => e.target.id === d.id);
        if (!parentEdge) return 1;
        const siblings = this.allEdges.filter((e) => e.source.id === parentEdge.source.id).map((e) => e.target.id);
        return siblings.indexOf(d.id) + 1;
      })
      .attr('aria-expanded', (d) => (hasOutgoing(d) ? String(!d.collapsed) : null));
  } else {
    selection
      .attr('role', 'button')
      .attr('aria-label', (d) => d.label)
      .attr('aria-expanded', (d) => (hasOutgoing(d) ? String(!d.collapsed) : null));
  }
}
```

`depth` (used for `aria-level` in the tree branch) needs to actually be populated — add depth computation to `render()` (Task 8's method), right before `this.redraw();`:
```ts
if (this.shape === 'tree' && this.entryNode) {
  const depthById = new Map<string, number>([[this.entryNode.id, 0]]);
  const stack = [this.entryNode];
  while (stack.length) {
    const n = stack.pop()!;
    for (const e of this.allEdges.filter((edge) => edge.source.id === n.id)) {
      depthById.set(e.target.id, (depthById.get(n.id) ?? 0) + 1);
      stack.push(e.target);
    }
  }
  for (const n of this.allNodes) n.depth = depthById.get(n.id);
} else {
  for (const n of this.allNodes) n.depth = undefined;
}
```

- [ ] **Step 3: Reuse the hover-highlight styling for the graph-mode keyboard cursor**

In `onNodeKeydownGraph()` (Task 10), after setting `this.outgoingCursor.set(d.id, index)` in both the `ArrowDown` and `ArrowUp` cases, call a new helper that applies the same edge highlight `enterNodes()`'s `mouseover` handler already uses:

```ts
private highlightOutgoingCursor(node: D3GraphNode): void {
  const { edge } = cycleOutgoingEdge(node, this.allEdges, (this.outgoingCursor.get(node.id) ?? 0) - 1, 1);
  this.g.select('.links').selectAll<SVGLineElement, D3GraphEdge>('line')
    .transition().duration(HOVER_TRANSITION_MS)
    .attr('stroke-opacity', (link) => (link.id === edge?.id ? 1 : 0.15))
    .attr('stroke-width', (link) => (link.id === edge?.id ? 2 : 1.5))
    .attr('stroke', (link) => (link.id === edge?.id ? this.colorScale(0) : this.tc.edgeStroke));
}
```

Call it from both `ArrowDown`/`ArrowUp` cases in `onNodeKeydownGraph()`, right after `this.outgoingCursor.set(d.id, index);`:
```ts
this.highlightOutgoingCursor(d);
```

- [ ] **Step 4: Type-check**

Run: `npx tsc -b --noEmit`
Expected: no errors in `mindmap.ts` related to this task's changes (other pending errors from Task 12's not-yet-done `computeRadialPositions()` call are still expected at this point).

- [ ] **Step 5: Commit**

```bash
git add src/app/mindmap/mindmap.ts
git commit -m "feat(mindmap): switch ARIA pattern by shape (tree/treeitem vs application/button), highlight graph-mode keyboard cursor"
```

---

## Task 12: Edge rendering — arrowheads, `edgeDirection` input, link-distance fallback, finish `computeRadialPositions()` cutover

**Files:**
- Modify: `src/app/mindmap/mindmap-layout.ts`
- Modify: `src/app/mindmap/mindmap-layout.spec.ts`
- Modify: `src/app/mindmap/mindmap.ts`

**Interfaces:**
- Consumes: `D3GraphNode`, `D3GraphEdge` (Task 1).
- Produces: `computeRadialPositions(root: D3GraphNode, visibleNodes: D3GraphNode[]): void` (signature changed from the old `(rootNode: D3Node): void` — needs an explicit node list since there's no `.children` to walk); `MindmapComponent.edgeDirection: InputSignal<'arrow' | 'plain'>` (default: shape-dependent — `'arrow'` for graph-shaped, `'plain'` for tree-shaped, unless explicitly set).

- [ ] **Step 1: Write the failing test for the `computeRadialPositions()` signature change**

Replace the `computeRadialPositions` describe block in `src/app/mindmap/mindmap-layout.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/mindmap/mindmap-layout.spec.ts`
Expected: FAIL — `computeRadialPositions()`'s current signature takes a nested `D3Node` (which no longer exists after Task 7's deletion) and only two parameters, not three.

- [ ] **Step 3: Rewrite `computeRadialPositions()`**

Replace the existing `computeRadialPositions()` in `src/app/mindmap/mindmap-layout.ts` (it previously used `d3.hierarchy(rootNode)` walking `.children`, which no longer exists on `D3GraphNode` — a flat structure needs the edge list passed in explicitly to reconstruct parent/child relationships):

```ts
/**
 * Computes deterministic radial-tree target positions for `visibleNodes` (a subset of the
 * full node set, e.g. with a collapsed subtree excluded), rooted at `root`. Builds a d3
 * hierarchy from `visibleEdges` rather than walking a nested `.children` (D3GraphNode is
 * flat — see mindmap.model.ts) — same d3-hierarchy/d3-tree math as before, just fed an
 * adjacency function instead of a property accessor.
 */
export function computeRadialPositions(root: D3GraphNode, visibleNodes: D3GraphNode[], visibleEdges: D3GraphEdge[]): void {
  const visibleIds = new Set(visibleNodes.map((n) => n.id));
  const childrenById = new Map<string, D3GraphNode[]>();
  for (const e of visibleEdges) {
    childrenById.set(e.source.id, [...(childrenById.get(e.source.id) ?? []), e.target]);
  }

  const hierarchyRoot = d3.hierarchy(root, (n) => childrenById.get(n.id) ?? []);
  const maxRadius = hierarchyRoot.height * RADIAL_RING_SPACING;
  const layout = d3.tree<D3GraphNode>().size([2 * Math.PI, maxRadius]);

  layout(hierarchyRoot).each((node) => {
    if (!visibleIds.has(node.data.id)) return;
    const angle = node.x - Math.PI / 2;
    const radius = node.y;
    node.data.targetX = radius * Math.cos(angle);
    node.data.targetY = radius * Math.sin(angle);
  });
}
```

- [ ] **Step 4: Fix the `mindmap.ts` call site left pending from Task 8**

In `src/app/mindmap/mindmap.ts`'s `redraw()`, replace the `// TODO(Task 12)` line:
```ts
computeRadialPositions(this.entryNode!, visibleNodes); // TODO(Task 12): update computeRadialPositions() call signature
```
with:
```ts
computeRadialPositions(this.entryNode!, visibleNodes, visibleEdges);
```

Add `computeRadialPositions` to the `mindmap-layout` import (already imports `buildGraph, classifyShape, computeVisibleGraph, resolveEntryNode, cycleOutgoingEdge` from Task 10 — add it to that list).

- [ ] **Step 5: Add `edgeDirection` input and arrowhead marker**

In `mindmap.ts`, add the input alongside `collapseMode`:
```ts
readonly edgeDirection = input<'arrow' | 'plain' | undefined>(undefined);
```

Add a computed default resolver (private method, since the effective value depends on `this.shape`, not just the raw input):
```ts
private effectiveEdgeDirection(): 'arrow' | 'plain' {
  return this.edgeDirection() ?? (this.shape === 'graph' ? 'arrow' : 'plain');
}
```

Add the arrowhead `<marker>` definition to `buildGlowFilter()` — rename the method's intent slightly by adding a second def alongside the existing glow filter (same `defs` selection, same "insert once" guard pattern):
```ts
private buildGlowFilter(): void {
  const defs = this.svg.select<SVGDefsElement>('defs').empty()
    ? this.svg.insert('defs', ':first-child')
    : this.svg.select<SVGDefsElement>('defs');

  if (defs.select('#mm-glow').empty()) {
    const f = defs.append('filter').attr('id', 'mm-glow')
      .attr('x', '-60%').attr('y', '-60%')
      .attr('width', '220%').attr('height', '220%');
    f.append('feGaussianBlur')
      .attr('in', 'SourceGraphic')
      .attr('stdDeviation', String(this.tc.glowStdDeviation))
      .attr('result', 'blur');
    const merge = f.append('feMerge');
    merge.append('feMergeNode').attr('in', 'blur');
    merge.append('feMergeNode').attr('in', 'SourceGraphic');
  }

  if (defs.select('#mm-arrow').empty()) {
    defs.append('marker').attr('id', 'mm-arrow')
      .attr('viewBox', '0 0 10 10')
      .attr('refX', 9).attr('refY', 5)
      .attr('markerWidth', 6).attr('markerHeight', 6)
      .attr('orient', 'auto-start-reverse')
      .append('path')
      .attr('d', 'M 0 0 L 10 5 L 0 10 z')
      .attr('fill', this.tc.edgeStroke);
  }
}
```

Update `updateEdges()` to apply the marker and shorten the line endpoint by the target node's radius (so the arrow tip sits at the node boundary, not inside it):
```ts
private updateEdges(edges: D3GraphEdge[]): void {
  const direction = this.effectiveEdgeDirection();

  this.g.select<SVGGElement>('.links')
    .selectAll<SVGLineElement, D3GraphEdge>('line')
    .data(edges, (d) => d.id)
    .join('line')
    .attr('stroke', this.tc.edgeStroke)
    .attr('stroke-width', 1.5)
    .attr('stroke-opacity', this.tc.edgeOpacity)
    .attr('marker-end', direction === 'arrow' ? 'url(#mm-arrow)' : null);

  this.linksByNode.clear();
  for (const edge of edges) {
    for (const id of [edge.source.id, edge.target.id]) {
      const incident = this.linksByNode.get(id);
      if (incident) incident.push(edge);
      else this.linksByNode.set(id, [edge]);
    }
  }
}
```

Update `tick()` (and the equivalent lines in `syncRadialLayout()`) to shorten the line endpoint when `direction === 'arrow'`, so the marker doesn't render inside the target node's circle:
```ts
private tick(): void {
  const direction = this.effectiveEdgeDirection();
  this.g.select('.links').selectAll<SVGLineElement, D3GraphEdge>('line')
    .attr('x1', (d) => d.source.x!)
    .attr('y1', (d) => d.source.y!)
    .attr('x2', (d) => this.shortenedEndpoint(d, direction).x)
    .attr('y2', (d) => this.shortenedEndpoint(d, direction).y);

  this.g.select('.nodes').selectAll<SVGGElement, D3GraphNode>('g.node')
    .attr('transform', (d) => `translate(${d.x},${d.y})`);
}

/** For 'arrow' mode, pulls the line's endpoint back along the source→target vector by the target's radius, so the arrowhead marker lands on the node's boundary instead of inside it. No-op for 'plain' mode. */
private shortenedEndpoint(d: D3GraphEdge, direction: 'arrow' | 'plain'): { x: number; y: number } {
  if (direction === 'plain') return { x: d.target.x!, y: d.target.y! };

  const dx = d.target.x! - d.source.x!;
  const dy = d.target.y! - d.source.y!;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: d.target.x!, y: d.target.y! }; // buildGraph() already rejects true self-loops; this guards a coincident-position edge case during simulation settle

  const radius = nodeRadius(d.target);
  const ratio = (len - radius) / len;
  return { x: d.source.x! + dx * ratio, y: d.source.y! + dy * ratio };
}
```

Apply the same `shortenedEndpoint()` call in `syncRadialLayout()`'s line-transition block (replace its `.attr('x2', (d) => d.target.x!)`/`.attr('y2', (d) => d.target.y!)` with `.attr('x2', (d) => this.shortenedEndpoint(d, this.effectiveEdgeDirection()).x)`/`.attr('y2', (d) => this.shortenedEndpoint(d, this.effectiveEdgeDirection()).y)`).

- [ ] **Step 6: Link-distance fallback for graph-shaped data**

In `syncForceSimulation()`, change the `.distance(...)` callback:
```ts
.distance((d) => LINK_DISTANCE_BASE + (d.target.depth ?? 0) * LINK_DISTANCE_PER_DEPTH)
```
(was `d.target.depth * LINK_DISTANCE_PER_DEPTH` — `depth` is now `number | undefined`, and Task 11 already sets it to `undefined` for graph-shaped data, so `?? 0` naturally gives the flat `LINK_DISTANCE_BASE` the spec calls for, with zero special-casing needed here.)

- [ ] **Step 7: Run the full test suite**

Run: `npx tsc -b --noEmit && npm test`
Expected: PASS — this is the first point since Task 7 where the whole app compiles and the whole unit-test suite runs. If there are remaining compile errors, they're leftover call sites this task list didn't anticipate; grep for `D3Node`, `MindmapNode`, `buildTree`, `flattenVisible`, `.children`, `.parent`, `._children` across `src/app/mindmap/*.ts` and fix each remaining reference using the equivalent from Tasks 8–12 (adjacency via `this.allEdges`, not nested properties).

- [ ] **Step 8: Commit**

```bash
git add src/app/mindmap/mindmap-layout.ts src/app/mindmap/mindmap-layout.spec.ts src/app/mindmap/mindmap.ts
git commit -m "feat(mindmap): arrowhead edges (edgeDirection input), graph-shaped link-distance fallback, finish computeRadialPositions() cutover"
```

---

## Task 13: Migrate `app.ts`/`app.html` demo data to `MindmapGraph`

**Files:**
- Modify: `src/app/app.ts`
- Modify: `src/app/app.html`

**Interfaces:**
- Consumes: `MindmapGraph`, `MindmapGraphNode` (Task 1); `MindmapComponent.collapseMode`, `edgeDirection` inputs (Tasks 9, 12).

- [ ] **Step 1: Convert the demo tree to `MindmapGraph`, add a DAG toggle**

In `src/app/app.ts`, replace the `readonly graph: MindmapNode = {...}` field with two fixtures and a toggle signal:

```ts
readonly dataMode = signal<'tree' | 'dag'>('tree');

readonly treeGraph: MindmapGraph = {
  entryNodeId: 'root',
  nodes: [
    { id: 'root', label: 'Household' },
    { id: 'frontend', label: 'Frontend' },
    { id: 'angular', label: 'Angular' },
    { id: 'signals', label: 'Signals' },
    { id: 'standalone', label: 'Standalone' },
    { id: 'react', label: 'React' },
    { id: 'hooks', label: 'Hooks' },
    { id: 'suspense', label: 'Suspense' },
    { id: 'd3', label: 'D3.js' },
    { id: 'backend', label: 'Backend' },
    { id: 'node', label: 'Node.js' },
    { id: 'express', label: 'Express' },
    { id: 'fastify', label: 'Fastify' },
    { id: 'go', label: 'Go' },
    { id: 'rust', label: 'Rust' },
    { id: 'data', label: 'Data' },
    { id: 'postgres', label: 'PostgreSQL' },
    { id: 'redis', label: 'Redis' },
    { id: 'kafka', label: 'Kafka' },
    { id: 'devops', label: 'DevOps' },
    { id: 'docker', label: 'Docker' },
    { id: 'k8s', label: 'Kubernetes' },
    { id: 'ci', label: 'CI / CD' },
  ],
  edges: [
    { source: 'root', target: 'frontend' }, { source: 'root', target: 'backend' },
    { source: 'root', target: 'data' }, { source: 'root', target: 'devops' },
    { source: 'frontend', target: 'angular' }, { source: 'frontend', target: 'react' }, { source: 'frontend', target: 'd3' },
    { source: 'angular', target: 'signals' }, { source: 'angular', target: 'standalone' },
    { source: 'react', target: 'hooks' }, { source: 'react', target: 'suspense' },
    { source: 'backend', target: 'node' }, { source: 'backend', target: 'go' }, { source: 'backend', target: 'rust' },
    { source: 'node', target: 'express' }, { source: 'node', target: 'fastify' },
    { source: 'data', target: 'postgres' }, { source: 'data', target: 'redis' }, { source: 'data', target: 'kafka' },
    { source: 'devops', target: 'docker' }, { source: 'devops', target: 'k8s' }, { source: 'devops', target: 'ci' },
  ],
};

/** Same content, but 'd3' is shared between 'frontend' and 'backend' (Node.js visualization tooling), and 'ci' also depends on 'docker' — a small, deliberately non-tree DAG to exercise collapseMode/edgeDirection. */
readonly dagGraph: MindmapGraph = {
  entryNodeId: 'root',
  nodes: this.treeGraph.nodes,
  edges: [
    ...this.treeGraph.edges,
    { source: 'backend', target: 'd3' },   // 'd3' now has two parents: frontend, backend
    { source: 'ci', target: 'docker' },     // creates a cross-link, still no cycle
  ],
};

readonly graph = computed(() => (this.dataMode() === 'tree' ? this.treeGraph : this.dagGraph));

readonly collapseMode = signal<'global' | 'per-edge'>('global');

toggleDataMode(): void {
  this.dataMode.update((m) => (m === 'tree' ? 'dag' : 'tree'));
}

toggleCollapseMode(): void {
  this.collapseMode.update((m) => (m === 'global' ? 'per-edge' : 'global'));
}
```

Add `computed` to the `@angular/core` import at the top of the file.

Update `nodeClickFn`/`nodeContextMenu`'s parameter type from `MindmapNode` to `MindmapGraphNode`, and update the `MindmapNode` import to `MindmapGraph, MindmapGraphNode` from `./mindmap/mindmap.model`.

- [ ] **Step 2: Wire the toggle buttons into the template**

In `src/app/app.html`, add two buttons next to the existing `layoutMode`/`theme` toggles, and pass the new inputs to `<app-mindmap>`:

```html
<button class="theme-toggle" (click)="toggleDataMode()">⎇ {{ dataMode() }}</button>
<button class="theme-toggle" (click)="toggleCollapseMode()">⊟ {{ collapseMode() }}</button>
```

Update the `<app-mindmap>` element's bindings:
```html
<app-mindmap #mm [data]="graph()" [width]="960" [height]="680" [theme]="theme()" [layoutMode]="layoutMode()" [collapseMode]="collapseMode()" [contextMenuFn]="nodeContextMenu" [nodeClickFn]="nodeClickFn" />
```

- [ ] **Step 3: Manual verification**

Run: `npm start` (or `npx ng serve --port 4321` if 4200 is busy)

In a browser: confirm the tree demo renders identically to before this whole feature (plain edges, `role="tree"`); click "⎇ tree" to switch to the DAG demo and confirm `d3` now shows two incoming edges with arrowheads, `role="application"` on the SVG (inspect via devtools), and `radial`/`hybrid` buttons become unavailable (per Task 8's gating — confirm the layout-mode button doesn't offer them, or degrades to force with a console warning if it does).

- [ ] **Step 4: Commit**

```bash
git add src/app/app.ts src/app/app.html
git commit -m "feat(app): migrate demo data to MindmapGraph, add a DAG dataset + collapseMode/dataMode toggles"
```

---

## Task 14: E2e coverage for graph-mode behavior

**Files:**
- Modify: `e2e/mindmap.spec.ts`

**Interfaces:**
- Consumes: `app.ts`'s `dataMode`/`collapseMode` toggles (Task 13).

- [ ] **Step 1: Add the DAG-specific e2e tests**

Append to `e2e/mindmap.spec.ts`:

```ts
test.describe('graph-shaped data (DAG demo)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('button', { hasText: 'tree' }).click(); // switches dataMode to 'dag'
    await expect(page.locator('button', { hasText: 'dag' })).toBeVisible();
  });

  test('radial/hybrid layout options are unavailable for graph-shaped data', async ({ page }) => {
    const layoutButton = page.locator('button', { hasText: /^⟐/ });
    await layoutButton.click({ force: true });
    // Cycling layoutMode on graph-shaped data must stay on 'force' — it should never show
    // 'radial' or 'hybrid' in the button label at all while dataMode is 'dag'.
    await expect(page.locator('button', { hasText: 'radial' })).toHaveCount(0);
    await expect(page.locator('button', { hasText: 'hybrid' })).toHaveCount(0);
  });

  test('edges render with arrowheads by default', async ({ page }) => {
    const line = page.locator('.links line').first();
    await expect(line).toHaveAttribute('marker-end', 'url(#mm-arrow)');
  });

  test('the SVG uses role="application" and nodes use role="button" for graph-shaped data', async ({ page }) => {
    await expect(page.locator('svg.mindmap-svg')).toHaveAttribute('role', 'application');
    await expect(page.locator('g.node').first()).toHaveAttribute('role', 'button');
  });

  test('collapseMode global vs per-edge changes visibility of the shared d3 node', async ({ page }) => {
    // 'd3' is shared between 'frontend' and 'backend' in the DAG fixture (Task 13).
    await expect(page.locator('button', { hasText: 'global' })).toBeVisible();

    await page.locator('g.node', { hasText: /^Frontend$/ }).click({ force: true });
    await expect(page.locator('g.node', { hasText: /^D3\.js$/ })).toHaveCount(0);

    await page.locator('g.node', { hasText: /^Frontend$/ }).click({ force: true }); // expand back
    await page.locator('button', { hasText: 'global' }).click(); // switch to per-edge

    await page.locator('g.node', { hasText: /^Frontend$/ }).click({ force: true });
    // Still visible via 'backend', even with 'frontend' collapsed, in per-edge mode.
    await expect(page.locator('g.node', { hasText: /^D3\.js$/ })).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx playwright test e2e/mindmap.spec.ts -g "graph-shaped data"`
Expected: PASS. If the `collapseMode` test is flaky due to force-layout node repositioning between clicks, add `{ force: true }` to every `.click()` in that test (already present above) and retry with `--retries=2`.

- [ ] **Step 3: Run the full e2e suite (regression check)**

Run: `npx playwright test e2e/mindmap.spec.ts -g "^((?!radial mode).)*$"`
Expected: every pre-existing tree-mode test still passes unchanged (excluding the one pre-existing flaky radial-drag test, a known issue unrelated to this feature — see prior session notes).

- [ ] **Step 4: Commit**

```bash
git add e2e/mindmap.spec.ts
git commit -m "test(e2e): add graph-shaped data coverage (layout gating, arrowheads, ARIA, collapseMode)"
```

---

## Task 15: Full regression pass and final review

**Files:** none (verification only)

- [ ] **Step 1: Type-check**

Run: `npx tsc -b --noEmit`
Expected: clean.

- [ ] **Step 2: Full unit suite**

Run: `npm test`
Expected: all green — every Phase A test (Tasks 1–6), every rewritten `mindmap.spec.ts` test (Tasks 8–10), `context-menu.spec.ts` unchanged and passing.

- [ ] **Step 3: Full e2e suite**

Run: `npx playwright test e2e/mindmap.spec.ts -g "^((?!radial mode).)*$"`
Expected: all green (tree-mode regression tests + Task 14's new graph-mode tests). Separately run the known-flaky radial-drag test a few times to confirm its failure rate is unchanged from before this feature (not worsened):
```bash
npx playwright test e2e/mindmap.spec.ts -g "radial mode" --repeat-each=3
```

- [ ] **Step 4: Manual dev-server check**

Launch the dev server and drive it with a Playwright script (per this project's established pattern — see `run` skill / prior session), confirming: tree demo unchanged, DAG demo's arrowheads/ARIA/collapseMode all visible and functioning, no console errors.

- [ ] **Step 5: Update `CLAUDE.md`**

Update the "Data flow" and "Architecture" sections of `CLAUDE.md` to describe `MindmapGraph`/`buildGraph()`/`classifyShape()`/`computeVisibleGraph()` in place of the old `MindmapNode`/`buildTree()`/`flattenVisible()` description, following the same terse style as the existing sections.

- [ ] **Step 6: Final commit and PR**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for the MindmapGraph data model"
git push -u origin <branch-name>
gh pr create --title "Support graph/DAG data alongside tree data" --body "$(cat <<'EOF'
## Summary
- Replaces MindmapNode with a flat MindmapGraph (nodes[]/edges[]) — see docs/superpowers/specs/2026-07-13-mindmap-graph-data-design.md
- Auto-detects tree- vs graph-shaped data via classifyShape(); radial/hybrid layouts stay tree-only
- New collapseMode input (global/per-edge) for multi-parent collapse propagation
- New edgeDirection input (arrow/plain), defaulting by shape
- Graph-shaped data gets its own keyboard-nav scheme and ARIA pattern (role=application/button vs role=tree/treeitem)
- app.ts demo gets a DAG dataset + toggle to exercise the new behavior

## Test plan
- [x] npx tsc -b --noEmit
- [x] npm test — full unit suite, including new coverage for every pure function in mindmap-layout.ts
- [x] npm run e2e — tree-mode regression suite unchanged, new graph-mode e2e coverage
- [x] Manual dev-server verification (both demo datasets)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

(Branch name: whatever this plan was executed on — created via `git switch -c` before Task 1, per this repo's "never commit to master" rule.)

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** Data model (Task 1, 7), layout gating (Task 8), collapse/expand both modes (Task 4, 9), keyboard nav both branches (Task 6, 10), ARIA both patterns (Task 11), error handling (Task 2), edge direction (Task 12), migration (Task 13), testing (Tasks 2–6, 8–10, 14). Every named spec section has a task.
- **`computeVisibleGraph()` (Task 4) is the trickiest logic in this plan** — it's a two-phase algorithm (a shared forward walk, then a `'global'`-only pruning pass), not two independent per-mode branches. An earlier draft of this task showed a naive single-branch version before the correct one; that's been removed — the task now shows only the final, correct two-phase implementation with a comment explaining why each phase exists. Whoever implements Task 4 should still read that comment closely, since transcribing the code without understanding the two-phase distinction risks "fixing" it back into the naive (wrong) version during any later touch-up.
- **Task 7 is a deliberate break-the-build task** — the app does not compile from Task 7 through Task 12. This is flagged explicitly in Task 7's description; execute Tasks 7–12 as one contiguous block without pausing for a full-suite green check until Task 12 Step 7.
