import { test, expect } from '../fixtures.ts';
import { complete, disableWebgl } from './fixtures.ts';

test('static-repeat-playback', async ({ page }) => {
  await disableWebgl(page);
  await page.goto(complete.url);
  const step = page.getByLabel('現在のstep');
  const repeat = page.getByRole('checkbox', { name: '繰り返し再生', exact: true });
  const play = page.getByRole('button', { name: '再生', exact: true });
  const pause = page.getByRole('button', { name: '一時停止', exact: true });
  await expect(step).toHaveText('0');
  await expect(repeat).not.toBeChecked();
  await page.getByLabel('再生速度').selectOption('4');
  await page.getByText('保存結果のhash', { exact: true }).click();
  const hash = await page.getByLabel('保存結果のhash').textContent();
  // Observe rendered frames rather than polling past a short-lived endpoint.
  await step.evaluate((output) => {
    output.setAttribute('data-starts', '0');
    output.setAttribute('data-ends', '0');
    new MutationObserver(() => {
      const key = output.textContent === '0' ? 'data-starts' : 'data-ends';
      if (output.textContent === '0' || output.textContent === '240')
        output.setAttribute(key, String(Number(output.getAttribute(key)) + 1));
    }).observe(output, { childList: true, characterData: true, subtree: true });
  });
  await repeat.check();
  await play.click();
  await expect
    .poll(async () => Number(await step.getAttribute('data-starts')))
    .toBeGreaterThanOrEqual(2);
  expect(Number(await step.getAttribute('data-ends'))).toBeGreaterThanOrEqual(2);
  await pause.click();
  await expect(page.getByRole('status', { name: '読込状態' })).toHaveCount(0);
  const paused = await step.textContent();
  await page.waitForTimeout(100);
  await expect(step).toHaveText(paused!);

  // Seeking stays paused even with repeat enabled. Playback at the end can restart.
  await page.getByLabel('表示stepを入力').fill('240');
  await expect(step).toHaveText('240');
  await expect(play).toBeEnabled();
  await page.getByLabel('再生速度').selectOption('0.5');
  await play.click();
  await expect.poll(async () => Number(await step.textContent())).toBeLessThan(240);
  await expect(pause).toBeVisible();
  await page.getByLabel('再生速度').selectOption('4');
  await repeat.uncheck();
  await expect(step).toHaveText('240');
  await expect(play).toBeDisabled();
  await expect(page.getByRole('region', { name: '再生時刻のログ' })).toContainText('terminal');
  await expect(page.getByLabel('保存結果のhash')).toHaveText(hash!);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
