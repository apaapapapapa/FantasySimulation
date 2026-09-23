import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { advanceLocomotion, locomotionFixture } from '../../test-support/locomotion.ts';
import { initialStatus } from '../../test-support/ai.ts';
import { initializePhysics } from './physics.ts';
import { reference, sealRevision } from './prepare.ts';
import { flightRate } from './locomotion.ts';
import { reserveMotion } from './motion-resources.ts';
import { ResourceBudget } from './resources.ts';
import { moveActors } from './movement.ts';
import { Journal } from './journal.ts';
import { applyStatuses } from './status.ts';
import { resolveEffects } from './effects.ts';

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
      f.actor.intent = { ...f.actor.intent, flight: true, canMove: false };
      f.actor.motion.position.y = 5;
      f.actor.motion.grounded = false;
      const journal = new Journal(0, 0, DEFAULT_BUDGET);
      for (let step = 0; step < 10; step++) {
        advanceLocomotion(f, step, { journal });
      }
      expect(f.actor.resources.stamina).toBe(95);
      expect(f.actor.motion.position.y).toBe(5);
      f.actor.resources.stamina = 0;
      const plan = reserveMotion(f.actor, new ResourceBudget(f.actor.resources), 10, false);
      expect(plan.intent.flight).toBe(false);
      const falling = moveActors(
        f.world,
        [f.actor.motion],
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
        [{ actor: f.actor.motion.actor, resources: f.actor.resources, statuses: [] }],
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
      f.actor.resources.stamina = 0;
      f.actor.intent.flight = true;
      const plan = reserveMotion(
        f.actor,
        new ResourceBudget(f.actor.resources, {}, false),
        1,
        false,
      );
      expect(plan.intent.flight).toBe(true);
      const moved = moveActors(
        f.world,
        [f.actor.motion],
        new Map([['left', plan.intent]]),
        f.battle.rules,
      )[0]!;
      plan.settle(moved, new Journal(0, 0, DEFAULT_BUDGET));
      expect(f.actor.resources.stamina).toBe(0);
    } finally {
      f.world.free();
    }
  });
});
