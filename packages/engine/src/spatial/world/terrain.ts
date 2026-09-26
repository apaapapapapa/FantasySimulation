import type { Capsule, Obstacle } from '../geometry-types.ts';
import type { PreparedBattle } from '../state.ts';
import type { DeepReadonly, Definition, VectorMm } from '@fantasy/domain/spatial/execution';
import { cosDegrees, sinDegrees, type Vec3 } from '../math.ts';
import { capsuleShape, CONTACT_TOLERANCE, SpatialWorld } from './physics.ts';

export const metres = (value: VectorMm): Vec3 => ({
  x: value.x / 1000,
  y: value.y / 1000,
  z: value.z / 1000,
});
export const bodyCapsule = (body: Definition<'character'>['body']): Capsule => ({
  radius: body.radiusMm / 1000,
  halfHeight: (body.heightMm / 2 - body.radiusMm) / 1000,
});
export function rotation(yaw: number, slope: number) {
  const sy = sinDegrees(yaw / 2000),
    cy = cosDegrees(yaw / 2000),
    sz = sinDegrees(slope / 2000),
    cz = cosDegrees(slope / 2000);
  const value = { x: sy * sz, y: sy * cz, z: cy * sz, w: cy * cz };
  const norm = Math.sqrt(value.x ** 2 + value.y ** 2 + value.z ** 2 + value.w ** 2);
  return { x: value.x / norm, y: value.y / norm, z: value.z / norm, w: value.w / norm };
}
export function terrainObstacles(scenario: DeepReadonly<Definition<'scenario'>>): Obstacle[] {
  const obstacles: Obstacle[] = scenario.obstacles.map((obstacle) =>
    obstacle.kind === 'pillar'
      ? {
          id: obstacle.id,
          ...(obstacle.material ? { material: obstacle.material } : {}),
          kind: 'pillar',
          position: metres(obstacle.center),
          halfExtents: {
            x: obstacle.radiusMm / 1000,
            y: obstacle.halfHeightMm / 1000,
            z: obstacle.radiusMm / 1000,
          },
          blocks: obstacle.blocks,
        }
      : {
          id: obstacle.id,
          ...(obstacle.material ? { material: obstacle.material } : {}),
          position: metres(obstacle.center),
          halfExtents: metres(obstacle.halfExtents),
          rotation: rotation(obstacle.yawMilliDegrees, obstacle.slopeMilliDegrees),
          blocks: obstacle.blocks,
        },
  );
  const min = metres(scenario.bounds.min),
    max = metres(scenario.bounds.max);
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const extents = {
    x: (max.x - min.x) / 2 + 1,
    y: (max.y - min.y) / 2 + 1,
    z: (max.z - min.z) / 2 + 1,
  };
  // Closed arena geometry, derived from immutable bounds. Leaving the arena is not a loss rule.
  for (const axis of ['x', 'y', 'z'] as const)
    for (const sign of [-1, 1])
      obstacles.push({
        id: `boundary.${axis}.${sign === -1 ? 'min' : 'max'}`,
        position: { ...center, [axis]: (sign === -1 ? min[axis] : max[axis]) + sign },
        halfExtents: { ...extents, [axis]: 1 },
        blocks: { movement: true, vision: true, attack: true },
      });
  return obstacles;
}
export function createBattleWorld(battle: PreparedBattle, maxCasts = 1_000_000): SpatialWorld {
  const obstacles = terrainObstacles(battle.scenario);
  const ids = new Set(obstacles.map((o) => o.id));
  if (ids.size !== obstacles.length) throw new Error('Terrain ID uses a reserved boundary ID');
  const world = new SpatialWorld(obstacles, maxCasts);
  try {
    for (const actor of battle.actors)
      if (
        world.overlaps(
          metres(actor.participant.position),
          capsuleShape(bodyCapsule(actor.character.body)),
        )
      )
        throw new Error(`Spawn overlaps terrain: ${actor.participant.actorId}`);
    const [a, b] = battle.actors;
    const pa = metres(a.participant.position),
      pb = metres(b.participant.position),
      ca = bodyCapsule(a.character.body),
      cb = bodyCapsule(b.character.body);
    const dy = Math.max(0, Math.abs(pa.y - pb.y) - ca.halfHeight - cb.halfHeight);
    if (
      (pa.x - pb.x) ** 2 + (pa.z - pb.z) ** 2 + dy ** 2 <
      (ca.radius + cb.radius - CONTACT_TOLERANCE) ** 2
    )
      throw new Error('Spawn bodies overlap');
    return world;
  } catch (error) {
    world.free();
    throw error;
  }
}
