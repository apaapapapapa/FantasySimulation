import { expect, it } from 'vite-plus/test';
import production from '../../../../data/content/skill-summoning-rat-v1.json' with { type: 'json' };
import { AbilitySchema } from './contracts.ts';

it('accepts a bounded zero summon command cost and rejects invalid numbers', () => {
  const definition = structuredClone(production.definition);
  definition.summon.commandCostMp = 0;
  expect(AbilitySchema.parse(definition).summon?.commandCostMp).toBe(0);
  for (const invalid of [-1, 0.5, 1_000_001]) {
    const candidate = structuredClone(definition);
    candidate.summon.commandCostMp = invalid;
    expect(AbilitySchema.safeParse(candidate).success).toBe(false);
  }
  const paid = structuredClone(definition);
  paid.summon.commandCostMp = 1;
  expect(AbilitySchema.parse(paid).summon?.commandCostMp).toBe(1);
});
