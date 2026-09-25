import { recordedCheckpoints } from '../../test-support/replay.ts';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_BUDGET,
  EffectSchema,
  ReplayState,
  type Effect,
  type ForceContribution,
} from '@fantasy/domain/spatial';
import {
  freezeForce,
  forceSum,
  beginForcedInterval,
  queueForce,
  settleForcedInterval,
} from './rules/forces.ts';
import { initializePhysics } from './world/physics.ts';
import { ZERO } from './math.ts';
import { runBattle } from './run.ts';
import { prepareBattle } from './prepare.ts';
import { simulate } from './simulate.ts';
import { locomotionFixture } from '../../test-support/locomotion.ts';
import { stagedManifest } from '../../test-support/stages.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { visibleStageCue } from './rules/stages.ts';
import { initialActor } from './sim/combat-state.ts';
import { emptyMemory, perceive } from './ai/perception.ts';
import { moveActors } from './world/movement.ts';

beforeAll(initializePhysics);
const force = (direction: 'away' | 'toward' = 'away'): Extract<Effect, { kind: 'force' }> => ({
  kind: 'force',
  profile: 'linear-v1',
  direction,
  speedMmPerSecond: 80000,
  durationSteps: 2,
});
const contribution = (id: string, x: number): ForceContribution => ({
  id,
  actorId: 'left',
  abilityId: 'push',
  startAt: 6,
  endAt: 8,
  velocityMmPerSecond: { x, y: 0, z: 0 },
});

