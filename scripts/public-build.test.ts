import { expect, it } from 'vite-plus/test';
import { publicBuild } from './public-build.ts';

it('limits public connections and emits source-bound compatible metadata with configurable base', () => {
  const build = publicBuild('https://reader.example/replays/', '1'.repeat(40), '/');
  expect(build.base).toBe('/');
  expect(build.csp).toContain("connect-src 'self' https://reader.example;");
  expect(build.csp).toContain("script-src 'self'");
  expect(build.metadata).toEqual({
    schemaVersion: 1,
    sourceSha: '1'.repeat(40),
    publicationSchema: 1,
    replay: {
      manifestSchema: 1,
      inputSchema: 3,
      eventSchema: 1,
      replaySchema: 1,
      profile: 'display-ndjson-gzip-v1',
    },
  });
});
it.each([
  'https://user:password@example.com/',
  'https://example.com/?token=bad',
  'https://example.com/#hash',
  'http://example.com/',
  'file:///etc/',
])('rejects unsuitable data roots: %s', (root) => {
  expect(() => publicBuild(root, '1'.repeat(40))).toThrow();
});
it('rejects missing source identity and paths that escape the Pages base', () => {
  expect(() => publicBuild('https://example.com/', '')).toThrow();
  expect(() => publicBuild('https://example.com/', '1'.repeat(40), '//example.com/')).toThrow();
});
