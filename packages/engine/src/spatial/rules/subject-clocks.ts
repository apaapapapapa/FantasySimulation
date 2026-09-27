import type { ClockDisplay } from '@fantasy/domain/spatial/execution';
import type { ActorClock, ActorState, PerceptionMemory } from '../state.ts';

export const frozen = (actor: ActorState) => !!actor.clock?.frozen;
export const domainSnapshotStep = (actor: ActorState, global: number) =>
  actor.clock?.frozen?.from ?? global;
export const subjectStep = (actor: ActorState, global: number) =>
  domainSnapshotStep(actor, global) - (actor.clock?.pausedSteps ?? 0);
/** Historical sample stamps stay global. Age subtracts only this observer's paused intervals. */
export function observedAge(clock: ActorClock | undefined, sampledAt: number, global: number) {
  return (
    global -
    sampledAt -
    (clock?.periods ?? []).reduce(
      (n, p) => n + Math.max(0, Math.min(global, p.to) - Math.max(sampledAt, p.from)),
      0,
    )
  );
}

/** Existing scalar timers are cached global projections. Rebase once on thaw, never per tick.
 * The domain deadline (cached timer - pausedSteps) is unchanged; stamps retain their origin. */
export function rebaseActorTimers(actor: ActorState, amount: number, from: number) {
  if (!amount) return;
  for (const status of actor.statuses) {
    status.globalStartStep ??= status.startStep;
    status.startStep += amount;
    status.endStep += amount;
  }
  const action = actor.actions.action;
  if (action) {
    action.globalStartedAt ??= action.startedAt;
    action.startedAt += amount;
    action.launchAt += amount;
    action.recoveryUntil += amount;
  }
  actor.actions.readyAt += amount;
  for (const id of Object.keys(actor.actions.cooldowns)) actor.actions.cooldowns[id]! += amount;
  for (const reaction of actor.actions.reactions ?? []) {
    if (reaction.state === 'queued') reaction.readyAt += amount;
    reaction.recoveryUntil += amount;
    reaction.cooldownUntil += amount;
  }
  if (actor.body.motionClock?.dodgeUntilStep !== undefined)
    actor.body.motionClock.dodgeUntilStep += amount;
  if (actor.body.motion.posture?.transition)
    actor.body.motion.posture.transition.completeAt += amount;
  if (actor.body.motion.posture?.holdUntil !== undefined)
    actor.body.motion.posture.holdUntil += amount;
  for (const force of actor.body.forces ?? []) {
    force.startAt += amount;
    force.endAt += amount;
  }
  // Copies prevent mutation of shared immutable perception snapshots across rollback.
  const memory = structuredClone(actor.mind.memory) as MutableMemory;
  memory.sampledAt += amount;
  const shift = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(shift);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (
        typeof item === 'number' &&
        (key === 'expiresAt' || (key === 'availableAt' && item >= from))
      )
        record[key] = item + amount;
      else shift(item);
    }
  };
  shift(memory);
  actor.mind.memory = memory;
}
type MutableMemory = { -readonly [K in keyof PerceptionMemory]: PerceptionMemory[K] };

export function freezeActor(actor: ActorState, controlId: string, from: number, until: number) {
  actor.clock ??= { pausedSteps: 0, periods: [] };
  actor.clock.frozen = { controlId, from, until };
  actor.body.motion.frozen = true;
}
export function thawActor(actor: ActorState, global: number) {
  const clock = actor.clock,
    stop = clock?.frozen;
  if (!clock || !stop) return 0;
  const amount = global - stop.from;
  rebaseActorTimers(actor, amount, stop.from);
  clock.pausedSteps += amount;
  clock.periods.push({ from: stop.from, to: global });
  delete clock.frozen;
  delete actor.body.motion.frozen;
  return amount;
}
export function clockDisplay(actor: ActorState, global: number): ClockDisplay | undefined {
  if (!actor.clock) return undefined;
  const current = subjectStep(actor, global),
    offset = global - current;
  const pending = global - domainSnapshotStep(actor, global);
  const deadlines: ClockDisplay['deadlines'] = [];
  const add = (
    key: string,
    domain: ClockDisplay['deadlines'][number]['domain'],
    cached: number,
  ) => {
    const at = Math.max(0, cached - actor.clock!.pausedSteps);
    deadlines.push({
      key,
      domain,
      at,
      remainingSteps: Math.max(0, at - current),
      projectedStep: at + offset,
    });
  };
  if (actor.actions.action) {
    add('action.launch', 'action', actor.actions.action.launchAt);
    add('action.recovery', 'action', actor.actions.action.recoveryUntil);
  }
  (actor.actions.reactions ?? []).forEach((reaction, i) => {
    if (reaction.state === 'queued') add(`reaction.${i}.ready`, 'action', reaction.readyAt);
  });
  actor.statuses.forEach((status, i) => add(`status.${i}.end`, 'status', status.endStep));
  (actor.body.forces ?? []).forEach((force, i) => add(`force.${i}.end`, 'motion', force.endAt));
  return {
    projectionAsOfGlobalStep: global,
    subjectStep: current,
    pausedSteps: actor.clock.pausedSteps + pending,
    periods: actor.clock.periods.map((period) => ({ ...period })),
    ...(actor.clock.frozen ? { frozen: { ...actor.clock.frozen } } : {}),
    deadlines,
  };
}
