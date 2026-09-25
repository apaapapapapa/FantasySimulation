import { expect, it } from 'vite-plus/test';
import { BudgetSchema, PhysicsProfileSchema } from './contracts.ts';
import { DefinitionKindSchema, RetryJobSchema } from './api.ts';
import { ArtifactRefSchema } from './replay.ts';
import { BatchInputSchema } from './batch.ts';

it('preserves the published limit values and rejects the next integer', () => {
  for (const [schema, maximum] of [
    [BudgetSchema.shape.maxFrameBytes, 4_000_000],
    [PhysicsProfileSchema.shape.maxSteps, 6000],
    [RetryJobSchema.shape.expectedAttempts, 3],
    [ArtifactRefSchema.shape.rawBytes, 4_000_001],
    [BatchInputSchema.shape.estimatedBytesPerMatch, 20_971_520],
  ] as const) {
    expect(schema.safeParse(maximum).success).toBe(true);
    expect(schema.safeParse(maximum + 1).success).toBe(false);
  }
});

it('retains all saved definition kinds and their public enumeration order', () => {
  expect(DefinitionKindSchema.options).toEqual([
    'character',
    'ability',
    'equipment',
    'policy',
    'status',
    'ruleset',
    'scenario',
  ]);
  expect(DefinitionKindSchema.safeParse('unknown').success).toBe(false);
});
