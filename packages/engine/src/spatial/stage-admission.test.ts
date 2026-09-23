import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { initializePhysics } from './physics.ts';
import { sealRevision } from './prepare.ts';
import { actionClock } from './attacks.ts';
import { releaseStage } from './stages.ts';
import { selfView } from './self-view.ts';
import { Journal } from './journal.ts';
import { ResourceBudget } from './resources.ts';
import { locomotionFixture, advanceLocomotion } from '../../test-support/locomotion.ts';
import { initialStatus } from '../../test-support/ai.ts';
import { comboStages, stagedManifest } from '../../test-support/stages.ts';

beforeAll(initializePhysics);
describe('due stage and movement admission', () => {
  it.each([
    { flight: false, dodge: true, jump: false, total: 11 },
    { flight: true, dodge: true, jump: false, total: 13 },
    { flight: false, dodge: false, jump: true, total: 14 },
    { flight: true, dodge: false, jump: false, total: 8 },
    { flight: false, dodge: true, jump: true, total: 6, blocked: true },
  ])('admits the whole stage and burst at the exact boundary: %j', async (choice) => {
    const f = await locomotionFixture(),
      canMove = !('blocked' in choice);
    try {
      const stages = comboStages();
      stages[1] = {
        id: 'paid-hold',
        offsetSteps: 3,
        durationSteps: 1,
        attack: null,
        effects: [],
        cost: { stamina: 6 },
      };
      const ability = (await stagedManifest({ stages, ability: { castSteps: 0 } })).revisions.find(
        (r) => r.kind === 'ability',
      )!;
      const status = await sealRevision(
        'status',
        'stage-flight',
        1,
        initialStatus({
          modifiers: { attack: 0, defense: 0, speedBps: 10000, rooted: false, flight: true },
          flightStaminaPerSecond: 100,
        }),
      );
      const motion = structuredClone(f.actor.motion);
      for (const enough of [false, true]) {
        const stamina = choice.total - (enough ? 0 : 1);
        f.actor.motion = structuredClone(motion);
        f.actor.resources.stamina = stamina;
        f.actor.motionClock = { remainder: 0, flightRemainder: 0 };
        f.actor.statuses = choice.flight
          ? [{ revision: status, startStep: 0, endStep: 100, stacks: 1, causes: [] }]
          : [];
        f.actor.intent = {
          ...f.actor.intent,
          jump: false,
          flight: choice.flight,
          direction: { x: 0, y: 0, z: 0 },
          canMove,
        };
        f.actor.decision = { ...f.actor.decision, abilityId: null, dodge: false, gait: 'walk' };
        const previous = { intent: { ...f.actor.intent }, decision: { ...f.actor.decision } };
        f.actor.intent.jump = choice.jump;
        f.actor.decision.dodge = choice.dodge;
        const clock = actionClock(ability.definition, 10000, 0)!;
        f.actor.action = {
          id: 'a.0',
          ability,
          cause: 'e.0',
          startedAt: 0,
          ...clock,
          released: true,
          stages: { index: 0, next: 1, active: false, cause: 'e.0' },
        };
        f.actor.readyAt = clock.recoveryUntil;
        f.actor.cooldowns[ability.id] = clock.cooldownUntil;
        const budget = new ResourceBudget(f.actor.resources),
          journal = new Journal(1, 0, DEFAULT_BUDGET);
        const released = releaseStage(
          f.actor,
          selfView(f.actor, 3, f.battle.rules.ai!, f.battle.statuses),
          3,
          budget,
          journal,
          { dodge: choice.dodge, previous },
        );
        expect(released !== null).toBe(enough);
        advanceLocomotion(f, 3, { budget, journal, dodge: !!f.actor.decision.dodge });
        expect(f.actor.resources.stamina).toBe(enough ? 0 : stamina - (choice.flight ? 2 : 0));
        expect(f.actor.used).toEqual({});
        expect(f.actor.readyAt).toBe(clock.recoveryUntil);
        expect(f.actor.cooldowns[ability.id]).toBe(clock.cooldownUntil);
        expect(f.actor.locomotion?.mode === 'flight').toBe(choice.flight);
        expect(journal.events.filter((e) => e.ruleId === 'stage.cost')).toHaveLength(
          enough ? 1 : 0,
        );
        expect(journal.events.filter((e) => e.kind === 'stage-interrupt')).toHaveLength(
          enough ? 0 : 1,
        );
        expect(f.actor.locomotion?.dodging).toBe(enough && choice.dodge && canMove);
        expect(f.actor.locomotion?.jumping).toBe(enough && choice.jump && canMove);
      }
    } finally {
      f.world.free();
    }
  });
});
