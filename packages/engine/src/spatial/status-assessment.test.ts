import { beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Definition, Effect } from '@fantasy/domain/spatial';
import { aiFixture, initialStatus } from '../../test-support/ai.ts';
import { initializePhysics } from './physics.ts';
import { reference } from './prepare.ts';
import { sealRevision } from './manifest-builder.ts';
import { assessAbility } from './assessment.ts';
import { assessStatusEffects } from './status-assessment.ts';
import { applyStatuses, statusBoundary, type StatusRevision } from './status.ts';
import { planStatusEffects } from './status-reactions.ts';
import { resolveEffects } from './effects.ts';
import { publicStatuses } from './status-observation.ts';
import { choosePolicy } from './policy.ts';
import { initialDecisionRandom } from './decision-random.ts';
import { knownPeriodicDamage } from './status-risk.ts';

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
  it('values legacy self buffs and enemy debuffs by magnitude and duration, excluding harmful self grants', async () => {
    const modifiers = initialStatus().modifiers;
    const f = await fixture([
      { modifiers: { ...modifiers, attack: 25 }, durationSteps: 50 },
      { modifiers: { ...modifiers, attack: 50 }, durationSteps: 50 },
      { modifiers: { ...modifiers, attack: 25 }, durationSteps: 10 },
      { modifiers: { ...modifiers, attack: -25 }, durationSteps: 50 },
    ]);
    try {
      const grant = (index: number, target: 'self' | 'enemy' = 'self') => ({
        ...f.abilities[0]!,
        id: `grant-${index}-${target}`,
        definition: {
          ...f.abilities[0]!.definition,
          target,
          effects: [{ kind: 'apply-status' as const, status: reference(f.statuses[index]!) }],
        },
      });
      const weights = [0, 1, 2, 3].map((i) => assessAbility(f.view, grant(i)).weight);
      expect(weights[0]).toBeGreaterThan(0);
      expect(weights[1]).toBeGreaterThan(weights[0]!);
      expect(weights[2]).toBeLessThan(weights[0]!);
      expect(weights[3]).toBe(0);
      expect(assessAbility(f.view, grant(3, 'enemy')).weight).toBeGreaterThan(0);
      expect(assessAbility(f.view, grant(0, 'enemy')).weight).toBe(0);
      const harmful = grant(3);
      const actor = {
        ...f.view.self.actor,
        abilities: [harmful],
        policy: {
          ...f.view.self.actor.policy,
          priorities: [{ abilityId: harmful.id, when: { kind: 'always' as const } }],
        },
      };
      const decision = choosePolicy(
        { ...f.view, self: { ...f.view.self, actor } },
        new Set([harmful.id]),
        false,
      );
      expect(decision.abilityId).toBeNull();
      expect(decision.cognition?.excluded).toContainEqual({
        abilityId: harmful.id,
        reason: 'no estimated benefit',
      });
    } finally {
      f.world.free();
    }
  });

  it('uses shared periodic damage for the approved 659/740 cleanse probability and retires expired risk', async () => {
    const f = await fixture([
      {
        burning: { waterExtinguishable: true },
        periodic: [{ kind: 'damage', amount: 9, element: 'fire', everySteps: 10 }],
      },
    ]);
    try {
      const view = { ...f.view, step: 5, ownStatuses: [cohort(f.statuses[0]!)] };
      const ready = new Set(f.abilities.map((a) => a.id));
      const decision = choosePolicy(view, ready, false);
      const candidates = decision.cognition!.candidates;
      expect(candidates.find((c) => c.abilityId === 'choice-0')).toMatchObject({
        weight: 81,
        totalWeight: 740,
      });
      expect(candidates.find((c) => c.abilityId === 'choice-1')).toMatchObject({
        weight: 659,
        totalWeight: 740,
      });
      const choices = new Set(
        Array.from(
          { length: 64 },
          (_, i) => choosePolicy(view, ready, false, initialDecisionRandom(i + 1)).abilityId,
        ),
      );
      expect(choices).toEqual(new Set(['choice-0', 'choice-1']));
      expect(choosePolicy(view, ready, false)).toEqual(decision);
      const expired = { ...view, step: 100, burnDamage: 0 };
      expect(assessAbility(expired, f.abilities[1]!).weight).toBe(0);
      expect(choosePolicy(expired, ready, false).abilityId).toBe('choice-0');
      const { burning: _, ...ordinaryPeriodic } = f.statuses[0]!.definition;
      const noBurnMarker = await sealRevision('status', 'toxin', 1, {
        ...ordinaryPeriodic,
        reactions: [{ element: 'water', response: { kind: 'remove' } }],
      });
      expect(
        assessAbility({ ...view, ownStatuses: [cohort(noBurnMarker)] }, f.abilities[1]!).weight,
      ).toBe(659);
    } finally {
      f.world.free();
    }
  });

  it('matches outgoing status qualifiers to known skills and retains permanent grants', async () => {
    const f = await fixture([
      {
        durationSteps: 1,
        categories: ['permanent'],
        adjustments: [
          { target: 'damageDealt', operation: 'multiply', amount: 20000, element: 'earth' },
        ],
      },
      {
        durationSteps: 1,
        categories: ['permanent'],
        adjustments: [
          { target: 'damageDealt', operation: 'multiply', amount: 20000, element: 'fire' },
        ],
      },
    ]);
    try {
      const apply = (i: number): Effect[] => [
        { kind: 'apply-status', status: reference(f.statuses[i]!) },
      ];
      expect(assessStatusEffects(f.view, apply(0), 'self').value).toBe(0);
      expect(assessStatusEffects(f.view, apply(1), 'self').value).toBe(1);
      expect(
        assessStatusEffects(
          { ...f.view, ownStatuses: [cohort(f.statuses[1]!, Infinity)] },
          [{ kind: 'dispel', categories: ['permanent'] }],
          'self',
        ).value,
      ).toBe(0);
    } finally {
      f.world.free();
    }
  });

  it('expires defensive modifiers within the periodic risk horizon before the next pulse', async () => {
    const f = await fixture([
      { periodic: [{ kind: 'damage', amount: 15, element: 'fire', everySteps: 10 }] },
      { modifiers: { ...initialStatus().modifiers, defense: 25 } },
    ]);
    try {
      const value = assessStatusEffects(
        { ...f.view, step: 5, ownStatuses: [cohort(f.statuses[0]!), cohort(f.statuses[1]!, 20)] },
        [{ kind: 'dispel', statusIds: [f.statuses[0]!.id] }],
        'self',
        5,
      );
      // Pulse10 is blocked; defence expires before pulses20/30/40/50, each 15-5=10.
      expect(value.risk).toMatchObject({ before: 40, after: 0 });
    } finally {
      f.world.free();
    }
  });

  it.each([
    ['remove', 4],
    ['transform', 8],
    ['strengthen', 48],
  ] as const)('advances %s reactions after each forecast pulse', async (kind, expected) => {
    const f = await fixture([
      {
        durationSteps: 25,
        stackKey: 'destination',
        periodic: [{ kind: 'damage', amount: 7, element: 'fire', everySteps: 10 }],
      },
    ]);
    try {
      const revision = await sealRevision(
        'status',
        'reactive-dot',
        1,
        initialStatus({
          stacking: 'sum',
          maxStacks: 3,
          periodic: [{ kind: 'damage', amount: 9, element: 'fire', everySteps: 10 }],
          reactions: [
            {
              element: 'fire',
              response:
                kind === 'remove'
                  ? { kind }
                  : kind === 'transform'
                    ? { kind, status: reference(f.statuses[0]!) }
                    : { kind, stacks: 1 },
            },
          ],
        }),
      );
      const states = [cohort(revision)],
        view = {
          ...f.view,
          step: 5,
          ownStatuses: states,
          self: {
            ...f.view.self,
            actor: { ...f.view.self.actor, knownStatuses: [...f.statuses, revision] },
          },
        };
      const risk = assessStatusEffects(
        view,
        [{ kind: 'dispel', statusIds: [revision.id] }],
        'self',
        5,
      ).risk;
      // 4 on the first pulse; transformed ticks at20/30 add2 each; strengthening ticks1/2/3/3/3 stacks.
      expect(risk).toMatchObject({ before: expected, after: 0 });
      expect(states).toEqual([cohort(revision)]);
    } finally {
      f.world.free();
    }
  });

  it('leaves undefined future reactions to actual resolution without failing the current forecast', async () => {
    const f = await fixture(
      [25, 50].map((attack) => ({
        stackKey: 'conflicting-destination',
        modifiers: { ...initialStatus().modifiers, attack },
      })),
    );
    try {
      const origins = await Promise.all(
        f.statuses.map((destination, i) =>
          sealRevision(
            'status',
            `origin-${i}`,
            1,
            initialStatus({
              stackKey: `origin-${i}`,
              periodic:
                i === 0 ? [{ kind: 'damage', amount: 9, element: 'fire', everySteps: 10 }] : [],
              reactions: [
                {
                  element: 'fire',
                  response: { kind: 'transform', status: reference(destination) },
                },
              ],
            }),
          ),
        ),
      );
      const actor = { ...f.view.self.actor, knownStatuses: [...f.statuses, ...origins] };
      const states = origins.map((s) => cohort(s));
      expect(knownPeriodicDamage(actor, states, f.view.resources, 5, 50)).toBeUndefined();
      expect(
        assessStatusEffects(
          { ...f.view, ownStatuses: states, self: { ...f.view.self, actor } },
          [{ kind: 'dispel', statusIds: origins.map((s) => s.id) }],
          'self',
          5,
        ).value,
      ).toBe(0);
      expect(() =>
        resolveEffects(
          [{ actor, resources: f.view.resources, statuses: states }],
          [
            {
              id: 'actual-pulse',
              actorId: null,
              targetId: 'left',
              attack: 0,
              effect: { kind: 'damage', amount: 9, element: 'fire', attackScaleBps: 0 },
            },
          ],
          actor.knownStatuses,
          10,
          10,
        ),
      ).toThrow('Different simultaneous definitions share a stack key');
    } finally {
      f.world.free();
    }
  });

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
