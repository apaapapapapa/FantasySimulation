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
import { battleEvents, boxObstacle, editScenario } from '../../test-support/fixtures.ts';

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
  it.each([false, true])('clips a later wall after a body hit, split trace=%s', async (split) => {
    const f = await locomotionFixture(),
      world = new SpatialWorld([
        {
          id: 'later-wall',
          position: { x: 0, y: 0, z: 0.75 },
          halfExtents: { x: 0.2, y: 1, z: 0.01 },
          blocks: { movement: false, vision: false, attack: true },
        },
      ]);
    try {
      const target = { ...f.actor.motion, position: { x: 0.75, y: 0, z: 0 } };
      const owner = split
        ? [
            { from: 0, to: 0.5, start: ZERO, end: ZERO },
            { from: 0.5, to: 1, start: ZERO, end: { x: -0.1, y: 0, z: 0 } },
          ]
        : straight(ZERO, ZERO);
      const result = sweepBlade(
        world,
        owner,
        ZERO,
        { x: 1, y: 0, z: 0 },
        arc(),
        0,
        1,
        target,
        straight(target.position, target.position),
        f.battle.rules,
        DEFAULT_BUDGET,
      );
      expect(result.contact?.kind).toBe('body');
      expect(result.contact!.time).toBeLessThan(0.5);
      if (result.geometry.kind !== 'blade') throw Error('Expected saved blade poses');
      const end = result.geometry.poses.at(-1)!;
      expect(end.fraction).toBeGreaterThan(0.5);
      expect(end.fraction).toBeLessThan(1);
      expect(result.wall?.time).toBe(end.fraction);
      expect(result.wall?.kind).toBe('wall');
    } finally {
      world.free();
      f.world.free();
    }
  });
  it.each(['arc', 'melee'] as const)(
    'keeps the first body hit but terminates a multi-hit %s at its later wall',
    async (kind) => {
      const input = await stagedManifest({
        steps: 12,
        ability: { castSteps: 0, rangeMm: 4000 },
        stages: [
          {
            id: 'cut',
            offsetSteps: 0,
            durationSteps: 2,
            attack:
              kind === 'arc'
                ? { ...arc(), startAngleMilliDegrees: -40000, sweepMilliDegrees: 60000 }
                : {
                    kind: 'melee',
                    reachMm: 4000,
                    radiusMm: 200,
                    activeSteps: 2,
                    maxHitsPerTarget: 2,
                  },
            effects: [
              {
                kind: 'damage',
                amount: 10,
                attackScaleBps: 0,
                element: 'physical',
                defense: 'none',
              },
            ],
            hit: { group: 'shared', maxHits: 2, minIntervalSteps: 1, requireSeparation: false },
          },
        ],
      });
      await editScenario(input, (scenario) =>
        scenario.obstacles.push({
          ...boxObstacle(
            'later-wall',
            kind === 'arc' ? { x: 1050, y: 1300, z: -180 } : { x: 600, y: 1300, z: 300 },
            { x: 5, y: 500, z: 5 },
          ),
          blocks: { movement: false, vision: false, attack: true },
        }),
      );
      const full = await runBattle(input),
        events = battleEvents(full.records);
      const hits = events.filter((e) => e.actorId === 'left' && e.kind === 'hit');
      expect(hits).toHaveLength(1);
      const stop = events.find(
        (e) => e.actorId === 'left' && e.reason === 'wall' && e.kind === 'fizzle',
      );
      expect(stop).toMatchObject({ step: hits[0]!.step, ruleId: `${kind}.blocking-wall` });
      expect(stop!.subtimeMicros).toBeGreaterThan(hits[0]!.subtimeMicros);
      const { replay, checkpoints } = await recordedCheckpoints(input, full);
      const stopped = checkpoints.find(
        (c) => c.lastRecord?.kind === 'interval' && c.lastRecord.fromStep === stop!.step,
      )!;
      const geometry = stopped.state!.actors[0]!.action!.stage!.geometry!;
      const end =
        geometry.kind === 'blade' ? geometry.poses.at(-1)!.fraction : geometry.segments.at(-1)!.to;
      expect(end).toBeCloseTo(stop!.subtimeMicros / 1000000, 6);
      expect(replay.checkpoint().state!.actors[1]!.resources.hp).toBe(90);
    },
  );
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
