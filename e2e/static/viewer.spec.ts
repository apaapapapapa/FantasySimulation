import { test, expect } from '../fixtures.ts';
import { complete, event, files, match } from './fixtures.ts';

// The fixture records are fixed display inputs. These assertions do not execute combat.
test('static-selection', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(`/FantasySimulation/#/sets/${complete.setHash.slice(7)}/pages/0`);
  const table = page.getByRole('table', { name: '公開試合一覧' });
  await expect(table.getByRole('row')).toHaveCount(101);
  await expect(page.getByRole('region', { name: '試合の選択' })).toContainText('全1000件');
  expect(requests.filter((url) => url.includes('/fixtures/'))).toHaveLength(4);
  expect(requests.some((url) => url.includes('/objects/') || url.includes('/api/'))).toBe(false);
  await page.getByLabel('一覧ページ').selectOption(String(complete.page));
  await expect(
    page.getByRole('link', { name: `リプレイを開く ${complete.row.slotId}` }),
  ).toBeVisible();
  await table.getByRole('button', { name: 'seed', exact: true }).click();
  await page.getByLabel('このページを絞り込み').fill('complete');
  await expect(table.getByRole('row')).toHaveCount(2);
  const link = page.getByRole('link', { name: `リプレイを開く ${complete.row.slotId}` });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('リプレイID', { exact: true })).toHaveText(complete.manifest.id);
  expect(page.url()).toContain(complete.row.slotId.slice(7));
  await expect(page.getByLabel('現在のstep')).toHaveText('0');
  await page.reload();
  await expect(page.getByLabel('現在のstep')).toHaveText('0');
  await expect(page.getByLabel('リプレイID', { exact: true })).toHaveText(complete.manifest.id);
  expect(requests.some((url) => url.includes('/api/'))).toBe(false);
});

test('static-replay-controls', async ({ page }, info) => {
  await page.goto(complete.url);
  const state = page.getByRole('table', { name: '記録された状態' });
  const canvas = page.getByRole('img', { name: '保存ログの3D表示' });
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  await page.getByText('保存結果のhash', { exact: true }).click();
  const result = await page.getByLabel('保存結果のhash').textContent();
  await page.getByLabel('表示stepを入力').fill('120');
  await expect(page.getByLabel('現在のstep')).toHaveText('120');
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(canvas).toHaveAttribute('data-rendered', 'true');
  const savedState = await state.textContent();
  const image = await canvas.screenshot();
  await page.getByRole('combobox', { name: 'カメラ', exact: true }).selectOption('side');
  await expect.poll(async () => (await canvas.screenshot()).equals(image)).toBe(false);
  for (const mode of ['follow', 'free'])
    await page.getByRole('combobox', { name: 'カメラ', exact: true }).selectOption(mode);
  const beforeDrag = await canvas.screenshot();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 20, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await canvas.screenshot()).equals(beforeDrag)).toBe(false);
  await page.getByLabel('記録された軌跡・命中点と形状を表示').check();
  await expect(state).toHaveText(savedState!);
  await page.getByRole('button', { name: '1step戻る' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('現在のstep')).toHaveText('119');
  await page.getByRole('button', { name: '1step進む' }).click();
  await expect(state).toHaveText(savedState!);
  await page.getByRole('button', { name: '先頭へ' }).click();
  await expect(page.getByLabel('現在のstep')).toHaveText('0');
  await page.getByLabel('再生速度').selectOption('2');
  await page.getByRole('button', { name: '再生', exact: true }).click();
  await expect
    .poll(async () => Number(await page.getByLabel('現在のstep').textContent()))
    .toBeGreaterThan(10);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await page.getByLabel('表示stepを入力').fill('120');
  await expect(page.getByLabel('現在のstep')).toHaveText('120');
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(state).toHaveText(savedState!);
  await page.getByText('イベントログを開く', { exact: true }).click();
  await page
    .getByRole('button', { name: `step ${event.step}へ: ${event.id} ${event.kind}`, exact: true })
    .click();
  await expect(page.getByLabel('現在のstep')).toHaveText(String(event.step));
  await expect(page.getByLabel('保存結果のhash')).toHaveText(result!);
  await info.attach('rendered-replay', {
    body: await canvas.screenshot(),
    contentType: 'image/png',
  });
});

