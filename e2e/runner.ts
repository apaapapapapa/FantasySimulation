import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { startServers } from './servers.ts';
import { UI_SETTINGS } from './contract.ts';

const require = createRequire(import.meta.url);
const output = process.env.FANTASY_UI_OUTPUT;
const temporary = process.env.FANTASY_UI_TEMP;
if (!output || !temporary) throw new Error('Use the isolated UI harness');
const save = (file: string, value: unknown) =>
  writeFileSync(join(output, file), JSON.stringify(value, null, 2) + '\n');
let stage = 'server-start';
let servers: Awaited<ReturnType<typeof startServers>> | undefined;
try {
  servers = await startServers(process.cwd(), temporary);
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
    settings: UI_SETTINGS,
    playwright: installed.version,
    browsers: JSON.parse(readFileSync(join(browserPackage, 'browsers.json'), 'utf8')) as unknown,
    font: {
      package: '@fontsource/noto-sans-jp',
      version: manifest.devDependencies['@fontsource/noto-sans-jp'],
      weight: 400,
    },
    origins: { web: servers.webOrigin, api: servers.apiOrigin },
    samples: servers.samples,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    reuseExistingServer: false,
    envFiles: false,
  });
  stage = 'browser';
  // Inherit our process group. The outer bounded runner kills the entire group on timeout/abort.
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(playwright, 'cli.js'), 'test', '--config', 'e2e/playwright.config.ts'],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        shell: false,
        env: { ...process.env, FANTASY_UI_ORIGIN: servers!.webOrigin },
      },
    );
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} catch (error) {
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
      save('servers.json', { stopped: true });
    } catch (error) {
      save('servers.json', {
        stopped: false,
        message: error instanceof Error ? error.message : 'Cleanup failed',
      });
      process.exitCode = 1;
    }
  }
}
