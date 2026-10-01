import { test, expect } from '../fixtures.ts';

async function readyWorkbench(page: import('@playwright/test').Page) {
  await page.goto('/');
  const workbench = page.locator('.skill-workbench');
  await expect(workbench.locator('fieldset').first()).toBeEnabled();
  await expect(workbench.locator('.skill-matrix tbody tr')).toHaveCount(6);
  await expect(workbench.locator('.skill-matrix tbody td')).toHaveCount(72);
  await expect(workbench.locator('.skill-matrix tbody td > button')).toHaveCount(72);
  return workbench;
}

test('skill-workbench-desktop', async ({ page }) => {
  const workbench = await readyWorkbench(page);

  await expect(workbench.locator('.local-note')).toContainText('ローカル専用');
  await expect(workbench.locator('.local-note')).toContainText('公開Pages');
  await expect(workbench).toContainText('条件を解除すると再び選べます');
  await expect(workbench.locator('.skill-paths > button')).toHaveCount(16);

  const firstNode = workbench.locator('.skill-matrix tbody td > button').first();
  const nodeName = (await firstNode.locator('strong').textContent())!.trim();
  const search = workbench.locator('input[type="search"]');
  await search.fill(nodeName);
  await expect(workbench.locator('.skill-matrix tbody td')).toHaveCount(72);
  await expect(workbench.locator('.skill-matrix tbody td[data-match="true"]')).not.toHaveCount(0);
  await expect(workbench.locator('.skill-matrix tbody td[data-match="false"]')).not.toHaveCount(0);
  await expect(
    workbench.locator('.skill-matrix tbody td[data-match="false"] > button').first(),
  ).toBeDisabled();
  await expect(
    workbench.locator('.skill-matrix tbody td[data-match="false"] > button').first(),
  ).toHaveAttribute('tabindex', '-1');

  await firstNode.click();
  const detail = workbench.locator('.skill-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('h3')).toHaveText(nodeName);
  await expect(detail.locator('dl > div')).toHaveCount(7);
  await expect(detail.locator('.skill-node-action')).toBeVisible();

  await search.fill('no-such-workbench-node');
  await expect(workbench.locator('.skill-detail')).toHaveCount(0);
  await expect(workbench.locator('.skill-matrix tbody td > button:enabled')).toHaveCount(0);
  await search.fill('');
  await expect(workbench.locator('.skill-matrix tbody td > button:enabled')).toHaveCount(72);
  await firstNode.click();
  await expect(workbench.locator('.skill-detail')).toBeVisible();

  await workbench.locator('.actions .primary').click();
  await expect(workbench.locator('.message[role="status"]')).toContainText(/revision \d+/);
  const battle = page.locator('.arena');
  await expect(battle.locator(':scope > p[role="status"]')).toContainText(/revision \d+/);
  await battle.locator(':scope > fieldset > button.primary').click();
  await expect(battle.locator('.result')).toBeVisible({ timeout: 15_000 });
  await battle.locator('.result button').click();
  await expect(page.locator('input[type="range"]')).toBeVisible();
});

test('skill-workbench-mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const workbench = await readyWorkbench(page);
  const paths = workbench.locator('.skill-paths');
  const matrix = workbench.locator('.skill-matrix-scroll');

  expect(
    await paths.evaluate((element) => element.scrollWidth > element.clientWidth),
    'path selector should scroll horizontally on mobile',
  ).toBe(true);
  expect(
    await matrix.evaluate((element) => element.scrollWidth > element.clientWidth),
    '72-cell matrix should scroll horizontally on mobile',
  ).toBe(true);

  await matrix.focus();
  await expect(matrix).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => matrix.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);

  const node = workbench.locator('.skill-matrix tbody td > button').nth(12);
  await node.click();
  await expect(workbench.locator('.skill-detail')).toBeVisible();
  await expect(workbench.locator('.skill-node-action')).toHaveCSS('min-height', '44px');
  expect(
    await workbench
      .locator('.skill-loadout-controls')
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
  ).toBe(1);
});
