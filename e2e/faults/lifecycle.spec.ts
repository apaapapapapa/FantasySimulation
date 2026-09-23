import { test, expect } from '../fixtures.ts';
import { uiScenario } from '../contract.ts';

const scenario = uiScenario(process.env.FANTASY_UI_SCENARIO);
if (scenario !== 'timeout' && scenario !== 'crash') throw new Error('Expected a browser fault');

// These deliberately fail. The outer diagnostic verifies the failure evidence, never UI coverage.
test(scenario, async ({ page, browser }, info) => {
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'API接続' })).toHaveText('APIに接続しました');
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
    // Browser.crash can hang in headless-shell. Kill only the browser owned by this fixture.
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const owned = processInfo.filter((entry) => entry.type === 'browser');
    expect(owned).toHaveLength(1);
    const pid = owned[0]!.id;
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
      throw new Error('Invalid isolated browser PID');
    process.kill(pid, 'SIGKILL');
    await disconnected;
    expect(browser.isConnected()).toBe(false);
    await info.attach('fault-observed', {
      body: Buffer.from('browser-disconnected'),
      contentType: 'text/plain',
    });
    throw new Error('Injected browser crash observed');
  }
});
