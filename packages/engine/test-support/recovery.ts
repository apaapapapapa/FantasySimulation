import type { Effect, Manifest, StatusAdjustment } from '@fantasy/domain/spatial';
import { initialStatus, withInitialStatus } from './ai.ts';
import { combatManifest } from './fixtures.ts';
import { prepareBattle } from '../src/spatial/prepare.ts';
import { sealRevision } from '../src/spatial/manifest-builder.ts';
import { applyStatuses } from '../src/spatial/rules/status.ts';
import type { EffectApplication } from '../src/spatial/rules/effects.ts';

export const recoveryDamage = (amount: number, drainBps?: number): Effect => ({
  kind: 'damage',
  amount,
  attackScaleBps: 0,
  element: 'fire',
  defense: 'none',
  ...(drainBps !== undefined && { drainBps }),
});
export const absorption = (amount: number): StatusAdjustment => ({
  target: 'absorption',
  operation: 'add',
  element: 'fire',
  amount,
});
export function recoveryApplication(
  id: string,
  effect: Effect,
  targetId = 'right',
): EffectApplication {
  return {
    id,
    effect,
    targetId,
    actorId: targetId === 'right' ? 'left' : 'right',
    abilityId: 'recovery-strike',
    attack: 0,
  };
}
export async function recoveryManifest(): Promise<Manifest> {
  const input = await combatManifest(20, {
    ids: { ability: 'recovery-strike', character: 'recovery-fighter', policy: 'recovery-policy' },
    ability: {
      attack: { kind: 'hitscan', radiusMm: 0 },
      castSteps: 0,
      cooldownSteps: 50,
      costs: { hp: 10, mp: 0, uses: 1 },
      rangeMm: 20000,
      effects: [recoveryDamage(20, 5000)],
    },
    policy: { movement: 'hold', jumpWhenBlocked: false },
    character: {
      stats: {
        hp: 100,
        mp: 50,
        shield: 0,
        attack: 0,
        defense: 0,
        actionSpeedBps: 10000,
        resistances: { physical: 0, fire: 0, ice: 0, lightning: 0, arcane: 0 },
      },
    },
  });
  await withInitialStatus(
    input,
    1,
    initialStatus({ categories: ['permanent'], adjustments: [absorption(5000)] }),
  );
  return input;
}
export async function recoveryTargets(adjustments: StatusAdjustment[] = []) {
  const battle = await prepareBattle(await combatManifest(5));
  const status = await sealRevision('status', 'recovery-trait', 1, initialStatus({ adjustments }));
  return battle.actors.map((actor, index) => ({
    actor: {
      ...actor,
      character: { ...actor.character, stats: { ...actor.character.stats, hp: 100, defense: 0 } },
    },
    resources: { hp: 10, mp: 50, shield: 0 },
    statuses:
      index === 1 ? applyStatuses([], [{ revision: status, cause: 'trait' }], [], 0).statuses : [],
  }));
}
