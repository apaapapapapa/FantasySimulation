import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { build, preview, type InlineConfig } from 'vite-plus';
import { publicBuild } from '../scripts/public-build.ts';

export async function startWeb(
  root: string,
  temporary: string,
  { apiOrigin, dataOrigin }: { apiOrigin?: string; dataOrigin?: string },
) {
  const webRequire = createRequire(join(root, 'apps/web/package.json'));
  const { default: react } = (await import(webRequire.resolve('@vitejs/plugin-react'))) as {
    default: () => import('vite-plus').PluginOption;
  };
  const config: InlineConfig = {
    base: dataOrigin ? '/FantasySimulation/' : '/',
    define: {
      'import.meta.env.VITE_APP_MODE': JSON.stringify(dataOrigin ? 'public' : 'local'),
      'import.meta.env.VITE_PUBLICATION_ROOT': JSON.stringify(
        dataOrigin ? dataOrigin + '/fixtures/' : '',
      ),
    },
    logLevel: 'warn',
    configFile: false,
    envDir: false,
    root: join(root, 'apps/web'),
    cacheDir: join(temporary, 'vite-cache'),
    plugins: [
      react(),
      ...(dataOrigin
        ? [
            publicBuild(
              dataOrigin,
              execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
            ).plugin,
          ]
        : []),
      {
        name: 'isolated-test-font',
        transform(code, id) {
          if (id === join(root, 'apps/web/src/main.tsx'))
            return 'import "@fontsource/noto-sans-jp/400.css";\n' + code;
        },
        transformIndexHtml: {
          order: 'pre',
          handler: () => [
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
      proxy: apiOrigin ? { '/api': apiOrigin } : {},
    },
  };
  // Production assets have no dev/HMR client or websocket reconnect attempts.
  await build(config);
  const web = await preview(config);
  return web;
}
