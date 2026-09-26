import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { startServers } from './servers.ts';
import type { startStaticServers } from './static-servers.ts';
import { CHROMIUM_ARGS, isStaticScenario, uiSettings, uiScenario } from './contract.ts';

const require = createRequire(import.meta.url);
const output = process.env.FANTASY_UI_OUTPUT;
const temporary = process.env.FANTASY_UI_TEMP;
if (!output || !temporary) throw new Error('Use the isolated UI harness');
const scenario = uiScenario(process.argv[2]);
const save = (file: string, value: unknown) =>
  writeFileSync(join(output, file), JSON.stringify(value, null, 2) + '\n');
let stage = 'server-start';
const lifecycle: { stage: string; at: string }[] = [];
function progress(value: string) {
  lifecycle.push({ stage: value, at: new Date().toISOString() });
  save('lifecycle.json', lifecycle);
}
let servers: Awaited<ReturnType<typeof startServers | typeof startStaticServers>> | undefined;
try {
  progress(stage);
  // A missing web package fails after the real API has bound, exercising partial startup cleanup.
  const start = isStaticScenario(scenario)
    ? (await import('./static-servers.ts')).startStaticServers
    : (await import('./servers.ts')).startServers;
  servers = await start(
    scenario === 'startup' ? join(temporary, 'missing-web') : process.cwd(),
    temporary,
    (state) => {
      save('servers.json', state);
      progress(
        state.stopped
          ? 'servers-stopped'
          : state.webOrigin
            ? 'web-ready'
            : isStaticScenario(scenario)
              ? 'fixtures-ready'
              : 'api-ready',
      );
    },
  );
  const playwright = dirname(
    require.resolve('playwright/package.json', {
      paths: [dirname(require.resolve('@playwright/test/package.json'))],
    }),
  );
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    devDependencies: Record<string, string>;
  };
  const installed = require('@playwright/test/package.json') as { version: string };
  if (manifest.devDependencies['@playwright/test'] !== installed.version)
    throw new Error('Playwright pin mismatch');
  const browserPackage = dirname(
    require.resolve('playwright-core/package.json', { paths: [playwright] }),
  );
  save('execution.json', {
    run: JSON.parse(readFileSync(join(output, 'run.json'), 'utf8')) as unknown,
    settings: uiSettings(scenario),
    launch: { chromiumArgs: CHROMIUM_ARGS, softwareGL: true },
    playwright: installed.version,
    browsers: JSON.parse(readFileSync(join(browserPackage, 'browsers.json'), 'utf8')) as unknown,
    font: {
      package: '@fontsource/noto-sans-jp',
      version: manifest.devDependencies['@fontsource/noto-sans-jp'],
      weight: 400,
    },
    origins: {
      web: servers.webOrigin,
      api: servers.apiOrigin,
      data: 'dataOrigin' in servers ? servers.dataOrigin : null,
    },
    samples: servers.samples,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    reuseExistingServer: false,
    envFiles: false,
    scenario,
  });
  stage = 'browser';
  progress(stage);
  // Inherit our process group. The outer bounded runner kills the entire group on timeout/abort.
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(playwright, 'cli.js'), 'test', '--config', 'e2e/playwright.config.ts'],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        shell: false,
        env: {
          ...process.env,
          FANTASY_UI_ORIGIN: servers!.webOrigin,
          FANTASY_UI_SCENARIO: scenario,
          FANTASY_UI_DATA_ORIGIN: 'dataOrigin' in servers! ? servers.dataOrigin : '',
          LIBGL_ALWAYS_SOFTWARE: '1',
        },
      },
    );
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
  progress('browser-finished');
} catch (error) {
  progress('failure');
  save('failure.json', {
    stage,
    message: error instanceof Error ? error.message : 'UI execution failed',
  });
  console.error(error);
  process.exitCode = 1;
} finally {
  if (servers) {
    try {
      await servers.stop();
    } catch (error) {
      save('servers.json', {
        stopped: false,
        message: error instanceof Error ? error.message : 'Cleanup failed',
      });
      process.exitCode = 1;
    }
  }
}
