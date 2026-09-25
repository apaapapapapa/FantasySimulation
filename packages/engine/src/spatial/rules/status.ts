import type { ResolvedActor, StatusRevision, StatusCohort } from '../state.ts';
export type { StatusRevision, StatusCohort } from '../state.ts';
import {
  DEFAULT_BUDGET,
  compareIds,
  statusTransformationRefs,
} from '@fantasy/domain/spatial/execution';
import { SpatialBudgetError } from '../world/physics.ts';
import { permanentStatus } from './categories.ts';
import { adjustedStatusValue } from './status-modifiers.ts';
export type StatusLimits = { maxStatusTypes: number; maxStatusCauses: number };

/** Only definitions reachable from known abilities or currently owned states enter self knowledge. */
export function statusKnowledge<T extends StatusRevision>(
  roots: readonly T[],
  available: readonly T[],
): T[] {
  const known = new Map<string, T>();
  function visit(status: T) {
    const key = `${status.id}:${status.revision}:${status.contentHash}`;
    if (known.has(key)) return;
    known.set(key, status);
    for (const ref of statusTransformationRefs(status.definition)) {
      const dependency = available.find(
        (s) => s.id === ref.id && s.revision === ref.revision && s.contentHash === ref.contentHash,
      );
      if (!dependency) throw new Error('Missing status transformation revision');
      visit(dependency);
    }
  }
  roots.forEach(visit);
  return [...known.values()];
}

export type StatusApplication = {
  revision: StatusRevision;
  cause: string;
  flightStaminaPerSecond?: number;
  causes?: readonly string[];
};
export type StatusChange = {
  kind: 'apply' | 'remove' | 'refresh' | 'reject';
  revision: StatusRevision;
  stacks: number;
  causes: string[];
  reason: string;
};
export class UnresolvedRuleError extends Error {
  readonly ruleId: string;
  readonly revisions: string[];
  constructor(ruleId: string, revisions: string[], reason: string) {
    super(reason);
    this.ruleId = ruleId;
    this.revisions = [...new Set(revisions)].sort(compareIds);
  }
}
const sameRevision = (a: StatusRevision, b: StatusRevision) =>
  a.id === b.id && a.revision === b.revision && a.contentHash === b.contentHash;
