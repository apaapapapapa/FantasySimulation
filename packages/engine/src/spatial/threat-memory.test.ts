import { beforeAll, expect, it } from 'vite-plus/test';
import { AI_RULES, DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { aiFixture, initialStatus, incomingArrow } from '../../test-support/ai.ts';
import { initializePhysics } from './physics.ts';
import { sealRevision } from './prepare.ts';
import { reapplicationEstimate, rememberThreat, seenAttack } from './threat-memory.ts';
import { assessAbility } from './assessment.ts';
import type { ThreatExperience } from './perception.ts';
import { perceive, emptyMemory } from './perception.ts';
import { initialActor } from './combat-state.ts';
import { commitEffects, commitTransactionStatuses } from './combat-effects.ts';
import { Journal } from './journal.ts';
import { reference } from './prepare.ts';
import { TACTICAL_AI } from './tactical-samples.ts';
import { surveySearch, chooseSearch } from './search.ts';
import { selfView } from './self-view.ts';

beforeAll(initializePhysics);
it('does not reinterpret a continuously visible projectile as a new attack when history rolls over', async () => {
  const f = await aiFixture();
  try {
    const projectile = {
      ...incomingArrow(f.self.position),
      element: 'fire' as const,
      attackCueId: 'visible-shot',
    };
    const observe = (step: number, memory: ReturnType<typeof emptyMemory>) =>
      perceive(
        f.world,
        f.self,
        f.enemy,
        [projectile],
        step,
        memory,
        undefined,
        'surveyed',
        TACTICAL_AI,
      );
    let memory = observe(5, observe(0, emptyMemory()));
    expect(memory.threatHistory).toHaveLength(1);
    for (let i = 0; i < 32; i++) memory = rememberThreat(memory, event(i, 'burning'));
    expect(observe(10, memory).threatHistory).toEqual(memory.threatHistory);
  } finally {
    f.world.free();
  }
});
it.each([false, true])(
  'remembers real incoming status contacts and only delayed hit directions (transaction=%s)',
  async (deferred) => {
    const f = await aiFixture();
    try {
      const status = await sealRevision(
        'status',
        'contact-toxin',
        1,
        initialStatus({
          periodic: [{ kind: 'damage', amount: 3, element: 'fire', everySteps: 10 }],
        }),
      );
      const victim = initialActor(f.world, f.self.actor),
        attacker = initialActor(f.world, f.enemy.actor);
      victim.memory = {
        ...victim.memory,
        search: surveySearch(
          victim.motion,
          f.battle.scenario.bounds,
          TACTICAL_AI.search!,
          0,
          undefined,
          null,
          () => false,
        ),
      };
      for (const step of [10, 30]) {
        const context = {
          battle: {
            ...f.battle,
            statuses: [status],
            rules: { ...f.battle.rules, ai: TACTICAL_AI },
          },
          journal: new Journal(step, 0, DEFAULT_BUDGET),
          step,
          activationStep: step,
          phase: 'resolution' as const,
          budget: DEFAULT_BUDGET,
          world: f.world,
        };
        const base = {
          actorId: 'right',
          targetId: 'left',
          attack: 0,
          abilityId: f.abilities[0]!.id,
          parentEventId: `contact-${step}`,
          incomingDirection: { x: 0, y: 0, z: 1 },
        };
        const effects = commitEffects(
          [victim, attacker],
          [
            { ...base, effect: { kind: 'damage', amount: 3, attackScaleBps: 0, element: 'fire' } },
            { ...base, effect: { kind: 'apply-status', status: reference(status) } },
          ],
          context,
          deferred,
        );
        if (deferred) commitTransactionStatuses([victim, attacker], effects.applications, context);
      }
      const view = selfView(victim, 35, TACTICAL_AI, [status]);
      expect(reapplicationEstimate(view, status.id, 35)).toMatchObject({
        intervalSteps: 20,
        effectiveSteps: 15,
        basis: 'self-application',
      });
      expect(victim.memory.search!.cues.map((c) => c.availableAt)).toEqual([15, 35]);
      expect(chooseSearch({ ...view, step: 14 }, 1)).toBeNull();
      expect(chooseSearch({ ...view, step: 15 }, 1)?.goal).toEqual({
        ...victim.motion.position,
        z: 3,
      });
    } finally {
      f.world.free();
    }
  },
);
const event = (at: number, statusId?: string): ThreatExperience => ({
  eventId: `seen-${at}${statusId ?? ''}`,
  sourceId: 'right',
  element: 'fire',
  sampledAt: at,
  availableAt: at + 5,
  expiresAt: 500,
  ...(statusId ? { statusId } : {}),
});
it('uses delayed own applications, then visible element intervals, with bounded memory', async () => {
  const f = await aiFixture();
  try {
    const view = {
      ...f.view,
      step: 40,
      rules: { ...AI_RULES, reapplication: 'self-observed-v1' as const },
    };
    const estimate = (history: ThreatExperience[]) =>
      reapplicationEstimate(
        { ...view, memory: { ...view.memory, threatHistory: history } },
        'toxin',
        45,
      );
    expect(estimate([event(20, 'toxin')])).toBeNull();
    expect(estimate([event(20, 'toxin'), event(40, 'toxin')])).toBeNull();
    expect(estimate([event(10, 'toxin'), event(30, 'toxin')])).toMatchObject({
      intervalSteps: 20,
      effectiveSteps: 5,
      basis: 'self-application',
    });
    expect(estimate([event(10), event(20), event(30, 'toxin')])).toMatchObject({
      intervalSteps: 10,
      effectiveSteps: 5,
      basis: 'visible-element',
    });
    expect(estimate([event(10), { ...event(20), element: 'ice' }, event(30, 'toxin')])).toBeNull();
    let memory = f.view.memory;
    for (let i = 0; i < 50; i++) memory = rememberThreat(memory, event(i));
    expect(memory.threatHistory).toHaveLength(32);
    expect(rememberThreat(memory, event(49))).toBe(memory);
    expect(
      seenAttack(
        f.world,
        f.self,
        {
          ...f.enemy,
          vision: { enabled: true, visible: false, rangeMm: 10000, fovMilliDegrees: 360000 },
        },
        f.abilities[0]!.definition.effects,
        'hidden',
        40,
        memory,
        500,
      ),
    ).toBe(memory);
  } finally {
    f.world.free();
  }
});
it.each(['burning', 'toxin'])(
  'limits %s removal benefit to the observed reapplication interval',
  async (id) => {
    const f = await aiFixture();
    try {
      const status = await sealRevision(
        'status',
        id,
        1,
        initialStatus({
          reactions: [{ element: 'water', response: { kind: 'remove' } }],
          periodic: [{ kind: 'damage', amount: 9, element: 'fire', everySteps: 10 }],
        }),
      );
      const view = {
        ...f.view,
        step: 40,
        rules: { ...AI_RULES, reapplication: 'self-observed-v1' as const },
        ownStatuses: [{ revision: status, startStep: 0, endStep: 200, stacks: 1, causes: [] }],
      };
      const weight = (interval: number) =>
        assessAbility(
          {
            ...view,
            memory: { ...view.memory, threatHistory: [event(40 - interval, id), event(35, id)] },
          },
          f.abilities[1]!,
        ).weight;
      const ordinary = assessAbility(view, f.abilities[1]!).weight;
      expect(weight(10)).toBeLessThan(weight(40));
      expect(weight(40)).toBeLessThan(ordinary);
      expect(
        assessAbility(
          { ...view, memory: { ...view.memory, threatHistory: [event(35, id)] } },
          f.abilities[1]!,
        ).weight,
      ).toBe(ordinary);
    } finally {
      f.world.free();
    }
  },
);
