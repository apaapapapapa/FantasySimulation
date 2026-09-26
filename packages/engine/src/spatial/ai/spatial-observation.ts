import { metres } from '../world/terrain.ts';
import { compareIds, type ObservedSpatial } from '@fantasy/domain/spatial/execution';
import type { SpatialObject } from '../rules/spatial-objects.ts';
import type { DecisionView, MotionState } from '../state.ts';
import { objectGeometry, closestObjectPoint } from '../world/object-geometry.ts';
import { bodyPoint, canSee } from '../world/visibility.ts';
import type { SpatialWorld } from '../world/physics.ts';
import { add, sub, mul, unit, length, type Vec3 } from '../math.ts';

/** Sample only visible surface points; hidden extents, durability, end time and masks stay private. */
export function observeSpatial(
  world: SpatialWorld,
  self: MotionState,
  objects: readonly SpatialObject[],
): ObservedSpatial[] {
  const eye = bodyPoint(self, self.actor.character.body.eyeOffset);
  const observed: ObservedSpatial[] = [];
  for (const object of objects) {
    if (!object.active) continue;
    let samples: Vec3[];
    if (object.kind === 'beam') {
      const segment = object.geometry?.kind === 'ray' ? object.geometry.segments.at(-1) : null;
      samples = segment
        ? [segment.start, mul(add(segment.start, segment.end), 0.5), segment.end]
        : [];
    } else {
      const geometry = objectGeometry(object.id, object.spec.shape, object.position);
      samples = [
        closestObjectPoint(geometry, eye),
        ...(['x', 'y', 'z'] as const).flatMap((axis) =>
          [-1, 1].map((sign) =>
            closestObjectPoint(
              geometry,
              add(object.position, { x: 0, y: 0, z: 0, [axis]: sign * 200 }),
            ),
          ),
        ),
      ];
    }
    const points = samples.filter((point) =>
      canSee(world, self, add(point, mul(unit(sub(eye, point)), 0.003))),
    );
    if (points.length)
      observed.push({
        id: object.id,
        ownerId: object.ownerId,
        kind: object.kind,
        pointsMm: points.map((point) => ({
          x: Math.round(point.x * 1000),
          y: Math.round(point.y * 1000),
          z: Math.round(point.z * 1000),
        })),
      });
  }
  return observed
    .sort(
      (a, b) =>
        length(sub(metres(a.pointsMm[0]!), eye)) - length(sub(metres(b.pointsMm[0]!), eye)) ||
        compareIds(a.id, b.id),
    )
    .slice(0, 32);
}

/** A fallible local retreat from delivered damaging geometry, with no lookup of a live object. */
export function spatialEscape(view: DecisionView, goal: Vec3 | null): Vec3 | null {
  if (!view.canMove || view.stageOwnsMotion || view.self.actor.policy.movement === 'hold')
    return goal;
  const points = (view.memory.observation?.spatial ?? [])
    .filter((o) => o.kind !== 'barrier' && o.ownerId !== view.self.actor.participant.actorId)
    .flatMap((o) => o.pointsMm.map(metres));
  const close = points.filter((p) => length(sub(p, view.self.position)) < 2);
  if (!close.length) return goal;
  const center = mul(
    close.reduce((sum, p) => add(sum, p), { x: 0, y: 0, z: 0 }),
    1 / close.length,
  );
  let direction = { ...sub(view.self.position, center), y: 0 };
  if (length(direction) < 1e-9) direction = { x: -view.self.facing.z, y: 0, z: view.self.facing.x };
  return add(view.self.position, mul(unit(direction), 2));
}
