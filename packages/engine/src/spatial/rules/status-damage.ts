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
  const source = damageSource(effectiveStats(actor.body.motion.actor, actor.statuses, step));
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
  return entries.some(([, bps]) => bps !== 10000)
    ? { ...source, dealtByElement: Object.fromEntries(entries) }
    : source;
}
export const copyDamageSnapshot = (source: DamageSnapshot): DamageSnapshot => ({
  ...damageSource(source),
  ...(source.dealtByElement && { dealtByElement: { ...source.dealtByElement } }),
});
