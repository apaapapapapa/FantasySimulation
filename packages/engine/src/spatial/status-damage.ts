import { ElementSchema } from '@fantasy/domain/spatial/execution';
import type { ActorState, AbilityRevision } from './combat-state.ts';
import { damageSource, type DamageSource } from './damage.ts';
import { abilityCategories } from './categories.ts';
import { damageStatusBps } from './status-modifiers.ts';
import { effectiveStats } from './status.ts';

export type DamageSnapshot = DamageSource & {
  dealtByElement?: Readonly<
    Partial<Record<(typeof ElementSchema.enum)[keyof typeof ElementSchema.enum], number>>
  >;
};
/** Preserve launch-time damage modifiers for melee and projectile contacts after the status expires. */
export function statusDamageSource(
  actor: ActorState,
  ability: AbilityRevision,
  step: number,
): DamageSnapshot {
  const source = damageSource(effectiveStats(actor.motion.actor, actor.statuses, step));
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
