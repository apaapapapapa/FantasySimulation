import { beforeAll, expect, it } from 'vite-plus/test';
import { aiFixture, withEvaluation } from '../../test-support/ai.ts';
import { initializePhysics } from './physics.ts';
import { choosePolicy } from './policy.ts';
import { TACTICAL_AI } from './tactical-samples.ts';

beforeAll(initializePhysics);
it('preserves neutral defaults and changes distributions using only the authored preference', async () => {
  const f = await aiFixture();
  try {
    const ready = new Set(f.abilities.map((a) => a.id));
    const distribution = (edit: Partial<NonNullable<typeof f.self.actor.policy.evaluation>>) => {
      const view = withEvaluation(f.view, edit);
      return choosePolicy(view, ready, false).cognition!.candidates.sort((a, b) =>
        a.abilityId!.localeCompare(b.abilityId!),
      );
    };
    const neutral = distribution({});
    expect(
      distribution({
        riskToleranceBps: 10000,
        resourceConservationBps: 10000,
        searchAggressionBps: 5000,
      }),
    ).toEqual(neutral);
    expect(neutral.map((c) => c.weight)).toEqual([81, 659]);
    const tactical = choosePolicy({ ...f.view, rules: TACTICAL_AI }, ready, false).cognition!
      .candidates;
    expect(tactical.find((c) => c.abilityId === 'choice-0')?.weight).toBe(81);
    expect(tactical.find((c) => c.abilityId === 'choice-1')?.totalWeight).toBe(740);
    const probability = (edit: Parameters<typeof distribution>[0]) => {
      const c = distribution(edit);
      return c[0]!.weight / c[0]!.totalWeight;
    };
    expect(probability({ attackBps: 20000 })).toBeGreaterThan(probability({}));
    expect(probability({ survivalBps: 20000 })).toBeLessThan(probability({}));
    expect(probability({ resourceConservationBps: 30000 })).toBeGreaterThan(probability({}));
    expect(probability({ explorationBps: 30000 })).toBeGreaterThan(probability({}));
    f.view.memory = {
      ...f.view.memory,
      observation: {
        ...f.view.memory.observation!,
        enemy: { ...f.view.memory.observation!.enemy!, action: 'active' },
      },
    };
    expect(distribution({ riskToleranceBps: 0 })[0]!.weight).toBeLessThan(
      distribution({ riskToleranceBps: 20000 })[0]!.weight,
    );
  } finally {
    f.world.free();
  }
});
