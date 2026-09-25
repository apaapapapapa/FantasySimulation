import { expect, it } from 'vite-plus/test';
import { matchLink, readMatchRoute } from './match-route.ts';

const hash = 'sha256:' + 'a'.repeat(64);
it('keeps set/page/slot identities in reloadable static hash links', () => {
  const url = new URL(matchLink(hash, 9, hash), 'https://example.test/FantasySimulation/');
  expect(url.pathname).toBe('/FantasySimulation/');
  expect(readMatchRoute(url.hash)).toEqual({ setHash: hash, page: 9, slotId: hash, error: '' });
  expect(readMatchRoute(matchLink(hash, 0))).toMatchObject({ page: 0, slotId: null });
});
it.each([
  '#/broken',
  '#/sets/latest/pages/0',
  matchLink(hash, 0) + '/matches/0',
  matchLink(hash, 0) + '?step=1',
])('rejects malformed route %s without selecting the default match set', (url) => {
  expect(readMatchRoute(url)).toMatchObject({ setHash: null, slotId: null });
  expect(readMatchRoute(url).error).not.toBe('');
});
it.each([-1, 10, 0.5, NaN])('rejects invalid page %s', (page) => {
  expect(() => matchLink(hash, page)).toThrow();
});
