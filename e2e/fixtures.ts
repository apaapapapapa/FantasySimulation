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
  // A fresh runner pages WebKit's process, text and software-GL stacks in from a cold disk on its
  // first page: that alone exceeded the first 3D case's render wait in #306 run 37700864570 and
  // #320 run 37703026059, while the retry passed. Warm them once per worker in a throwaway
  // context; every case keeps its own fresh context, deadline and retry policy.
  browserWarmup: [
    async ({ browser, browserName }, use) => {
      if (browserName === 'webkit') {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          await page.setContent('<p>warm-up</p><canvas width="8" height="8"></canvas>');
          await page.evaluate(() => {
            const gl = document.querySelector('canvas')!.getContext('webgl');
            if (!gl) return;
            const shader = (type: number, source: string) => {
              const created = gl.createShader(type)!;
              gl.shaderSource(created, source);
              gl.compileShader(created);
              return created;
            };
            const program = gl.createProgram()!;
            gl.attachShader(program, shader(gl.VERTEX_SHADER, 'void main(){gl_PointSize=8.0;}'));
            gl.attachShader(
              program,
              shader(gl.FRAGMENT_SHADER, 'void main(){gl_FragColor=vec4(1.0);}'),
            );
            gl.linkProgram(program);
            gl.useProgram(program);
            gl.drawArrays(gl.POINTS, 0, 1);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
          });
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
