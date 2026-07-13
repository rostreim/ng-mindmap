import { test, expect } from '@playwright/test';

// These cover exactly what mindmap.spec.ts's unit tests can't: real DOM/SVG geometry
// (getBBox, d3-zoom, drag) that jsdom doesn't implement. See mindmap-app/src/app/mindmap/
// mindmap.spec.ts and mindmap-layout.spec.ts for the pure-logic unit test suite.

const FULL_GRAPH_NODE_COUNT = 23;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('g.node')).toHaveCount(FULL_GRAPH_NODE_COUNT);
});

test('clicking a node with children collapses it, clicking again restores it', async ({ page }) => {
  const devops = page.locator('g.node', { hasText: 'DevOps' });

  await devops.click();
  // DevOps has 3 children (Docker, Kubernetes, CI/CD) — collapsing hides exactly those.
  await expect(page.locator('g.node')).toHaveCount(FULL_GRAPH_NODE_COUNT - 3);

  await devops.click();
  await expect(page.locator('g.node')).toHaveCount(FULL_GRAPH_NODE_COUNT);
});

test('collapsing/expanding a node announces it via the aria-live region', async ({ page }) => {
  const liveRegion = page.locator('[aria-live="polite"]');
  const devops = page.locator('g.node', { hasText: 'DevOps' });

  await devops.click();
  await expect(liveRegion).toHaveText('DevOps collapsed');

  await devops.click();
  await expect(liveRegion).toHaveText('DevOps expanded');
});

test('clicking a leaf node whose nodeClickFn intercepts the click announces activation, not collapse', async ({ page }) => {
  const liveRegion = page.locator('[aria-live="polite"]');
  // 'PostgreSQL' is a leaf under 'Data'; app.ts's nodeClickFn selects leaves and
  // returns true, suppressing the default collapse/expand toggle.
  const postgres = page.locator('g.node', { hasText: 'PostgreSQL' });

  // force: true — the force simulation can settle this leaf anywhere, including under the
  // fixed toolbar; this test only cares that the click fires and its result propagates.
  await postgres.click({ force: true });

  await expect(liveRegion).toHaveText('PostgreSQL activated');
  await expect(page.locator('g.node')).toHaveCount(FULL_GRAPH_NODE_COUNT);
});

test('right-click opens a context menu; selecting an item or pressing Escape closes it', async ({ page }) => {
  // Exercises ContextMenuComponent's document click/keydown listeners and closed.emit(),
  // which now run with no NgZone wrapping at all (removed as decorative dead weight in a
  // zoneless app) — this is the real regression risk of that change.
  //
  // 'Household' (the root) is used rather than a leaf: the force simulation's center
  // force keeps it near the middle of the viewport, so the menu it opens (positioned at
  // the click coordinates) reliably stays on-screen and clickable.
  const node = page.locator('g.node', { hasText: 'Household' });
  const menu = page.locator('.mm-context-menu');

  await node.click({ button: 'right' });
  await expect(menu).toBeVisible();

  await page.locator('.mm-item', { hasText: 'Rename' }).click();
  await expect(menu).toBeHidden();

  await node.click({ button: 'right' });
  await expect(menu).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(node).toBeFocused();
});

test('keyboard arrow navigation moves the roving tabindex/focus to the next visible node', async ({ page }) => {
  const household = page.locator('g.node', { hasText: 'Household' });
  await household.focus();
  await expect(household).toBeFocused();

  await page.keyboard.press('ArrowDown');

  await expect(household).not.toBeFocused();
  await expect(page.locator('g.node:focus')).toHaveCount(1);
});

test('zoom-to-fit recenters the graph after a manual pan', async ({ page }) => {
  const graph = page.locator('g.graph');
  const beforePan = await graph.getAttribute('transform');

  const svg = page.locator('svg.mindmap-svg');
  const box = await svg.boundingBox();
  if (!box) throw new Error('svg not visible');
  // Start from a corner, not the center: the root node loads positioned near the viewport
  // center, so a center-anchored drag risks grabbing it (triggering a node drag) instead of
  // panning the empty canvas.
  const startX = box.x + 20;
  const startY = box.y + 20;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 150, startY + 100, { steps: 5 });
  await page.mouse.up();

  const afterPan = await graph.getAttribute('transform');
  expect(afterPan).not.toBe(beforePan);

  await page.locator('button', { hasText: 'Fit' }).click();
  await page.waitForTimeout(500); // FIT_TRANSITION_MS

  const afterFit = await graph.getAttribute('transform');
  expect(afterFit).not.toBe(afterPan);
});

test('dragging a node in radial mode moves it and it stays put (no snap-back)', async ({ page }) => {
  // 'radial' mode runs no simulation at all, so this is the regression case that motivated
  // making dragBehavior() work without one (see mindmap.ts dragBehavior()).
  await page.locator('button', { hasText: 'force' }).click();
  await expect(page.locator('button', { hasText: 'radial' })).toBeVisible();
  await page.waitForTimeout(500); // RADIAL_TRANSITION_MS settle

  const node = page.locator('g.node', { hasText: 'React' });
  const before = await node.boundingBox();
  if (!before) throw new Error('node not visible');

  const startX = before.x + before.width / 2;
  const startY = before.y + before.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 120, startY - 80, { steps: 10 });
  await page.mouse.up();

  const afterDrag = await node.boundingBox();
  if (!afterDrag) throw new Error('node not visible after drag');
  expect(Math.abs(afterDrag.x - before.x)).toBeGreaterThan(50);

  await page.waitForTimeout(300);
  const afterWait = await node.boundingBox();
  if (!afterWait) throw new Error('node not visible after wait');
  // Loose tolerance: this only needs to rule out a snap-back (a reversal of most/all of the
  // ~120px drag), not assert pixel-perfect stability against minor hover-scale CSS jitter.
  expect(Math.abs(afterWait.x - afterDrag.x)).toBeLessThan(20);
  expect(Math.abs(afterWait.y - afterDrag.y)).toBeLessThan(20);
});

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

  test('graph-mode keyboard traversal: ArrowDown cursors an edge, ArrowRight commits, ArrowLeft retraces', async ({ page }) => {
    // 'Frontend' has three outgoing edges (→angular, →react, →d3), so it can drive the
    // outgoing-edge cursor. Everything here is real KeyboardEvents on focused DOM elements,
    // covering the interaction end-to-end (unit tests call the private handlers directly).
    const frontend = page.locator('g.node', { hasText: /^Frontend$/ });
    await frontend.focus();
    await expect(frontend).toBeFocused();

    // ArrowDown moves the outgoing-edge cursor and highlights exactly one edge
    // (highlightOutgoingCursor() sets stroke-opacity=1 on the cursored line, 0.15 on the
    // rest) — but must NOT move focus (that's ArrowRight's job).
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.links line[stroke-opacity="1"]')).toHaveCount(1);
    await expect(frontend).toBeFocused();

    // ArrowRight commits to the cursored edge, moving focus to its target node.
    await page.keyboard.press('ArrowRight');
    await expect(frontend).not.toBeFocused();
    const committed = page.locator('g.node:focus');
    await expect(committed).toHaveCount(1);

    // ArrowLeft retraces via arrivedVia back to the node we came from ('Frontend').
    await page.keyboard.press('ArrowLeft');
    await expect(frontend).toBeFocused();
  });
});
