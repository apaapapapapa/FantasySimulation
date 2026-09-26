import type { Definition } from '@fantasy/domain/spatial';
import { reactionManifest } from './reactions.ts';

export const reviveAbility = (
  edit: Partial<Definition<'ability'>> = {},
): Partial<Definition<'ability'>> => ({
  trigger: 'before-defeat',
  categories: ['special'],
  reaction: { response: { kind: 'revive', health: { kind: 'fixed', amount: 7 } } },
  costs: { hp: 0, mp: 2, stamina: 3, uses: 4 },
  effects: [],
  ...edit,
});
export function revivalManifest(options: Partial<Parameters<typeof reactionManifest>[0]> = {}) {
  return reactionManifest({
    steps: 8,
    character: {
      stats: {
        hp: 10,
        mp: 20,
        shield: 5,
        attack: 0,
        defense: 0,
        actionSpeedBps: 10000,
        resistances: { physical: 0, fire: 0, ice: 0, lightning: 0, arcane: 0 },
      },
      stamina: { max: 20, recoveryPerSecond: 0 },
    },
    attack: {
      effects: [
        { kind: 'damage', amount: 30, attackScaleBps: 0, element: 'fire', defense: 'none' },
        { kind: 'heal', amount: 8 },
      ],
    },
    reactions: [reviveAbility()],
    ...options,
  });
}
