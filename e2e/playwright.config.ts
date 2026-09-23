import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { localOrigin, UI_SETTINGS } from './contract.ts';

const output = process.env.FANTASY_UI_OUTPUT;
if (!output) throw new Error('Run vp run test:e2e; direct execution has no isolated servers');

export default defineConfig({
  testDir: './specs',
  testMatch: '**/*.spec.ts',
  outputDir: resolve(output, 'tests'),
  fullyParallel: false,
  forbidOnly: true,
  workers: UI_SETTINGS.workers,
  retries: UI_SETTINGS.retries,
  timeout: UI_SETTINGS.timeout,
  globalTimeout: UI_SETTINGS.globalTimeout,
  expect: { timeout: 5000 },
  reporter: [['line'], ['json', { outputFile: resolve(output, 'results.json') }]],
  use: {
    baseURL: localOrigin(process.env.FANTASY_UI_ORIGIN),
    browserName: UI_SETTINGS.browser,
    locale: UI_SETTINGS.locale,
    timezoneId: UI_SETTINGS.timezoneId,
    viewport: UI_SETTINGS.viewport,
    deviceScaleFactor: UI_SETTINGS.deviceScaleFactor,
    colorScheme: UI_SETTINGS.colorScheme,
    reducedMotion: UI_SETTINGS.reducedMotion,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium' }],
});
