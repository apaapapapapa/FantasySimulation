import {
  DEFAULT_BUDGET,
  compareIds,
  type DeepReadonly,
  type Revision,
} from '@fantasy/domain/spatial';
import type { ResolvedActor } from './prepare.ts';
import { SpatialBudgetError } from './physics.ts';
export type StatusLimits = { maxStatusTypes: number; maxStatusCauses: number };
export type StatusRevision = DeepReadonly<Extract<Revision, { kind: 'status' }>>;
export type StatusCohort = {
  revision: StatusRevision;
  startStep: number;
  endStep: number;
  stacks: number;
  causes: string[];
};
export type StatusApplication = { revision: StatusRevision; cause: string };
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
/** Expiry precedes periodic effects. A new status first pulses at its activation boundary. */
export function statusBoundary(statuses: readonly StatusCohort[], step: number) {
  const removed = statuses.filter((s) => s.endStep <= step).map(clone);
  const active = statuses.filter((s) => s.startStep <= step && step < s.endStep);
  const pulses = active.flatMap((s) => {
    const causes = Object.freeze([...s.causes]);
    return s.revision.definition.periodic.flatMap((effect, index) =>
      step >= s.startStep && (step - s.startStep) % effect.everySteps === 0
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
    const causes = [...new Set(group.map((a) => a.cause))].sort(compareIds);
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
    if (definition.stacking === 'refresh' && old.length) {
      statuses = statuses.map((s) =>
        s.revision.definition.stackKey === key
          ? {
              ...s,
              endStep: Math.max(s.endStep, nextStep + definition.durationSteps),
              causes: [...new Set([...s.causes, ...causes])].sort(compareIds),
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
    } else
      statuses.push({
        revision,
        startStep: nextStep,
        endStep: nextStep + definition.durationSteps,
        stacks,
        causes,
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
  return {
    attack: Math.max(0, attack),
    defense: Math.max(0, defense),
    ...(actor.character.stats.magicPower !== undefined && {
      magicPower: actor.character.stats.magicPower,
    }),
    ...(actor.character.stats.magicDefense !== undefined && {
      magicDefense: actor.character.stats.magicDefense,
    }),
    speedBps: Math.max(0, Math.min(30000, speedBps)),
    flight,
    rooted,
    silenced,
  };
}
