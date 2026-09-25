import type { Obstacle } from './geometry-types.ts';
import { add, encodeNumericState, sub, turnToward, type Vec3 } from './math.ts';
import {
  at,
  ballShape,
  capsuleShape,
  firstContact,
  SpatialWorld,
  stopAt,
  straight,
} from './physics.ts';

export const probeInputs = [
  { name: 'open', seed: 17, obstacles: 0, projectiles: 1, steps: 6000 },
  { name: 'dense', seed: 73, obstacles: 256, projectiles: 64, steps: 6000 },
] as const;
export type ProbeInput = {
  name: string;
  seed: number;
  obstacles: number;
  projectiles: number;
  steps: number;
};

/** Geometry workload, not a substitute for the integrated battle/log benchmark. */
export function runProbe(input: ProbeInput) {
  const obstacles: Obstacle[] = Array.from({ length: input.obstacles }, (_, i) => ({
    id: `box-${String(i).padStart(3, '0')}`,
    position: { x: 3 + (i % 16) * 2, y: 1, z: 3 + Math.floor(i / 16) * 2 },
    halfExtents: { x: 0.4, y: 1, z: 0.4 },
    blocks: { movement: true, vision: true, attack: true },
  }));
  const world = new SpatialWorld(obstacles, 10_000_000);
  const body = { radius: 0.3, halfHeight: 0.6 };
  const actorShape = capsuleShape(body),
    projectileShape = ballShape(0.02);
  let left: Vec3 = { x: -2, y: 0.902, z: 0 },
    right: Vec3 = { x: 2, y: 0.902, z: 0 };
  let facing: Vec3 = { x: 1, y: 0, z: 0 },
    state = input.seed >>> 0,
    contacts = 0,
    walls = 0;
  const checkpoints: unknown[] = [];
  try {
    for (let step = 0; step < input.steps; step++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      const direction = Math.floor(step / 100) % 2 === 0 ? 1 : -1;
      let a = world.trace(left, { x: direction * 0.08, y: 0, z: 0 }, body);
      let b = world.trace(right, { x: direction * -0.08, y: 0, z: 0 }, body);
      const contact = firstContact(a, actorShape, b, actorShape);
      if (contact !== undefined) {
        a = stopAt(a, contact);
        b = stopAt(b, contact);
        contacts++;
      }
      facing = turnToward(facing, sub(right, left), 7.2);
      for (let p = 0; p < input.projectiles; p++) {
        const start = { x: -4, y: 0.3 + (p % 3) * 0.4, z: -0.25 + ((state + p) % 10) * 0.05 };
        const velocity = { x: 8 + p, y: 0, z: p % 2 ? 4 : 0 };
        const path = straight(start, add(start, velocity));
        const hit = firstContact(path, projectileShape, b, actorShape);
        const wall = world.sweep(start, velocity, projectileShape, 'attack');
        if (wall && (hit === undefined || wall.time_of_impact <= hit + 1e-6)) walls++;
        else if (hit !== undefined) contacts++;
      }
      left = at(a, 1);
      right = at(b, 1);
      if (step % 100 === 99 || step === input.steps - 1)
        checkpoints.push(encodeNumericState({ step, left, right, facing, state, contacts, walls }));
    }
    return {
      input,
      checkpoints,
      snapshot: Array.from(world.world.takeSnapshot()),
      casts: world.casts,
      steps: input.steps,
    };
  } finally {
    world.free();
  }
}
