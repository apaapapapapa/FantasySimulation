import { beforeAll, expect, it } from 'vite-plus/test';
import { AI_RULES, ExperienceSchema } from '@fantasy/domain/spatial';
import { aiFixture } from '../../test-support/ai.ts';
import { initializePhysics } from './physics.ts';
import { observeImpact, rememberExperience, perceive } from './perception.ts';
import { efficacy } from './assessment.ts';

beforeAll(initializePhysics);
it('delivers four relative bands with exact boundaries and no finer damage interval', async () => {
  const f = await aiFixture();
  try {
    const rules = {
      ...AI_RULES,
      relativeImpactBps: [2500, 7500, 12500] as [number, number, number],
    };
    const detail = {
      ability: f.abilities[0]!,
      eventId: 'relative-hit',
      element: 'fire' as const,
      basePower: 100,
      impact: 0,
      shield: false,
      partial: false,
    };
    const samples = [0, 24, 25, 74, 75, 124, 125, 300].map((impact) =>
      observeImpact(f.world, f.self, f.enemy, { ...detail, impact }, 10, rules)!,
    );
    expect(samples.map((s) => s.impactBand)).toEqual([
      'minimal',
      'minimal',
      'weak',
      'weak',
      'normal',
      'normal',
      'strong',
      'strong',
    ]);
    for (const sample of samples) {
      expect(sample.range).toBeNull();
      expect(ExperienceSchema.safeParse(sample).success).toBe(true);
    }
    for (const defense of [{ shield: true }, { partial: true }]) {
      const sample = observeImpact(f.world, f.self, f.enemy, { ...detail, ...defense }, 10, rules)!;
      expect(sample.impactBand).toBeUndefined();
      expect(sample.range).toBeNull();
    }
    const pending = rememberExperience(f.view.memory, samples[4]!);
    expect(
      perceive(f.world, f.self, f.enemy, [], 14, pending, undefined, 'surveyed', rules).learned,
    ).toEqual([]);
    expect(
      perceive(f.world, f.self, f.enemy, [], 15, pending, undefined, 'surveyed', rules).learned,
    ).toHaveLength(1);
    const view = {
      ...f.view,
      step: 15,
      rules,
      memory: { ...f.view.memory, knowledge: [samples[4]!] },
    };
    expect(efficacy(view, 'fire', 100).bps).toBe(10000);
    expect(
      efficacy({ ...view, memory: { ...view.memory, knowledge: [samples[2]!] } }, 'fire', 100).bps,
    ).toBe(5000);
    const hidden = { ...f.enemy, position: { x: -10, y: 1, z: 0 } };
    expect(observeImpact(f.world, f.self, hidden, detail, 10, rules)).toBeNull();
  } finally {
    f.world.free();
  }
});
