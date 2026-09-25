import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { advanceLocomotion, locomotionFixture } from '../../test-support/locomotion.ts';
import { initialStatus } from '../../test-support/ai.ts';
import { initializePhysics } from './world/physics.ts';
import { reference } from './prepare.ts';
import { sealRevision } from './manifest-builder.ts';
import { flightRate } from './rules/locomotion.ts';
import { reserveMotion } from './rules/motion-resources.ts';
import { ResourceBudget } from './rules/resources.ts';
import { moveActors } from './world/movement.ts';
import { Journal } from './rules/journal.ts';
import { applyStatuses } from './rules/status.ts';
import { resolveEffects } from './rules/effects.ts';

beforeAll(initializePhysics);
describe('flight grants and their shared stamina budget', () => {
  async function grant(rate?: number) {
    return sealRevision(
      'status',
      'wings',
      1,
      initialStatus({
        modifiers: { attack: 0, defense: 0, speedBps: 10000, flight: true, rooted: false },
        ...(rate === undefined ? {} : { flightStaminaPerSecond: rate }),
      }),
    );
  }
  it('charges hover time even while movement is disabled and drops paid flight when unaffordable', async () => {
    const f = await locomotionFixture();
    try {
      f.actor.statuses = applyStatuses(
        [],
        [{ revision: await grant(25), cause: 'wings' }],
        [],
        0,
      ).statuses;
      f.actor.body.intent = { ...f.actor.body.intent, flight: true, canMove: false };
      f.actor.body.motion.position.y = 5;
      f.actor.body.motion.grounded = false;
      const journal = new Journal(0, 0, DEFAULT_BUDGET);
      for (let step = 0; step < 10; step++) {
        advanceLocomotion(f, step, { journal });
      }
      expect(f.actor.vitals.resources.stamina).toBe(95);
      expect(f.actor.body.motion.position.y).toBe(5);
      f.actor.vitals.resources.stamina = 0;
      const plan = reserveMotion(f.actor, new ResourceBudget(f.actor.vitals.resources), 10, false);
      expect(plan.intent.flight).toBe(false);
      const falling = moveActors(
        f.world,
        [f.actor.body.motion],
        new Map([['left', plan.intent]]),
        f.battle.rules,
      )[0]!;
      plan.settle(falling, journal);
      expect(falling.state.position.y).toBeLessThan(5);
    } finally {
      f.world.free();
    }
  });
  it('honours effect overrides through actual resolution, uses the cheapest simultaneous grant and retains legacy free flight', async () => {
    const f = await locomotionFixture();
    try {
      const revision = await grant(20);
      const resolved = resolveEffects(
        [{ actor: f.actor.body.motion.actor, resources: f.actor.vitals.resources, statuses: [] }],
        [7, 3].map((rate) => ({
          id: `grant-${rate}`,
          actorId: 'left',
          targetId: 'left',
          attack: 0,
          effect: {
            kind: 'apply-status' as const,
            status: reference(revision),
            flightStaminaPerSecond: rate,
          },
        })),
        [revision],
        0,
        1,
      )[0]!;
      expect(flightRate(resolved.statuses, 0)).toBe(0);
      expect(flightRate(resolved.statuses, 1)).toBe(3);
      expect(resolved.statuses).toHaveLength(1);
      const free = await grant();
      f.actor.statuses = applyStatuses([], [{ revision: free, cause: 'free' }], [], 0).statuses;
      expect(flightRate(f.actor.statuses, 1)).toBe(0);
      f.actor.vitals.resources.stamina = 0;
      f.actor.body.intent.flight = true;
      const plan = reserveMotion(
        f.actor,
        new ResourceBudget(f.actor.vitals.resources, {}, false),
        1,
        false,
      );
      expect(plan.intent.flight).toBe(true);
      const moved = moveActors(
        f.world,
        [f.actor.body.motion],
        new Map([['left', plan.intent]]),
        f.battle.rules,
      )[0]!;
      plan.settle(moved, new Journal(0, 0, DEFAULT_BUDGET));
      expect(f.actor.vitals.resources.stamina).toBe(0);
    } finally {
      f.world.free();
    }
  });
  it('settles fractional flight carry without reserving an extra unavailable unit', async () => {
    const f = await locomotionFixture();
    try {
      f.actor.statuses = applyStatuses(
        [],
        [{ revision: await grant(8), cause: 'wings' }],
        [],
        0,
      ).statuses;
      f.actor.vitals.resources.stamina = 1;
      f.actor.body.motionClock = { remainder: 0, flightRemainder: 960000 };
      f.actor.body.intent = { ...f.actor.body.intent, flight: true, canMove: false };
      f.actor.body.motion.position.y = 5;
      f.actor.body.motion.grounded = false;
      advanceLocomotion(f, 1);
      expect(f.actor.vitals.resources.stamina).toBe(0);
      expect(f.actor.body.motionClock.flightRemainder).toBe(120000);
      expect(f.actor.body.motion.position.y).toBe(5);
      advanceLocomotion(f, 2);
      expect(f.actor.body.motion.position.y).toBeLessThan(5);
    } finally {
      f.world.free();
    }
  });
});
