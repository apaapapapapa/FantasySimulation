import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import { CHROMIUM_ARGS, localOrigin, uiSettings, uiScenario } from './contract.ts';

const output = process.env.FANTASY_UI_OUTPUT;
if (!output) throw new Error('Run vp run test:e2e; direct execution has no isolated servers');
const scenario = uiScenario(process.env.FANTASY_UI_SCENARIO);
const settings = uiSettings(scenario);

export default defineConfig({
  testDir: scenario === 'smoke' ? './specs' : scenario === 'static' ? './static' : './faults',
  testMatch: '**/*.spec.ts',
  outputDir: resolve(output, 'tests'),
  fullyParallel: false,
  forbidOnly: true,
  workers: settings.workers,
  retries: settings.retries,
  timeout: settings.timeout,
  globalTimeout: settings.globalTimeout,
  expect: { timeout: 5000 },
  reporter: [['line'], ['json', { outputFile: resolve(output, 'results.json') }]],
  use: {
    baseURL: localOrigin(process.env.FANTASY_UI_ORIGIN),
    locale: settings.locale,
    timezoneId: settings.timezoneId,
    viewport: settings.viewport,
    deviceScaleFactor: settings.deviceScaleFactor,
    colorScheme: settings.colorScheme,
    reducedMotion: settings.reducedMotion,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: settings.browsers.map((name) => ({
    name,
    use: { browserName: name, launchOptions: name === 'chromium' ? { args: CHROMIUM_ARGS } : {} },
  })),
});
