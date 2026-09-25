import type { DamageSnapshot, ResolvedActor, StatusCohort, StatusRevision } from '../state.ts';
import {
  DEFAULT_BUDGET,
  matchEffect,
  type EffectHandlers,
  compareIds,
  type DeepReadonly,
  type Effect,
  type ResourceState,
  type BattleEvent,
} from '@fantasy/domain/spatial/execution';
import { calculateDamage, damageDefense, hasDamageFormula, type DamageEffect } from './damage.ts';
import { adjustedStatusValue, damageStatusBps, statusResistance } from './status-modifiers.ts';
import { planStatusEffects, reactionDamageBps } from './status-reactions.ts';
import { applyStatuses, effectiveStats, type StatusLimits } from './status.ts';
export type Fraction = { numerator: string; denominator: string };
export function fraction(n: bigint, d: bigint): Fraction {
  if (n < 0n || d <= 0n) throw new Error('Invalid nonnegative fraction');
  let a = n,
    b = d;
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return { numerator: (n / a).toString(), denominator: (d / a).toString() };
}
export type EffectTarget = {
  actor: ResolvedActor;
  resources: ResourceState;
  statuses: StatusCohort[];
};
export type EffectApplication = DamageSnapshot & {
  id: string;
  actorId: string | null;
  targetId: string;
  effect: DeepReadonly<Effect>;
  abilityId?: string | null;
  parentEventId?: string | null;
  scaleBps?: number;
  dealtBps?: number;
  damageCancelled?: boolean;
};
export type DamageDetail = NonNullable<BattleEvent['damage']> & {
  applicationId: string;
};
const checked = (n: bigint) => {
  const value = Number(n);
  if (!Number.isSafeInteger(value)) throw new Error('Unsafe resource accumulation');
  return value;
};
/** Shared integer damage arithmetic for resolution and self-known periodic-risk estimates. */
export function damageAmounts(
  amount: number,
  attack: number,
  attackScaleBps: number,
  defense: number,
  resistance: number,
  coverage = 10000,
) {
  return calculateDamage(
    { kind: 'damage', amount, attackScaleBps, element: 'physical' },
    { attack },
    { defense, resistance },
    coverage,
  );
}
type DamageEntry = ReturnType<typeof calculateDamage> & {
  applicationId: string;
  effect: DamageEffect;
  statusModified: boolean;
};
type ResolutionContext = {
  target: EffectTarget;
  application: EffectApplication;
  stats: ReturnType<typeof effectiveStats>;
  step: number;
  scale: bigint;
  damages: DamageEntry[];
  healing: { applicationId: string; amount: number }[];
  totals: { heal: bigint; shield: bigint };
};
// Status changes share one status transaction; observation/force commit at their existing boundary.
const deferredEffect = () => {};
const effectHandlers: EffectHandlers<ResolutionContext, void> = {
  damage: (effect, { target, application, stats, step, scale, damages }) => {
    const dealtBps = application.dealtByElement?.[effect.element] ?? application.dealtBps ?? 10000;
    const resistance = statusResistance(
      target.actor.character.stats.resistances,
      target.statuses,
      step,
      effect.element,
    );
    const receivedBps = damageStatusBps(
      'damageTaken',
      target.statuses,
      step,
      { element: effect.element },
      reactionDamageBps(target.statuses, step, effect.element),
    );
    const amounts = calculateDamage(
      effect,
      application,
      {
        ...stats,
        resistance,
      },
      Number(scale),
      { dealtBps, receivedBps },
    );
    damages.push({
      applicationId: application.id,
      effect,
      ...amounts,
      ...(application.damageCancelled ? { afterModifiers: 0n } : {}),
      statusModified:
        !!application.damageCancelled ||
        dealtBps !== 10000 ||
        receivedBps !== 10000 ||
        resistance !== (target.actor.character.stats.resistances[effect.element] ?? 0),
    });
  },
  heal: (effect, { target, application, step, scale, healing, totals }) => {
    const amount =
      (BigInt(effect.amount) *
        scale *
        BigInt(Math.min(30000, adjustedStatusValue(10000, 'hpRecovery', target.statuses, step)))) /
      100000000n;
    totals.heal += amount;
    healing.push({ applicationId: application.id, amount: checked(amount) });
  },
  shield: (effect, { scale, totals }) => {
    totals.shield += (BigInt(effect.amount) * scale) / 10000n;
  },
  dispel: deferredEffect,
  water: deferredEffect,
  'apply-status': deferredEffect,
  reveal: deferredEffect,
  force: deferredEffect,
};
/** Simultaneous defense/resistance/shield resolution with exact attribution and one HP clamp. */
export function resolveEffects(
  targets: readonly EffectTarget[],
  applications: readonly EffectApplication[],
  statuses: readonly StatusRevision[],
  step: number,
  activationStep = step + 1,
  limits: StatusLimits = DEFAULT_BUDGET,
  deferStatuses = false,
) {
  const ids = new Set(targets.map((t) => t.actor.participant.actorId));
  if (
    ids.size !== targets.length ||
    new Set(applications.map((a) => a.id)).size !== applications.length ||
    applications.some((a) => !ids.has(a.targetId))
  )
    throw new Error('Invalid effect instance/target identity');
  return [...targets]
    .sort((a, b) => compareIds(a.actor.participant.actorId, b.actor.participant.actorId))
    .map((target) => {
      const incoming = applications.filter((a) => a.targetId === target.actor.participant.actorId);
      const stats = effectiveStats(target.actor, target.statuses, step);
      const reactions = deferStatuses
        ? null
        : planStatusEffects(target.statuses, incoming, statuses, step);
      const damages: DamageEntry[] = [];
      const totals = { heal: 0n, shield: BigInt(target.resources.shield) };
      const healing: { applicationId: string; amount: number }[] = [];
      for (const application of incoming) {
        const effect = application.effect,
          scale = BigInt(application.scaleBps ?? 10000);
        if (scale < 0n || scale > 10000n) throw new Error('Invalid effect coverage');
        matchEffect(effect, effectHandlers, {
          target,
          application,
          stats,
          step,
          scale,
          damages,
          healing,
          totals,
        });
      }
      const { heal, shield } = totals;
      const total = damages.reduce((n, d) => n + d.afterModifiers, 0n),
        absorbed = total < shield ? total : shield;
      const hpDamage = total - absorbed,
        unclamped = BigInt(target.resources.hp) + heal - hpDamage,
        maxHp = BigInt(target.actor.character.stats.hp);
      const resources = {
        ...target.resources,
        hp: checked(unclamped < 0n ? 0n : unclamped > maxHp ? maxHp : unclamped),
        mp: target.resources.mp,
        shield: checked(shield - absorbed),
      };
      const details: DamageDetail[] = damages
        .sort((a, b) => compareIds(a.applicationId, b.applicationId))
        .map((damage) => ({
          applicationId: damage.applicationId,
          defenseApplied: damage.defenseApplied,
          afterDefense: checked(damage.afterDefense),
          afterResistance: checked(damage.afterResistance),
          ...((hasDamageFormula(damage.effect) || damage.statusModified) && {
            calculation: {
              element: damage.effect.element,
              component:
                damage.effect.element === 'physical'
                  ? ('physical' as const)
                  : ('elemental' as const),
              defense: damageDefense(damage.effect),
              basePower: checked(damage.basePower),
              afterModifiers: checked(damage.afterModifiers),
            },
          }),
          absorbed: total ? fraction(absorbed * damage.afterModifiers, total) : fraction(0n, 1n),
          toHp: total ? fraction(hpDamage * damage.afterModifiers, total) : fraction(0n, 1n),
        }));
      const result = reactions
        ? applyStatuses(
            reactions.statuses,
            reactions.applications,
            reactions.dispels,
            activationStep,
            limits,
          )
        : { statuses: target.statuses, changes: [] };
      return {
        actorId: target.actor.participant.actorId,
        resources,
        statuses: result.statuses,
        changes: [...(reactions?.changes ?? []), ...result.changes],
        reactions: reactions?.traces ?? [],
        damage: details,
        healing,
        healed: checked(heal),
        hpDamage: checked(hpDamage),
        shieldAbsorbed: checked(absorbed),
      };
    });
}
