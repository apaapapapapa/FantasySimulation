import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { canonicalJson } from '@fantasy/domain/spatial';
import { initializePhysics } from './physics.ts';
import { choosePolicy } from './policy.ts';
import { assessAbility, efficacy } from './assessment.ts';
import { aiFixture, impactEvidence } from '../../test-support/ai.ts';
import { initialDecisionRandom } from './decision-random.ts';

beforeAll(initializePhysics);
describe('observed utility distributions', () => {
  it('prefers ordinary self extinguishing without making it compulsory, then favors a supported quick kill', async () => {
    const f = await aiFixture();
    try {
      const ready = new Set(f.abilities.map((a) => a.id)),
        standard = choosePolicy(f.view, ready, false).cognition!;
      const water = standard.candidates.find((c) => c.abilityId === 'choice-1')!,
        attack = standard.candidates.find((c) => c.abilityId === 'choice-0')!;
      // Rounded integer formula for 25 power, unknown unhurt target, 20/100 burn risk and MP=100.
      expect([attack.weight, water.weight]).toEqual([81, 659]);
      expect(water.weight / water.totalWeight).toBeGreaterThan(0.75);
      expect(water.weight / water.totalWeight).toBeLessThan(0.95);
      const knowledge = Array.from({ length: 4 }, (_, i) =>
        impactEvidence(f.abilities[0]!, { eventId: `observed.${i}`, range: { low: 20, high: 30 } }),
      );
      const favorable = {
        ...f.view,
        memory: {
          ...f.view.memory,
          knowledge,
          observation: {
            ...f.view.memory.observation!,
            enemy: { ...f.view.memory.observation!.enemy!, wounds: 'critical' as const },
          },
        },
      };
      const fast = assessAbility(favorable, f.abilities[0]!);
      expect(fast.weight).toBeGreaterThan(attack.weight);
      expect(fast.weight).toBeGreaterThan(water.weight);
      const urgent = assessAbility({ ...favorable, burnDamage: 100 }, f.abilities[1]!);
      const urgentAttack = assessAbility({ ...favorable, burnDamage: 100 }, f.abilities[0]!);
      expect(urgent.weight / (urgent.weight + urgentAttack.weight)).toBeGreaterThan(
        water.weight / (water.weight + fast.weight),
      );
      const picks = new Set<string | null>();
      for (let seed = 1; seed <= 64; seed++)
        picks.add(choosePolicy(favorable, ready, false, initialDecisionRandom(seed)).abilityId);
      expect(picks).toEqual(new Set(['choice-0', 'choice-1']));
      expect(
        assessAbility(favorable, {
          ...f.abilities[0]!,
          definition: {
            ...f.abilities[0]!.definition,
            castSteps: 50,
            costs: { hp: 0, mp: 80, uses: 0 },
          },
        }).weight,
      ).toBeLessThan(fast.weight);
    } finally {
      f.world.free();
    }
  });
  it('learns comparable coarse efficacy without treating shields, different powers or distances as resistance', async () => {
    const f = await aiFixture({
      abilities: [
        { effects: [{ kind: 'damage', amount: 25, attackScaleBps: 0, element: 'fire' }] },
        { effects: [{ kind: 'damage', amount: 25, attackScaleBps: 0, element: 'ice' }] },
      ],
    });
    try {
      const knowledge = [
        impactEvidence(f.abilities[0]!, { range: { low: 0, high: 10 } }),
        impactEvidence(f.abilities[1]!, {
          eventId: 'observed.2',
          element: 'ice',
          range: { low: 20, high: 30 },
        }),
      ];
      const view = { ...f.view, memory: { ...f.view.memory, knowledge } };
      expect(efficacy(view, 'ice', 25)).toMatchObject({ bps: 10000, confidence: 2500 });
      expect(efficacy(view, 'fire', 25)).toMatchObject({ bps: 2000, confidence: 2500 });
      expect(assessAbility(view, f.abilities[1]!).weight).toBeGreaterThan(
        assessAbility(view, f.abilities[0]!).weight,
      );
      for (const edit of [
        { kind: 'shield' as const, range: null },
        { basePower: 100 },
        { distanceBand: 0 },
        { expiresAt: 5 },
      ]) {
        const uncertain = {
          ...view,
          memory: { ...view.memory, knowledge: [{ ...knowledge[0]!, ...edit }] },
        };
        expect(efficacy(uncertain, 'fire', 25)).toMatchObject({
          bps: 7500,
          confidence: 0,
          evidence: [],
        });
      }
      expect(
        efficacy(
          {
            ...view,
            memory: {
              ...view.memory,
              knowledge: [
                impactEvidence(f.abilities[0]!, {
                  kind: 'reveal',
                  range: { low: 10000, high: 10000 },
                }),
              ],
            },
          },
          'ice',
          25,
        ).confidence,
      ).toBe(0);
    } finally {
      f.world.free();
    }
  });
  it('excludes every self-known failure before a draw and preserves alternatives and enumeration invariance', async () => {
    const f = await aiFixture();
    try {
      const ready = new Set(f.abilities.map((a) => a.id));
      for (const edit of [{ resources: { hp: 100, mp: 0, shield: 0 } }, { silenced: true }]) {
        const d = choosePolicy({ ...f.view, ...edit }, ready, false);
        expect(d.abilityId).toBe('choice-0');
        expect(d.cognition!.draws[0]!.draws).toBe(0);
      }
      expect(choosePolicy(f.view, new Set(['choice-0']), false).cognition!.excluded).toContainEqual(
        { abilityId: 'choice-1', reason: 'cooldown' },
      );
      const ability = {
        ...f.abilities[0]!,
        definition: { ...f.abilities[0]!.definition, costs: { hp: 0, mp: 0, uses: 1 } },
      };
      const self = {
        ...f.self,
        actor: { ...f.self.actor, abilities: [ability, ...f.abilities.slice(1)] },
      };
      expect(
        choosePolicy({ ...f.view, self, used: { 'choice-0': 1 } }, ready, false).abilityId,
      ).toBe('choice-1');
      expect(choosePolicy({ ...f.view, canAct: false }, ready, false).cognition!.selection).toBe(
        'wait',
      );
      const reverse = {
        ...f.view,
        self: {
          ...f.self,
          actor: {
            ...f.self.actor,
            abilities: [...f.self.actor.abilities].reverse(),
            policy: {
              ...f.self.actor.policy,
              priorities: [...f.self.actor.policy.priorities].reverse(),
            },
          },
        },
      };
      expect(canonicalJson(choosePolicy(reverse, ready, false))).toBe(
        canonicalJson(choosePolicy(f.view, ready, false)),
      );
      const unusableWater = {
        ...f.abilities[1]!,
        definition: {
          ...f.abilities[1]!.definition,
          target: 'enemy' as const,
          attack: { kind: 'hitscan' as const, radiusMm: 0 },
          rangeMm: 20000,
        },
      };
      expect(assessAbility(f.view, unusableWater).weight).toBe(0);
    } finally {
      f.world.free();
    }
  });
});
