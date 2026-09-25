import { test, expect } from '../fixtures.ts';
import { publicFixtures } from '../publication-fixtures.ts';
import { match, serveFixture } from './fixtures.ts';

const archive = publicFixtures(process.cwd(), 'publication-expiry');
const expiry = match('complete', archive, (manifest) => manifest.id === 'status-expiry-240');
test('static-status-expiry', async ({ page, context }) => {
  await serveFixture(context, archive);
  await page.goto(expiry.url);
  await expect(page.getByLabel('現在のstep')).toHaveText('0');
  const state = page.getByRole('table', { name: '記録された状態' });
  await page.getByLabel('表示stepを入力').fill('4');
  await expect(page.getByLabel('現在のstep')).toHaveText('4');
  await expect(state).toContainText('魔法飛行');
  await expect(state).toContainText('0–5');
  const before = await state.textContent();
  await page.getByRole('button', { name: '1step進む' }).click();
  await expect(page.getByLabel('現在のstep')).toHaveText('5');
  await expect(state).not.toContainText('魔法飛行');
  await expect(page.getByRole('region', { name: '再生時刻のログ' })).toContainText('status-remove');
  await page.getByRole('button', { name: '1step戻る' }).click();
  await expect(page.getByLabel('現在のstep')).toHaveText('4');
  await expect(state).toHaveText(before!);
});
