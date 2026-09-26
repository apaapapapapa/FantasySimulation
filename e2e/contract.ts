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
  'static-repeat-playback',
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
/**
 * Static browser parts run as separate CI jobs; together they execute every static case in both
 * browsers exactly once. WebKit, the slowest browser, is split by durations measured on main run
 * 36233578962. Each part is validated against its own case list and browser.
 */
export const UI_STATIC_PARTS = {
  'static-chromium': { browser: 'chromium', cases: UI_STATIC_CASES },
  'static-webkit-1': {
    browser: 'webkit',
    cases: [
      'static-errors',
      'static-replay-controls',
      'static-selection-another-attempt',
      'static-mobile-controls',
      'static-local-file',
      'static-long-replay',
      'static-timeline-overlays',
      'static-selection-invalid-link',
      'static-status-expiry',
      'static-partials',
      'static-league-overview',
      'static-league-provisional',
    ],
  },
  'static-webkit-2': {
    browser: 'webkit',
    cases: [
      'static-webgl-2d-to-end',
      'static-repeat-playback',
      'static-selection-reused',
      'static-selection-original',
      'static-step-link',
      'static-selection',
      'static-league-pair-replay',
      'static-network-boundary',
      'static-webgl-fallback',
      'static-stale-navigation',
      'static-list-cost-and-states',
    ],
  },
} as const satisfies Record<
  string,
  { browser: 'chromium' | 'webkit'; cases: readonly (typeof UI_STATIC_CASES)[number][] }
>;
export type UiStaticPart = keyof typeof UI_STATIC_PARTS;
export const UI_STATIC_SCENARIOS = Object.keys(UI_STATIC_PARTS) as UiStaticPart[];
export const UI_FAULTS = ['startup', 'timeout', 'crash'] as const;
export type UiScenario = 'smoke' | UiStaticPart | (typeof UI_FAULTS)[number];
/** CI jobs: the editor/battle suite with its fault probes, then each static part. */
export const UI_PARTS = ['interactive', ...UI_STATIC_SCENARIOS] as const;
export type UiPart = (typeof UI_PARTS)[number];
export const UI_MATRIX_JOB = 'UI (Linux ${{ matrix.part }})';
export const UI_JOBS = UI_PARTS.map((part) => `UI (Linux ${part})`);
export const isStaticScenario = (scenario: UiScenario): scenario is UiStaticPart =>
  UI_STATIC_SCENARIOS.some((part) => part === scenario);
export function uiScenario(value: string | undefined): UiScenario {
  if (value === undefined || value === 'smoke') return 'smoke';
  const known = [...UI_STATIC_SCENARIOS, ...UI_FAULTS].find((scenario) => scenario === value);
  if (known) return known;
  throw new Error('Unknown UI execution scenario');
}
export function uiPart(value: string): UiPart {
  const part = UI_PARTS.find((known) => known === value);
  if (!part) throw new Error('Unknown UI part');
  return part;
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

export const uiCases = (scenario: UiScenario): readonly string[] =>
  scenario === 'smoke'
    ? UI_CASES
    : isStaticScenario(scenario)
      ? UI_STATIC_PARTS[scenario].cases
      : [scenario];
export const uiBrowsers = (scenario: UiScenario): readonly ('chromium' | 'webkit')[] =>
  isStaticScenario(scenario) ? [UI_STATIC_PARTS[scenario].browser] : ['chromium'];
export function uiSettings(scenario: UiScenario) {
  const isStatic = isStaticScenario(scenario);
  return {
    ...UI_SETTINGS,
    browsers: uiBrowsers(scenario),
    retries: scenario === 'smoke' || isStatic ? 1 : 0,
    globalTimeout: isStatic ? 300000 : UI_SETTINGS.globalTimeout,
    timeout: isStatic ? 30000 : UI_SETTINGS.timeout,
  };
}
/** Selects exact case titles; Playwright matches `project file describe title` joined by spaces. */
export function uiCaseGrep(cases: readonly string[]): RegExp {
  const escaped = cases.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?:^| )(?:${escaped.join('|')})(?: |$)`);
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
