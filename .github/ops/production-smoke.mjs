import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit, expect } from '@playwright/test';
import { publicationGraph } from '../../apps/api/src/publication-graph.ts';
import { publicHttp } from '../../apps/api/src/publication-http.ts';
import { PublicMatchPageSchema, ReplayManifestSchema } from '@fantasy/domain/spatial';

const viewer = 'https://apaapapapapa.github.io/FantasySimulation/';
const reader = 'https://fantasysimulation-replay-reader.tokyojp.workers.dev/';
const expected = process.env.TARGET_SHA;
assert.match(expected ?? '', /^[a-f0-9]{40}$/);
const output = '.generated/harness/production-smoke';
await mkdir(output, { recursive: true });
await writeFile(output + '/started.json', JSON.stringify({ sourceSha: expected, startedAt: new Date().toISOString(), productionData: true }));
const buildResponse = await fetch(viewer + 'build.json', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
assert.equal(buildResponse.status, 200);
const build = await buildResponse.json();
assert.equal(build.sourceSha, expected);
let graphRequests = 0, graphBytes = 0;
const readPublic = publicHttp(reader);
const read = async (key, limit) => {
  assert.ok(++graphRequests <= 300, 'Acceptance request budget');
  const data = await readPublic(key, limit);
  graphBytes += data.length;
  assert.ok(graphBytes <= 10_000_000, 'Acceptance byte budget');
  return data;
};
// Reuse the shared byte/hash/reference/privacy validation rather than reimplementing it.
const graph = await publicationGraph(read);
const ref = graph.catalog.sets.find(r => graph.sets.get(r.setHash).source.sha === expected);
assert.ok(ref, 'The deployed source must have a published set');
const set = graph.sets.get(ref.setHash);
assert.equal(set.totalRows, 2);
assert.equal(set.incompleteRows, 0);
const prefix = 'sets/' + ref.setHash.slice(7) + '/';
const firstPage = set.pages[0];
const rows = PublicMatchPageSchema.parse(JSON.parse((await read(prefix + firstPage.pageHash.slice(7) + '.json', firstPage.bytes)).toString('utf8'))).rows;
assert.equal(rows.length, 2);
const origin = new URL(viewer).origin;
const current = await fetch(reader + 'catalog/current.json', { headers: { Origin: origin }, signal: AbortSignal.timeout(15000) });
assert.equal(current.status, 200);
assert.equal(current.headers.get('access-control-allow-origin'), origin);
assert.deepEqual(await current.json(), graph.current);
const compressed = [...graph.files.values()].find(f => f.key.endsWith('.gz'));
assert.ok(compressed);
const header = await fetch(reader + compressed.key, { method: 'HEAD', headers: { Origin: origin }, signal: AbortSignal.timeout(15000) });
assert.equal(header.status, 200);
assert.match(header.headers.get('content-type'), /application\/gzip/);
assert.equal(header.headers.get('content-encoding'), null);
assert.equal(Number(header.headers.get('content-length')), compressed.bytes);
assert.match(header.headers.get('cache-control'), /immutable/);
assert.equal(header.headers.get('access-control-allow-origin'), origin);
const browserReports = [];
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true, ...(name === 'chromium' ? { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const requests = [], forbidden = [], pageErrors = [];
  await page.route('**/*', route => {
    const request = route.request();
    if (requests.length >= 600) { forbidden.push({ reason: 'Request budget exceeded' }); return route.abort(); }
    const url = new URL(request.url());
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && [origin, new URL(reader).origin].includes(url.origin) && !url.pathname.includes('/api/')) return route.continue();
    forbidden.push({ method: request.method(), url: request.url() });
    return route.abort();
  });
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => pageErrors.push(error.message));
  const matches = [];
  try {
    await page.goto(viewer + '#/sets/' + ref.setHash.slice(7) + '/pages/0');
    await expect(page.getByRole('table', { name: '公開試合一覧' }).getByRole('row')).toHaveCount(3);
    for (const [index, row] of rows.entries()) {
      assert.ok(row.replay);
      const manifest = ReplayManifestSchema.parse(JSON.parse((await read('objects/' + row.replay.objectHash.slice(7) + '/manifest.json', 4_000_000)).toString('utf8')));
      const before = requests.filter(url => url.startsWith(reader)).length;
      await page.getByRole('link', { name: 'リプレイを開く ' + row.slotId, exact: true }).click();
      await expect(page.getByLabel('リプレイID', { exact: true })).toHaveText(manifest.id);
      await expect(page.getByLabel('現在のstep')).toHaveText('0');
      const canvas = page.getByRole('img', { name: '保存ログの3D表示' });
      await expect(canvas).toHaveAttribute('data-rendered', 'true');
      if (manifest.lastVerifiedStep > 0) {
        await page.getByRole('button', { name: '再生', exact: true }).click();
        await expect.poll(async () => Number(await page.getByLabel('現在のstep').textContent())).toBeGreaterThan(0);
        const pause = page.getByRole('button', { name: '一時停止', exact: true });
        if (await pause.isVisible()) await pause.click();
        await page.getByLabel('表示stepを入力').fill(String(manifest.lastVerifiedStep));
        await expect(page.getByLabel('現在のstep')).toHaveText(String(manifest.lastVerifiedStep));
      }
      await page.screenshot({ path: output + '/' + name + '-' + index + '.png', fullPage: true });
      const directUrl = page.url();
      const playbackRequests = requests.filter(url => url.startsWith(reader)).length - before;
      await page.reload();
      await expect(page.getByLabel('リプレイID', { exact: true })).toHaveText(manifest.id);
      await expect(page.getByLabel('現在のstep')).toHaveText('0');
      await expect(canvas).toHaveAttribute('data-rendered', 'true');
      await expect(page.getByRole('alert')).toHaveCount(0);
      matches.push({ slotId: row.slotId, replayId: manifest.id, lastStep: manifest.lastVerifiedStep, directUrl, playbackRequests, reloadRequests: requests.filter(url => url.startsWith(reader)).length - before - playbackRequests });
    }
    assert.deepEqual(forbidden, []);
    assert.deepEqual(pageErrors, []);
    browserReports.push({ browser: name, viewport: '390x844 mobile emulation on Linux', matches, dataRequests: requests.filter(url => url.startsWith(reader)).length, forbidden, pageErrors });
  } catch (error) {
    await page.screenshot({ path: output + '/' + name + '-failure.png', fullPage: true }).catch(() => {});
    await writeFile(output + '/' + name + '-failure.json', JSON.stringify({ message: String(error), text: await page.locator('body').innerText().catch(() => ''), forbidden, pageErrors }, null, 2));
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}
const report = { status: 'verified', sourceSha: expected, build, catalogHash: graph.current.catalogHash, setHash: ref.setHash, storedFiles: graph.files.size, storedBytes: graph.totalBytes, graphRequests, graphBytes, cors: 'exact Pages origin', compression: 'gzip without Content-Encoding', browserReports };
await writeFile(output + '/report.json', JSON.stringify(report, null, 2));
console.log('PRODUCTION_ACCEPTANCE=' + JSON.stringify(report));
