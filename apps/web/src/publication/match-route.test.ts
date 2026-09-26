import { expect, it } from 'vite-plus/test';
import { matchLink, readMatchRoute } from './match-route.ts';

const hash = 'sha256:' + 'a'.repeat(64);
it('keeps set/page/slot identities in reloadable static hash links', () => {
  const url = new URL(matchLink(hash, 9, hash), 'https://example.test/FantasySimulation/');
  expect(url.pathname).toBe('/FantasySimulation/');
  expect(readMatchRoute(url.hash)).toEqual({
    setHash: hash,
    page: 9,
    slotId: hash,
    step: null,
    error: '',
  });
  expect(readMatchRoute(matchLink(hash, 0))).toMatchObject({ page: 0, slotId: null });
});
it('pins a shared replay step after the match', () => {
  expect(matchLink(hash, 2, hash, 120)).toBe(
    `#/sets/${'a'.repeat(64)}/pages/2/matches/${'a'.repeat(64)}/steps/120`,
  );
  expect(readMatchRoute(matchLink(hash, 2, hash, 120))).toMatchObject({ slotId: hash, step: 120 });
  expect(readMatchRoute(matchLink(hash, 2, hash, 0)).step).toBe(0);
  expect(readMatchRoute(matchLink(hash, 2, hash, 6000)).step).toBe(6000);
  expect(() => matchLink(hash, 0, undefined, 1)).toThrow('requires a match');
  for (const step of [-1, 6001, 1.5])
    expect(() => matchLink(hash, 0, hash, step)).toThrow('Invalid replay step');
});
it.each([
  '#/broken',
  '#/sets/latest/pages/0',
  matchLink(hash, 0) + '/matches/0',
  matchLink(hash, 0) + '?step=1',
  matchLink(hash, 0) + '/steps/1',
  matchLink(hash, 0, hash) + '/steps/6001',
  matchLink(hash, 0, hash) + '/steps/01',
  matchLink(hash, 0, hash) + '/steps/-1',
])('rejects malformed route %s without selecting the default match set', (url) => {
  expect(readMatchRoute(url)).toMatchObject({ setHash: null, slotId: null });
  expect(readMatchRoute(url).error).not.toBe('');
});
it.each([-1, 10, 0.5, NaN])('rejects invalid page %s', (page) => {
  expect(() => matchLink(hash, page)).toThrow();
});
