import { beforeAll, expect, it } from 'vite-plus/test';
import { locomotionFixture } from '../../test-support/locomotion.ts';
import { cloneActor } from './combat-state.ts';
import { initializePhysics } from './physics.ts';

beforeAll(initializePhysics);

it('keeps every committed actor substate intact when a proposed step is discarded', async () => {
  const fixture = await locomotionFixture();
  try {
    const before = structuredClone(fixture.actor);
    const next = cloneActor(fixture.actor);
    next.body.motion.position.x = 99;
    next.body.intent.canMove = false;
    next.vitals.resources.hp = 1;
    next.vitals.staminaClock!.exhausted = true;
    next.actions.used['discarded-action'] = 1;
    next.actions.cooldowns['discarded-action'] = 20;
    next.actions.readyAt = 20;
    next.mind.random = 42;
    next.mind.memory = { ...next.mind.memory, sampledAt: 20 };
    expect(fixture.actor).toEqual(before);
    expect(next.statuses).not.toBe(fixture.actor.statuses);
  } finally {
    fixture.world.free();
  }
});
