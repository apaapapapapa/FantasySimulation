// Stable acceptance IDs; a missing/skipped case never satisfies this inventory.
export const UI_CASES = [
  'local-health',
  'api-http-error',
  'api-invalid-json',
  'network-boundary',
] as const;
export const UI_CHECKS = ['ui:source', 'ui:execution', 'ui:coverage', 'ui:cleanup'] as const;
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
