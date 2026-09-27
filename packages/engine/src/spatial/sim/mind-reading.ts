import type {
  Effect,
  DeepReadonly,
  ReadObservation,
  RevisionRef,
} from '@fantasy/domain/spatial/execution';
import type { ActorState, MotionState } from '../state.ts';
import type { SpatialWorld } from '../world/physics.ts';
import { canObserveActor } from '../world/visibility.ts';
import { displayActor } from './combat-state.ts';

/** The sensor samples the opening snapshot. Policies only receive its delayed bounded result. */
export function readMind(
  world: SpatialWorld,
  self: MotionState,
  target: ActorState,
  observedTarget: MotionState,
  effect: DeepReadonly<Extract<Effect, { kind: 'reveal' }>>,
  ability: RevisionRef,
  eventId: string,
  step: number,
  visible = canObserveActor(world, self, observedTarget),
): ReadObservation | null {
  if (
    effect.field === 'resistance' ||
    !visible ||
    effect.powerBps <= (observedTarget.actor.character.perception.revealWardBps ?? 0)
  )
    return null;
  const timing = {
    eventId,
    targetId: observedTarget.actor.participant.actorId,
    ability: { ...ability },
    sampledAt: step,
    availableAt: step + effect.delaySteps + self.actor.character.perception.reactionSteps,
    expiresAt: step + effect.durationSteps,
  };
  if (effect.field === 'health') {
    const value = Math.floor(
      (target.vitals.resources.hp * 10000) / observedTarget.actor.character.stats.hp,
    );
    const low = Math.floor(value / effect.precisionBps) * effect.precisionBps;
    return {
      ...timing,
      field: 'health',
      range: { low, high: Math.min(10000, low + effect.precisionBps) },
    };
  }
  const action = displayActor(target, step).action;
  return {
    ...timing,
    field: 'declared-action',
    action: action ? { abilityId: action.abilityId, phase: action.phase } : null,
  };
}
