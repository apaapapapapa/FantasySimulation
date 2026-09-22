import {
  DEFAULT_BUDGET,
  compareIds,
  type DeepReadonly,
  type Effect,
  type ResourceState,
} from '@fantasy/domain/spatial';
import type { ResolvedActor } from './prepare.ts';
import {
  applyStatuses,
  effectiveStats,
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
export type EffectApplication = {
  id: string;
  actorId: string | null;
  targetId: string;
  effect: DeepReadonly<Effect>;
  attack: number;
  scaleBps?: number;
};
export type DamageDetail = {
  applicationId: string;
  defenseApplied: number;
  afterDefense: number;
  afterResistance: number;
  absorbed: Fraction;
  toHp: Fraction;
};
const checked = (n: bigint) => {
  const value = Number(n);
  if (!Number.isSafeInteger(value)) throw new Error('Unsafe resource accumulation');
  return value;
};
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
      const damages: { applicationId: string; afterDefense: bigint; afterResistance: bigint }[] =
        [];
      let heal = 0n,
        shield = BigInt(target.resources.shield);
      const statusApplications: StatusApplication[] = [],
        dispels: string[] = [];
      for (const application of incoming) {
        const effect = application.effect,
          scale = BigInt(application.scaleBps ?? 10000);
        if (scale < 0n || scale > 10000n) throw new Error('Invalid effect coverage');
        switch (effect.kind) {
          case 'damage': {
            const raw =
              BigInt(effect.amount) +
              (BigInt(application.attack) * BigInt(effect.attackScaleBps)) / 10000n;
            const afterDefense =
              ((raw > BigInt(stats.defense) ? raw - BigInt(stats.defense) : 0n) * scale) / 10000n;
            const afterResistance =
              (afterDefense *
                BigInt(10000 - target.actor.character.stats.resistances[effect.element])) /
              10000n;
            damages.push({ applicationId: application.id, afterDefense, afterResistance });
            break;
          }
          case 'heal':
            heal += (BigInt(effect.amount) * scale) / 10000n;
            break;
          case 'shield':
            shield += (BigInt(effect.amount) * scale) / 10000n;
            break;
          case 'dispel':
            if (scale > 0n) dispels.push(...effect.statusIds);
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
      const total = damages.reduce((n, d) => n + d.afterResistance, 0n),
        absorbed = total < shield ? total : shield;
      const hpDamage = total - absorbed,
        unclamped = BigInt(target.resources.hp) + heal - hpDamage,
        maxHp = BigInt(target.actor.character.stats.hp);
      const resources = {
        hp: checked(unclamped < 0n ? 0n : unclamped > maxHp ? maxHp : unclamped),
        mp: target.resources.mp,
        shield: checked(shield - absorbed),
      };
      const details: DamageDetail[] = damages
        .sort((a, b) => compareIds(a.applicationId, b.applicationId))
        .map((damage) => ({
          applicationId: damage.applicationId,
          defenseApplied: stats.defense,
          afterDefense: checked(damage.afterDefense),
          afterResistance: checked(damage.afterResistance),
          absorbed: total ? fraction(absorbed * damage.afterResistance, total) : fraction(0n, 1n),
          toHp: total ? fraction(hpDamage * damage.afterResistance, total) : fraction(0n, 1n),
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