test('static-partials', async ({ page }) => {
  for (const kind of ['unresolved', 'truncated'] as const) {
    const partial = match(kind);
    await page.goto(partial.url);
    await expect(page.getByLabel('リプレイ結果')).toHaveText(kind);
    await expect(page.getByLabel('現在のstep')).toHaveText('0');
    await expect(page.getByRole('region', { name: '保存リプレイ' })).toContainText('記録済み範囲');
    await page.getByLabel('表示stepを入力').fill(String(partial.manifest.lastVerifiedStep));
    await expect(page.getByLabel('現在のstep')).toHaveText(
      String(partial.manifest.lastVerifiedStep),
    );
    await expect(page.getByRole('button', { name: '1step進む' })).toBeDisabled();
    await expect(page.getByLabel('リプレイ結果')).toHaveText(kind);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
});

test('static-errors', async ({ page }) => {
  const key = complete.prefix + complete.manifest.chunks[0]!.file;
  const pattern = `**/fixtures/${key}`;
  for (const failure of ['missing', 'corrupt', 'oversize', 'http-gzip']) {
    await page.route(pattern, (route) =>
      route.fulfill(
        failure === 'missing'
          ? { status: 404, body: '' }
          : {
              status: 200,
              headers: {
                'content-type': 'application/gzip',
                ...(failure === 'http-gzip'
                  ? {
                      'content-encoding': 'gzip',
                      'access-control-expose-headers': 'content-encoding',
                    }
                  : {}),
              },
              body:
                failure === 'http-gzip'
                  ? files.get(key)!
                  : failure === 'oversize'
                    ? Buffer.alloc(files.get(key)!.length + 1)
                    : Buffer.from([0, 1, 2]),
            },
      ),
    );
    await page.goto(complete.url);
    await expect(
      page.getByRole('region', { name: '保存リプレイ' }).getByRole('alert'),
    ).toBeVisible();
    await expect(page.getByLabel('現在のstep')).not.toHaveText('1');
    await page.unroute(pattern);
  }
  await page.route('**/fixtures/catalog/current.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: '{bad' }),
  );
  await page.goto('/FantasySimulation/');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('table', { name: '公開試合一覧' })).toHaveCount(0);
});

test('static-stale-navigation', async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const key = complete.prefix + complete.manifest.chunks[0]!.file;
  await page.route(`**/fixtures/${key}`, async (route) => {
    requested();
    await delayed;
    await route.fulfill({ contentType: 'application/gzip', body: files.get(key)! }).catch(() => {});
  });
  await page.goto(complete.url);
  await started;
  await page
    .getByRole('combobox', { name: '試合集', exact: true })
    .selectOption(match('truncated').setHash);
  const truncated = match('truncated');
  await page.getByRole('link', { name: `リプレイを開く ${truncated.row.slotId}` }).click();
  await expect(page.getByLabel('リプレイ結果')).toHaveText('truncated');
  release();
  await expect(page.getByLabel('リプレイID', { exact: true })).toHaveText(truncated.manifest.id);
  await expect(page.getByLabel('リプレイ結果')).toHaveText('truncated');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('static-webgl-fallback', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...args: unknown[]
    ) {
      if (type.startsWith('webgl')) return null;
      return getContext.apply(this, [type, ...args] as Parameters<typeof getContext>);
    } as typeof getContext;
  });
  await page.goto(complete.url);
  await expect(page.getByText(/WebGL|3D表示を利用できません/)).toBeVisible();
  await expect(page.getByRole('img', { name: '保存ログの2D表示' })).toBeVisible();
  await page.getByRole('button', { name: '1step進む' }).click();
  await expect(page.getByLabel('現在のstep')).toHaveText('1');
  await expect(page.getByRole('table', { name: '記録された状態' }).getByRole('row')).toHaveCount(3);
});

test.describe('static origin guard', () => {
  // HTTP is blocked by production CSP before the external-network fixture sees it.
  test.use({ expectedBlockedOrigins: ['ws://127.0.0.1:12345'] });
  test('static-network-boundary', async ({ page }) => {
    await page.goto(complete.url);
    await expect(page.getByLabel('現在のstep')).toHaveText('0');
    const blocked = await page.evaluate(async () => {
      const violation = new Promise<{ url: string; directive: string }>((resolve) => {
        window.addEventListener(
          'securitypolicyviolation',
          (event) =>
            resolve({
              url: event.blockedURI,
              directive: event.effectiveDirective,
            }),
          { once: true },
        );
      });
      await fetch('https://example.invalid/forbidden').catch(() => {});
      const blocked = await violation;
      await new Promise<void>((resolve) => {
        const socket = new WebSocket('ws://127.0.0.1:12345');
        socket.onclose = () => resolve();
        socket.onerror = () => resolve();
      });
      return blocked;
    });
    expect(new URL(blocked.url).origin).toBe('https://example.invalid');
    expect(blocked.directive).toBe('connect-src');
  });
});
