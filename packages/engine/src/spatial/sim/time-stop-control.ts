import { effectiveStatuses } from '@fantasy/domain/spatial/execution';
import type { AbilityRevision, ActorState } from '../state.ts';
import { canSee, bodyPoint } from '../world/visibility.ts';
import { inMuzzleRange } from '../rules/attacks.ts';
import { selfView } from '../ai/self-view.ts';
import { blockedBySeal, blockedBySilence } from '../rules/categories.ts';
import { domainSnapshotStep, freezeActor, frozen, thawActor } from '../rules/subject-clocks.ts';
import { type StepTransaction, actorId } from './step-transaction.ts';
import {
  emptyStopState,
  restoreDescriptor,
  stopDescriptor,
  type StopRequest,
} from './time-stop-state.ts';

export function stopEvent(
  tx: StepTransaction,
  request: StopRequest,
  state: 'queued' | 'activated' | 'fizzle' | 'capture' | 'release',
  step: number,
  reason: string,
  phase: 'launch' | 'boundary' | 'resolution',
) {
  const stop = tx.next.stop!;
  return tx.journal.emit({
    kind: 'time-stop',
    step,
    phase,
    actorId: request.ownerId,
    targetId: request.targetId,
    abilityId: request.ability.id,
    parentEventId: request.cause,
    ruleId: `concept.time-stop.${state}`,
    reason,
    timeStop: {
      state,
      controlId: request.id,
      durationSteps: request.duration,
      uses: stop.uses,
      reservedSteps: stop.reserved,
      executedSteps: stop.executed,
      contacts: stop.contacts,
      operations: stop.operations,
      bytes: stop.bytes,
    },
  });
}
export function queueStop(
  tx: StepTransaction,
  actor: ActorState,
  ability: AbilityRevision,
  cause: string,
) {
  const observed = actor.mind.memory.observation?.enemy;
  const stop = (tx.next.stop ??= emptyStopState());
  const request: StopRequest = {
    id: `t.${tx.next.serial++}`,
    ownerId: actorId(actor),
    targetId: tx.next.actors.find((other) => actorId(other) !== actorId(actor))!.body.motion.actor
      .participant.actorId,
    ability,
    cause,
    at: tx.step + 1,
    duration: ability.definition.timeStop!.durationSteps,
  };
  if (!observed || !canSee(tx.context.world, actor.body.motion, observed.position)) {
    stopEvent(tx, request, 'fizzle', tx.step, 'no delivered visible target', 'launch');
    return;
  }
  stop.requests.push(request);
  stopEvent(tx, request, 'queued', tx.step, 'fixed-target next-boundary activation', 'launch');
}
export function activateStops(tx: StepTransaction) {
  const stop = tx.next.stop;
  if (!stop?.requests.length) return;
  const { world, battle } = tx.context;
  const due = stop.requests.filter((request) => request.at <= tx.step);
  stop.requests = stop.requests.filter((request) => request.at > tx.step);
  const eligible = due.filter((request) => {
    tx.context.work.candidate();
    const source = tx.next.actors.find((actor) => actorId(actor) === request.ownerId)!;
    const target = tx.next.actors.find((actor) => actorId(actor) === request.targetId)!;
    const view = selfView(source, tx.step, battle.rules.ai, battle.statuses);
    return (
      !stop.active &&
      !frozen(source) &&
      source.vitals.resources.hp > 0 &&
      target.vitals.resources.hp > 0 &&
      !view.incapacitated &&
      !blockedBySeal(view, request.ability.definition) &&
      !(view.silenced && blockedBySilence(request.ability.definition)) &&
      inMuzzleRange(
        request.ability.definition,
        source.body.motion,
        bodyPoint(target.body.motion, target.body.motion.actor.character.body.aimOffset),
      ) &&
      canSee(
        world,
        source.body.motion,
        bodyPoint(target.body.motion, target.body.motion.actor.character.body.aimOffset),
      ) &&
      !effectiveStatuses(target.statuses, domainSnapshotStep(target, tx.step)).some(
        (status) => status.revision.definition.stopImmunity,
      ) &&
      stop.uses < 4 &&
      stop.reserved + request.duration <= 300
    );
  });
  for (const request of due) {
    if (eligible.length !== 1 || eligible[0] !== request) {
      stopEvent(
        tx,
        request,
        'fizzle',
        tx.step,
        'activation rejected or mutually valid opposing requests; costs retained',
        'boundary',
      );
      continue;
    }
    stop.uses++;
    stop.reserved += request.duration;
    stop.active = { ...request, from: tx.step, until: tx.step + request.duration };
    const target = tx.next.actors.find((actor) => actorId(actor) === request.targetId)!;
    freezeActor(target, request.id, tx.step, tx.step + request.duration);
    target.vitals.conceptCue = { kind: 'time-stop', at: tx.step };
    stopEvent(
      tx,
      request,
      'activated',
      tx.step,
      'opponent full clock mask; global deadlines continue',
      'boundary',
    );
  }
}
export function releaseStop(
  tx: StepTransaction,
  step: number,
  reason: string,
  phase: 'boundary' | 'resolution',
) {
  const stop = tx.next.stop,
    active = stop?.active;
  if (!stop || !active) return [];
  const target = tx.next.actors.find((actor) => actorId(actor) === active.targetId)!;
  const amount = thawActor(target, step);
  for (const melee of tx.next.melees)
    if (melee.actorId === active.targetId) melee.launchStep += amount;
  stop.executed += amount;
  delete stop.active;
  const pending = stop.pending.map((ordinal) =>
    restoreDescriptor(stopDescriptor(stop, ordinal), tx.next.actors),
  );
  stop.pending = [];
  stopEvent(tx, active, 'release', step, reason, phase);
  return pending;
}

export function cancelEndedStops(tx: StepTransaction) {
  if (
    !tx.next.stop ||
    (tx.step + 1 < tx.context.battle.rules.maxSteps &&
      tx.next.actors.every((actor) => actor.vitals.resources.hp > 0))
  )
    return;
  for (const request of tx.next.stop.requests)
    stopEvent(
      tx,
      request,
      'fizzle',
      tx.step + 1,
      'battle-ended; paid request not activated',
      'resolution',
    );
  tx.next.stop.requests = [];
}
