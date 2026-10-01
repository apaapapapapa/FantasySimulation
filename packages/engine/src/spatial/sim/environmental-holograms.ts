import { environmentalHologramId, type BattleEvent } from '@fantasy/domain/spatial/execution';
import type { ActorState, EnvironmentalHologram } from '../state.ts';
import type { Journal } from '../rules/journal.ts';
import { adjustedStatusValue } from '../rules/status-modifiers.ts';
import { frozen } from '../rules/subject-clocks.ts';

export function hologramIdentity(
  seed: number,
  creatorId: string,
  observerId: string,
  ordinal: number,
) {
  return environmentalHologramId(seed, creatorId, observerId, ordinal);
}

export function visualSensorEligibility(actor: ActorState, statusStep: number) {
  return adjustedStatusValue(10000, 'vision', actor.statuses, statusStep) > 0
    ? ({ eligible: true } as const)
    : ({ eligible: false, reason: 'visual-sensor-disabled' } as const);
}

export function recordedHologram(
  hologram: EnvironmentalHologram,
): NonNullable<BattleEvent['environmentalHologram']> {
  return { ...structuredClone(hologram), transition: 'activated' };
}

/** Lifecycle changes occur only at boundaries; terminal removal makes each transition one-shot. */
export function settleEnvironmentalHolograms(actor: ActorState, step: number, journal: Journal) {
  if (frozen(actor)) return;
  const retained: EnvironmentalHologram[] = [];
  for (const hologram of actor.sensors.environmentalHolograms) {
    if (hologram.state === 'active-unobserved' && hologram.observedAt <= step) {
      hologram.state = 'observed';
      journal.emit({
        step,
        phase: 'boundary',
        kind: 'environmental-hologram',
        actorId: hologram.creatorId,
        targetId: hologram.observerId,
        entityId: hologram.id,
        ruleId: 'environmental-hologram.observed',
        reason: 'observer-visual-sensor-observation',
        environmentalHologram: { ...recordedHologram(hologram), transition: 'observed' },
      });
    }
    if (hologram.state === 'observed' && hologram.invalidatedAt <= step) {
      hologram.state = 'invalidated';
      journal.emit({
        step,
        phase: 'boundary',
        kind: 'environmental-hologram',
        actorId: hologram.creatorId,
        targetId: hologram.observerId,
        entityId: hologram.id,
        ruleId: 'environmental-hologram.invalidated',
        reason: 'observer-visual-sensor-invalidation',
        environmentalHologram: { ...recordedHologram(hologram), transition: 'invalidated' },
      });
    }
    if (hologram.expiresAt <= step) {
      journal.emit({
        step,
        phase: 'boundary',
        kind: 'environmental-hologram',
        actorId: hologram.creatorId,
        targetId: hologram.observerId,
        entityId: hologram.id,
        ruleId: 'environmental-hologram.expired',
        reason: 'observer-visual-sensor-expiry',
        environmentalHologram: { ...recordedHologram(hologram), transition: 'expired' },
      });
    } else retained.push(hologram);
  }
  actor.sensors.environmentalHolograms = retained;
}
