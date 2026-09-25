import { z } from 'zod';
import { HashSchema, IdSchema } from './contracts.ts';
import { LeagueFractionSchema, LeagueWeightSchema, MAX_LEAGUE_SLOTS } from './league.ts';

const count = z.number().int().min(0).max(MAX_LEAGUE_SLOTS);
export const LeagueCellSchema = z
  .strictObject({
    characters: z.tuple([IdSchema, IdSchema]),
    scenario: IdSchema,
    planned: count.min(1),
    wins: z.tuple([count, count]),
    draws: count,
  })
  .refine(
    (cell) => cell.wins[0] + cell.wins[1] + cell.draws <= cell.planned,
    'Results exceed planned slots',
  );
export type LeagueCell = z.infer<typeof LeagueCellSchema>;
export const LeagueScoreInputSchema = z.strictObject({
  characters: z.array(IdSchema).min(2).max(64),
  battlefields: z
    .array(z.strictObject({ scenario: IdSchema, weight: LeagueWeightSchema }))
    .min(1)
    .max(5),
  cells: z.array(LeagueCellSchema).min(1).max(10_080),
});
export type LeagueScoreInput = z.infer<typeof LeagueScoreInputSchema>;
export const LeagueAttemptSchema = z.strictObject({
  slotId: HashSchema,
  simulationHash: HashSchema,
  attempt: z.union([z.literal(1), z.literal(2)]),
  outcome: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('win'), winner: IdSchema, resultHash: HashSchema }),
    z.strictObject({ kind: z.literal('draw'), resultHash: HashSchema }),
    z.strictObject({ kind: z.enum(['unresolved', 'truncated', 'failed', 'cancelled']) }),
  ]),
});
export type LeagueAttempt = z.infer<typeof LeagueAttemptSchema>;
const CountsSchema = z.strictObject({
  planned: count,
  wins: count,
  draws: count,
  losses: count,
  unresolved: count,
});
export const LeagueScoreSchema = z.strictObject({
  lower: LeagueFractionSchema,
  upper: LeagueFractionSchema,
  completion: LeagueFractionSchema,
  winRate: LeagueFractionSchema,
  drawRate: LeagueFractionSchema,
  lossRate: LeagueFractionSchema,
  rateDenominator: z.literal('planned-slots'),
  counts: CountsSchema,
});
export type LeagueScore = z.infer<typeof LeagueScoreSchema>;
export const LeagueStandingSchema = z.strictObject({
  character: IdSchema,
  rank: z.number().int().min(1).max(64).nullable(),
  displayOrder: z.number().int().min(1).max(64),
  overall: LeagueScoreSchema,
  scenarios: z.array(z.strictObject({ scenario: IdSchema, score: LeagueScoreSchema })).max(5),
  opponents: z.array(z.strictObject({ character: IdSchema, score: LeagueScoreSchema })).max(63),
});
export const LeagueStandingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scoringVersion: z.literal('league-score-v1'),
  status: z.enum(['formal', 'provisional']),
  order: z.literal('lower-score-then-id'),
  planned: count.min(1),
  resolved: count,
  completion: LeagueFractionSchema,
  rows: z.array(LeagueStandingSchema).min(2).max(64),
});
export type LeagueStandings = z.infer<typeof LeagueStandingsSchema>;
