import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  actionClock,
  hitscan,
  inObservedRange,
  launchDirection,
  meleeTrace,
  payCost,
  traceAttack,
} from './attacks.ts';
import { initializePhysics, SpatialWorld, straight, type Obstacle } from './physics.ts';
import { prepareBattle } from './prepare.ts';
import { sampleManifest } from '@fantasy/samples';
import { initialMotion } from './movement.ts';
import { emptyMemory } from './perception.ts';
import { length, mul, sub } from './math.ts';
beforeAll(initializePhysics);
const wall: Obstacle = {
  id: 'wall',
  position: { x: 0, y: 1, z: 0 },
  halfExtents: { x: 0.005, y: 2, z: 2 },
  blocks: { movement: true, attack: true, vision: false },
};
async function setup(obstacles: Obstacle[] = []) {
  const battle = await prepareBattle(await sampleManifest());
  const world = new SpatialWorld(obstacles);
  return {
    world,
    owner: initialMotion(world, battle.actors[0]),
    target: initialMotion(world, battle.actors[1]),
    ability: battle.actors[0].abilities[0]!.definition,
  };
}
describe('action clocks and attack geometry', () => {
  it('separates action speed, active physics duration, limited uses and atomic resource payment', async () => {
    const { world, ability } = await setup();
    try {
      expect(actionClock(ability, 0, 10)).toBeNull();
      expect(actionClock(ability, 20000, 10)).toEqual({
        launchAt: 13,
        recoveryUntil: 25,
        cooldownUntil: 13,
      });
      const limited = { ...ability, costs: { hp: 10, mp: 4, uses: 2 } };
      const resources = { hp: 10, mp: 4, shield: 3 };
      expect(payCost(limited, resources, 1)).toMatchObject({
        ok: true,
        resources: { hp: 0, mp: 0, shield: 3 },
      });
      expect(payCost(limited, resources, 2)).toMatchObject({
        ok: false,
        reason: 'uses',
        resources,
      });
      expect(payCost(limited, { ...resources, mp: 3 }, 0)).toMatchObject({
        ok: false,
        reason: 'mp',
        resources: { hp: 10, mp: 3, shield: 3 },
      });
      expect(resources.hp).toBe(10);
      expect(payCost(ability, resources, 10000).ok).toBe(true);
    } finally {
      world.free();
    }
  });
  it('checks range and forward orientation against the immutable observation, not a hidden live position', async () => {
    const { world, owner, ability } = await setup();
    try {
      const observed = {
        id: 'right',
        position: { ...owner.position, x: -3 },
        facing: { x: -1, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
        step: 0,
      };
      const view = {
        self: owner,
        memory: { ...emptyMemory(), lastSeen: observed },
        resources: { hp: 100, mp: 100, shield: 0 },
        statusIds: [],
      };
      expect(inObservedRange(ability, view)).toBe(true);
      expect(inObservedRange(ability, { ...view, memory: emptyMemory() })).toBe(false);
      expect(
        inObservedRange(ability, { ...view, self: { ...owner, facing: { x: -1, y: 0, z: 0 } } }),
      ).toBe(false);
      expect(inObservedRange({ ...ability, rangeMm: 100 }, view)).toBe(false);
    } finally {
      world.free();
    }
  });
  it('stops an instantaneous thick shot at a thin transparent wall before the target', async () => {
    const { world, owner, target } = await setup([wall]);
    try {
      expect(hitscan(world, owner, target, { x: 1, y: 0, z: 0 }, 12, 0.1)?.kind).toBe('wall');
      expect(hitscan(world, owner, target, { x: -1, y: 0, z: 0 }, 12, 0.1)).toBeNull();
    } finally {
      world.free();
    }
    const open = await setup();
    try {
      expect(
        hitscan(open.world, open.owner, open.target, { x: 1, y: 0, z: 0 }, 12, 0.1)?.kind,
      ).toBe('body');
      expect(hitscan(open.world, open.owner, open.target, { x: 1, y: 0, z: 0 }, 2, 0.1)).toBeNull();
    } finally {
      open.world.free();
    }
  });
  it('blocks a muzzle offset across a wall even when the outgoing ray starts beyond it', async () => {
    const { world, owner, target } = await setup([
      { ...wall, position: { x: -4, y: 1, z: 0.15 }, halfExtents: { x: 20, y: 2, z: 0.005 } },
    ]);
    try {
      expect(hitscan(world, owner, target, { x: 1, y: 0, z: 0 }, 12, 0.1)).toMatchObject({
        kind: 'wall',
        time: 0,
      });
    } finally {
      world.free();
    }
  });
  it('detects a moving target crossing a thrust between endpoints and retains every body slide segment', async () => {
    const { world, target } = await setup();
    try {
      const base = { x: -1, y: 1, z: 0 };
      const trace = meleeTrace(
        straight(base, base),
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0, z: 0 },
        2,
        0,
        1,
      );
      const crossing = straight({ x: 0, y: 1, z: -2 }, { x: 0, y: 1, z: 2 });
      expect(traceAttack(world, trace, 0.1, target, crossing)).toMatchObject({ kind: 'body' });
      const hit = traceAttack(world, trace, 0.1, target, crossing)!;
      expect(hit.time).toBeGreaterThan(0.3);
      expect(hit.time).toBeLessThan(0.5);
      const slide = [
        ...straight(base, { x: 0, y: 1, z: 0 }).map((p) => ({ ...p, to: 0.4 })),
        ...straight({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 1 }).map((p) => ({ ...p, from: 0.4 })),
      ];
      const thrust = meleeTrace(slide, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 2, 1, 2);
      expect(thrust.map((p) => [p.from, p.to])).toEqual([
        [0, 0.4],
        [0.4, 1],
      ]);
      expect(thrust[0]!.end).toEqual(thrust[1]!.start);
    } finally {
      world.free();
    }
  });
  it('counts initial attack overlap but gives terrain priority for simultaneous contact', async () => {
    const { world, target } = await setup();
    try {
      expect(
        traceAttack(
          world,
          straight(target.position, target.position),
          0.1,
          target,
          straight(target.position, target.position),
        ),
      ).toMatchObject({ kind: 'body', time: 0 });
    } finally {
      world.free();
    }
    const blocked = await setup([{ ...wall, position: { x: 4, y: 1, z: 0 } }]);
    try {
      expect(
        traceAttack(
          blocked.world,
          straight(blocked.target.position, blocked.target.position),
          0.1,
          blocked.target,
          straight(blocked.target.position, blocked.target.position),
        ),
      ).toMatchObject({ kind: 'wall', time: 0 });
    } finally {
      blocked.world.free();
    }
  });
  it('uses reproducible bounded aim error with independent actor streams and an inverted-facing counterpart', () => {
    const direction = { x: 1, y: 0, z: 0 };
    const shot = launchDirection(direction, 0, 42);
    expect(shot.direction).toEqual(direction);
    expect(shot.random).not.toBe(42);
    const a = launchDirection(direction, 5000, 42);
    expect(launchDirection(direction, 5000, 42)).toEqual(a);
    expect(launchDirection(direction, 5000, 43)).not.toEqual(a);
    expect(length(a.direction)).toBeCloseTo(1, 12);
    // Zero-error inversion is exact; nonzero yaw/pitch is defined in the owner's local basis.
    expect(
      length(sub(launchDirection(mul(direction, -1), 0, 42).direction, mul(direction, -1))),
    ).toBe(0);
    expect(length(sub(a.direction, direction))).toBeLessThan(0.13);
  });
});
