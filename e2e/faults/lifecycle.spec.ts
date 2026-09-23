import { test, expect } from '../fixtures.ts';
import { uiScenario } from '../contract.ts';

const scenario = uiScenario(process.env.FANTASY_UI_SCENARIO);
if (scenario !== 'timeout' && scenario !== 'crash') throw new Error('Expected a browser fault');

// These deliberately fail. The outer diagnostic verifies the failure evidence, never UI coverage.
test(scenario, async ({ page, browser }, info) => {
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText('APIに接続しました');
  await info.attach('before-fault', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  if (scenario === 'timeout') {
    test.setTimeout(3000);
    await new Promise(() => {});
  } else {
    const disconnected = new Promise<void>((resolve) =>
      browser.once('disconnected', () => resolve()),
    );
    const session = await browser.newBrowserCDPSession();
    await session.send('Browser.crash').catch(() => {});
    await disconnected;
    expect(browser.isConnected()).toBe(false);
    await info.attach('fault-observed', {
      body: Buffer.from('browser-disconnected'),
      contentType: 'text/plain',
    });
    throw new Error('Injected browser crash observed');
  }
});
