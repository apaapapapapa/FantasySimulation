import { cosDegrees } from '../math.ts';
import type { ActorState, AbilityRevision, DamageSnapshot } from '../state.ts';
export type { DamageSnapshot } from '../state.ts';
import { ElementSchema } from '@fantasy/domain/spatial/execution';
import { damageSource } from './damage.ts';
import { abilityCategories } from './categories.ts';
import { damageStatusBps } from './status-modifiers.ts';
import { effectiveStats } from './status.ts';

/** Preserve launch-time damage modifiers for melee and projectile contacts after the status expires. */
export function statusDamageSource(
  actor: ActorState,
  ability: AbilityRevision,
  step: number,
): DamageSnapshot {
  const source: DamageSnapshot = damageSource(
    effectiveStats(actor.body.motion.actor, actor.statuses, step),
  );
  const entries = ElementSchema.options.map(
    (element) =>
      [
        element,
        damageStatusBps('damageDealt', actor.statuses, step, {
          element,
          categories: abilityCategories(ability.definition),
        }),
      ] as const,
  );
  const shape = ability.definition.attack;
  if ('phasing' in shape && shape.phasing)
    source.phaseSlopeY = cosDegrees(
      actor.body.motion.actor.character.movement.maxSlopeMilliDegrees / 1000,
    );
  return entries.some(([, bps]) => bps !== 10000)
    ? { ...source, dealtByElement: Object.fromEntries(entries) }
    : source;
}
export const copyDamageSnapshot = (source: DamageSnapshot): DamageSnapshot => ({
  ...damageSource(source),
  ...(source.phaseSlopeY !== undefined ? { phaseSlopeY: source.phaseSlopeY } : {}),
  ...(source.drainDisabled && { drainDisabled: true }),
  ...(source.dealtByElement && { dealtByElement: { ...source.dealtByElement } }),
});
