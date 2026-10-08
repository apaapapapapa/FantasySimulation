import { PublicCatalogCurrentSchema } from '@fantasy/domain/spatial';
import { test, expect, guardNetwork } from '../fixtures.ts';
import { leagueFiles, leagueGenerations, leagueRows } from '../league-fixtures.ts';
import { leagueLink } from '../../apps/web/src/publication/league-route.ts';
import { acceptPublishedLeague } from '../../scripts/league-pages-acceptance.ts';
import { serveFixture } from './fixtures.ts';
import type { PublicReadObservation } from '../../apps/web/src/replay/public-source.ts';
import { experimentalLeagueFiles } from '../experimental-league-fixtures.ts';

test('static-experimental-league-labels', async ({ page, context }, info) => {
  await serveFixture(context, await experimentalLeagueFiles());
  await page.goto('/FantasySimulation/');
  await page.getByRole('link', { name: 'experimental-league（実験）', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '実験基盤リーグ（実験）', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('実験リーグの順位表', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '相性表', exact: true }).click();
  await page.getByRole('link', { name: 'character-0 対 character-1 の試合', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '実験基盤リーグ（実験）', exact: true }),
  ).toBeVisible();
  await info.attach('experimental-league', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

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
  expect(loaded).toHaveLength(4);
  expect(
    loaded.every(
      (v) =>
        v.key.startsWith('catalog/') ||
        v.key === `leagues/${leagueGenerations[1]!.hash.slice(7)}.json` ||
        v.key === `leagues/${leagueGenerations[1]!.snapshot.definition.hash.slice(7)}.json`,
    ),
  ).toBe(true);
  expect(observations).toEqual([]);
  const initial = [...loaded];
  loaded.length = 0;
  await page.goto('/FantasySimulation/?publication-metrics=1');
  await expect(table.getByRole('row')).toHaveCount(4);
  expect(loaded).toEqual(initial);
  expect(observations.filter((entry) => entry.event === 'request')).toHaveLength(4);
  expect(observations.filter((entry) => entry.event === 'failed')).toEqual([]);
  expect(
    observations
      .filter((entry) => entry.event === 'response')
      .map((entry) => ({ key: entry.key, bytes: entry.decodedBytes })),
  ).toEqual(initial);
  // Authenticate classification with the pinned definition; retain the original overview budget.
  expect(
    loaded
      .filter(
        (v) => v.key !== `leagues/${leagueGenerations[1]!.snapshot.definition.hash.slice(7)}.json`,
      )
      .reduce((sum, f) => sum + f.bytes, 0),
  ).toBeLessThan(6000);
  expect(
    loaded
      .filter(
        (v) => v.key === `leagues/${leagueGenerations[1]!.snapshot.definition.hash.slice(7)}.json`,
      )
      .map((v) => v.bytes),
  ).toEqual([leagueGenerations[1]!.snapshot.definition.bytes]);
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
  const scroll = page.getByRole('region', { name: 'リーグ順位表のスクロール領域', exact: true });
  expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(
    (await table.getByRole('button', { name: '総合得点', exact: true }).boundingBox())!.height,
  ).toBeLessThan(60);
  await scroll.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(table.getByRole('row').nth(1).getByRole('cell').last()).toContainText(
    '分母: 予定16枠',
  );
  await scroll.evaluate((element) => {
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

test('static-pages-acceptance', async ({ browser, baseURL, blockedOrigins }) => {
  const league = leagueGenerations[1]!;
  const current = PublicCatalogCurrentSchema.parse(
    JSON.parse(leagueFiles.get('catalog/current.json')!.toString()),
  );
  const expected = {
    viewerUrl: new URL('/FantasySimulation/', baseURL).href,
    catalogHash: current.catalogHash,
    league: { id: league.snapshot.id, snapshot: league.hash },
  };
  let contexts = 0;
  const open = async () => {
    const context = await browser.newContext();
    contexts++;
    await guardNetwork(context, blockedOrigins);
    await serveFixture(context, leagueFiles);
    return { page: await context.newPage(), close: () => context.close() };
  };
  const accepted = await acceptPublishedLeague(open, expected, {
    deadlineMs: 20000,
    intervalMs: 100,
    stepTimeoutMs: 8000,
  });
  expect(accepted).toMatchObject({
    status: 'accepted',
    formal: true,
    planned: 24,
    resolved: 24,
    attempts: [{ error: null }],
  });
  if (accepted.status !== 'accepted') throw new Error('Expected acceptance');
  expect(leagueRows.some((row) => row.replay?.replayId === accepted.replayId)).toBe(true);
  const { pointerMs, leagueMs, replayMs } = accepted.timings;
  expect(pointerMs <= leagueMs && leagueMs <= replayMs).toBe(true);
  // Viewer assets and publication reads are counted per origin; unknown sizes stay explicit.
  expect(accepted.traffic.map((entry) => entry.origin)).toEqual(
    expect.arrayContaining([
      new URL(baseURL!).origin,
      new URL(process.env.FANTASY_UI_DATA_ORIGIN!).origin,
    ]),
  );
  for (const entry of accepted.traffic)
    expect(entry.requests > 0 && entry.bytes >= 0 && entry.unsized <= entry.requests).toBe(true);
  // A pointer that never reaches the committed catalog is retried in new contexts, never accepted.
  const stale = await acceptPublishedLeague(
    open,
    { ...expected, catalogHash: 'sha256:' + '0'.repeat(64) },
    { deadlineMs: 15000, intervalMs: 100, stepTimeoutMs: 5000, maxAttempts: 2 },
  );
  expect(stale.status).toBe('failed');
  expect(stale.attempts).toHaveLength(2);
  expect(stale.attempts.every((attempt) => attempt.error?.startsWith('Stale catalog'))).toBe(true);
  expect(contexts).toBe(1 + stale.attempts.length);
});
