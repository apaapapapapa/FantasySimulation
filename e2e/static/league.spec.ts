import { test, expect } from '../fixtures.ts';
import { leagueFiles, leagueGenerations, leagueRows } from '../league-fixtures.ts';
import { leagueLink } from '../../apps/web/src/publication/league-route.ts';
import { serveFixture } from './fixtures.ts';
import type { PublicReadObservation } from '../../apps/web/src/replay/public-source.ts';

test('static-league-overview', async ({ page, context }, info) => {
  const loaded: { key: string; bytes: number }[] = [];
  const observations: PublicReadObservation[] = [];
  page.on('console', (message) => {
    const prefix = 'FANTASY_PUBLICATION_READ ';
    if (message.text().startsWith(prefix))
      observations.push(JSON.parse(message.text().slice(prefix.length)) as PublicReadObservation);
  });
  await serveFixture(context, leagueFiles, (key, bytes) => loaded.push({ key, bytes }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/FantasySimulation/');
  const table = page.getByRole('table', { name: 'リーグ順位表', exact: true });
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: '正式ランキング' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'リーグ概要' })).toContainText('24 / 24枠が確定');
  expect(loaded).toHaveLength(3);
  expect(
    loaded.every(
      (v) =>
        v.key.startsWith('catalog/') ||
        v.key === `leagues/${leagueGenerations[1]!.hash.slice(7)}.json`,
    ),
  ).toBe(true);
  expect(loaded.reduce((sum, f) => sum + f.bytes, 0)).toBeLessThan(6000);
  expect(observations).toEqual([]);
  const initial = [...loaded];
  loaded.length = 0;
  await page.goto('/FantasySimulation/?publication-metrics=1');
  await expect(table.getByRole('row')).toHaveCount(4);
  expect(loaded).toEqual(initial);
  expect(observations.filter((entry) => entry.event === 'request')).toHaveLength(3);
  expect(observations.filter((entry) => entry.event === 'failed')).toEqual([]);
  expect(
    observations
      .filter((entry) => entry.event === 'response')
      .map((entry) => ({ key: entry.key, bytes: entry.decodedBytes })),
  ).toEqual(initial);
  await info.attach('league-initial-load', {
    body: Buffer.from(
      JSON.stringify({
        requests: loaded.length,
        bytes: loaded.reduce((sum, f) => sum + f.bytes, 0),
        files: loaded,
        observations,
      }),
    ),
    contentType: 'application/json',
  });
  await table.getByRole('button', { name: '総合得点', exact: true }).click();
  for (const row of await table
    .getByRole('row')
    .all()
    .then((rows) => rows.slice(1)))
    await expect(row.getByRole('cell').first()).toHaveText('1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(await table.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(
    (await table.getByRole('button', { name: '総合得点', exact: true }).boundingBox())!.height,
  ).toBeLessThan(60);
  await table.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(table.getByRole('row').nth(1).getByRole('cell').last()).toContainText(
    '分母: 予定16枠',
  );
  await table.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await info.attach('league-mobile', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: '戦場別得点', exact: true }).click();
  await expect(
    page.getByRole('table', { name: '戦場別得点', exact: true }).getByRole('row'),
  ).toHaveCount(4);
  expect(loaded.some((f) => f.key.startsWith('objects/') || f.key.startsWith('sets/'))).toBe(false);
});

test('static-league-pair-replay', async ({ page, context }, info) => {
  const objects: string[] = [];
  await serveFixture(context, leagueFiles, (key) => {
    if (key.startsWith('objects/')) objects.push(key);
  });
  const hash = leagueGenerations[1]!.hash;
  await page.goto('/FantasySimulation/' + leagueLink(hash));
  await page.getByRole('button', { name: '相性表', exact: true }).click();
  const matrix = page.getByRole('table', { name: '相性表', exact: true });
  await expect(matrix.getByRole('row')).toHaveCount(4);
  await expect(matrix.getByRole('link')).toHaveCount(6);
  expect(objects).toHaveLength(0);
  await matrix
    .getByRole('link', { name: 'character-0 対 character-1 の試合', exact: true })
    .click();
  const matches = page.getByRole('table', { name: 'リーグ所属試合', exact: true });
  await expect(matches.getByRole('row')).toHaveCount(9);
  await matches.getByRole('button', { name: 'seed', exact: true }).click();
  const href = await matches.getByRole('link').first().getAttribute('href');
  expect(objects).toHaveLength(0);
  await matches.getByRole('link').first().click();
  await expect(page.getByLabel('現在のstep')).toHaveText('0');
  const selectedId = await page.getByLabel('選択した予定枠', { exact: true }).textContent();
  const row = leagueRows.find((row) => row.slotId === selectedId && row.replay)!;
  await expect(page.getByLabel('リプレイID', { exact: true })).toHaveText(row.replay!.replayId);
  expect(
    objects.every((key) => key.startsWith(`objects/${row.replay!.objectHash.slice(7)}/`)),
  ).toBe(true);
  expect(page.url()).toContain(href!);
  await page.reload();
  await expect(page.getByLabel('リプレイID', { exact: true })).toHaveText(row.replay!.replayId);
  await page.getByText('この試合の保存記録', { exact: true }).click();
  await expect(page.getByLabel('選択したresult', { exact: true })).toHaveText(row.replay!.resultId);
  await info.attach('league-pair-replay', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await page.getByRole('link', { name: '試合一覧へ戻る', exact: true }).click();
  await expect(page.getByRole('region', { name: '保存リプレイ' })).toHaveCount(0);
});

test('static-league-provisional', async ({ page, context }) => {
  await serveFixture(context, leagueFiles);
  const hash = leagueGenerations[0]!.hash;
  await page.goto('/FantasySimulation/' + leagueLink(hash));
  await expect(page.getByRole('heading', { name: '暫定ランキング' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'リーグ概要' })).toContainText('12 / 24枠が確定');
  const table = page.getByRole('table', { name: 'リーグ順位表', exact: true });
  await expect(table).toContainText('表示順');
  await expect(table).toContainText('〜');
  await page.goto('/FantasySimulation/' + leagueLink(hash, 'character-1', 'character-2'));
  const matches = page.getByRole('table', { name: 'リーグ所属試合', exact: true });
  await expect(matches).toContainText('pending');
  await expect(matches).toContainText('この枠のバッチ結果がまだ届いていません');
  await matches.getByRole('link').first().click();
  await expect(page.getByRole('region', { name: '選択した試合' })).toContainText('pending');
  await expect(page.getByRole('region', { name: '保存リプレイ' })).toHaveCount(0);
  await page.goto('/FantasySimulation/#/leagues/latest');
  await expect(page.getByRole('alert')).toHaveText('リーグURLの形式が不正です');
});
