import { z } from 'zod';
import {
  BudgetSchema,
  DEFAULT_BUDGET,
  HashSchema,
  IdSchema,
  ParticipantSchema,
  RefSchema,
  RevisionSchema,
} from './contracts.ts';

export const MAX_LEAGUE_SLOTS = 64_000;
export const LeagueWeightSchema = z.strictObject({
  numerator: z.string().regex(/^(0|[1-9]\d{0,11})$/),
  denominator: z.string().regex(/^[1-9]\d{0,11}$/),
});
export const LeagueFractionSchema = z.strictObject({
  // <=315 cells with total T<=64000: product(T)<204^315<10^728.
  // Five <=12-digit weights, 2*(N-1), and the 100-point scale need <793 digits.
  numerator: z.string().regex(/^(0|[1-9]\d{0,799})$/),
  denominator: z.string().regex(/^[1-9]\d{0,799}$/),
});
const SpawnSchema = ParticipantSchema.pick({ position: true, facing: true });
export const LeagueBattlefieldSchema = z.strictObject({
  scenario: RefSchema,
  weight: LeagueWeightSchema,
  starts: z.tuple([SpawnSchema, SpawnSchema]),
});
export const LeagueDefinitionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: IdSchema,
    name: z.string().min(1).max(120),
    characters: z.array(RefSchema).min(2).max(64),
    ruleset: RefSchema,
    battlefields: z.array(LeagueBattlefieldSchema).min(1).max(5),
    placements: z.tuple([z.literal('normal'), z.literal('swapped')]),
    trials: z.number().int().min(1).max(64),
    masterSeed: z.number().int().min(0).max(0xffff_ffff),
    seedDerivation: z.literal('league-trial-v1'),
    scoringVersion: z.literal('league-score-v1'),
    budget: BudgetSchema,
    retryBudget: BudgetSchema,
    revisions: z.array(RevisionSchema).min(4).max(4096),
  })
  .superRefine((value, ctx) => {
    const reject = (message: string) => ctx.addIssue({ code: 'custom', message });
    for (const refs of [value.characters, value.battlefields.map((field) => field.scenario)])
      if (new Set(refs.map((ref) => ref.id)).size !== refs.length)
        reject('Duplicate league character or scenario ID');
    let numerator = 0n,
      denominator = 1n;
    for (const { weight } of value.battlefields) {
      if (!LeagueWeightSchema.safeParse(weight).success) return;
      const n = BigInt(weight.numerator),
        d = BigInt(weight.denominator);
      numerator = numerator * d + n * denominator;
      denominator *= d;
    }
    if (numerator !== denominator) reject('League weights must sum to exactly one');
    if (leagueSlotCount(value) > MAX_LEAGUE_SLOTS) reject('League exceeds planned slot limit');
    const initialBudget = { ...DEFAULT_BUDGET, ...value.budget };
    const retryBudget = { ...DEFAULT_BUDGET, ...value.retryBudget };
    for (const key of Object.keys(initialBudget) as (keyof typeof initialBudget)[]) {
      const initial = initialBudget[key];
      if (initial !== undefined && (retryBudget[key] ?? 0) < initial)
        reject(`Retry budget must preserve or increase ${key}`);
    }
  });
export type LeagueDefinition = z.infer<typeof LeagueDefinitionSchema>;
export function leagueSlotCount(
  definition: Pick<LeagueDefinition, 'characters' | 'battlefields' | 'placements' | 'trials'>,
) {
  const n = definition.characters.length;
  return (
    ((n * (n - 1)) / 2) *
    definition.battlefields.filter((field) => BigInt(field.weight.numerator) > 0n).length *
    definition.placements.length *
    definition.trials
  );
}
export const LeagueRevisionBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  definition: LeagueDefinitionSchema,
  engineVersion: IdSchema,
  implementationDigest: HashSchema,
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  inputHash: HashSchema,
});
export const LeagueRevisionSchema = LeagueRevisionBodySchema.extend({ leagueHash: HashSchema });
export type LeagueRevision = z.infer<typeof LeagueRevisionSchema>;
export const LeagueSlotSchema = z.strictObject({
  id: HashSchema,
  characters: z.tuple([RefSchema, RefSchema]),
  scenario: RefSchema,
  placement: z.enum(['normal', 'swapped']),
  trial: z.number().int().min(0).max(63),
  seed: z.number().int().min(0).max(0xffff_ffff),
  simulationHash: HashSchema,
});
export type LeagueSlot = z.infer<typeof LeagueSlotSchema>;
