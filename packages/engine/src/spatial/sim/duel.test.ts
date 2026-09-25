import { expect, it } from 'vite-plus/test';
import { opponentInDuel } from './duel.ts';

const id = (actor: { id: string }) => actor.id;
it('chooses the other identity independently of array order and object identity', () => {
  const left = { id: 'left' },
    right = { id: 'right' };
  for (const pair of [
    [left, right],
    [right, left],
  ]) {
    expect(opponentInDuel(pair, left.id, id)).toBe(right);
    expect(opponentInDuel(pair, right.id, id)).toBe(left);
  }
});
it.each(
  [[], ['left'], ['left', 'right', 'third'], ['left', 'left'], ['other', 'right']].map((ids) => ({
    ids,
  })),
)('rejects invalid duel identities $ids', ({ ids }) => {
  expect(() =>
    opponentInDuel(
      ids.map((value) => ({ id: value })),
      'left',
      id,
    ),
  ).toThrow(/duel requires/);
});
