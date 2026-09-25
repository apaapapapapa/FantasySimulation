import { PublicMatchPageSchema } from '@fantasy/domain/spatial';
import { test, expect } from '../fixtures.ts';
import { selectionFiles, selectionGenerations, selectionUrl } from '../selection-fixtures.ts';
import { complete, files } from './fixtures.ts';

for (const generation of selectionGenerations) {
  test(`static-selection-${generation.kind}`, async ({ page }) => {
    const objects: string[] = [];
    await page.route('**/fixtures/**', async (route) => {
      const key = route.request().url().split('/fixtures/')[1]!;
      if (key.startsWith('objects/')) objects.push(key);
      const body = selectionFiles.get(key);
      await route.fulfill({
        status: body ? 200 : 404,
        contentType: key.endsWith('.gz') ? 'application/gzip' : 'application/json',
        body: body ?? '',
      });
    });
    for (const row of generation.rows) {
      await page.goto(selectionUrl(generation.setHash));
      const table = page.getByRole('table', { name: '公開試合一覧' });
      await expect(table.getByRole('row')).toHaveCount(4);
      await table.getByRole('button', { name: 'seed', exact: true }).click();
      await table.getByRole('button', { name: '参加者', exact: true }).click();
      await page.getByLabel('このページを絞り込み').fill(String(row.seed));
      objects.length = 0;
      await page.getByRole('link', { name: `リプレイを開く ${row.slotId}` }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('リプレイID', { exact: true })).toHaveText(row.replay!.replayId);
      await expect(page.getByLabel('現在のstep')).toHaveText('0');
      await page.getByText('この試合の保存記録', { exact: true }).click();
      for (const [label, value] of [
        ['bundle', row.replay!.objectHash],
        ['result', row.replay!.resultId],
        ['attempt', row.replay!.attemptId],
      ])
        await expect(page.getByLabel(`選択した${label}`, { exact: true })).toHaveText(value!);
      expect(objects.length).toBeGreaterThanOrEqual(2);
      expect(
        objects.every((key) => key.startsWith(`objects/${row.replay!.objectHash.slice(7)}/`)),
      ).toBe(true);
      await page.reload();
      await expect(page.getByLabel('リプレイID', { exact: true })).toHaveText(row.replay!.replayId);
      await page.getByRole('link', { name: '試合一覧へ戻る' }).click();
      await expect(page.getByRole('region', { name: '保存リプレイ' })).toHaveCount(0);
      if (row.reused) await expect(table).toContainText('保存結果を再利用');
    }
  });
}

test('static-list-cost-and-states', async ({ page }, info) => {
  const measurements: Promise<{ key: string; bytes: number }>[] = [];
  page.on('response', (response) => {
    if (!response.url().includes('/fixtures/')) return;
    measurements.push(
      response.body().then((body) => ({
        key: response.url().split('/fixtures/')[1]!,
        bytes: body.length,
      })),
    );
  });
  await page.goto(`/FantasySimulation/#/sets/${complete.setHash.slice(7)}/pages/0`);
  const table = page.getByRole('table', { name: '公開試合一覧' });
  await expect(table.getByRole('row')).toHaveCount(101);
  const initial = await Promise.all(measurements);
  expect(initial).toHaveLength(4);
  expect(initial.filter((entry) => entry.key.startsWith('objects/'))).toHaveLength(0);
  const bytes = initial.reduce((sum, entry) => sum + entry.bytes, 0);
  expect(bytes).toBe(initial.reduce((sum, entry) => sum + files.get(entry.key)!.length, 0));
  await info.attach('1000-slot-initial-load', {
    body: Buffer.from(
      JSON.stringify(
        { slots: 1000, visibleRows: 100, requests: initial.length, bytes, files: initial },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });
  await expect(table).toContainText('実行に失敗し、再生できる記録がありません');
  await expect(table).toContainText('まだ実行されていません');
  await expect(
    page.getByText('ローカルのデータを表示しています。このURLは他の端末との共有には使えません。'),
  ).toBeVisible();
  const firstPage = initial.find(
    (entry) => entry.key.startsWith('sets/') && !entry.key.endsWith('/set.json'),
  )!;
  const rows = PublicMatchPageSchema.parse(JSON.parse(files.get(firstPage.key)!.toString())).rows;
  for (const state of ['failed', 'pending']) {
    const row = rows.find((row) => row.state === state)!;
    await page.goto(selectionUrl(complete.setHash, row.slotId));
    await expect(page.getByRole('region', { name: '選択した試合' })).toContainText(state);
    await expect(page.getByRole('region', { name: '選択した試合' })).toContainText(
      '再生できません',
    );
    await expect(page.getByRole('region', { name: '保存リプレイ' })).toHaveCount(0);
  }
  expect((await Promise.all(measurements)).some((entry) => entry.key.startsWith('objects/'))).toBe(
    false,
  );
});

test('static-selection-invalid-link', async ({ page }) => {
  await page.goto(complete.url);
  await expect(page.getByLabel('現在のstep')).toHaveText('0');
  await page.goto('/FantasySimulation/#/sets/latest/pages/0');
  await expect(page.getByRole('alert')).toHaveText('リプレイURLの形式が不正です');
  await expect(page.getByRole('region', { name: '保存リプレイ' })).toHaveCount(0);
  await expect(page.getByRole('table', { name: '公開試合一覧' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('alert')).toHaveText('リプレイURLの形式が不正です');
  await expect(page.getByRole('table', { name: '公開試合一覧' })).toHaveCount(0);
});
