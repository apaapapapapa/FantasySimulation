import { recordedCheckpoints } from '../../test-support/replay.ts';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { ReplayState } from '@fantasy/domain/spatial';
import { initializePhysics } from './physics.ts';
import { runBattle } from './run.ts';
import { admitPair } from './pair-admission.ts';
import { ResourceBudget } from './resources.ts';
import { locomotionFixture, advanceLocomotion } from '../../test-support/locomotion.ts';
import { boxObstacle, battleEvents } from '../../test-support/fixtures.ts';
import { movingSweepStages, stagedManifest } from '../../test-support/stages.ts';

beforeAll(initializePhysics);
const authored = (jump = false) => ({
  direction: { x: 1, y: 0, z: 0 },
  speedMmPerSecond: 10000,
  accelerationMmPerSecond2: 500000,
  jump,
});

describe('authored movement through shared physics and resources', () => {
  it('replaces gait travel cost and suppresses an unstarted dodge while retaining wall collision', async () => {
    const f = await locomotionFixture([
      boxObstacle('stop', { x: -3200, y: 1000, z: 0 }, { x: 50, y: 1000, z: 1000 }),
    ]);
    try {
      f.actor.intent.authored = authored();
      const results = [];
      for (let step = 0; step < 5; step++)
        results.push(advanceLocomotion(f, step, { dodge: true }).moved);
      expect(f.actor.motion.position.x).toBeCloseTo(-3.552, 5);
      expect(f.actor.resources.stamina).toBe(100);
      expect(f.actor.locomotion?.dodging).toBe(false);
      expect(results.at(-1)!.state.velocity.x).toBe(0);
      expect(results.some((m) => m.trace.length > 1)).toBe(true);
    } finally {
      f.world.free();
    }
  });
  it('charges a real leap once, clips against the ceiling and falls without reapplying the jump', async () => {
    const f = await locomotionFixture([
      boxObstacle('ceiling', { x: -4000, y: 2000, z: 0 }, { x: 1000, y: 100, z: 1000 }),
    ]);
    try {
      f.actor.intent.authored = authored(true);
      const first = advanceLocomotion(f, 0).moved;
      expect(first.jumped).toBe(true);
      expect(f.actor.resources.stamina).toBe(92);
      f.actor.intent.authored.jump = false;
      const positions = [first.state.position.y];
      for (let step = 1; step < 4; step++)
        positions.push(advanceLocomotion(f, step).moved.state.position.y);
      expect(Math.max(...positions)).toBeLessThanOrEqual(0.998001);
      expect(positions.at(-1)!).toBeLessThan(Math.max(...positions));
      expect(f.actor.resources.stamina).toBe(92);
    } finally {
      f.world.free();
    }
  });
  it('gives force priority over authored movement and keeps its target free of movement charges', async () => {
    const f = await locomotionFixture();
    try {
      f.actor.intent.authored = authored(true);
      f.actor.intent.forced = { gravity: { x: 0, y: 0, z: 0 }, force: { x: -80, y: 0, z: 0 } };
      const moved = advanceLocomotion(f, 0, { dodge: true }).moved;
      expect(moved.state.position.x).toBeCloseTo(-5.6, 8);
      expect(moved.jumped).toBe(false);
      expect(f.actor.resources.stamina).toBe(100);
    } finally {
      f.world.free();
    }
  });
  it('rejects same-interval dash plus dodge but allows a present dodge before a future dash', async () => {
    const f = await locomotionFixture();
    try {
      for (const castSteps of [0, 2]) {
        const ability = (
          await stagedManifest({ stages: movingSweepStages(), ability: { castSteps } })
        ).revisions.find((r) => r.kind === 'ability')!;
        const budget = new ResourceBudget(f.actor.resources);
        expect(admitPair(f.actor, ability, budget, 0).ok).toBe(castSteps === 2);
        expect(budget.finish().resources).toEqual(f.actor.resources);
      }
    } finally {
      f.world.free();
    }
  });
  it('records fixed stage time and cost, actual dash and force ownership, and seeks after expiry', async () => {
    const input = await stagedManifest({
        stages: movingSweepStages(),
        steps: 20,
        ability: { castSteps: 0 },
      }),
      output = await runBattle(input);
    expect(output.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
    const events = battleEvents(output.records);
    expect(events.filter((e) => e.kind === 'hit')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'stage-end').map((e) => e.step)).toEqual([15, 15]);
    expect(events.filter((e) => e.kind === 'cost').map((e) => e.after?.stamina)).toEqual([14, 14]);
    const { context, replay, checkpoints } = await recordedCheckpoints(input, output);
    const moving = checkpoints.find((c) => c.state?.actors[0]?.action?.stage?.motion?.applied)!;
    const forced = checkpoints.find((c) => c.state?.actors[0]?.force?.active)!;
    expect(moving.state!.actors[0]!.action!.stage!.motion).toMatchObject({
      kind: 'dash',
      speedMmPerSecond: 4000,
    });
    expect(forced.state!.actors[0]!.action!.stage!.motion!.applied).toBe(false);
    for (const checkpoint of [checkpoints.at(-1)!, moving, forced, checkpoints[0]!]) {
      const restored = new ReplayState(context, checkpoint);
      for (const record of output.records.slice(restored.nextRecord)) restored.apply(record);
      expect(restored.checkpoint()).toEqual(replay.checkpoint());
    }
  });
});
