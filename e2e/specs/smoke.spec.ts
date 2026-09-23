import { test, expect } from '../fixtures.ts';
import { RevisionPageSchema } from '../../packages/domain/src/spatial/index.ts';

test('local-health', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('3D対戦の開発環境');
  await expect(page.getByRole('status', { name: 'API接続' })).toHaveText('APIに接続しました');
  const revisions: unknown = await page.evaluate(async () =>
    (await fetch('/api/characters')).json(),
  );
  // The HTTP payload and current sample revisions use the existing domain schema.
  const samples = RevisionPageSchema.parse(revisions);
  expect(samples.items.length).toBeGreaterThan(0);
  expect(samples.items.every((revision) => revision.kind === 'character')).toBe(true);
  await page.keyboard.press('Control+r');
  await expect(page.getByRole('status', { name: 'API接続' })).toHaveText('APIに接続しました');
  expect(
    await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('16px "Noto Sans JP"');
    }),
  ).toBe(true);
});

for (const [id, response] of [
  [
    'api-http-error',
    { status: 503, contentType: 'application/json', body: '{"error":"fixture unavailable"}' },
  ],
  [
    'api-invalid-json',
    { status: 200, contentType: 'application/json', body: '{"status":"unexpected"}' },
  ],
] as const) {
  test(id, async ({ page }) => {
    await page.route('**/api/health', (route) => route.fulfill(response));
    await page.goto('/');
    await expect(page.getByRole('status', { name: 'API接続' })).toHaveText('APIに接続できません');
  });
}

test.describe('egress policy', () => {
  test.use({ expectedBlockedOrigins: ['https://example.invalid'] });
  test('network-boundary', async ({ page, blockedOrigins }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      try {
        await fetch('https://example.invalid/must-not-leave');
        return 'unexpected';
      } catch {
        return 'blocked';
      }
    });
    expect(result).toBe('blocked');
    expect(blockedOrigins).toEqual(['https://example.invalid']);
  });
});