describe('contact-frozen forces', () => {
  it('validates bounded fields and freezes direction, including symmetric ties and coincidence', () => {
    expect(freezeForce(force(), ZERO, { x: 3, y: 4, z: 0 })).toEqual({ x: 48000, y: 64000, z: 0 });
    expect(freezeForce(force('toward'), ZERO, { x: 3, y: 4, z: 0 })).toEqual({
      x: -48000,
      y: -64000,
      z: 0,
    });
    expect(freezeForce(force(), ZERO, ZERO)).toEqual(ZERO);
    for (const sign of [1, -1])
      expect(
        freezeForce({ ...force(), speedMmPerSecond: 1 }, ZERO, { x: sign, y: 1, z: Math.sqrt(2) })
          .x,
      ).toBe(sign);
    for (const input of [
      { ...force(), durationSteps: 0 },
      { ...force(), speedMmPerSecond: 100001 },
      { ...force(), profile: 'retarget' },
      { ...force(), teleport: true },
    ])
      expect(EffectSchema.safeParse(input).success).toBe(false);
  });
  it('sums before the Euclidean cap, cancels independent of order, and respects half-open windows', () => {
    const forces = [contribution('e.1', 80000), contribution('e.2', 80000)];
    expect(forceSum(forces, 6, 100000)).toMatchObject({
      capped: true,
      force: { x: 100, y: 0, z: 0 },
    });
    expect(forceSum([...forces].reverse(), 6, 100000)).toEqual(forceSum(forces, 6, 100000));
    forces[1]!.velocityMmPerSecond.x = -80000;
    expect(forceSum(forces, 6, 100000)).toMatchObject({ capped: false, force: ZERO });
    expect(forceSum(forces, 5, 100000).contributors).toHaveLength(0);
    expect(forceSum(forces, 8, 100000).contributors).toHaveLength(0);
    forces[1]!.velocityMmPerSecond = { x: 0, y: 80000, z: 0 };
    const diagonal = forceSum(forces, 7, 100000).force;
    expect(diagonal.x).toBeCloseTo(70.71067811865, 9);
    expect(diagonal.y).toBeCloseTo(70.71067811865, 9);
  });
  it('queues the next boundary, retains only gravity on expiry, and truncates excess contributions', async () => {
    const f = await locomotionFixture();
    try {
      f.actor.body.motion.velocity = { x: 50, y: 4, z: 9 };
      queueForce(
        f.actor,
        force(),
        ZERO,
        { x: 1, y: 0, z: 0 },
        { id: 'e.0', actorId: 'right', abilityId: 'push' },
        5,
        DEFAULT_BUDGET,
      );
      expect(beginForcedInterval(f.actor, 5, 100000)?.active).toBe(false);
      expect(beginForcedInterval(f.actor, 6, 100000)?.gravity).toEqual({ x: 0, y: 4, z: 0 });
      f.actor.body.motion.velocity = { x: 80, y: 12, z: 0 };
      f.actor.body.forceGravity = { ...ZERO };
      expect(beginForcedInterval(f.actor, 8, 100000)?.active).toBe(false);
      expect(f.actor.body.motion.velocity).toEqual(ZERO);
      expect(f.actor.body.forceGravity).toBeUndefined();
      queueForce(
        f.actor,
        force(),
        ZERO,
        ZERO,
        { id: 'e.1', actorId: 'right', abilityId: 'push' },
        8,
        DEFAULT_BUDGET,
      );
      expect(() =>
        queueForce(
          f.actor,
          force(),
          ZERO,
          ZERO,
          { id: 'e.2', actorId: 'right', abilityId: 'push' },
          8,
          { ...DEFAULT_BUDGET, maxForces: 1 },
        ),
      ).toThrow('forces; 2/1;cause=e.2');
    } finally {
      f.world.free();
    }
  });
  it('moves freely from n+1, saves projections, seeks through expiry and rolls back force overflow', async () => {
    const input = await stagedManifest({
      steps: 12,
      ability: { castSteps: 0 },
      stages: [
        {
          id: 'push',
          offsetSteps: 0,
          durationSteps: 1,
          attack: {
            kind: 'melee',
            reachMm: 2000,
            radiusMm: 200,
            activeSteps: 1,
            maxHitsPerTarget: 1,
          },
          effects: [
            { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'physical', defense: 'none' },
            force(),
            force(),
          ],
        },
      ],
    });
    const full = await runBattle(input);
    expect(full.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
    const events = battleEvents(full.records).filter((e) => e.kind === 'force');
    expect(events).toHaveLength(4);
    expect(events.map((e) => [e.step, e.force?.startAt, e.force?.endAt])).toEqual(
      Array(4).fill([6, 6, 8]),
    );
    const { context, replay, checkpoints } = await recordedCheckpoints(input, full);
    const active = checkpoints.find((c) => c.state?.actors[0]?.force?.active)!;
    expect(active.step).toBe(7);
    expect(active.state!.actors[0]).toMatchObject({
      position: { x: -2.75 },
      resources: { hp: 90, stamina: 14 },
      force: { applied: { x: -100, y: 0, z: 0 }, capped: true },
    });
    expect(active.state!.actors[0]!.force!.projections.some((p) => p.normal?.y === 1)).toBe(true);
    const tampered = structuredClone(active);
    tampered.state!.actors[0]!.force!.applied.x = -1;
    expect(() => new ReplayState(context, tampered)).toThrow('force applied sum');
    expect(replay.checkpoint().state!.actors[0]!.position.x).toBeCloseTo(-4.75, 8);
    for (const checkpoint of [checkpoints.at(-1)!, active, checkpoints[0]!]) {
      const restored = new ReplayState(context, checkpoint);
      for (const record of full.records.slice(restored.nextRecord)) restored.apply(record);
      expect(restored.checkpoint()).toEqual(replay.checkpoint());
    }
    const capped = { ...DEFAULT_BUDGET, maxForces: 1 },
      stream = simulate(await prepareBattle(input), capped);
    let end = stream.next();
    while (!end.done) end = stream.next();
    expect(end.value.outcome).toMatchObject({ kind: 'truncated', resource: 'forces' });
    expect(end.value.steps).toBe(5);
    expect(end.value.decisionState).toMatchObject({
      actors: [
        { resources: { hp: 100, stamina: 20 }, used: {} },
        { resources: { hp: 100, stamina: 20 }, used: {} },
      ],
    });
    expect(JSON.stringify(end.value.decisionState)).not.toContain('forceGravity');
    expect((await runBattle(input)).result).toEqual(full.result);
  });
  it('samples one-step force onset and expiry from current forces before delayed delivery', async () => {
    const f = await locomotionFixture();
    try {
      const enemy = initialActor(f.world, f.battle.actors[1]);
      queueForce(
        enemy,
        { ...force(), speedMmPerSecond: 1000, durationSteps: 1 },
        f.actor.body.motion.position,
        enemy.body.motion.position,
        { id: 'e.0', actorId: 'left', abilityId: 'push' },
        4,
        DEFAULT_BUDGET,
      );
      expect(visibleStageCue(enemy, 4)).toBeUndefined();
      const cue = visibleStageCue(enemy, 5);
      expect(cue).toEqual({ shape: 'hold', state: 'active', motion: 'forced' });
      const sampled = perceive(
        f.world,
        f.actor.body.motion,
        enemy.body.motion,
        [],
        5,
        emptyMemory(),
        {
          resources: enemy.vitals.resources,
          action: 'idle',
          stage: cue,
        },
      );
      expect(sampled.observation).toBeNull();
      const plan = beginForcedInterval(enemy, 5, 100000)!;
      const moved = moveActors(
        f.world,
        [enemy.body.motion],
        new Map([
          [
            'right',
            {
              ...enemy.body.intent,
              forced: { force: plan.force, gravity: plan.gravity! },
            },
          ],
        ]),
        f.battle.rules,
      )[0]!;
      settleForcedInterval(enemy, plan, moved, 5);
      expect(enemy.body.forceDisplay?.active).toBe(true);
      expect(visibleStageCue(enemy, 6)).toBeUndefined();
      const expired = perceive(
        f.world,
        f.actor.body.motion,
        enemy.body.motion,
        [],
        6,
        emptyMemory(),
        {
          resources: enemy.vitals.resources,
          action: 'idle',
          stage: visibleStageCue(enemy, 6),
        },
      );
      const delivered = perceive(f.world, f.actor.body.motion, enemy.body.motion, [], 10, sampled);
      expect(delivered.observation?.sampledAt).toBe(5);
      expect(delivered.observation?.enemy?.stage).toEqual({
        shape: 'hold',
        state: 'active',
        motion: 'forced',
      });
      expect(
        perceive(f.world, f.actor.body.motion, enemy.body.motion, [], 11, expired).observation
          ?.enemy?.stage,
      ).toBeUndefined();
    } finally {
      f.world.free();
    }
  });
});
