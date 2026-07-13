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
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 150, cy + 100, { steps: 5 });
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
