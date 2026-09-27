import type { Definition } from '@fantasy/domain/spatial';
import { experimentalRules } from '@fantasy/samples/testing';
import { reactionManifest } from './reactions.ts';
import { initialStatus, withInitialStatus } from './ai.ts';

export async function conceptManifest(
  options: {
    attack?: Partial<Definition<'ability'>>;
    reactions?: Partial<Definition<'ability'>>[];
    status?: Partial<Definition<'status'>>;
    both?: boolean;
    steps?: number;
  } = {},
) {
  const input = await reactionManifest({
    steps: options.steps ?? 20,
    reactions: options.reactions ?? [],
    leftReactions: true,
    attack: { effects: [{ kind: 'defeat' }], costs: { hp: 0, mp: 0, uses: 1 }, ...options.attack },
    character: {
      stats: {
        hp: 10,
        mp: 30,
        shield: 100,
        attack: 0,
        defense: 1000,
        actionSpeedBps: 10000,
        resistances: { physical: 0, fire: 10000, ice: 0, lightning: 0, arcane: 0 },
      },
    },
  });
  if (options.status)
    for (const index of (options.both ? [0, 1] : [1]) as (0 | 1)[])
      await withInitialStatus(
        input,
        index,
        initialStatus({ maxStacks: 1, stacking: 'refresh', ...options.status }),
      );
  return experimentalRules(input, [
    'absolute-evasion',
    'absolute-hit',
    'immortality',
    'instant-death',
    'mind-read',
  ]);
}
