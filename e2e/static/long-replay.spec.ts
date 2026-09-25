import { execFileSync } from 'node:child_process';
import { cpus, platform, arch } from 'node:os';
import { test, expect } from '../fixtures.ts';
import { publicFixtures } from '../publication-fixtures.ts';
import { match } from './fixtures.ts';
import { OVERLAY_LABELS } from '../../apps/web/src/replay/overlays.ts';

const archive = publicFixtures(process.cwd(), 'publication-long');
const long = match('complete', archive, (m) => m.lastVerifiedStep === 6000);
const mutual = match('complete', archive, (m) => m.id === 'fixture-replay');
function browserRssKiB() {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, parent, rss, name] = line.trim().split(/\s+/);
      return { pid: Number(pid), parent: Number(parent), rss: Number(rss), name };
    });
  const descendants = new Set([process.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows)
      if (descendants.has(row.parent) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
  }
  return rows
    .filter((r) => descendants.has(r.pid) && r.pid !== process.pid && r.name !== 'ps')
    .reduce((n, r) => n + r.rss, 0);
}
test('static-long-replay', async ({ page, context, browser }, info) => {
  const requested: string[] = [];
  let transferred = 0;
  await context.route('**/fixtures/**', async (route) => {
    const key = new URL(route.request().url()).pathname.split('/fixtures/')[1]!;
    const body = archive.get(key);
    requested.push(key);
    transferred += body?.byteLength ?? 0;
    await route.fulfill({
      status: body ? 200 : 404,
      body: body ?? '',
      headers: {
        'content-type': key.endsWith('.gz') ? 'application/gzip' : 'application/json',
        'access-control-allow-origin': '*',
      },
    });
  });
  const memory = [browserRssKiB()];
  const start = performance.now();
  await page.goto(long.url);
  await expect(page.getByLabel('現在のstep')).toHaveText('0');
  const canvas = page.getByRole('img', { name: '保存ログの3D表示' });
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  const initialMs = performance.now() - start,
    initialBytes = transferred;
  const initialChunks = requested.filter((key) =>
    long.manifest.chunks.some((c) => key === long.prefix + c.file),
  );
  expect(new Set(initialChunks).size).toBeLessThan(long.manifest.chunks.length);
  expect(initialChunks.length).toBeLessThanOrEqual(2);
  memory.push(browserRssKiB());
  await page.getByText('保存結果のhash', { exact: true }).click();
  const hash = await page.getByLabel('保存結果のhash').textContent();
  const measurements: { step: number; milliseconds: number; bytes: number }[] = [];
  const state = page.getByRole('table', { name: '記録された状態' });
  let at3000 = '';
  for (const step of [3000, 6000, 120, 3000]) {
    const started = performance.now(),
      beforeBytes = transferred;
    await page.getByLabel('表示stepを入力').fill(String(step));
    await expect(page.getByLabel('現在のstep')).toHaveText(String(step));
    measurements.push({
      step,
      milliseconds: performance.now() - started,
      bytes: transferred - beforeBytes,
    });
    memory.push(browserRssKiB());
    if (step === 3000) {
      if (at3000) await expect(state).toHaveText(at3000);
      else at3000 = (await state.textContent())!;
    }
  }
  // Overlapping seeks must not apply an older reply. Camera input remains usable while loading.
  await page.getByLabel('表示stepを入力').fill('5900');
  await page.getByLabel('表示stepを入力').fill('2500');
  await page.getByLabel('カメラ', { exact: true }).selectOption('side');
  await expect(page.getByLabel('現在のstep')).toHaveText('2500');
  await page.getByLabel('再生速度').selectOption('4');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('button', { name: '再生', exact: true })).toBeVisible();
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByLabel('表示stepを入力').fill('3000');
  await expect(page.getByLabel('現在のstep')).toHaveText('3000');
  await expect(state).toHaveText(at3000);
  await expect(page.getByLabel('保存結果のhash')).toHaveText(hash!);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('replay-6000-performance', {
    contentType: 'application/json',
    body: Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 1,
          input: long.row.replay,
          chunks: long.manifest.chunks.length,
          environment: {
            browser: browser.browserType().name(),
            version: browser.version(),
            platform: platform(),
            arch: arch(),
            cpu: cpus()[0]?.model,
            logicalCpus: cpus().length,
            node: process.version,
            viewport: page.viewportSize(),
          },
          initialMs,
          initialBytes,
          initialChunks,
          seeks: measurements,
          totalDataBytes: transferred,
          browserDescendantRssKiB: memory,
          maxSampledBrowserRssKiB: Math.max(...memory),
          method:
            'Wall time includes Playwright input/polling. RSS is sampled at milestones for descendants of the test worker, excluding ps; shared pages may be counted more than once. Data bytes are fulfilled payload bytes, including repeat requests, excluding headers and JS assets. Linux CI, not a physical phone.',
        },
        null,
        2,
      ),
    ),
  });
});

test('static-timeline-overlays', async ({ page, context }, info) => {
  await context.route('**/fixtures/**', async (route) => {
    const key = new URL(route.request().url()).pathname.split('/fixtures/')[1]!;
    const body = archive.get(key);
    await route.fulfill({
      status: body ? 200 : 404,
      body: body ?? '',
      headers: {
        'content-type': key.endsWith('.gz') ? 'application/gzip' : 'application/json',
        'access-control-allow-origin': '*',
      },
    });
  });
  await page.goto(mutual.url);
  await expect(page.getByLabel('現在のstep')).toHaveText('0');
  await page.getByLabel('表示stepを入力').fill(String(mutual.manifest.lastVerifiedStep));
  await expect(page.getByLabel('現在のstep')).toHaveText(String(mutual.manifest.lastVerifiedStep));
  const gauges = page.getByRole('meter', { name: / hp$/ });
  await expect(gauges).toHaveCount(2);
  for (const gauge of await gauges.all()) await expect(gauge).toHaveAttribute('value', '0');
  const state = await page.getByRole('table', { name: '記録された状態' }).textContent();
  for (const label of Object.values(OVERLAY_LABELS)) {
    await page.getByLabel(label, { exact: true }).check();
    await expect(page.getByLabel(label, { exact: true })).toBeChecked();
  }
  await expect(page.getByRole('table', { name: '記録された状態' })).toHaveText(state!);
  await expect(page.getByRole('region', { name: '再生時刻のログ' })).toContainText('主観');
  await info.attach('recorded-overlays', {
    body: await page.getByRole('img', { name: '保存ログの3D表示' }).screenshot(),
    contentType: 'image/png',
  });
});
