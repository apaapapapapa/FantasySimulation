import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  StreamRecordSchema,
  AI_RULES,
  type AbilityCategory,
  type Definition,
  type Effect,
} from '@fantasy/domain/spatial';
import {
  aiFixture,
  impactEvidence,
  initialStatus,
  withInitialStatus,
} from '../../test-support/ai.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { initializePhysics } from './physics.ts';
import { prepareBattle, reference, sealRevision } from './prepare.ts';
import { runBattle } from './run.ts';
import { emptyMemory, perceive, observeImpact, observeReveal } from './perception.ts';
import { choosePolicy } from './policy.ts';
import { assessAbility, efficacy } from './assessment.ts';
import { assessStatusEffect } from './status-assessment.ts';
import { copyPublicStatuses, statusVision } from './status-observation.ts';
import { selfView } from './self-view.ts';
import { applyStatuses } from './status.ts';
import { planStatusReactions } from './status-reactions.ts';

beforeAll(initializePhysics);
const water: Effect = { kind: 'damage', amount: 25, attackScaleBps: 0, element: 'water' };
const stopped: Definition<'status'>['adjustments'] = [
  { target: 'action', operation: 'multiply', amount: 0 },
];

async function statusCombat(
  status: Partial<Definition<'status'>>,
  effects: Effect[] = [water],
  categories?: AbilityCategory[],
) {
  const f = await aiFixture({
    steps: 30,
    abilities: [
      {
        castSteps: 0,
        costs: { hp: 0, mp: 0, uses: 1 },
        effects,
        ...(categories && { categories }),
      },
    ],
  });
  f.world.free();
  await withInitialStatus(
    f.manifest,
    1,
    initialStatus({ durationSteps: 12, visibility: 'visible', adjustments: stopped, ...status }),
  );
  return f.manifest;
}