const clone = (s: StatusCohort): StatusCohort => ({ ...s, causes: [...s.causes] });
/** Number of origin-aligned pulses in the half-open interval [from, until). */
export function periodicPulseCount(
  origin: number,
  everySteps: number,
  from: number,
  until: number,
) {
  const first = origin + Math.max(0, Math.ceil((from - origin) / everySteps)) * everySteps;
  return Math.max(0, Math.ceil((until - first) / everySteps));
}
/** Expiry precedes periodic effects. A new status first pulses at its activation boundary. */
export function statusBoundary(statuses: readonly StatusCohort[], step: number) {
  const removed = statuses.filter((s) => s.endStep <= step).map(clone);
  const active = statuses.filter((s) => s.startStep <= step && step < s.endStep);
  const pulses = active.flatMap((s) => {
    const causes = Object.freeze([...s.causes]);
    return s.revision.definition.periodic.flatMap((effect, index) =>
      periodicPulseCount(s.startStep, effect.everySteps, step, step + 1) > 0
        ? Array.from({ length: s.stacks }, (_, stack) => ({
            revision: s.revision,
            effect,
            index,
            stack,
            causes,
            startStep: s.startStep,
          }))
        : [],
    );
  });
  return { statuses: statuses.filter((s) => s.endStep > step).map(clone), removed, pulses };
}
/** A dispel target is a whole status ID or one exact revision (e.g. a category match). */
export type DispelTarget = string | StatusRevision;
/** Dispel affects the pre-existing snapshot; simultaneous new applications become active nextStep. */
export function applyStatuses(
  existing: readonly StatusCohort[],
  incoming: readonly StatusApplication[],
  dispel: readonly DispelTarget[],
  nextStep: number,
  limits: StatusLimits = DEFAULT_BUDGET,
): { statuses: StatusCohort[]; changes: StatusChange[] } {
  const dispelled = (s: StatusCohort) =>
    !permanentStatus(s.revision.definition) &&
    dispel.some((t) => (typeof t === 'string' ? t === s.revision.id : sameRevision(t, s.revision)));
  let statuses = existing.filter((s) => s.endStep > nextStep && !dispelled(s)).map(clone);
  const changes: StatusChange[] = existing
    .filter((s) => s.endStep <= nextStep || dispelled(s))
    .map((s) => ({
      kind: 'remove',
      revision: s.revision,
      stacks: s.stacks,
      causes: [...s.causes],
      reason: s.endStep <= nextStep ? 'expired' : 'dispel-existing',
    }));
  const groups = new Map<string, StatusApplication[]>();
  for (const application of incoming) {
    const key = application.revision.definition.stackKey;
    const group = groups.get(key) ?? [];
    group.push(application);
    groups.set(key, group);
  }
  for (const [key, group] of [...groups].sort(([a], [b]) => compareIds(a, b))) {
    const revision = group[0]!.revision,
      definition = revision.definition;
    if (group.some((a) => !sameRevision(a.revision, revision)))
      throw new UnresolvedRuleError(
        'status.simultaneous-conflict',
        group.map((a) => a.revision.id),
        'Different simultaneous definitions share a stack key',
      );
    const old = statuses.filter((s) => s.revision.definition.stackKey === key);
    if (
      old.some((s) => permanentStatus(s.revision.definition) && !sameRevision(s.revision, revision))
    )
      throw new UnresolvedRuleError(
        'status.permanent-conflict',
        [revision.id, ...old.map((s) => s.revision.id)],
        'A permanent status cannot be replaced by a different revision',
      );
    const causes = [...new Set(group.flatMap((a) => a.causes ?? [a.cause]))].sort(compareIds);
    const flightCosts = group.map(
      (a) => a.flightStaminaPerSecond ?? definition.flightStaminaPerSecond ?? 0,
    );
    const flightCost = Math.min(...flightCosts);
    const flightOverride = group.some((a) => a.flightStaminaPerSecond !== undefined)
      ? { flightStaminaPerSecond: flightCost }
      : {};
    const change = (kind: StatusChange['kind'], stacks: number, reason: string) =>
      changes.push({ kind, revision, stacks, causes, reason });
    if (definition.stacking === 'reject' && old.length) {
      change('reject', 0, 'existing-stack');
      continue;
    }
    if (definition.stacking !== 'replace' && old.some((s) => !sameRevision(s.revision, revision)))
      throw new UnresolvedRuleError(
        'status.existing-conflict',
        [revision.id, ...old.map((s) => s.revision.id)],
        'Different definitions share a stack key without replacement',
      );
    if (
      (definition.stacking === 'refresh' ||
        (permanentStatus(definition) &&
          definition.stacking === 'replace' &&
          old.every((s) => sameRevision(s.revision, revision)))) &&
      old.length
    ) {
      statuses = statuses.map((s) =>
        s.revision.definition.stackKey === key
          ? {
              ...s,
              endStep: permanentStatus(definition)
                ? 12000
                : Math.max(s.endStep, nextStep + definition.durationSteps),
              causes: [...new Set([...s.causes, ...causes])].sort(compareIds),
              ...((s.flightStaminaPerSecond !== undefined ||
                Object.keys(flightOverride).length) && {
                flightStaminaPerSecond: Math.min(
                  s.flightStaminaPerSecond ?? definition.flightStaminaPerSecond ?? 0,
                  flightCost,
                ),
              }),
            }
          : s,
      );
      change(
        'refresh',
        old.reduce((n, s) => n + s.stacks, 0),
        'extend-end-preserve-period',
      );
      continue;
    }
    if (definition.stacking === 'replace') {
      statuses = statuses.filter((s) => s.revision.definition.stackKey !== key);
      for (const s of old)
        changes.push({
          kind: 'remove',
          revision: s.revision,
          stacks: s.stacks,
          causes,
          reason: 'replace-existing',
        });
    }
    const capacity = definition.maxStacks - old.reduce((n, s) => n + s.stacks, 0);
    const stacks =
      definition.stacking === 'sum' ? Math.max(0, Math.min(group.length, capacity)) : 1;
    if (!stacks) {
      change('reject', 0, 'stack-limit');
      continue;
    }
    // Same-boundary equal effects form one cohort; saturation never chooses an actor as winner.
    const sameStart = statuses.find(
      (s) => sameRevision(s.revision, revision) && s.startStep === nextStep,
    );
    if (sameStart) {
      sameStart.stacks += stacks;
      sameStart.causes = [...new Set([...sameStart.causes, ...causes])].sort(compareIds);
      if (sameStart.flightStaminaPerSecond !== undefined || Object.keys(flightOverride).length)
        sameStart.flightStaminaPerSecond = Math.min(
          sameStart.flightStaminaPerSecond ?? definition.flightStaminaPerSecond ?? 0,
          flightCost,
        );
    } else
      statuses.push({
        revision,
        startStep: nextStep,
        endStep: permanentStatus(definition) ? 12000 : nextStep + definition.durationSteps,
        stacks,
        causes,
        ...flightOverride,
      });
    change('apply', stacks, stacks < group.length ? 'simultaneous-cohort-capped' : 'next-boundary');
  }
  if (
    new Set(statuses.map((s) => s.revision.definition.stackKey)).size > limits.maxStatusTypes ||
    statuses.length > limits.maxStatusTypes * 32
  )
    throw new SpatialBudgetError('active-statuses');
  if (statuses.reduce((n, s) => n + s.causes.length, 0) > limits.maxStatusCauses)
    throw new SpatialBudgetError('status-causes');
  statuses.sort(
    (a, b) =>
      compareIds(a.revision.definition.stackKey, b.revision.definition.stackKey) ||
      a.startStep - b.startStep,
  );
  return { statuses, changes };
}
export function effectiveStats(
  actor: ResolvedActor,
  statuses: readonly StatusCohort[],
  step: number,
) {
  let attack =
    actor.character.stats.attack + actor.equipment.reduce((n, e) => n + e.attackBonus, 0);
  let defense =
    actor.character.stats.defense + actor.equipment.reduce((n, e) => n + e.defenseBonus, 0);
  let speedBps = 10000,
    flight = false,
    rooted = false,
    silenced = false;
  for (const status of statuses)
    if (status.startStep <= step && step < status.endStep) {
      const modifiers = status.revision.definition.modifiers;
      attack += modifiers.attack * status.stacks;
      defense += modifiers.defense * status.stacks;
      speedBps += (modifiers.speedBps - 10000) * status.stacks;
      flight ||= modifiers.flight;
      rooted ||= modifiers.rooted;
      silenced ||= modifiers.silenced ?? false;
    }
  attack = adjustedStatusValue(attack, 'attack', statuses, step);
  defense = adjustedStatusValue(defense, 'defense', statuses, step);
  const has = (target: 'magicPower' | 'magicDefense') =>
    statuses.some(
      (s) =>
        s.startStep <= step &&
        step < s.endStep &&
        s.revision.definition.adjustments?.some((a) => a.target === target),
    );
  return {
    attack,
    defense,
    ...((actor.character.stats.magicPower !== undefined || has('magicPower')) && {
      magicPower: adjustedStatusValue(
        actor.character.stats.magicPower ?? attack,
        'magicPower',
        statuses,
        step,
      ),
    }),
    ...((actor.character.stats.magicDefense !== undefined || has('magicDefense')) && {
      magicDefense: adjustedStatusValue(
        actor.character.stats.magicDefense ?? defense,
        'magicDefense',
        statuses,
        step,
      ),
    }),
    speedBps: Math.min(30000, adjustedStatusValue(10000, 'speed', statuses, step, {}, speedBps)),
    flight,
    rooted: rooted || adjustedStatusValue(10000, 'movement', statuses, step) === 0,
    silenced,
    incapacitated: adjustedStatusValue(10000, 'action', statuses, step) === 0,
  };
}
