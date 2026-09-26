import type { VectorMm } from '@fantasy/domain/spatial/execution';
import type { MotionState } from '../state.ts';
import type { SpatialWorld } from './physics.ts';
import { add, cosDegrees, cross, dot, length, mul, sub, unit, type Vec3 } from '../math.ts';
import { metres } from './terrain.ts';

/** Upright body offsets: local +X is forward, +Z is right, +Y remains world up. */
export function bodyPoint(state: Pick<MotionState, 'position' | 'facing'>, offset: VectorMm): Vec3 {
  const horizontal = { x: state.facing.x, y: 0, z: state.facing.z };
  const forward = length(horizontal) > 1e-12 ? unit(horizontal) : { x: 1, y: 0, z: 0 };
  const right = cross(forward, { x: 0, y: 1, z: 0 });
  const local = metres(offset);
  return add(
    state.position,
    add(mul(forward, local.x), add({ x: 0, y: local.y, z: 0 }, mul(right, local.z))),
  );
}
export function canSee(world: SpatialWorld, self: MotionState, point: Vec3): boolean {
  const perception = self.vision ?? self.actor.character.perception;
  const eye = bodyPoint(self, self.actor.character.body.eyeOffset),
    delta = sub(point, eye);
  const distance = length(delta);
  return (
    self.vision?.enabled !== false &&
    distance <= perception.rangeMm / 1000 &&
    (distance < 1e-12 ||
      dot(unit(self.facing), unit(delta)) >=
        cosDegrees(perception.fovMilliDegrees / 2000) - 1e-12) &&
    !world.forQuery({ ownerId: self.actor.participant.actorId }).occluded(eye, point, 'vision')
  );
}
