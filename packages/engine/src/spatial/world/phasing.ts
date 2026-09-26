import type { PhaseContribution, SpatialMaterial } from '@fantasy/domain/spatial/execution';
import type { AbilityRevision, DamageSnapshot, MotionState } from '../state.ts';
import type { PhaseQuery } from '../geometry-types.ts';
import { cosDegrees } from '../math.ts';
import type { SpatialWorld } from './physics.ts';
export function combinedPhase(contributions: readonly PhaseContribution[]): {
  materials: SpatialMaterial[];
  floor: boolean;
  floorMaterials: SpatialMaterial[];
} {
  return {
    materials: [...new Set(contributions.flatMap((c) => c.materials))].sort(),
    floor: false,
    floorMaterials: [
      ...new Set(contributions.filter((c) => c.floor).flatMap((c) => c.materials)),
    ].sort(),
  };
}
export function bodyWorld(world: SpatialWorld, motion: MotionState): SpatialWorld {
  const contributions = [...(motion.phasing?.active ?? []), ...(motion.phasing?.retained ?? [])],
    mask = combinedPhase(contributions);
  return world.forQuery({
    ownerId: motion.actor.participant.actorId,
    ...(mask.materials.length
      ? {
          phase: {
            ...mask,
            layer: 'movement',
            minGroundY: cosDegrees(motion.actor.character.movement.maxSlopeMilliDegrees / 1000),
          } satisfies PhaseQuery,
        }
      : {}),
  });
}
export function attackWorld(
  world: SpatialWorld,
  source: Pick<DamageSnapshot, 'phaseSlopeY'> & { ownerId: string; ability: AbilityRevision },
  motion?: MotionState,
): SpatialWorld {
  const shape = source.ability.definition.attack;
  const mask = 'phasing' in shape ? shape.phasing : undefined;
  const minGroundY =
    source.phaseSlopeY ??
    (motion ? cosDegrees(motion.actor.character.movement.maxSlopeMilliDegrees / 1000) : undefined);
  if (mask && minGroundY === undefined) throw new Error('Missing launch phasing slope');
  return world.forQuery({
    ownerId: source.ownerId,
    ...(mask
      ? { phase: { ...mask, layer: 'attack', minGroundY: minGroundY! } satisfies PhaseQuery }
      : {}),
  });
}
