import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build, preview, type InlineConfig } from 'vite-plus';
import { createApp } from '../apps/api/src/app.ts';
import { openStore, readSampleRevisions } from '../apps/api/src/store.ts';
import { BattleRuntime } from '../apps/api/src/battle-runtime.ts';
import { readConfig } from '../apps/api/src/config.ts';
import { RevisionSchema } from '../packages/domain/src/spatial/index.ts';

/** Ports are assigned by bind(0), never probed/released or reused from another server. */
export async function startServers(root: string, temporary: string) {
  const store = openStore(join(temporary, 'sample.sqlite'));
  const samples = readSampleRevisions().map((value) => RevisionSchema.parse(value));
  const close: (() => Promise<unknown>)[] = [];
  const stop = async () => {
    const outcomes = await Promise.allSettled(close.toReversed().map((dispose) => dispose()));
    if (outcomes.some((outcome) => outcome.status === 'rejected'))
      throw new Error('Server cleanup failed');
  };
  close.push(async () => store.close());
  try {
    await store.seedRevisions(samples);
    const runtime = await BattleRuntime.open(
      store,
      join(temporary, 'replays'),
      readConfig().runtime,
    );
    close.push(() => runtime.close());
    const api = createApp(store, false, runtime);
    // The app owns store/runtime after this point, matching the production lifecycle.
    close.splice(0, close.length, () => api.close());
    const apiOrigin = await api.listen({ host: '127.0.0.1', port: 0 });
    const webRequire = createRequire(join(root, 'apps/web/package.json'));
    const { default: react } = (await import(webRequire.resolve('@vitejs/plugin-react'))) as {
      default: () => import('vite-plus').PluginOption;
    };
    const config: InlineConfig = {
      logLevel: 'warn',
      configFile: false,
      envDir: false,
      root: join(root, 'apps/web'),
      cacheDir: join(temporary, 'vite-cache'),
      plugins: [
        react(),
        {
          name: 'isolated-test-font',
          transformIndexHtml: {
            order: 'pre',
            handler: () => [
              {
                tag: 'script',
                attrs: { type: 'module' },
                children: 'import "@fontsource/noto-sans-jp/400.css";',
                injectTo: 'head',
              },
              {
                tag: 'style',
                children: ':root { font-family: "Noto Sans JP", sans-serif !important; }',
                injectTo: 'head',
              },
            ],
          },
        },
      ],
      build: { outDir: join(temporary, 'web'), emptyOutDir: true },
      preview: {
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
        proxy: { '/api': apiOrigin },
      },
    };
    // Production assets have no dev/HMR client or websocket reconnect attempts.
    await build(config);
    const web = await preview(config);
    close.push(() => web.close());
    const address = web.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Web server did not bind');
    const webOrigin = `http://127.0.0.1:${address.port}`;
    // Both must be ready before starting a browser; these are owned, already bound origins.
    for (const url of [`${apiOrigin}/api/health`, webOrigin]) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Isolated server readiness failed');
      await response.arrayBuffer();
    }
    return {
      webOrigin,
      apiOrigin,
      stop,
      samples: samples.map(({ id, revision, contentHash, kind }) => ({
        id,
        revision,
        contentHash,
        kind,
      })),
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
