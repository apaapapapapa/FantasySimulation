import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { DEFAULT_BUDGET, CharacterSchema } from '@fantasy/domain/spatial';
import { advanceLocomotion, locomotionFixture } from '../../test-support/locomotion.ts';
import { boxObstacle } from '../../test-support/fixtures.ts';
import { initializePhysics } from './physics.ts';
import { ResourceBudget } from './resources.ts';
import { reserveMotion } from './motion-resources.ts';
import { moveActors } from './movement.ts';
import { recoverActorResources } from './resource-step.ts';
import { Journal } from './journal.ts';
import { chooseGait } from './locomotion.ts';
import { selfView } from './self-view.ts';

beforeAll(initializePhysics);
describe('one interval budget for physical locomotion', () => {
  async function travel(gait: 'walk' | 'run', jump = false) {
    const f = await locomotionFixture();
    try {
      f.actor.decision.gait = gait;
      let highest = 0;
      const journal = new Journal(0, 0, DEFAULT_BUDGET);
      for (let step = 0; step < 50; step++) {
        f.actor.intent.jump = jump && step === 0;
        const { moved } = advanceLocomotion(f, step, { journal });
        highest = Math.max(highest, moved.state.position.y);
      }
      return {
        distance: f.actor.motion.position.x + 4,
        stamina: f.actor.resources.stamina!,
        highest,
      };
    } finally {
      f.world.free();
    }
  }
  it('charges both gaits by travelled metres, and running is faster and more costly', async () => {
    const walk = await travel('walk'),
      run = await travel('run');
    expect(walk.distance).toBeCloseTo(2, 2);
    expect(walk.stamina).toBe(96);
    expect(run.distance).toBeGreaterThan(5.8);
    expect(run.stamina).toBeLessThan(66);
  });
  it('uses gait speed for jump travel and charges the takeoff exactly once', async () => {
    const walk = await travel('walk', true),
      run = await travel('run', true);
    expect(run.distance).toBeGreaterThan(walk.distance * 2.5);
    expect(run.highest).toBeCloseTo(walk.highest, 4);
    expect(walk.stamina).toBe(88);
  });
  it.each([
    { multiplierBps: 3000, final: 49 },
    { multiplierBps: 10000, final: 56 },
  ])(
    'recovers continuously during walking at recovery multiplier $multiplierBps',
    async ({ multiplierBps, final }) => {
      const f = await locomotionFixture();
      try {
        f.actor.resources.stamina = 50;
        f.actor.decision.gait = 'walk';
        const journal = new Journal(0, 0, DEFAULT_BUDGET);
        for (let step = 0; step < 50; step++) {
          advanceLocomotion(f, step, { journal });
          recoverActorResources(f.actor, 20, step + 1, journal, { multiplierBps });
        }
        expect(f.actor.resources.stamina).toBe(final);
      } finally {
        f.world.free();
      }
    },
  );
  it('refunds blocked travel and charges a legal step lift only when it occurs', async () => {
    const f = await locomotionFixture([
      boxObstacle('wall', { x: -3650, y: 2000, z: 0 }, { x: 50, y: 2000, z: 1000 }),
    ]);
    try {
      const journal = new Journal(0, 0, DEFAULT_BUDGET);
      for (let step = 0; step < 20; step++) {
        advanceLocomotion(f, step, { journal });
      }
      expect(f.actor.resources.stamina).toBe(100);
      expect(journal.events.filter((e) => e.ruleId === 'movement.cost')).toEqual([]);
    } finally {
      f.world.free();
    }
    const stepScene = await locomotionFixture([
      boxObstacle('step', { x: -3400, y: 100, z: 0 }, { x: 300, y: 100, z: 1000 }),
    ]);
    try {
      const plan = reserveMotion(
        stepScene.actor,
        new ResourceBudget(stepScene.actor.resources),
        0,
        false,
      );
      const moved = moveActors(
        stepScene.world,
        [stepScene.actor.motion],
        new Map([['left', plan.intent]]),
        stepScene.battle.rules,
      )[0]!;
      plan.settle(moved, new Journal(0, 0, DEFAULT_BUDGET));
      expect(moved.stepped).toBe(true);
      expect(stepScene.actor.resources.stamina).toBe(98);
    } finally {
      stepScene.world.free();
    }
  });
  it('shares the remaining skill budget and falls back to slow walk through exhaustion, then resumes', async () => {
    const f = await locomotionFixture();
    try {
      f.actor.resources.stamina = 8;
      f.actor.decision.gait = 'run';
      f.actor.intent.jump = true;
      const budget = new ResourceBudget(f.actor.resources);
      expect(budget.reserve('skill', [{ stamina: 8 }]).ok).toBe(true);
      f.actor.resources = budget.commit('skill').after;
      const plan = reserveMotion(f.actor, budget, 0, true);
      expect(plan.intent).toMatchObject({ speedMmPerSecond: 500, jump: false, canStep: false });
      const moved = moveActors(
        f.world,
        [f.actor.motion],
        new Map([['left', plan.intent]]),
        f.battle.rules,
      )[0]!;
      const journal = new Journal(0, 0, DEFAULT_BUDGET);
      plan.settle(moved, journal);
      f.actor.motion = moved.state;
      expect(moved.state.position.x).toBeGreaterThan(-4);
      expect(f.actor.resources.stamina).toBe(0);
      expect(f.actor.staminaClock?.exhausted).toBe(true);
      recoverActorResources(f.actor, 900, 45, journal);
      expect(chooseGait(selfView(f.actor, 45, f.battle.rules.ai!), 0)?.gait).toBe('slow');
      recoverActorResources(f.actor, 100, 50, journal);
      expect(chooseGait(selfView(f.actor, 50, f.battle.rules.ai!), 0)?.gait).toBe('walk');
      expect(f.actor.staminaClock?.exhausted).toBe(false);
    } finally {
      f.world.free();
    }
  });
  it('validates locomotion requires stamina and running is faster and costlier', async () => {
    const f = await locomotionFixture();
    try {
      const c = CharacterSchema.parse(f.actor.motion.actor.character);
      expect(CharacterSchema.safeParse({ ...c, stamina: undefined }).success).toBe(false);
      c.movement.locomotion!.run.staminaPerMeter = 1;
      expect(CharacterSchema.safeParse(c).success).toBe(false);
    } finally {
      f.world.free();
    }
  });
});
