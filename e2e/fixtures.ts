import { test as base, expect } from '@playwright/test';
import { allowedRequest, localOrigin } from './contract.ts';

export const test = base.extend<{
  blockedOrigins: string[];
  expectedBlockedOrigins: string[];
  networkGuard: void;
}>({
  expectedBlockedOrigins: [[], { option: true }],
  blockedOrigins: async ({}, use) => {
    await use([]);
  },
  networkGuard: [
    async ({ context, browser, blockedOrigins, expectedBlockedOrigins }, use, info) => {
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
