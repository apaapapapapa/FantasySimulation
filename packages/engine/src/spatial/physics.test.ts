import type { Obstacle } from './geometry-types.ts';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { createHash } from 'node:crypto';
import {
  add,
  cosDegrees,
  encodeNumericState,
  floatBits,
  IDENTITY,
  mul,
  sinDegrees,
  turnToward,
} from './math.ts';
import {
  at,
  ballShape,
  capsuleShape,
  firstContact,
  firstImpact,
  initializePhysics,
  SpatialWorld,
  stopAt,
  straight,
} from './world/physics.ts';

beforeAll(initializePhysics);
const body = { radius: 0.3, halfHeight: 0.6 };
const shape = () => capsuleShape(body);
const blocks = { movement: true, vision: true, attack: true };
const wall: Obstacle = {
  id: 'wall',
  position: { x: 1, y: 2, z: 0 },
  halfExtents: { x: 0.05, y: 2, z: 10 },
  blocks,
};

describe('3D-01 physics feasibility', () => {
  it('finds exact capsule surface contact and agrees with Rapier casts within their 5mm tolerance', () => {
    const projectile = ballShape(0.05),
      target = shape();
    for (const y of [-1.1, -0.8, -0.3, 0, 0.3, 0.8, 1.1]) {
      for (const z of [0, 0.1, 0.25, 0.4]) {
        const start = { x: -2, y, z },
          velocity = { x: 4, y: 0, z: 0 },
          origin = { x: 0, y: 0, z: 0 };
        const reference = projectile.castShape(
          start,
          IDENTITY,
          velocity,
          target,
          origin,
          IDENTITY,
          origin,
          0,
          1,
          false,
        );
        const actual = firstContact(
          straight(start, add(start, velocity)),
          projectile,
          straight(origin, origin),
          target,
        );
        expect(actual === undefined).toBe(reference === null);
        const discrepancy = reference ? Math.abs(actual! - reference.time_of_impact) * 4 : 0;
        expect(discrepancy).toBeLessThan(0.005);
        const point = add(start, { x: 4 * (actual ?? 0), y: 0, z: 0 });
        const dy = Math.max(0, Math.abs(point.y) - 0.6);
        const surfaceError =
          actual === undefined ? 0 : Math.abs(point.x ** 2 + point.z ** 2 + dy ** 2 - 0.35 ** 2);
        expect(surfaceError).toBeLessThan(1e-10);
      }
    }
  });
  it('blocks a non-piercing attack when wall and body contacts tie within the fixed tolerance', () => {
    expect(firstImpact(0.5, 0.5)?.kind).toBe('wall');
    expect(firstImpact(0.5000005, 0.5)?.kind).toBe('wall');
    expect(firstImpact(0.50001, 0.5)?.kind).toBe('body');
    expect(firstImpact(undefined, undefined)).toBeUndefined();
  });
  it('stops both approaching bodies at the same contact time and permits separation', () => {
    const a = straight({ x: -2, y: 1, z: 0 }, { x: 2, y: 1, z: 0 });
    const b = straight({ x: 2, y: 1, z: 0 }, { x: -2, y: 1, z: 0 });
    const contact = firstContact(a, shape(), b, shape())!;
    expect(contact).toBeCloseTo(0.425, 5);
    expect(firstContact(b, shape(), a, shape())).toBeCloseTo(contact, 6);
    const left = at(stopAt(a, contact), 1),
      right = at(stopAt(b, contact), 1);
    expect(left.x).toBeCloseTo(-right.x, 6);
    expect(right.x - left.x).toBeCloseTo(0.6, 5);
    expect(
      firstContact(
        straight(left, add(left, { x: -1, y: 0, z: 0 })),
        shape(),
        straight(right, add(right, { x: 1, y: 0, z: 0 })),
        shape(),
      ),
    ).toBeUndefined();
  });

  it('retains the bend in a wall slide instead of replacing it by a diagonal chord', () => {
    const world = new SpatialWorld([wall]);
    try {
      const trace = world.trace({ x: 0, y: 1, z: 0 }, { x: 2, y: 0, z: 2 }, body);
      expect(trace.length).toBeGreaterThanOrEqual(2);
      expect(at(trace, 1).x).toBeCloseTo(0.648, 3);
      expect(at(trace, 1).z).toBeCloseTo(2, 4);
      expect(at(trace, 0.5).x).toBeCloseTo(at(trace, 1).x, 4);
      expect(at(trace, 0.5).x).not.toBeCloseTo(at(trace, 1).x * 0.5, 2);
      expect(world.overlaps(at(trace, 1), shape())).toBe(false);
    } finally {
      world.free();
    }
  });

  it('sweeps fast projectiles against moving bodies and thin walls', () => {
    const projectile = straight({ x: -5, y: 1, z: 0 }, { x: 5, y: 1, z: 0 });
    const actor = straight({ x: 0, y: 1, z: -2 }, { x: 0, y: 1, z: 2 });
    const time = firstContact(projectile, ballShape(0.05), actor, shape());
    expect(time).toBeGreaterThan(0.4);
    expect(time).toBeLessThan(0.5);
    const world = new SpatialWorld([{ ...wall, halfExtents: { ...wall.halfExtents, x: 0.005 } }]);
    try {
      expect(
        world.sweep(projectile[0]!.start, { x: 10, y: 0, z: 0 }, ballShape(0.05), 'attack')
          ?.time_of_impact,
      ).toBeCloseTo(0.5945, 4);
    } finally {
      world.free();
    }
  });

  it('checks relative contact along the slid path, including a collision missed by its chord', () => {
    const world = new SpatialWorld([wall]);
    try {
      const path = world.trace({ x: 0, y: 1, z: 0 }, { x: 2, y: 0, z: 2 }, body);
      const other = straight({ x: 0.648, y: 1, z: 1.1 }, { x: 0.648, y: 1, z: 1.1 });
      const hit = firstContact(path, ballShape(0.04), other, ballShape(0.04));
      expect(hit).toBeDefined();
      expect(
        firstContact(
          straight(path[0]!.start, at(path, 1)),
          ballShape(0.04),
          other,
          ballShape(0.04),
        ),
      ).toBeUndefined();
    } finally {
      world.free();
    }
  });

  it('repeats TS trajectories and Rapier snapshot bytes with stable construction order', () => {
    function run(reverse: boolean) {
      const obstacles = [wall, { ...wall, id: 'second', position: { x: 20, y: 2, z: 0 } }];
      const world = new SpatialWorld(reverse ? obstacles.reverse() : obstacles);
      try {
        const trace = world.trace({ x: 0, y: 1, z: 0 }, { x: 2, y: 0, z: 2 }, body);
        return {
          state: encodeNumericState(trace),
          physics: createHash('sha256').update(world.world.takeSnapshot()).digest('hex'),
        };
      } finally {
        world.free();
      }
    }
    expect(run(false)).toEqual(run(true));
    expect(run(false)).toEqual(run(false));
  });
});

