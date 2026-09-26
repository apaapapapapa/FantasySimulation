import type { DeepReadonly } from './canonical.ts';
import type { Definition } from './contracts.ts';

type Status = {
  revision: { id: string; definition: DeepReadonly<Definition<'status'>> };
  startStep: number;
  endStep: number;
};
export const statusActive = (s: Pick<Status, 'startStep' | 'endStep'>, step: number) =>
  s.startStep <= step && step < s.endStep;
/** Seals cannot suppress seals. Selectors form a union, independent of cohort order. */
export function statusSealed(status: Status, statuses: readonly Status[], step: number) {
  if (status.revision.definition.seals) return false;
  return statuses.some((s) => {
    const seals = s.revision.definition.seals;
    return (
      statusActive(s, step) &&
      !!seals &&
      (seals.statusIds?.includes(status.revision.id) ||
        seals.statusCategories?.some((c) => status.revision.definition.categories?.includes(c)))
    );
  });
}
export function effectiveStatuses<T extends Status>(statuses: readonly T[], step: number): T[] {
  const active = statuses.filter((s) => statusActive(s, step));
  if (!active.some((s) => s.revision.definition.seals)) return active;
  return active.filter((s) => !statusSealed(s, active, step));
}
export function sealedAbilityCategories(statuses: readonly Status[], step: number) {
  return [
    ...new Set(
      statuses.flatMap((s) =>
        statusActive(s, step) ? (s.revision.definition.seals?.abilityCategories ?? []) : [],
      ),
    ),
  ];
}
/** Revival is an explicit reset after damage/healing, not an ordinary heal multiplier. */
export function revivalHp(
  health: Extract<
    NonNullable<Definition<'ability'>['reaction']>['response'],
    { kind: 'revive' }
  >['health'],
  maxHp: number,
) {
  return Math.min(
    maxHp,
    health.kind === 'fixed' ? health.amount : Math.max(1, Math.floor((maxHp * health.bps) / 10000)),
  );
}
