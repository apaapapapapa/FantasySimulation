import type { Point, SceneModel } from './scene-model.ts';

type Obstacle = SceneModel['obstacles'][number];
const SKIN = 0.05;

/** Distance down a vertical ray from `origin` to the first face of a yawed/sloped box. */
function boxEntry(
  box: Extract<Obstacle, { kind: 'box' }>,
  origin: Point,
  reach: number,
): number | null {
  const [, yaw, slope] = box.rotation;
  // Local = Rz(−slope)·Ry(−yaw)·(world − centre), matching Three's XYZ Euler of the renderers.
  const dx = origin[0] - box.position[0],
    dy = origin[1] - box.position[1],
    dz = origin[2] - box.position[2];
  const yx = Math.cos(yaw) * dx - Math.sin(yaw) * dz,
    yz = Math.sin(yaw) * dx + Math.cos(yaw) * dz;
  const o = [
    Math.cos(slope) * yx + Math.sin(slope) * dy,
    -Math.sin(slope) * yx + Math.cos(slope) * dy,
    yz,
  ];
  const d = [-Math.sin(slope), -Math.cos(slope), 0];
  let near = -Infinity,
    far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    // Horizontal local axes grow by the body radius, so a body standing on an edge counts.
    const half = box.size[axis]! / 2 + (axis === 1 ? 0 : reach);
    if (Math.abs(d[axis]!) < 1e-9) {
      if (Math.abs(o[axis]!) > half) return null;
      continue;
    }
    const a = (-half - o[axis]!) / d[axis]!,
      b = (half - o[axis]!) / d[axis]!;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  return near <= far && far >= -SKIN ? Math.max(0, near) : null;
}

/**
 * Height of the highest recorded terrain surface under a disc of radius `reach` at `origin`, or
 * `floor` (the arena's lower boundary). Used only to place decorative shadows and ground marks.
 */
export function groundBelow(
  obstacles: readonly Obstacle[],
  origin: Point,
  floor: number,
  reach = 0,
): number {
  let ground = floor;
  for (const obstacle of obstacles) {
    let drop: number | null = null;
    if (obstacle.kind === 'cylinder') {
      const top = obstacle.position[1] + obstacle.height / 2;
      const inside =
        Math.hypot(origin[0] - obstacle.position[0], origin[2] - obstacle.position[2]) <=
        obstacle.radius + reach;
      if (inside && top <= origin[1] + SKIN) drop = origin[1] + SKIN - top;
    } else drop = boxEntry(obstacle, [origin[0], origin[1] + SKIN, origin[2]], reach);
    if (drop !== null) ground = Math.max(ground, Math.min(origin[1], origin[1] + SKIN - drop));
  }
  return ground;
}
