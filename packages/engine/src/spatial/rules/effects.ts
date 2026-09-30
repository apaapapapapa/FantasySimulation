import type { DamageSnapshot, EffectTarget, StatusRevision } from '../state.ts';
import {
  DEFAULT_BUDGET,
  matchEffect,
  type EffectHandlers,
  compareIds,
  type DeepReadonly,
  type Effect,
  type BattleEvent,
} from '@fantasy/domain/spatial/execution';
import { calculateDamage, damageDefense, hasDamageFormula, type DamageEffect } from './damage.ts';
import {
  absorptionBps,
  hpRecoveryBps,
  damageStatusBps,
  statusResistance,
} from './status-modifiers.ts';
import { planStatusEffects, reactionDamageBps } from './status-reactions.ts';
import { applyStatuses, effectiveStats, UnresolvedRuleError, type StatusLimits } from './status.ts';
import { availableImmortality, defeatRequest } from './concepts.ts';
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
export type { EffectTarget } from '../state.ts';
export type EffectApplication = DamageSnapshot & {
  id: string;
  actorId: string | null;
  targetId: string;
  effect: DeepReadonly<Effect>;
  abilityId?: string | null;
  parentEventId?: string | null;
  scaleBps?: number;
  powerBps?: number;
  dealtBps?: number;
  damageCancelled?: boolean;
  guards?: readonly { activationId: string; retainedDamageBps: number }[];
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
  afterAbsorption: bigint;
  absorption?: NonNullable<BattleEvent['damage']>['absorption'];
  guard?: NonNullable<NonNullable<BattleEvent['damage']>['guard']>;
};
type ResolutionContext = {
  target: EffectTarget;
  application: EffectApplication;
  stats: ReturnType<typeof effectiveStats>;
  step: number;
  scale: bigint;
  damages: DamageEntry[];
  healing: { applicationId: string; amount: number }[];
  defeats: { applicationId: string; detail: NonNullable<BattleEvent['defeat']> }[];
  totals: { heal: bigint; shield: bigint };
};
// Status changes share one status transaction; observation/force commit at their existing boundary.
const deferredEffect = () => {};
const effectHandlers: EffectHandlers<ResolutionContext, void> = {
  defeat: (effect, { target, application, step, defeats }) => {
    defeats.push({ applicationId: application.id, detail: defeatRequest(target, effect, step) });
  },
  damage: (effect, { target, application, stats, step, scale, damages, totals }) => {
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
      { dealtBps, receivedBps, powerBps: application.powerBps ?? 10000 },
    );
    const beforeGuard = amounts.afterModifiers;
    const guards = [...(application.guards ?? [])].sort((a, b) =>
      compareIds(a.activationId, b.activationId),
    );
    if (guards.length) {
      const numerator = guards.reduce(
        (value, guard) => value * BigInt(guard.retainedDamageBps),
        beforeGuard,
      );
      amounts.afterModifiers = numerator / 10000n ** BigInt(guards.length);
    }
    if (application.damageCancelled) amounts.afterModifiers = 0n;
    const converted =
      (amounts.afterModifiers * BigInt(absorptionBps(target.statuses, step, effect.element))) /
      10000n;
    const healing = converted ? (converted * hpRecoveryBps(target.statuses, step)) / 10000n : 0n;
    totals.heal += healing;
    damages.push({
      applicationId: application.id,
      effect,
      ...amounts,
      afterAbsorption: amounts.afterModifiers - converted,
      ...(guards.length && {
        guard: {
          before: checked(beforeGuard),
          after: checked(amounts.afterModifiers),
          responses: guards,
        },
      }),
      ...(converted > 0n && {
        absorption: {
          element: effect.element,
          converted: checked(converted),
          healing: checked(healing),
        },
      }),
      statusModified:
        !!application.damageCancelled ||
        guards.length > 0 ||
        (application.powerBps ?? 10000) !== 10000 ||
        dealtBps !== 10000 ||
        receivedBps !== 10000 ||
        resistance !== (target.actor.character.stats.resistances[effect.element] ?? 0),
    });
  },
  heal: (effect, { target, application, step, scale, healing, totals }) => {
    const amount =
      (BigInt(effect.amount) * scale * hpRecoveryBps(target.statuses, step)) / 100000000n;
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
  'sensory-cue': deferredEffect,
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
  conceptMode = false,
) {
  const ids = new Set(targets.map((t) => t.actor.participant.actorId));
  if (
    ids.size !== targets.length ||
    new Set(applications.map((a) => a.id)).size !== applications.length ||
    applications.some((a) => !ids.has(a.targetId))
  )
    throw new Error('Invalid effect instance/target identity');
  const results = [...targets]
    .sort((a, b) => compareIds(a.actor.participant.actorId, b.actor.participant.actorId))
    .map((target) => {
      const evaluationStep = step,
        commitStep = activationStep;
      const statusStep = target.statusStep ?? evaluationStep;
      try {
        const incoming = applications.filter(
          (a) => a.targetId === target.actor.participant.actorId,
        );
        const stats = effectiveStats(target.actor, target.statuses, statusStep);
        const reactions = deferStatuses
          ? null
          : planStatusEffects(target.statuses, incoming, statuses, statusStep);
        const damages: DamageEntry[] = [];
        const defeats: ResolutionContext['defeats'] = [];
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
            step: statusStep,
            scale,
            damages,
            healing,
            defeats,
            totals,
          });
        }
        const { heal, shield } = totals;
        const total = damages.reduce((n, d) => n + d.afterAbsorption, 0n),
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
            ...(damage.guard && { guard: damage.guard }),
            ...(damage.absorption && { absorption: damage.absorption }),
            ...((hasDamageFormula(damage.effect) ||
              damage.statusModified ||
              damage.absorption ||
              damage.effect.drainBps !== undefined) && {
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
            absorbed: total ? fraction(absorbed * damage.afterAbsorption, total) : fraction(0n, 1n),
            toHp: total ? fraction(hpDamage * damage.afterAbsorption, total) : fraction(0n, 1n),
          }));
        const result = reactions
          ? applyStatuses(
              reactions.statuses,
              reactions.applications,
              reactions.dispels,
              target.statusStep ?? commitStep,
              limits,
            )
          : { statuses: target.statuses, changes: [] };
        return {
          unclamped,
          openingHp: target.resources.hp,
          ordinaryHealing: heal,
          guard: availableImmortality(target, statusStep),
          defeats,
          maxHp,
          availableHp: BigInt(target.resources.hp) + heal,
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
      } catch (error) {
        if (error instanceof UnresolvedRuleError) error.actorId = target.actor.participant.actorId;
        throw error;
      }
    });
  // All bases are frozen before crediting drains. Drain healing never feeds another drain;
  // this bounds mutual drain without iteration or actor/registration-order precedence.
  const draining = new Map(
    applications
      .filter(
        (app) =>
          app.effect.kind === 'damage' &&
          !!app.effect.drainBps &&
          !app.drainDisabled &&
          !!app.actorId &&
          !!app.abilityId &&
          app.actorId !== app.targetId,
      )
      .map((app) => [app.id, app]),
  );
  const guarded = new Set<string>();
  const concept =
    conceptMode ||
    results.some((result) => result.guard || result.defeats.length) ||
    targets.some((target) =>
      target.statuses.some((status) => status.revision.definition.immortality),
    );
  // Pure fixed-point probes: reducing the numeric loss by one HP can reduce opposing
  // drain and expose a second lethal target. Add all required guards simultaneously.
  for (let evaluation = 0; evaluation <= targets.length; evaluation++) {
    for (const result of results) {
      result.healed = checked(concept && !result.openingHp ? 0n : result.ordinaryHealing);
      result.unclamped = BigInt(result.openingHp) + BigInt(result.healed) - BigInt(result.hpDamage);
    }
    for (const result of draining.size ? results : []) {
      const capacity =
        concept && !result.openingHp
          ? 0n
          : result.availableHp - (guarded.has(result.actorId) ? 1n : 0n);
      const actual =
        capacity < 0n
          ? 0n
          : capacity < BigInt(result.hpDamage)
            ? capacity
            : BigInt(result.hpDamage);
      for (const detail of result.damage) {
        const app = draining.get(detail.applicationId);
        if (
          !app ||
          app.effect.kind !== 'damage' ||
          !app.effect.drainBps ||
          app.drainDisabled ||
          !app.actorId ||
          !app.abilityId ||
          app.actorId === app.targetId
        )
          continue;
        const source = results.find((r) => r.actorId === app.actorId);
        const sourceTarget = targets.find((t) => t.actor.participant.actorId === app.actorId);
        if (!source || !sourceTarget || (concept && !source.openingHp)) continue;
        const n = actual * BigInt(detail.toHp.numerator);
        const d = BigInt(detail.toHp.denominator) * BigInt(result.hpDamage || 1);
        const healing =
          (n *
            BigInt(app.effect.drainBps) *
            hpRecoveryBps(sourceTarget.statuses, sourceTarget.statusStep ?? step)) /
          (d * 100000000n);
        detail.drain = { basis: fraction(n, d), healing: checked(healing) };
        source.unclamped += healing;
        source.healed += checked(healing);
      }
    }
    const required = results.filter(
      (result) =>
        result.guard &&
        !guarded.has(result.actorId) &&
        (result.defeats.some((request) => request.detail.applied) || result.unclamped <= 0n),
    );
    if (!required.length) break;
    for (const result of required) guarded.add(result.actorId);
    if (evaluation === targets.length) throw new Error('Nonconvergent finite guard allocation');
  }
  return results.map(
    ({
      unclamped,
      maxHp,
      availableHp: _,
      guard,
      openingHp,
      ordinaryHealing: _ordinary,
      ...result
    }) => ({
      ...result,
      ...(guarded.has(result.actorId) && guard ? { protection: guard.revision } : {}),
      resources: {
        ...result.resources,
        hp: guarded.has(result.actorId)
          ? 1
          : (concept && !openingHp) || result.defeats.some((request) => request.detail.applied)
            ? 0
            : checked(unclamped < 0n ? 0n : unclamped > maxHp ? maxHp : unclamped),
      },
    }),
  );
}
