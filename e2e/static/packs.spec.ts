import { test, expect } from '../fixtures.ts';
import { packedFixture, packedResponse } from '../packed-fixtures.ts';
import { disableWebgl } from './fixtures.ts';

test('static-packed-replay', async ({ page, context }) => {
  const fixture = packedFixture(),
    ranges: string[] = [];
  await disableWebgl(page);
  await context.route('**/fixtures/**', async (route) => {
    const key = new URL(route.request().url()).pathname.split('/fixtures/')[1]!;
    const range = route.request().headers().range ?? null;
    if (key.startsWith('packs/')) {
      expect(range).toMatch(/^bytes=\d+-\d+$/);
      ranges.push(range!);
    }
    expect(key.startsWith('objects/')).toBe(false);
    await route.fulfill(packedResponse(fixture.files, key, range));
  });
  await page.goto(fixture.url);
  await expect(page.getByRole('table', { name: '公開試合一覧' }).getByRole('row')).toHaveCount(4);
  expect(ranges).toEqual([]);
  const row = fixture.rows[0]!;
  await page.getByRole('link', { name: `リプレイを開く ${row.slotId}` }).click();
  await expect(page.getByLabel('リプレイID', { exact: true })).toHaveText(row.replay.replayId);
  const step = page.getByLabel('現在のstep');
  await expect(step).toHaveText('0');
  for (const value of ['20', '2', '30']) {
    await page.getByLabel('表示stepを入力').fill(value);
    await expect(step).toHaveText(value);
  }
  expect(ranges.length).toBeGreaterThanOrEqual(4);
  await page.reload();
  await expect(page.getByLabel('リプレイID', { exact: true })).toHaveText(row.replay.replayId);
});
