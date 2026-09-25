import type { Obstacle } from './geometry-types.ts';
import type { DeepReadonly, ObservedSurface } from '@fantasy/domain/spatial/execution';
import { length, mul, sub, unit, type Vec3 } from './math.ts';
import { SpatialWorld } from './physics.ts';
import { metres } from './terrain.ts';

/** A small sensed surface patch is a fallible local map, never a copy of an unseen collider. */
export function knownTerrainWorld(surfaces: readonly DeepReadonly<ObservedSurface>[]) {
  const obstacles: Obstacle[] = surfaces.map((sample, index) => {
    const normal = unit(sample.normalBps),
      upDot = normal.y;
    let xyz: Vec3, w: number;
    if (upDot < -0.999999) {
      xyz = { x: 1, y: 0, z: 0 };
      w = 0;
    } else {
      xyz = { x: normal.z, y: 0, z: -normal.x };
      w = 1 + upDot;
      const norm = Math.sqrt(length(xyz) ** 2 + w * w);
      xyz = mul(xyz, 1 / norm);
      w /= norm;
    }
    return {
      id: `observed.${index}`,
      position: sub(metres(sample.pointMm), mul(normal, 0.003)),
      halfExtents: { x: 0.35, y: 0.003, z: 0.35 },
      rotation: { ...xyz, w },
      blocks: { movement: true, vision: true, attack: true },
    };
  });
  return new SpatialWorld(obstacles);
}
