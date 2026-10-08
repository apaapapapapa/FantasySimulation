import { test as base, expect, type BrowserContext } from '@playwright/test';
import { allowedRequest, localOrigin } from './contract.ts';

/** Any context a UI test opens may reach only the isolated servers; others are recorded. */
export async function guardNetwork(context: BrowserContext, blockedOrigins: string[]) {
  const origin = localOrigin(process.env.FANTASY_UI_ORIGIN);
  const data = process.env.FANTASY_UI_DATA_ORIGIN;
  const origins = data ? [origin, localOrigin(data)] : [origin];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (allowedRequest(url, origins)) await route.continue();
    else {
      blockedOrigins.push(new URL(url).origin);
      await route.abort('blockedbyclient');
    }
  });
  await context.routeWebSocket('**/*', async (socket) => {
    blockedOrigins.push(new URL(socket.url()).origin);
    await socket.close();
  });
}
export const test = base.extend<
  {
    blockedOrigins: string[];
    expectedBlockedOrigins: string[];
    networkGuard: void;
  },
  { browserSession: string; browserWarmup: void }
>({
  // A distinct worker option gives a suite its own built-in browser and normal teardown.
  browserSession: ['shared', { scope: 'worker', option: true }],
  // WebKit's first 3D frame on a fresh runner compiles the viewer's scene shaders cold; it missed
  // the first case's 5s render wait in #306 run 37700864570 and #320 runs 37703026059/37703784070,
  // while the retry (a new browser on the same runner) passed. A trivial shader did not help, so
  // render the fixed static replay once per worker in a throwaway, network-guarded context. Every
  // case keeps its own fresh context, deadline and retry policy; Chromium parts are unchanged.
  browserWarmup: [
    async ({ browser, browserName }, use) => {
      if (browserName === 'webkit') {
        const { complete } = await import('./static/fixtures.ts');
        const blocked: string[] = [];
        const context = await browser.newContext({
          baseURL: localOrigin(process.env.FANTASY_UI_ORIGIN),
        });
        try {
          await guardNetwork(context, blocked);
          const page = await context.newPage();
          await page.goto(complete.url);
          await page
            .locator('canvas[aria-label="保存ログの3D表示"][data-rendered="true"]')
            .waitFor({ timeout: 30_000 });
          expect(blocked).toEqual([]);
        } finally {
          await context.close();
        }
      }
      await use();
    },
    { scope: 'worker', auto: true },
  ],
  expectedBlockedOrigins: [[], { option: true }],
  blockedOrigins: async ({}, use) => {
    await use([]);
  },
  networkGuard: [
    async ({ context, browser, blockedOrigins, expectedBlockedOrigins }, use, info) => {
      await guardNetwork(context, blockedOrigins);
      await info.attach('browser-identity', {
        body: Buffer.from(
          JSON.stringify({ name: browser.browserType().name(), version: browser.version() }),
        ),
        contentType: 'application/json',
      });
      await use();
      expect(blockedOrigins).toEqual(expectedBlockedOrigins);
    },
    { auto: true },
  ],
});
export { expect };
