import {
  DEFAULT_BUDGET,
  compareIds,
  type DeepReadonly,
  type Effect,
  type ResourceState,
  type BattleEvent,
} from '@fantasy/domain/spatial';
import {
  calculateDamage,
  damageDefense,
  hasDamageFormula,
  type DamageSource,
  type DamageEffect,
} from './damage.ts';
import type { ResolvedActor } from './prepare.ts';
import { dispelTargets } from './categories.ts';
import {
  applyStatuses,
  effectiveStats,
  type DispelTarget,
  type StatusApplication,
  type StatusCohort,
  type StatusRevision,
  type StatusLimits,
} from './status.ts';
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
export type EffectApplication = DamageSource & {
  id: string;
  actorId: string | null;
  targetId: string;
  effect: DeepReadonly<Effect>;
  scaleBps?: number;
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
/** Simultaneous defense/resistance/shield resolution with exact attribution and one HP clamp. */
export function resolveEffects(
  targets: readonly EffectTarget[],
  applications: readonly EffectApplication[],
  statuses: readonly StatusRevision[],
  step: number,
  activationStep = step + 1,
  limits: StatusLimits = DEFAULT_BUDGET,
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
      const damages: (ReturnType<typeof calculateDamage> & {
        applicationId: string;
        effect: DamageEffect;
      })[] = [];
      let heal = 0n,
        shield = BigInt(target.resources.shield);
      const statusApplications: StatusApplication[] = [],
        dispels: DispelTarget[] = [];
      for (const application of incoming) {
        const effect = application.effect,
          scale = BigInt(application.scaleBps ?? 10000);
        if (scale < 0n || scale > 10000n) throw new Error('Invalid effect coverage');
        switch (effect.kind) {
          case 'damage': {
            const amounts = calculateDamage(
              effect,
              application,
              {
                ...stats,
                resistance: target.actor.character.stats.resistances[effect.element] ?? 0,
              },
              Number(scale),
            );
            damages.push({ applicationId: application.id, effect, ...amounts });
            break;
          }
          case 'heal':
            heal += (BigInt(effect.amount) * scale) / 10000n;
            break;
          case 'shield':
            shield += (BigInt(effect.amount) * scale) / 10000n;
            break;
          case 'dispel':
            if (scale > 0n)
              dispels.push(
                ...dispelTargets(
                  effect,
                  target.statuses.map((s) => s.revision),
                ),
              );
            break;
          case 'water':
            if (scale > 0n)
              dispels.push(
                ...target.statuses
                  .filter((s) => s.revision.definition.burning?.waterExtinguishable)
                  .map((s) => s.revision.id),
              );
            break;
          case 'reveal':
            // Information is extracted only by the observation boundary, after actual contact.
            break;
          case 'apply-status': {
            const revision = statuses.find(
              (s) =>
                s.id === effect.status.id &&
                s.revision === effect.status.revision &&
                s.contentHash === effect.status.contentHash,
            );
            if (!revision) throw new Error('Missing prepared status reference');
            if (scale > 0n) statusApplications.push({ revision, cause: application.id });
            break;
          }
          default: {
            const impossible: never = effect;
            throw new Error(`Unknown effect: ${String(impossible)}`);
          }
        }
      }
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
          ...(hasDamageFormula(damage.effect) && {
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
      const result = applyStatuses(
        target.statuses,
        statusApplications,
        dispels,
        activationStep,
        limits,
      );
      return {
        actorId: target.actor.participant.actorId,
        resources,
        statuses: result.statuses,
        changes: result.changes,
        damage: details,
        healed: checked(heal),
        hpDamage: checked(hpDamage),
        shieldAbsorbed: checked(absorbed),
      };
    });
}
