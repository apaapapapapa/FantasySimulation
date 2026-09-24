import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { AI_RULES, AiRulesSchema, CognitionSchema } from '@fantasy/domain/spatial';
import { initializePhysics } from './physics.ts';
import { reference } from './prepare.ts';
import { sealRevision } from './manifest-builder.ts';
import { runBattle } from './run.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { initialDecisionRandom, initialMovementRandom, weightedChoice } from './decision-random.ts';
import { choosePolicy } from './policy.ts';
import { aiFixture, dodgeFixture } from '../../test-support/ai.ts';

beforeAll(initializePhysics);

describe('best-relative rational candidate cutoff', () => {
  it.each([
    { weights: [19, 20, 400], floor: 500, effective: [0, 20, 400], total: 420 },
    { weights: [20, 401], floor: 500, effective: [0, 401], total: 401 },
    { weights: [81, 659], floor: 500, effective: [81, 659], total: 740 },
    { weights: [5, 5, 5], floor: 10000, effective: [5, 5, 5], total: 15 },
    { weights: [0, 0], floor: 10000, effective: [0, 0], total: 0 },
    { weights: [], floor: 500, effective: [], total: 0 },
    { weights: [1, 0, 1000000], floor: 1, effective: [0, 0, 1000000], total: 1000000 },
    { weights: [1, 0, 1000000], floor: 0, effective: [1, 0, 1000000], total: 1000001 },
  ])(
    'uses the original maximum and an inclusive exact boundary: %j',
    ({ weights, floor, effective, total }) => {
      const choice = weightedChoice(Object.freeze(weights), 19, floor);
      expect(choice.weights).toEqual(effective);
      expect(choice.total).toBe(total);
      const positive = effective.filter((w) => w > 0);
      expect(choice.draws === 0).toBe(positive.length < 2);
      expect(choice.index === null).toBe(total === 0);
      expect(choice.index === null ? 0 : effective[choice.index]).toBeGreaterThanOrEqual(
        total === 0 ? 0 : 1,
      );
    },
  );

  it.each([-1, 10001, 0.5, NaN, Infinity])(
    'rejects an invalid cutoff at both boundaries: %s',
    (floor) => {
      expect(
        AiRulesSchema.safeParse({ ...AI_RULES, minimumCandidateWeightBps: floor }).success,
      ).toBe(false);
      expect(() => weightedChoice([1, 2], 19, floor)).toThrow(/Invalid decision weight cutoff/);
      expect(() => weightedChoice([], 19, floor)).toThrow(/Invalid decision weight cutoff/);
    },
  );

  it('preserves omission, input order, equal alternatives and the bounded integer weight contract', () => {
    expect(AiRulesSchema.parse(AI_RULES)).not.toHaveProperty('minimumCandidateWeightBps');
    for (const floor of [0, 500, 10000])
      expect(
        AiRulesSchema.safeParse({ ...AI_RULES, minimumCandidateWeightBps: floor }).success,
      ).toBe(true);
    expect(weightedChoice([400, 19, 20], 19, 500).weights).toEqual([400, 0, 20]);
    expect(weightedChoice(Array(35).fill(1000000), 19, 10000).total).toBe(35000000);
    for (const weights of [[NaN], [Infinity], [-1], [1000001], Array(36).fill(1), Array<number>(1)])
      expect(() => weightedChoice(weights, 19, 500)).toThrow(/Invalid decision weights/);
    for (let seed = 1; seed <= 64; seed++) {
      expect(weightedChoice([81, 659], seed, 500)).toEqual(weightedChoice([81, 659], seed));
      expect(weightedChoice([1, 1000000], seed, 0)).toEqual(weightedChoice([1, 1000000], seed));
      expect(weightedChoice([5, 5, 5], seed, 10000)).toEqual(weightedChoice([5, 5, 5], seed));
    }
  });

  it('keeps the approved 659/740 fixture and legacy records while logging effective action probabilities', async () => {
    const f = await aiFixture();
    try {
      const ready = new Set(f.abilities.map((a) => a.id));
      const view = { ...f.view, rules: { ...AI_RULES, minimumCandidateWeightBps: 500 } };
      for (let seed = 1; seed <= 32; seed++) {
        const random = initialDecisionRandom(seed);
        const legacy = choosePolicy(f.view, ready, false, random);
        const decision = choosePolicy(view, ready, false, random);
        expect(decision.abilityId).toBe(legacy.abilityId);
        expect(decision.random).toEqual(legacy.random);
        expect(legacy.cognition!.candidates.every((c) => !('weightBeforeCutoff' in c))).toBe(true);
        expect(
          decision
            .cognition!.candidates.map((c) => [c.weightBeforeCutoff, c.weight, c.totalWeight])
            .sort((a, b) => a[1]! - b[1]!),
        ).toEqual([
          [81, 81, 740],
          [659, 659, 740],
        ]);
        expect(CognitionSchema.safeParse(decision.cognition).success).toBe(true);
      }
      // A synthetic high boundary is not a proposal for the published standard rules.
      const decision = choosePolicy(
        { ...view, rules: { ...view.rules, minimumCandidateWeightBps: 2000 } },
        ready,
        false,
      );
      expect(decision.abilityId).toBe('choice-1');
      expect(decision.cognition!.method).toBe('sole');
      expect(decision.cognition!.draws[0]).toMatchObject({
        draws: 0,
        before: decision.random!.action,
        after: decision.random!.action,
      });
      expect(decision.cognition!.candidates.find((c) => c.abilityId === 'choice-0')).toMatchObject({
        weightBeforeCutoff: 81,
        weight: 0,
        totalWeight: 659,
      });
      const unavailable = choosePolicy(view, new Set(['choice-0']), false);
      expect(unavailable.abilityId).toBe('choice-0');
      expect(unavailable.cognition!.excluded).toContainEqual({
        abilityId: 'choice-1',
        reason: 'cooldown',
      });
    } finally {
      f.world.free();
    }
  });

  it('carries an explicit test-only rules revision through real battle records and seeded replay', async () => {
    const f = await aiFixture();
    try {
      const old = f.manifest.revisions.find((r) => r.kind === 'ruleset')!;
      const original = structuredClone(old);
      const rules = await sealRevision('ruleset', 'cutoff-test-only', 1, {
        ...old.definition,
        ai: { ...old.definition.ai!, minimumCandidateWeightBps: 500 },
      });
      f.manifest.revisions.push(rules);
      f.manifest.ruleset = reference(rules);
      const first = await runBattle(f.manifest);
      const second = await runBattle(f.manifest);
      expect(second).toEqual(first);
      const decisions = battleEvents(first.records).flatMap((event) =>
        event.cognition?.kind === 'decision' ? [event.cognition] : [],
      );
      expect(decisions.length).toBeGreaterThan(0);
      for (const decision of decisions) {
        expect(CognitionSchema.safeParse(decision).success).toBe(true);
        expect(decision.candidates.every((c) => c.weightBeforeCutoff !== undefined)).toBe(true);
        const total = decision.candidates.reduce((sum, c) => sum + c.weight, 0);
        expect(decision.candidates.every((c) => c.totalWeight === total)).toBe(true);
      }
      expect(old).toEqual(original);
    } finally {
      f.world.free();
    }
  });

  it('uses the same floor for the conditional movement and direction draws without consuming sole-choice streams', async () => {
    const f = await dodgeFixture();
    try {
      const observation = f.view.memory.observation!;
      f.view.memory = {
        ...f.view.memory,
        observation: {
          ...observation,
          projectiles: observation.projectiles.map((p) => ({
            ...p,
            position: { ...p.position, y: p.position.y + 0.1 },
          })),
        },
      };
      f.view.rules = { ...AI_RULES, slots: 'simultaneous-v1', minimumCandidateWeightBps: 10000 };
      const random = { ...initialDecisionRandom(42), movement: initialMovementRandom(42) };
      const decision = choosePolicy(f.view, new Set(), true, random);
      expect(decision.dodge).toBe(true);
      expect(decision.random).toEqual(random);
      expect(CognitionSchema.safeParse(decision.cognition).success).toBe(true);
      const movement = decision.cognition!.movementSlot!;
      expect(movement.selection).toBe('dodge');
      expect(movement.draw.draws).toBe(0);
      expect(movement.candidates.find((c) => c.kind === 'move')).toMatchObject({
        weightBeforeCutoff: 100,
        weight: 0,
        totalWeight: 600,
      });
      expect(decision.cognition!.directions.filter((d) => d.weight > 0).map((d) => d.key)).toEqual([
        'down',
      ]);
      expect(
        decision.cognition!.directions.some(
          (d) => d.weight === 0 && (d.weightBeforeCutoff ?? 0) > 0,
        ),
      ).toBe(true);
      expect(decision.cognition!.draws.find((d) => d.purpose === 'dodge')).toMatchObject({
        draws: 0,
        selection: 'down',
      });
      // No exact hidden enemy information is introduced by the selection stage.
      expect(decision.cognition!.targetId).toBeNull();
      expect(decision.cognition!.targetPositionMm).toBeNull();
    } finally {
      f.world.free();
    }
  });
});
