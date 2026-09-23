import { recordedCheckpoints } from '../../test-support/replay.ts';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  AbilitySchema,
  DEFAULT_BUDGET,
  ReplayState,
  type Definition,
} from '@fantasy/domain/spatial';
import { sweepBlade } from './blades.ts';
import { initializePhysics, SpatialWorld, straight } from './physics.ts';
import { ZERO } from './math.ts';
import type { MotionState } from './movement.ts';
import { runBattle } from './run.ts';
import { locomotionFixture } from '../../test-support/locomotion.ts';
import { stagedManifest } from '../../test-support/stages.ts';
import { battleEvents } from '../../test-support/fixtures.ts';

beforeAll(initializePhysics);
const arc = (): Extract<Definition<'ability'>['attack'], { kind: 'arc' }> => ({
  kind: 'arc',
  reachMm: 2000,
  bladeRadiusMm: 50,
  startAngleMilliDegrees: -90000,
  sweepMilliDegrees: 180000,
});

function sweepFromOrigin(
  world: SpatialWorld,
  target: MotionState,
  rules: Parameters<typeof sweepBlade>[9],
  shape = arc(),
) {
  return sweepBlade(
    world,
    straight(ZERO, ZERO),
    ZERO,
    { x: 1, y: 0, z: 0 },
    shape,
    0,
    1,
    target,
    straight(target.position, target.position),
    rules,
    DEFAULT_BUDGET,
  );
}

