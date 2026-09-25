import type { DecisionView, StatusCohort, Gait } from '../state.ts';
export type { Gait } from '../state.ts';
import type { DeepReadonly, Definition, ResourceState } from '@fantasy/domain/spatial/execution';
import { staminaExhausted } from './resources.ts';

export function gaitProfile(character: DeepReadonly<Definition<'character'>>, gait: Gait) {
  const m = character.movement;
  if (!m.locomotion)
    return {
      speedMmPerSecond:
        character.stamina && gait === 'slow' ? m.speedMmPerSecond / 4 : m.speedMmPerSecond,
      staminaPerMeter: 0,
    };
  return gait === 'slow'
    ? { speedMmPerSecond: m.locomotion.exhaustedSpeedMmPerSecond, staminaPerMeter: 0 }
    : m.locomotion[gait];
}
/** Competing flight grants offer alternatives; omitted cost is a free grant. */
export function flightRate(statuses: readonly StatusCohort[], step: number): number {
  const grants = statuses.filter(
    (s) => s.startStep <= step && step < s.endStep && s.revision.definition.modifiers.flight,
  );
  return grants.length
    ? Math.min(
        ...grants.map(
          (s) => s.flightStaminaPerSecond ?? s.revision.definition.flightStaminaPerSecond ?? 0,
        ),
      )
    : 0;
}
export function resourceReady(view: Pick<DecisionView, 'resources' | 'self' | 'staminaExhausted'>) {
  return !staminaExhausted(
    view.resources,
    view.self.actor.character.stamina,
    view.staminaExhausted,
  );
}
export function canMaintainFlight(
  resources: ResourceState,
  perSecond: number,
  ready: boolean,
  elapsedMs = 20,
) {
  return (
    perSecond === 0 ||
    (ready && (resources.stamina ?? 0) >= Math.ceil((perSecond * elapsedMs) / 1000))
  );
}
