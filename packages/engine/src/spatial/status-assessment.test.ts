import { beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Definition, Effect } from '@fantasy/domain/spatial';
import { aiFixture, initialStatus } from '../../test-support/ai.ts';
import { initializePhysics } from './physics.ts';
import { reference, sealRevision } from './prepare.ts';
import { assessAbility } from './assessment.ts';
import { assessStatusEffects } from './status-assessment.ts';
import { applyStatuses, statusBoundary, type StatusRevision } from './status.ts';
import { planStatusEffects } from './status-reactions.ts';
import { resolveEffects } from './effects.ts';
import { publicStatuses } from './status-observation.ts';

beforeAll(initializePhysics);
const cohort = (revision: StatusRevision, endStep = 100, stacks = 1) => ({
  revision,
  startStep: 0,
  endStep,
  stacks,
  causes: [],
});
async function fixture(definitions: Partial<Definition<'status'>>[]) {
  const f = await aiFixture();
  const statuses = await Promise.all(
    definitions.map((d, i) => sealRevision('status', `forecast-${i}`, 1, initialStatus(d))),
  );
  return {
    ...f,
    statuses,
    view: {
      ...f.view,
      step: 1,
      self: { ...f.self, actor: { ...f.self.actor, knownStatuses: statuses } },
    },
  };
}

