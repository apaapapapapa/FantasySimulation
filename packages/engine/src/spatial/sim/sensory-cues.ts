import {
  effectiveStatuses,
  sensoryCueId,
  type BattleEvent,
} from '@fantasy/domain/spatial/execution';
import type { ActorState, PerceptionMemory, SensoryCue } from '../state.ts';
import type { Journal } from '../rules/journal.ts';

export function recordedCue(cue: SensoryCue): NonNullable<BattleEvent['sensoryCue']> {
  const { deliveryRecorded: _, ...recorded } = cue;
  return { ...recorded, transition: 'emitted' };
}

/** Independent identity derivation: this never reads or advances combat/decision PRNG state. */
export function cueIdentity(seed: number, creatorId: string, observerId: string, ordinal: number) {
  return sensoryCueId(seed, creatorId, observerId, ordinal);
}

export function cleanseSensoryCues(
  actor: ActorState,
  step: number,
  phase: BattleEvent['phase'],
  journal: Journal,
  causes: readonly string[],
) {
  for (const cue of actor.mind.sensoryCues)
    journal.emit({
      step,
      phase,
      kind: 'sensory-cue',
      actorId: cue.creatorId,
      targetId: cue.observerId,
      entityId: cue.id,
      ruleId: 'sensory-cue.cleanse',
      causes: [...causes],
      reason: 'observer-scoped-control-cleanse',
      sensoryCue: { ...recordedCue(cue), transition: 'cleansed' },
    });
  const removed = actor.mind.sensoryCues.length;
  actor.mind.sensoryCues = [];
  return removed;
}

export function cognitiveCueEligibility(actor: ActorState, statusStep: number) {
  if (actor.body.motion.actor.character.mentalEligibility !== 'cognitive')
    return { eligible: false as const, reason: 'non-cognitive-target' as const };
  if (
    effectiveStatuses(actor.statuses, statusStep).some(
      (status) => status.revision.definition.mentalImmunity === true,
    )
  )
    return { eligible: false as const, reason: 'mental-immunity' as const };
  return { eligible: true as const };
}

/** Discovery wins a same-step tie with expiry. Delivery is recorded once before either removal. */
export function settleSensoryCues(actor: ActorState, step: number, journal: Journal) {
  const retained: SensoryCue[] = [];
  for (const cue of actor.mind.sensoryCues) {
    if (!cue.deliveryRecorded && cue.deliveredAt <= step) {
      cue.deliveryRecorded = true;
      journal.emit({
        step,
        phase: 'boundary',
        kind: 'sensory-cue',
        actorId: cue.creatorId,
        targetId: cue.observerId,
        entityId: cue.id,
        ruleId: 'sensory-cue.delivery',
        reason: 'observer-only-delivery',
        sensoryCue: { ...recordedCue(cue), transition: 'delivered' },
      });
    }
    const transition =
      cue.discoveredAt <= step
        ? ('discovered' as const)
        : cue.expiresAt <= step
          ? ('expired' as const)
          : null;
    if (transition) {
      journal.emit({
        step,
        phase: 'boundary',
        kind: 'sensory-cue',
        actorId: cue.creatorId,
        targetId: cue.observerId,
        entityId: cue.id,
        ruleId: `sensory-cue.${transition}`,
        reason: `observer-scoped-${transition}`,
        sensoryCue: { ...recordedCue(cue), transition },
      });
    } else retained.push(cue);
  }
  actor.mind.sensoryCues = retained;
}

/** Overlay only the observer's delivered, undiscovered cue; canonical bodies stay untouched. */
export function subjectiveCueMemory(
  memory: PerceptionMemory,
  cues: readonly SensoryCue[],
  step: number,
): PerceptionMemory {
  const cue = [...cues]
    .filter(
      (candidate) =>
        candidate.deliveredAt <= step &&
        step < candidate.discoveredAt &&
        step < candidate.expiresAt,
    )
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!cue) return memory;
  const observation = memory.observation;
  const enemy = observation?.enemy ?? memory.lastSeen;
  if (!enemy || enemy.id !== cue.creatorId) return memory;
  const perceived = { ...enemy, position: { ...cue.perceivedOrigin } };
  return {
    ...memory,
    observation: observation ? { ...observation, enemy: perceived } : observation,
    lastSeen: perceived,
  };
}