describe('deterministic numeric profile', () => {
  it.each([
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0.01, y: 1, z: 0 },
  ])('preserves inversion for antipodal turns from %j', (from) => {
    const desired = mul(from, -1);
    for (const angle of [0, 30, 90, 179])
      expect(encodeNumericState(turnToward(desired, from, angle))).toEqual(
        encodeNumericState(mul(turnToward(from, desired, angle), -1)),
      );
  });
  it('uses fixed trigonometry and a bounded turn without runtime sin/cos', () => {
    expect(sinDegrees(0)).toBe(0);
    expect(sinDegrees(30)).toBe(0.5);
    expect(cosDegrees(90)).toBe(0);
    expect(sinDegrees(270)).toBe(-1);
    const from = { x: 0, y: 0, z: 1 },
      desired = { x: 1, y: 0, z: 0 };
    const turned = turnToward(from, desired, 30);
    expect(turned.x).toBeCloseTo(0.5, 8);
    expect(turned.z).toBeCloseTo(0.866025404, 8);
    expect(encodeNumericState(turnToward(mul(from, -1), mul(desired, -1), 30))).toEqual(
      encodeNumericState(mul(turned, -1)),
    );
  });
  it('encodes binary64 in network byte order with explicit zero and non-finite rules', () => {
    expect(floatBits(1)).toBe('3ff0000000000000');
    expect(floatBits(-0)).toBe(floatBits(0));
    expect(() => floatBits(Infinity)).toThrow('Non-finite');
    expect(() => floatBits(NaN)).toThrow('Non-finite');
  });
});
