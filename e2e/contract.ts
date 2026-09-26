// Stable acceptance IDs; a missing/skipped case never satisfies this inventory.
export const UI_CASES = [
  'local-health',
  'api-http-error',
  'api-invalid-json',
  'network-boundary',
  'draft-revisions',
  'draft-errors',
  'draft-resume-tall-character',
  'battle-cancel-retry',
  'battle-truncated-result',
  'battle-api-error',
] as const;
export const UI_RUN_CHECKS = ['ui:source', 'ui:execution', 'ui:coverage', 'ui:cleanup'] as const;
export const UI_CHECKS = [...UI_RUN_CHECKS, 'ui:diagnostics', 'ui:static-replay'] as const;
export const UI_STATIC_CASES = [
  'static-league-overview',
  'static-league-pair-replay',
  'static-league-provisional',
  'static-selection',
  'static-selection-original',
  'static-selection-reused',
  'static-selection-another-attempt',
  'static-list-cost-and-states',
  'static-selection-invalid-link',
  'static-replay-controls',
  'static-partials',
  'static-errors',
  'static-stale-navigation',
  'static-webgl-fallback',
  'static-network-boundary',
  'static-long-replay',
  'static-timeline-overlays',
  'static-status-expiry',
  'static-webgl-2d-to-end',
  'static-mobile-controls',
  'static-local-file',
  'static-step-link',
] as const;
export const UI_FAULTS = ['startup', 'timeout', 'crash'] as const;
export type UiScenario = 'smoke' | 'static' | (typeof UI_FAULTS)[number];
export function uiScenario(value: string | undefined): UiScenario {
  if (value === undefined || value === 'smoke') return 'smoke';
  if (value === 'static') return value;
  if (UI_FAULTS.some((fault) => fault === value)) return value as UiScenario;
  throw new Error('Unknown UI execution scenario');
}
export const UI_SETTINGS = {
  browser: 'chromium',
  locale: 'ja-JP',
  timezoneId: 'Asia/Tokyo',
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
  reducedMotion: 'reduce',
  workers: 1,
  retries: 1,
  timeout: 20_000,
  globalTimeout: 120_000,
} as const;

export const uiCases = (scenario: UiScenario) =>
  scenario === 'smoke' ? UI_CASES : scenario === 'static' ? UI_STATIC_CASES : [scenario];
export const uiBrowsers = (scenario: UiScenario) =>
  scenario === 'static' ? (['chromium', 'webkit'] as const) : (['chromium'] as const);
export function uiSettings(scenario: UiScenario) {
  return {
    ...UI_SETTINGS,
    browsers: uiBrowsers(scenario),
    retries: scenario === 'smoke' || scenario === 'static' ? 1 : 0,
    globalTimeout: scenario === 'static' ? 300000 : UI_SETTINGS.globalTimeout,
    timeout: scenario === 'static' ? 30000 : UI_SETTINGS.timeout,
  };
}
export const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];

export function localOrigin(value: string | undefined): string {
  if (!value) throw new Error('Missing isolated server origin');
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.origin !== value
  )
    throw new Error('Expected an exact loopback origin');
  return url.origin;
}

export function allowedRequest(value: string, origins: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username && !url.password && origins.includes(url.origin) && url.protocol === 'http:'
    );
  } catch {
    return false;
  }
}
