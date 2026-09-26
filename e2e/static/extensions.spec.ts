import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../fixtures.ts';
import { complete, disableWebgl } from './fixtures.ts';
import type { Page } from '@playwright/test';

// #82: 2D fallback, phone-width touch controls, local files and step links (display only).
const step = (page: Page) => page.getByLabel('現在のstep');

test('static-webgl-2d-to-end', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (request) => scripts.push(request.url()));
  await disableWebgl(page);
  await page.goto(complete.url);
  await expect(page.getByRole('status', { name: '描画状態' })).toContainText('WebGL');
  const flat = page.getByRole('img', { name: '保存ログの2D表示' });
  await expect(flat).toBeVisible();
  await expect(page.getByRole('img', { name: '保存ログの3D表示' })).toHaveCount(0);
  await expect(step(page)).toHaveText('0');
  // The 3D bundle is never fetched when WebGL is known to be unavailable.
  expect(scripts.some((url) => /\/assets\/Scene-[^/]*\.js$/.test(url))).toBe(false);
  await page.getByLabel('再生速度').selectOption('4');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  const last = String(complete.manifest.lastVerifiedStep);
  await expect(step(page)).toHaveText(last, { timeout: 15000 });
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: '再生時刻のログ' })).toContainText('terminal');
  await expect(page.getByLabel('リプレイ結果')).toHaveText(
    complete.manifest.end.kind === 'result' ? complete.manifest.end.result.outcome.kind : '',
  );
  await page.getByRole('button', { name: '近づく' }).click();
  await expect(flat).toHaveAttribute('data-zoom', '1.5');
  await page.getByRole('button', { name: '先頭へ' }).click();
  await expect(step(page)).toHaveText('0');
  await page.getByText('イベントログを開く', { exact: true }).click();
  await page.getByLabel('ログの区間').selectOption('0');
  await expect(page.getByRole('region', { name: '保存リプレイ' })).toContainText('step 0');
  expect(scripts.some((url) => /\/assets\/Scene-[^/]*\.js$/.test(url))).toBe(false);
});