describe('status transaction forecasts', () => {
  it('preserves the periodic origin for removal, replacement and added stacks', async () => {
    const f = await fixture([
      {
        stacking: 'replace',
        maxStacks: 3,
        durationSteps: 30,
        periodic: [{ kind: 'resource', resource: 'mp', amount: -25, everySteps: 25 }],
        reactions: [{ element: 'water', response: { kind: 'strengthen', stacks: 2 } }],
      },
    ]);
    try {
      const revision = f.statuses[0]!,
        ownStatuses = [cohort(revision, 30)],
        view = { ...f.view, ownStatuses };
      expect(
        assessStatusEffects(view, [{ kind: 'dispel', statusIds: [revision.id] }], 'self').value,
      ).toBe(1);
      expect(
        assessStatusEffects(view, [{ kind: 'apply-status', status: reference(revision) }], 'self')
          .value,
      ).toBe(-1);
      const effects: Effect[] = [{ kind: 'water', extinguish: true }];
      expect(assessStatusEffects(view, effects, 'self').value).toBe(-2);
      const plan = planStatusEffects(
        ownStatuses,
        [{ id: 'strengthen', effect: effects[0]! }],
        f.statuses,
        1,
      );
      const after = applyStatuses(plan.statuses, plan.applications, plan.dispels, 2).statuses;
      expect(statusBoundary(after, 2).pulses).toHaveLength(0);
      expect(statusBoundary(after, 25).pulses).toHaveLength(3);
      expect(statusBoundary(after, 30).pulses).toHaveLength(0);
      expect(
        assessStatusEffects(
          { ...view, step: 25 },
          [{ kind: 'dispel', statusIds: [revision.id] }],
          'self',
        ).value,
      ).toBe(0);
    } finally {
      f.world.free();
    }
  });

  it('uses speed-scaled launch time and ignores states that expire during casting', async () => {
    const f = await fixture([
      {
        stackKey: 'cast',
        stacking: 'replace',
        adjustments: [{ target: 'attack', operation: 'add', amount: 50 }],
        reactions: [{ element: 'water', response: { kind: 'strengthen', stacks: 1 } }],
        maxStacks: 3,
      },
      {
        stackKey: 'cast',
        stacking: 'replace',
        durationSteps: 100,
        adjustments: [{ target: 'attack', operation: 'add', amount: 5 }],
      },
    ]);
    try {
      const actor = f.view.self.actor;
      const view = {
        ...f.view,
        step: 2,
        ownStatuses: [cohort(f.statuses[0]!, 8)],
        self: {
          ...f.view.self,
          actor: {
            ...actor,
            character: {
              ...actor.character,
              stats: { ...actor.character.stats, actionSpeedBps: 20000 },
            },
          },
        },
      };
      const effects: Effect[] = [{ kind: 'apply-status', status: reference(f.statuses[1]!) }];
      const ability = {
        ...f.abilities[0]!,
        definition: {
          ...f.abilities[0]!.definition,
          target: 'self' as const,
          attack: { kind: 'direct' as const },
          castSteps: 16,
          costs: { hp: 0, mp: 0, uses: 0 },
          effects,
        },
      };
      expect(assessStatusEffects(view, effects, 'self', 10).value).toBeCloseTo(0.2);
      expect(assessAbility(view, ability).weight).toBeGreaterThan(0);
      expect(assessAbility(view, ability).weight).toBe(
        assessAbility({ ...view, ownStatuses: [] }, ability).weight,
      );
      for (const effect of [
        { kind: 'water', extinguish: true },
        { kind: 'dispel', statusIds: [f.statuses[0]!.id] },
      ] as Effect[]) {
        expect(
          assessAbility(view, {
            ...ability,
            definition: { ...ability.definition, effects: [effect] },
          }).weight,
        ).toBe(0);
      }
      const resolved = resolveEffects(
        [{ actor, resources: view.resources, statuses: [] }],
        [{ id: 'launch', actorId: 'left', targetId: 'left', attack: 0, effect: effects[0]! }],
        f.statuses,
        10,
      );
      expect(resolved[0]!.statuses).toMatchObject([
        { revision: f.statuses[1], startStep: 11, endStep: 111 },
      ]);
    } finally {
      f.world.free();
    }
  });

  it('groups duplicate grants, capped stacks and overlapping cleanses into one transaction', async () => {
    const f = await fixture([
      {
        stackKey: 'grant',
        stacking: 'replace',
        durationSteps: 100,
        adjustments: [{ target: 'attack', operation: 'add', amount: 25 }],
      },
      {
        stackKey: 'sum',
        stacking: 'sum',
        maxStacks: 3,
        durationSteps: 100,
        adjustments: [{ target: 'attack', operation: 'add', amount: 25 }],
      },
      {
        stackKey: 'cleanse',
        durationSteps: 100,
        visibility: 'visible',
        adjustments: [{ target: 'attack', operation: 'add', amount: -25 }],
        reactions: [{ element: 'water', response: { kind: 'remove' } }],
      },
    ]);
    try {
      const grant: Effect = { kind: 'apply-status', status: reference(f.statuses[0]!) };
      const duplicate = [grant, { ...grant }];
      expect(assessStatusEffects(f.view, duplicate, 'self').value).toBe(1);
      expect(assessStatusEffects(f.view, duplicate, 'enemy').value).toBe(-1);
      const ability = {
        ...f.abilities[0]!,
        definition: { ...f.abilities[0]!.definition, target: 'self' as const, effects: duplicate },
      };
      expect(assessAbility(f.view, ability).weight).toBe(
        assessAbility(f.view, {
          ...ability,
          definition: { ...ability.definition, effects: [grant] },
        }).weight,
      );
      const summed: Effect = { kind: 'apply-status', status: reference(f.statuses[1]!) };
      expect(
        assessStatusEffects(
          { ...f.view, ownStatuses: [cohort(f.statuses[1]!, 100, 2)] },
          [summed, { ...summed }],
          'self',
        ).value,
      ).toBe(1);
      const ownStatuses = [cohort(f.statuses[2]!)];
      const cleanses: Effect[] = [
        { kind: 'dispel', statusIds: [f.statuses[2]!.id] },
        { kind: 'water', extinguish: true },
        { kind: 'dispel', statusIds: [f.statuses[2]!.id] },
      ];
      expect(assessStatusEffects({ ...f.view, ownStatuses }, cleanses, 'self').value).toBe(1);
      const observation = f.view.memory.observation!;
      const memory = {
        ...f.view.memory,
        observation: {
          ...observation,
          enemy: { ...observation.enemy!, statuses: publicStatuses(ownStatuses, 1) },
        },
      };
      expect(assessStatusEffects({ ...f.view, memory }, cleanses, 'enemy').value).toBe(-1);
      const resolved = resolveEffects(
        [{ actor: f.view.self.actor, resources: f.view.resources, statuses: ownStatuses }],
        [...cleanses, ...duplicate].map((effect, i) => ({
          id: `combined-${i}`,
          actorId: 'left',
          targetId: 'left',
          attack: 0,
          effect,
        })),
        f.statuses,
        1,
      );
      expect(resolved[0]!.statuses).toMatchObject([
        { revision: f.statuses[0], stacks: 1, startStep: 2 },
      ]);
      expect(
        assessStatusEffects({ ...f.view, ownStatuses }, [...cleanses, ...duplicate], 'self').value,
      ).toBe(2);
    } finally {
      f.world.free();
    }
  });
});
