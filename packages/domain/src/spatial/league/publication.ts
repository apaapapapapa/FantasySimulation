import { z } from 'zod';
import { HashSchema, IdSchema, RefSchema } from '../contracts.ts';
import { LeagueRevisionSchema, LeagueSlotSchema, LeagueWeightSchema } from '../league.ts';
import { LeagueStandingSchema, LeagueStandingsSchema } from '../league-results.ts';

export const LeagueFileRefSchema = z.strictObject({
  hash: HashSchema,
  bytes: z.number().int().min(1).max(4_000_000),
});
export type LeagueFileRef = z.infer<typeof LeagueFileRefSchema>;
const pageRef = LeagueFileRefSchema.extend({ rows: z.number().int().min(1).max(100) });
const named = RefSchema.extend({ name: z.string().min(1).max(120) });
export const PublicLeagueSlotPageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  leagueHash: HashSchema,
  characters: z.tuple([IdSchema, IdSchema]),
  index: z.number().int().min(0).max(639),
  rows: z
    .array(
      z.strictObject({
        slot: LeagueSlotSchema,
        setHash: HashSchema,
        pageHash: HashSchema,
        rowId: HashSchema,
      }),
    )
    .min(1)
    .max(100),
});
export type PublicLeagueSlotPage = z.infer<typeof PublicLeagueSlotPageSchema>;
export const PublicLeagueDetailSchema = z.strictObject({
  schemaVersion: z.literal(1),
  leagueHash: HashSchema,
  standing: LeagueStandingSchema,
  opponents: z
    .array(
      z.strictObject({
        character: IdSchema,
        pages: z.array(pageRef).min(1).max(7),
      }),
    )
    .min(1)
    .max(63),
});
export type PublicLeagueDetail = z.infer<typeof PublicLeagueDetailSchema>;
export const PublicLeagueSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  leagueHash: HashSchema,
  inputHash: HashSchema,
  id: IdSchema,
  name: z.string().min(1).max(120),
  sourceSha: LeagueRevisionSchema.shape.sourceSha,
  engineVersion: IdSchema,
  implementationDigest: HashSchema,
  trials: z.number().int().min(1).max(64),
  masterSeed: z.number().int().min(0).max(0xffff_ffff),
  definition: LeagueFileRefSchema,
  characters: z.array(named).min(2).max(64),
  battlefields: z
    .array(z.strictObject({ scenario: named, weight: LeagueWeightSchema }))
    .min(1)
    .max(5),
  standings: LeagueStandingsSchema.omit({ rows: true }).extend({
    rows: z
      .array(
        LeagueStandingSchema.omit({ scenarios: true, opponents: true }).extend({
          detail: LeagueFileRefSchema,
        }),
      )
      .min(2)
      .max(64),
  }),
});
export type PublicLeagueSnapshot = z.infer<typeof PublicLeagueSnapshotSchema>;
export const PublicLeagueCatalogRefSchema = LeagueFileRefSchema.extend({
  id: IdSchema,
  leagueHash: HashSchema,
  inputHash: HashSchema,
});

/** Durable admission journal; a reservation survives an absent/crashed worker. */
export const PublicLeagueWorkSchema = z.strictObject({
  schemaVersion: z.literal(1),
  executionId: IdSchema,
  sourceSha: LeagueRevisionSchema.shape.sourceSha,
  inputHash: HashSchema,
  planId: HashSchema,
  previousWork: LeagueFileRefSchema.nullable(),
  progress: z
    .array(LeagueFileRefSchema.extend({ records: z.number().int().min(1).max(1000) }))
    .max(64),
  reservations: z
    .array(LeagueFileRefSchema.extend({ partitionId: HashSchema }))
    .min(1)
    .max(512),
});
export type PublicLeagueWork = z.infer<typeof PublicLeagueWorkSchema>;