describe('G-03 status combat and subjective observations', () => {
  it('applies the old-snapshot weakness on the extinguishing hit, then observes its removal after delay', async () => {
    for (const category of ['physical', 'magic'] as const) {
      const manifest = await statusCombat(
        {
          burning: { waterExtinguishable: false },
          reactions: [{ element: 'water', response: { kind: 'remove' }, damageTakenBps: 20000 }],
          periodic: [{ kind: 'damage', amount: 6, element: 'fire', everySteps: 4 }],
        },
        [water],
        [category],
      );
      const run = await runBattle(manifest),
        events = battleEvents(run.records);
      const damage = events.find((e) => e.kind === 'damage' && e.actorId === 'left')!;
      expect(damage).toMatchObject({
        step: 6,
        amount: 40,
        after: { hp: 58 },
        damage: { calculation: { basePower: 25, afterModifiers: 40 } },
      });
      const reaction = events.find((e) => e.ruleId === 'status.reaction')!;
      expect(reaction).toMatchObject({
        step: 6,
        reason: 'initial-status-1:water:remove',
        causes: [damage.id],
      });
      expect(events.some((e) => e.kind === 'status-remove' && e.step === 6)).toBe(true);
      const seen = events
        .filter((e) => e.actorId === 'left')
        .flatMap((e) =>
          e.cognition?.kind === 'knowledge' && e.cognition.statusObservation
            ? [{ step: e.step, ...e.cognition.statusObservation }]
            : [],
        );
      expect(seen.map((s) => [s.step, s.sampledAt, s.availableAt, s.statuses.length])).toEqual([
        [5, 0, 5, 1],
        [15, 10, 15, 0],
      ]);
      expect(seen[0]!.statuses[0]).not.toHaveProperty('contentHash');
      expect(seen[0]!.statuses[0]).not.toHaveProperty('stacks');
      expect(seen[0]!.statuses[0]).not.toHaveProperty('endStep');
      for (const record of run.records)
        expect(StreamRecordSchema.safeParse(record).success).toBe(true);
      expect((await runBattle(manifest)).result).toEqual(run.result);
    }
  });

  it('transforms once into a referenced status and expires the destination on its own clock', async () => {
    const thaw = await sealRevision(
      'status',
      'thawed',
      1,
      initialStatus({
        stackKey: 'thawed',
        durationSteps: 5,
        visibility: 'visible',
        reactions: [{ element: 'water', response: { kind: 'remove' } }],
      }),
    );
    const manifest = await statusCombat({
      reactions: [{ element: 'water', response: { kind: 'transform', status: reference(thaw) } }],
    });
    manifest.revisions.push(thaw);
    const prepared = await prepareBattle(manifest);
    expect(prepared.actors[0].knownStatuses).toBeUndefined();
    expect(prepared.actors[1].knownStatuses?.map((s) => s.id)).toEqual([
      'initial-status-1',
      'thawed',
    ]);
    const events = battleEvents((await runBattle(manifest)).records);
    expect(
      events
        .filter((e) => e.kind === 'status-apply' && e.reason.startsWith('thawed:'))
        .map((e) => e.step),
    ).toEqual([6]);
    expect(
      events
        .filter((e) => e.kind === 'status-remove' && e.reason === 'thawed:expired')
        .map((e) => e.step),
    ).toEqual([11]);
    await expect(
      prepareBattle({
        ...manifest,
        revisions: manifest.revisions.filter((r) => r.id !== 'thawed'),
      }),
    ).rejects.toThrow();
  });

  it('strengthens once per element despite multiple components, retains the deadline, and prevents actions while incapacitated', async () => {
    const manifest = await statusCombat(
      {
        maxStacks: 3,
        stacking: 'sum',
        reactions: [{ element: 'water', response: { kind: 'strengthen', stacks: 2 } }],
      },
      [water, { ...water, amount: 0 }],
    );
    const events = battleEvents((await runBattle(manifest)).records);
    expect(
      events
        .filter((e) => e.reason.endsWith('element-strengthen-preserve-period'))
        .map((e) => [e.step, e.amount]),
    ).toEqual([[6, 2]]);
    expect(
      events
        .filter((e) => e.kind === 'status-remove' && e.reason === 'initial-status-1:expired')
        .map((e) => e.step),
    ).toEqual([12]);
    expect(
      events
        .filter((e) => e.kind === 'launch' && e.actorId === 'right' && e.abilityId === 'choice-0')
        .every((e) => e.step >= 12),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.actorId === 'right' &&
          e.cognition?.kind === 'decision' &&
          e.cognition.excluded.some((x) => x.reason === 'incapacitated'),
      ),
    ).toBe(true);
  });

  it('keeps a permanent state past its declared duration and through normal dispel and water contact', async () => {
    const manifest = await statusCombat(
      {
        durationSteps: 1,
        categories: ['permanent', 'control'],
        reactions: [{ element: 'water', response: { kind: 'remove' } }],
      },
      [water, { kind: 'dispel', categories: ['control'] }],
    );
    const events = battleEvents((await runBattle(manifest)).records);
    expect(events.some((e) => e.kind === 'status-remove')).toBe(false);
    expect(events.some((e) => e.reason === 'initial-status-1:water:permanent-retained')).toBe(true);
    expect(
      events.some(
        (e) => e.kind === 'launch' && e.actorId === 'right' && e.abilityId === 'choice-0',
      ),
    ).toBe(false);
  });

  it('retains launch-time outgoing multipliers after the source status expires in flight', async () => {
    const f = await aiFixture({
      steps: 50,
      abilities: [
        {
          castSteps: 0,
          costs: { hp: 0, mp: 0, uses: 1 },
          categories: ['magic'],
          attack: {
            kind: 'projectile',
            speedMmPerSecond: 20000,
            radiusMm: 100,
            lifetimeSteps: 100,
            gravityScaleBps: 0,
            homingTurnMilliDegreesPerSecond: 0,
            observation: 'launch-only',
            explosionRadiusMm: 0,
            maxHitsPerTarget: 1,
          },
          effects: [water],
        },
      ],
    });
    f.world.free();
    await withInitialStatus(
      f.manifest,
      0,
      initialStatus({
        durationSteps: 8,
        adjustments: [
          {
            target: 'damageDealt',
            operation: 'multiply',
            amount: 20000,
            element: 'water',
            category: 'magic',
          },
        ],
      }),
    );
    const events = battleEvents((await runBattle(f.manifest)).records);
    const hit = events.find((e) => e.kind === 'damage' && e.actorId === 'left')!;
    expect(hit.step).toBeGreaterThan(8);
    expect(hit.amount).toBe(40);
    expect(
      events
        .flatMap((e) =>
          e.actorId === 'left' && e.cognition?.kind === 'knowledge' ? e.cognition.learned : [],
        )
        .some((e) => e.basePower === 50),
    ).toBe(true);
  });

  it('does not leak hidden states into observation, candidate weights, or cognition', async () => {
    const f = await aiFixture();
    try {
      const hidden = await sealRevision(
        'status',
        'secret',
        1,
        initialStatus({
          visibility: 'hidden',
          adjustments: [{ target: 'damageTaken', operation: 'multiply', amount: 30000 }],
        }),
      );
      const states = [
        { revision: hidden, startStep: 0, endStep: 20, stacks: 3, causes: ['secret-source'] },
      ];
      const observe = (statuses: typeof states, enemy = f.enemy) => {
        const visible = {
          resources: { hp: enemy.actor.character.stats.hp, mp: 100, shield: 0 },
          action: 'idle' as const,
          statuses,
        };
        const first = perceive(f.world, f.self, enemy, [], 0, emptyMemory(), visible);
        return perceive(f.world, f.self, enemy, [], 5, first, visible);
      };
      const absent = observe([]),
        concealed = observe(states);
      expect(concealed).toEqual(absent);
      const ready = new Set(f.abilities.map((a) => a.id));
      expect(choosePolicy({ ...f.view, memory: concealed }, ready, false)).toEqual(
        choosePolicy({ ...f.view, memory: absent }, ready, false),
      );
      const privateEnemy = {
        ...f.enemy,
        actor: {
          ...f.enemy.actor,
          character: {
            ...f.enemy.actor.character,
            stamina: { max: 999, recoveryPerSecond: 200 },
            stats: {
              ...f.enemy.actor.character.stats,
              hp: 9999,
              defense: 900,
              resistances: {
                physical: 10000,
                fire: 9000,
                ice: 1000,
                lightning: 8000,
                arcane: 6000,
              },
            },
          },
        },
      };
      const changed = observe(states, privateEnemy);
      expect(changed).toEqual(absent);
      const knowledge = [impactEvidence(f.abilities[0]!)];
      expect(choosePolicy({ ...f.view, memory: { ...changed, knowledge } }, ready, false)).toEqual(
        choosePolicy({ ...f.view, memory: { ...absent, knowledge } }, ready, false),
      );
      const visibleRevision = await sealRevision('status', 'public', 1, {
        ...hidden.definition,
        visibility: 'visible',
      });
      const publicMemory = observe([{ ...states[0]!, revision: visibleRevision }]);
      expect(efficacy({ ...f.view, memory: publicMemory }, 'fire', 25).bps).toBe(9375);
      const decision = choosePolicy({ ...f.view, memory: publicMemory }, ready, false);
      expect(decision.cognition?.observedStatuses?.[0]).toMatchObject({
        id: 'public',
        adjustments: [{ target: 'damageTaken', direction: 'higher' }],
      });
    } finally {
      f.world.free();
    }
  });

  it('applies perception range, blindness and invisibility only at the observation boundary and restores them on expiry', async () => {
    const f = await aiFixture();
    try {
      for (const target of ['perceptionRange', 'vision', 'visibility'] as const) {
        const revision = await sealRevision(
          'status',
          target.toLowerCase(),
          1,
          initialStatus({ adjustments: [{ target, operation: 'multiply', amount: 0 }] }),
        );
        const states = [{ revision, startStep: 0, endStep: 5, stacks: 1, causes: [] }];
        const self = target === 'visibility' ? f.self : statusVision(f.self, states, 0);
        const enemy = target === 'visibility' ? statusVision(f.enemy, states, 0) : f.enemy;
        const unseen = perceive(f.world, self, enemy, [], 0, emptyMemory());
        expect(unseen.pending[0]?.enemy).toBeNull();
        const clear = perceive(
          f.world,
          statusVision(f.self, states, 5),
          statusVision(f.enemy, states, 5),
          [],
          5,
          unseen,
        );
        expect(clear.pending[0]?.enemy?.id).toBe('right');
      }
    } finally {
      f.world.free();
    }
  });

  it('retires measured damage from the previous public status context only after observing the change', async () => {
    const f = await aiFixture();
    try {
      const revision = await sealRevision(
        'status',
        'visible-weakness',
        1,
        initialStatus({
          visibility: 'visible',
          reactions: [{ element: 'fire', response: { kind: 'none' }, damageTakenBps: 20000 }],
        }),
      );
      const visible = {
        resources: { hp: 100, mp: 100, shield: 0 },
        action: 'idle' as const,
        statuses: [{ revision, startStep: 0, endStep: 10, stacks: 1, causes: [] }],
      };
      const sampled = perceive(f.world, f.self, f.enemy, [], 0, emptyMemory(), visible);
      const observed = perceive(f.world, f.self, f.enemy, [], 5, sampled, visible);
      const old = impactEvidence(f.abilities[0]!, {
        sampledAt: 5,
        availableAt: 10,
        range: { low: 40, high: 50 },
        observedStatuses: copyPublicStatuses(observed.observation!.enemy!.statuses!),
      });
      const before = perceive(
        f.world,
        f.self,
        f.enemy,
        [],
        10,
        { ...observed, knowledge: [old] },
        visible,
      );
      expect(efficacy({ ...f.view, step: 10, memory: before }, 'fire', 25).bps).toBe(18000);
      const { observedStatuses: _, ...bareImpact } = old;
      expect(
        efficacy({ ...f.view, memory: { ...before, knowledge: [bareImpact] } }, 'fire', 25),
      ).toMatchObject({ bps: 9375, evidence: [] });
      const transitionHit = observeImpact(
        f.world,
        f.self,
        f.enemy,
        {
          ability: reference(f.abilities[0]!),
          eventId: 'transition-hit',
          element: 'fire',
          basePower: 25,
          impact: 45,
          shield: false,
          partial: false,
          statuses: visible.statuses,
          statusStep: 9,
        },
        10,
      )!;
      expect(transitionHit).toMatchObject({ sampledAt: 10, availableAt: 15 });
      expect(transitionHit.observedStatuses).toMatchObject([{ id: 'visible-weakness' }]);
      const mismatched = {
        ...f.view,
        memory: { ...f.view.memory, knowledge: [transitionHit] },
      };
      expect(efficacy(mismatched, 'fire', 25)).toMatchObject({ bps: 7500, evidence: [] });
      const after = perceive(
        f.world,
        f.self,
        f.enemy,
        [],
        15,
        {
          ...before,
          pendingExperience: [transitionHit],
        },
        visible,
      );
      expect(after.expired).toEqual(['observed.1']);
      expect(after.knowledge).toEqual([]);
      expect(after.learned).toEqual([]);
      expect(efficacy({ ...f.view, step: 15, memory: after }, 'fire', 25)).toMatchObject({
        bps: 7500,
        confidence: 0,
        evidence: [],
      });
    } finally {
      f.world.free();
    }
  });

  it('combines revealed baseline resistance with public status direction and retains that baseline after expiry', async () => {
    const f = await aiFixture();
    try {
      for (const [definition, expected] of [
        [
          { reactions: [{ element: 'fire', response: { kind: 'none' }, damageTakenBps: 20000 }] },
          11875,
        ],
        [
          {
            adjustments: [
              { target: 'resistance', element: 'fire', operation: 'add', amount: 5000 },
            ],
          },
          7125,
        ],
      ] as [Partial<Definition<'status'>>, number][]) {
        const revision = await sealRevision(
          'status',
          'revealed-context',
          1,
          initialStatus({
            ...definition,
            visibility: 'visible',
          }),
        );
        const visible = {
          resources: f.view.resources,
          action: 'idle' as const,
          statuses: [{ revision, startStep: 0, endStep: 10, stacks: 1, causes: [] }],
        };
        const reveal = observeReveal(
          f.world,
          f.self,
          f.enemy,
          {
            kind: 'reveal',
            field: 'resistance',
            occlusion: 'vision',
            element: 'fire',
            powerBps: 10000,
            precisionBps: 1000,
            delaySteps: 0,
            durationSteps: 100,
          },
          reference(f.abilities[0]!),
          'baseline',
          0,
        )!;
        let memory = perceive(
          f.world,
          f.self,
          f.enemy,
          [],
          0,
          { ...emptyMemory(), pendingExperience: [reveal] },
          visible,
        );
        memory = perceive(f.world, f.self, f.enemy, [], 5, memory, visible);
        expect(efficacy({ ...f.view, memory }, 'fire', 25)).toMatchObject({
          bps: expected,
          confidence: 1000,
          evidence: ['baseline'],
        });
        for (const step of [10, 15])
          memory = perceive(f.world, f.self, f.enemy, [], step, memory, visible);
        expect(efficacy({ ...f.view, step: 15, memory }, 'fire', 25)).toMatchObject({
          bps: 9500,
          confidence: 10000,
          evidence: ['baseline'],
        });
      }
    } finally {
      f.world.free();
    }
  });

  it('learns only the transform closure of a received own status and rejects a worsening self reaction', async () => {
    const f = await aiFixture();
    try {
      const worse = await sealRevision(
        'status',
        'worse-result',
        1,
        initialStatus({
          adjustments: [
            { target: 'attack', operation: 'add', amount: -25 },
            { target: 'damageTaken', operation: 'multiply', amount: 30000 },
          ],
        }),
      );
      const unrelated = await sealRevision(
        'status',
        'unrelated-enemy-secret',
        1,
        initialStatus({
          visibility: 'hidden',
          adjustments: stopped,
        }),
      );
      f.manifest.revisions.push(worse, unrelated);
      const received = await withInitialStatus(
        f.manifest,
        1,
        initialStatus({
          adjustments: [{ target: 'attack', operation: 'add', amount: -5 }],
          reactions: [
            { element: 'water', response: { kind: 'transform', status: reference(worse) } },
          ],
        }),
      );
      const battle = await prepareBattle(f.manifest);
      expect(battle.actors[0].knownStatuses).toBeUndefined();
      const actor = {
        motion: { ...f.self, actor: battle.actors[0] },
        resources: f.view.resources,
        memory: f.view.memory,
        used: {},
        readyAt: 0,
        action: null,
        statuses: [],
      };
      expect(
        selfView(actor, 5, AI_RULES, battle.statuses).self.actor.knownStatuses,
      ).toBeUndefined();
      const view = selfView(
        {
          ...actor,
          statuses: [
            { revision: received, startStep: 1, endStep: 100, stacks: 1, causes: ['enemy-grant'] },
          ],
        },
        5,
        AI_RULES,
        battle.statuses,
      );
      expect(view.self.actor.knownStatuses?.map((s) => s.id)).toEqual([received.id, worse.id]);
      expect(
        assessStatusEffect(view, { kind: 'water', extinguish: true }, 'self').value,
      ).toBeCloseTo(-2.8);
      expect(assessAbility(view, f.abilities[1]!).weight).toBe(0);
      expect(battle.actors[0].knownStatuses).toBeUndefined();
    } finally {
      f.world.free();
    }
  });

  it('values known new buffs, harmful self states, transformation destinations, and permanent cleanse immunity', async () => {
    const f = await aiFixture();
    try {
      const buff = await sealRevision(
        'status',
        'buff',
        1,
        initialStatus({
          stackKey: 'buff',
          adjustments: [{ target: 'attack', operation: 'add', amount: 25 }],
        }),
      );
      const harmful = await sealRevision(
        'status',
        'harmful',
        1,
        initialStatus({
          adjustments: stopped,
          reactions: [
            { element: 'water', response: { kind: 'transform', status: reference(buff) } },
          ],
        }),
      );
      const permanent = await sealRevision('status', 'permanent', 1, {
        ...harmful.definition,
        categories: ['permanent'],
      });
      const view = {
        ...f.view,
        burnDamage: 0,
        self: { ...f.self, actor: { ...f.self.actor, knownStatuses: [buff, harmful, permanent] } },
        ownStatuses: [{ revision: harmful, startStep: 0, endStep: 100, stacks: 1, causes: [] }],
      };
      expect(
        assessStatusEffect(view, { kind: 'apply-status', status: reference(buff) }, 'self').value,
      ).toBe(1);
      expect(
        assessStatusEffect(
          { ...view, ownStatuses: [] },
          { kind: 'apply-status', status: reference(harmful) },
          'self',
        ).value,
      ).toBeLessThan(0);
      expect(assessStatusEffect(view, { kind: 'water', extinguish: true }, 'self').value).toBe(2);
      expect(
        assessStatusEffect(
          { ...view, ownStatuses: [{ ...view.ownStatuses[0]!, revision: permanent }] },
          { kind: 'dispel', statusIds: ['permanent'] },
          'self',
        ).value,
      ).toBe(0);
      const selfHarm = {
        ...f.abilities[0]!,
        definition: {
          ...f.abilities[0]!.definition,
          target: 'self' as const,
          effects: [{ kind: 'apply-status' as const, status: reference(harmful) }],
        },
      };
      expect(assessAbility(view, selfHarm).weight).toBe(0);
    } finally {
      f.world.free();
    }
  });

  it('subtracts displaced cohorts from self replacement utility and installs an incoming permanent revision', async () => {
    const f = await aiFixture();
    try {
      const revisions = await Promise.all(
        [50, 5, 25].map((amount, index) =>
          sealRevision(
            'status',
            `replacement-${index}`,
            1,
            initialStatus({
              stackKey: 'replacement',
              stacking: 'replace',
              durationSteps: 100,
              ...(index === 2 && { categories: ['permanent'] }),
              adjustments: [{ target: 'attack', operation: 'add', amount }],
            }),
          ),
        ),
      );
      const [strong, weak, permanent] = revisions;
      const ownStatuses = [0, 5].map((startStep) => ({
        revision: strong!,
        startStep,
        endStep: startStep + 100,
        stacks: 1,
        causes: [],
      }));
      const view = {
        ...f.view,
        step: 10,
        ownStatuses,
        self: { ...f.self, actor: { ...f.self.actor, knownStatuses: revisions } },
      };
      const effect = { kind: 'apply-status' as const, status: reference(weak!) };
      expect(assessStatusEffect(view, effect, 'self').value).toBeCloseTo(-3.8);
      expect(
        assessAbility(view, {
          ...f.abilities[0]!,
          definition: { ...f.abilities[0]!.definition, target: 'self', effects: [effect] },
        }).weight,
      ).toBe(0);
      const replaced = applyStatuses(ownStatuses, [{ revision: weak!, cause: 'replace' }], [], 11);
      expect(replaced.statuses).toMatchObject([
        { revision: weak, startStep: 11, endStep: 111, stacks: 1 },
      ]);
      const next = { ...view, step: 11, ownStatuses: replaced.statuses };
      expect(
        assessStatusEffect(next, { kind: 'apply-status', status: reference(permanent!) }, 'self')
          .value,
      ).toBeCloseTo(0.8);
      const installed = applyStatuses(
        replaced.statuses,
        [{ revision: permanent!, cause: 'permanent' }],
        [],
        12,
      );
      expect(installed.statuses).toMatchObject([
        { revision: permanent, startStep: 12, endStep: 12000, stacks: 1 },
      ]);
      expect(applyStatuses(installed.statuses, [], [permanent!], 13).statuses).toEqual(
        installed.statuses,
      );
      expect(
        assessStatusEffect(
          { ...view, ownStatuses: ownStatuses.map((s) => ({ ...s, endStep: 11 })) },
          effect,
          'self',
        ).value,
      ).toBeCloseTo(0.2);
    } finally {
      f.world.free();
    }
  });

  it('values strengthening once against total stacks with the oldest deadline regardless of cohort order', async () => {
    const f = await aiFixture();
    try {
      const revision = await sealRevision(
        'status',
        'strengthened',
        1,
        initialStatus({
          stacking: 'sum',
          maxStacks: 3,
          durationSteps: 20,
          adjustments: [{ target: 'attack', operation: 'add', amount: 25 }],
          reactions: [{ element: 'water', response: { kind: 'strengthen', stacks: 2 } }],
        }),
      );
      const cohorts = [0, 5].map((startStep) => ({
        revision,
        startStep,
        endStep: startStep + 20,
        stacks: 1,
        causes: [],
      }));
      const view = {
        ...f.view,
        step: 10,
        self: { ...f.self, actor: { ...f.self.actor, knownStatuses: [revision] } },
      };
      for (const ownStatuses of [cohorts, [...cohorts].reverse()]) {
        expect(
          assessStatusEffect({ ...view, ownStatuses }, { kind: 'water', extinguish: true }, 'self')
            .value,
        ).toBeCloseTo(0.18);
        const plan = planStatusReactions(
          ownStatuses,
          [{ id: 'water', element: 'water' }],
          [revision],
          10,
        );
        const resolved = applyStatuses(plan.statuses, plan.applications, plan.dispels, 11).statuses;
        expect(
          resolved.map(({ startStep, endStep, stacks }) => ({ startStep, endStep, stacks })),
        ).toEqual([
          { startStep: 0, endStep: 20, stacks: 2 },
          { startStep: 5, endStep: 25, stacks: 1 },
        ]);
        expect(
          assessStatusEffect(
            { ...view, ownStatuses: resolved },
            { kind: 'water', extinguish: true },
            'self',
          ).value,
        ).toBe(0);
      }
      expect(cohorts.map((s) => s.stacks)).toEqual([1, 1]);
    } finally {
      f.world.free();
    }
  });
});