test.describe('phone-width emulation', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('static-mobile-controls', async ({ page }) => {
    await page.goto(complete.url);
    const canvas = page.getByRole('img', { name: '保存ログの3D表示' });
    await expect(canvas).toHaveAttribute('data-rendered', 'true');
    const overflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expect(canvas).toHaveCSS('touch-action', 'pan-y');
    await page.getByRole('button', { name: '再生', exact: true }).tap();
    await expect.poll(async () => Number(await step(page).textContent())).toBeGreaterThan(0);
    await page.getByRole('button', { name: '一時停止', exact: true }).tap();
    await page.getByLabel('表示step', { exact: true }).fill('120');
    await expect(step(page)).toHaveText('120');
    await page.getByRole('button', { name: '1step進む' }).tap();
    await expect(step(page)).toHaveText('121');
    const before = await canvas.screenshot();
    await page.getByRole('button', { name: '左へ回す' }).tap();
    await expect(page.getByRole('combobox', { name: 'カメラ', exact: true })).toHaveValue('free');
    await expect(canvas).toHaveCSS('touch-action', 'none');
    await expect.poll(async () => (await canvas.screenshot()).equals(before)).toBe(false);
    const turned = await canvas.screenshot();
    await page.getByRole('button', { name: '近づく' }).tap();
    await expect.poll(async () => (await canvas.screenshot()).equals(turned)).toBe(false);
    await expect(step(page)).toHaveText('121');
    await page.getByRole('combobox', { name: 'カメラ', exact: true }).selectOption('side');
    await expect(canvas).toHaveCSS('touch-action', 'pan-y');
    await page.getByRole('combobox', { name: '表示', exact: true }).selectOption('2d');
    const flat = page.getByRole('img', { name: '保存ログの2D表示' });
    await page.getByRole('button', { name: '近づく' }).tap();
    await expect(flat).toHaveAttribute('data-zoom', '1.5');
    expect(await overflow()).toBeLessThanOrEqual(0);
    const box = (await page.getByRole('button', { name: '1step進む' }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
  });
});

const STAGES = join(
  process.cwd(),
  'apps/web/test-fixtures/replays/stage-vanguard-staged-duelist-300',
);
const stageFiles = () =>
  readdirSync(STAGES).map((name) => ({
    name,
    mimeType: name.endsWith('.gz') ? 'application/gzip' : 'application/json',
    buffer: readFileSync(join(STAGES, name)),
  }));
const tarSize = (sizes: number[]) =>
  sizes.reduce((sum, bytes) => sum + 512 + Math.ceil(bytes / 512) * 512, 0) + 1024;

test('static-local-file', async ({ page }) => {
  await page.goto('/FantasySimulation/#/local');
  const picker = page.getByLabel(/リプレイのファイル/);
  await expect(page.getByRole('table', { name: '端末に保存したリプレイ' })).toContainText(
    '保存したリプレイはありません',
  );
  // The public catalog finishes loading before any file is chosen.
  await expect(page.getByRole('navigation', { name: '公開データ' })).toBeVisible();
  const sent: { url: string; method: string; body: boolean }[] = [];
  page.on('request', (request) =>
    sent.push({ url: request.url(), method: request.method(), body: !!request.postDataBuffer() }),
  );
  const files = stageFiles();
  // Oversized and damaged selections are rejected without opening a replay.
  await picker.setInputFiles([
    ...files.filter((f) => f.name !== 'manifest.json'),
    { name: 'manifest.json', mimeType: 'application/json', buffer: Buffer.alloc(4_000_001, 32) },
  ]);
  await expect(page.getByRole('alert')).toContainText('size limit');
  const corrupt = files.map((f) => {
    if (f.name !== 'chunk-00001.ndjson.gz') return f;
    const buffer = Buffer.from(f.buffer);
    buffer[20]! ^= 1;
    return { ...f, buffer };
  });
  await picker.setInputFiles(corrupt);
  await expect(page.getByRole('alert')).toContainText('checksum');
  await picker.setInputFiles(files.filter((f) => f.name !== 'chunk-00003.ndjson.gz'));
  await expect(page.getByRole('alert')).toContainText('missing');
  await expect(page.getByRole('region', { name: 'ローカルリプレイ' })).toHaveCount(0);

  await page.getByLabel(/この端末（ブラウザー）にも保存する/).check();
  await picker.setInputFiles(files);
  const viewer = page.getByRole('region', { name: 'ローカルリプレイ' });
  await expect(viewer.getByRole('note')).toContainText(
    '公開済みの試合・正式なランキングには含まれず',
  );
  await expect(viewer.getByLabel('リプレイID', { exact: true })).toHaveText(
    'stage-vanguard-staged-duelist-300',
  );
  await expect(
    page.getByRole('status').filter({ hasText: 'この端末に保存しました' }),
  ).toBeVisible();
  // #61 records: forced motion, staged dash, multi-stage label, walk/run and stamina.
  const state = viewer.getByRole('table', { name: '記録された状態' });
  await viewer.getByLabel('表示stepを入力').fill('6');
  await expect(state).toContainText('走行');
  await expect(state).toContainText('歩行');
  await expect(state.getByRole('meter', { name: 'left stamina' })).toBeVisible();
  await viewer.getByLabel('表示stepを入力').fill('68');
  await expect(state).toContainText('押し出し 12.0 m/s');
  await expect(state).toContainText('突進 8 m/s');
  await viewer.getByLabel(/押し出し・技の移動/).check();
  await viewer.getByRole('combobox', { name: '表示', exact: true }).selectOption('2d');
  const flat = viewer.getByRole('img', { name: '保存ログの2D表示' });
  await expect(flat.locator('g[stroke="#ff9f5a"]')).toHaveCount(1);
  await expect(flat.locator('g[stroke="#c9a6ff"]')).toHaveCount(1);
  await viewer.getByLabel('表示stepを入力').fill('81');
  await expect(state).toContainText('技 return-cut-v1 第2段/全2段');
  await viewer.getByLabel('表示stepを入力').fill('300');
  await expect(viewer.getByLabel('リプレイ結果')).toHaveText('win');
  // Nothing about the selected files leaves the browser.
  expect(sent.filter((r) => r.body || r.method !== 'GET')).toEqual([]);
  expect(sent.filter((r) => new URL(r.url).origin !== new URL(page.url()).origin)).toEqual([]);

  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: '表示中のリプレイを書き出す' }).click();
  const download = await exported;
  expect(download.suggestedFilename()).toBe('stage-vanguard-staged-duelist-300.replay.tar');
  const tar = readFileSync((await download.path())!);
  expect(tar.length).toBe(tarSize(files.map((f) => f.buffer.length)));
  for (const file of files) expect(tar.includes(file.buffer)).toBe(true);

  await page.reload();
  const saved = page.getByRole('table', { name: '端末に保存したリプレイ' });
  await expect(saved).toContainText('stage-vanguard-staged-duelist-300');
  await saved.getByRole('button', { name: '開く stage-vanguard-staged-duelist-300' }).click();
  await expect(viewer.getByLabel('現在のstep')).toHaveText('0');
  await saved.getByRole('button', { name: '削除 stage-vanguard-staged-duelist-300' }).click();
  await expect(saved).toContainText('保存したリプレイはありません');
  await page.reload();
  await expect(saved).toContainText('保存したリプレイはありません');
  await picker.setInputFiles({
    name: 'backup.replay.tar',
    mimeType: 'application/x-tar',
    buffer: tar,
  });
  await expect(viewer.getByLabel('リプレイID', { exact: true })).toHaveText(
    'stage-vanguard-staged-duelist-300',
  );
});

test('static-step-link', async ({ page }) => {
  await page.goto(`${complete.url}/steps/120`);
  await expect(step(page)).toHaveText('120');
  await expect(page.getByLabel('表示時刻')).toHaveText('2.40秒');
  const link = page.getByRole('link', { name: 'この場面へのリンク' });
  await expect(link).toHaveAttribute(
    'href',
    new RegExp(`${complete.url.split('#')[1]}/steps/120$`),
  );
  await page.getByRole('button', { name: '1step進む' }).click();
  await expect(step(page)).toHaveText('121');
  await expect(link).toHaveAttribute('href', /\/steps\/121$/);
  await link.click();
  await expect(step(page)).toHaveText('121');
  expect(page.url()).toMatch(/\/steps\/121$/);
  await page.reload();
  await expect(step(page)).toHaveText('121');
  await page.goto(`${complete.url}/steps/6000`);
  await expect(page.getByRole('status').filter({ hasText: 'step 6000' })).toContainText(
    '記録済み範囲 0–240',
  );
  await expect(step(page)).toHaveText('0');
  await page.goto(`${complete.url}/steps/6001`);
  await expect(page.getByRole('alert')).toContainText('リプレイURLの形式が不正です');
});