describe('rotating whole-blade contact', () => {
  it('hits an interior shaft crossing that neither endpoint nor the tip path touches', async () => {
    const f = await locomotionFixture(),
      world = new SpatialWorld([]);
    try {
      const target = { ...f.actor.motion, position: { x: 0.75, y: 0, z: 0 } };
      const sweep = sweepFromOrigin(world, target, f.battle.rules, arc());
      expect(sweep.contact?.kind).toBe('body');
      expect(sweep.contact!.time).toBeGreaterThan(0.3);
      expect(sweep.contact!.time).toBeLessThan(0.4);
      if (sweep.geometry.kind !== 'blade') throw Error('Expected saved blade poses');
      expect(sweep.geometry.poses[0]!.tip).toEqual({ x: 0, y: 0, z: -2 });
      expect(sweep.geometry.poses.at(-1)!.tip).toEqual({ x: 0, y: 0, z: 2 });
      expect(sweep.geometry.poses.every((p) => Math.hypot(p.tip.x - 0.75, p.tip.z) > 1.2)).toBe(
        true,
      );
    } finally {
      world.free();
      f.world.free();
    }
  });
  it('clips at a blocking wall before the target, with stable collider order and zero-time wall ties', async () => {
    const f = await locomotionFixture();
    const wall = {
      id: 'wall',
      position: { x: 0.4, y: 0, z: 0 },
      halfExtents: { x: 0.01, y: 1, z: 0.2 },
      blocks: { movement: true, vision: false, attack: true },
    };
    const far = { ...wall, id: 'far', position: { x: 10, y: 0, z: 0 } };
    try {
      const target = { ...f.actor.motion, position: { x: 0.75, y: 0, z: 0 } },
        results = [];
      for (const obstacles of [
        [wall, far],
        [far, wall],
      ]) {
        const world = new SpatialWorld(obstacles);
        try {
          const result = sweepFromOrigin(world, target, f.battle.rules, arc());
          expect(result.contact?.kind).toBe('wall');
          if (result.geometry.kind !== 'blade') throw Error('Expected saved blade poses');
          expect(result.geometry.poses.at(-1)!.fraction).toBe(result.contact!.time);
          const cornerAngle = Math.atan2(0.2, 0.39) + Math.asin(0.05 / Math.hypot(0.39, 0.2));
          expect(result.contact!.time).toBeCloseTo(0.5 - cornerAngle / Math.PI, 4);
          expect(result.contact!.point.x).toBeCloseTo(0.39, 5);
          expect(result.contact!.point.z).toBeCloseTo(-0.2, 5);
          results.push(result);
          const tied = sweepFromOrigin(world, target, f.battle.rules, {
            ...arc(),
            startAngleMilliDegrees: 0,
          });
          expect(tied.contact).toMatchObject({ kind: 'wall', time: 0 });
        } finally {
          world.free();
        }
      }
      expect(results[0]).toEqual(results[1]);
    } finally {
      f.world.free();
    }
  });
  it('retains bent root paths during a full radial sweep and enforces the shared work budgets', async () => {
    const f = await locomotionFixture(),
      world = new SpatialWorld([]);
    try {
      const target = { ...f.actor.motion, position: { x: 20, y: 0, z: 0 } },
        shape = {
          kind: 'radial' as const,
          reachMm: 500,
          bladeRadiusMm: 50,
          startAngleMilliDegrees: 0,
        };
      const owner = [
        { from: 0, to: 0.5, start: ZERO, end: { x: 0, y: 0, z: 1 } },
        { from: 0.5, to: 1, start: { x: 0, y: 0, z: 1 }, end: { x: 1, y: 0, z: 1 } },
      ];
      const result = sweepBlade(
        world,
        owner,
        ZERO,
        { x: 1, y: 0, z: 0 },
        shape,
        0,
        1,
        target,
        straight(target.position, target.position),
        f.battle.rules,
        DEFAULT_BUDGET,
      );
      expect(result.contact).toBeNull();
      if (result.geometry.kind !== 'blade') throw Error('Expected saved blade poses');
      expect(result.geometry.poses.find((p) => p.fraction === 0.5)).toMatchObject({
        root: { x: 0, y: 0, z: 1 },
        tip: { x: -0.5, y: 0, z: 1 },
      });
      expect(result.geometry.poses.at(-1)).toMatchObject({
        root: { x: 1, y: 0, z: 1 },
        tip: { x: 1.5, y: 0, z: 1 },
      });
      expect(() =>
        sweepBlade(
          world,
          owner,
          ZERO,
          { x: 1, y: 0, z: 0 },
          shape,
          0,
          1,
          target,
          straight(target.position, target.position),
          f.battle.rules,
          { ...DEFAULT_BUDGET, maxCurveSegments: 1 },
        ),
      ).toThrow('curve-segments');
      world.castLimit = world.casts;
      expect(() =>
        sweepBlade(
          world,
          owner,
          ZERO,
          { x: 1, y: 0, z: 0 },
          shape,
          0,
          1,
          target,
          straight(target.position, target.position),
          f.battle.rules,
          DEFAULT_BUDGET,
        ),
      ).toThrow('casts');
    } finally {
      world.free();
      f.world.free();
    }
  });
  it('executes a staged radial sweep once per target and restores recorded blade geometry', async () => {
    const attack = {
      kind: 'radial' as const,
      reachMm: 2000,
      bladeRadiusMm: 100,
      startAngleMilliDegrees: -90000,
    };
    const input = await stagedManifest({
      steps: 20,
      ability: { castSteps: 0 },
      stages: [
        {
          id: 'sweep',
          offsetSteps: 0,
          durationSteps: 10,
          attack,
          effects: [
            { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'physical', defense: 'none' },
          ],
        },
      ],
    });
    const definition = input.revisions.find((r) => r.kind === 'ability')!.definition;
    expect(AbilitySchema.safeParse({ ...definition, stages: undefined }).success).toBe(false);
    const full = await runBattle(input);
    expect(full.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
    expect(battleEvents(full.records).filter((e) => e.kind === 'hit')).toHaveLength(2);
    const { context, replay, checkpoints } = await recordedCheckpoints(input, full);
    const active = checkpoints.find(
      (c) => c.state?.actors[0]?.action?.stage?.geometry?.kind === 'blade',
    )!;
    expect(active).toBeDefined();
    expect(replay.checkpoint().state!.actors.map((a) => a.resources.hp)).toEqual([90, 90]);
    for (const checkpoint of [checkpoints.at(-1)!, active, checkpoints[0]!]) {
      const restored = new ReplayState(context, checkpoint);
      for (const record of full.records.slice(restored.nextRecord)) restored.apply(record);
      expect(restored.checkpoint()).toEqual(replay.checkpoint());
    }
  });
});
