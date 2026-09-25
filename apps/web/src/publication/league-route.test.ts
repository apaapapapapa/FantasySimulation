import { expect, it } from 'vite-plus/test';
import { leagueLink, readLeagueRoute } from './league-route.ts';
import { leagueDecimal, compareLeagueScore } from './league-presentation.ts';

const hash = 'sha256:' + 'a'.repeat(64);
it('pins snapshot, participants, pair page and slot in a reloadable hash route', () => {
  const route = leagueLink(hash, 'character-1', 'character-2', 6, hash);
  expect(readLeagueRoute(new URL(route, 'https://example.test/app/').hash)).toEqual({
    snapshot: hash,
    character: 'character-1',
    opponent: 'character-2',
    page: 6,
    slot: hash,
  });
  expect(readLeagueRoute(leagueLink(hash))).toMatchObject({
    character: null,
    opponent: null,
    slot: null,
  });
});
it.each([
  '#/leagues/latest',
  leagueLink(hash) + '/characters/../bad',
  leagueLink(hash, 'a', 'b') + '?step=1',
  leagueLink(hash, 'a', 'b').replace('/pages/0', '/pages/7'),
])('rejects malformed league link %s', (route) => {
  expect(readLeagueRoute(route)).toBeNull();
});
it('rounds only for display and compares arbitrarily large fractions exactly', () => {
  expect(leagueDecimal({ numerator: '325', denominator: '8' })).toBe('40.63');
  const huge = '1' + '0'.repeat(500);
  const a = { numerator: (BigInt(huge) + 1n).toString(), denominator: huge };
  const b = { numerator: '1', denominator: '1' };
  expect(leagueDecimal(a)).toBe('1.00');
  expect(compareLeagueScore(a, b)).toBe(1);
});
