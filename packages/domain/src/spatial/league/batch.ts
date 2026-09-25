import { z } from 'zod';
import { HashSchema, IdSchema } from '../contracts.ts';
import { BatchIndexSchema, ExecutionSourceSchema } from '../batch.ts';
import { LeagueRevisionSchema, LeagueSlotSchema } from '../league.ts';

export const LeaguePartitionBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  leagueHash: HashSchema,
  index: z.number().int().min(0).max(511),
  batchPlanId: HashSchema,
  slots: z.array(LeagueSlotSchema).min(1).max(1000),
});
export const LeaguePartitionSchema = LeaguePartitionBodySchema.extend({ id: HashSchema });
export type LeaguePartition = z.infer<typeof LeaguePartitionSchema>;
export const LeaguePlanBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: LeagueRevisionSchema,
  source: ExecutionSourceSchema,
  partitions: z
    .array(
      z.strictObject({
        partitionId: HashSchema,
        batchPlanId: HashSchema,
        slots: z.number().int().min(1).max(1000),
      }),
    )
    .min(1)
    .max(512),
});
export const LeaguePlanSchema = LeaguePlanBodySchema.extend({ id: HashSchema });
export type LeaguePlan = z.infer<typeof LeaguePlanSchema>;

export const LeagueProgressAttemptSchema = z
  .strictObject({
    attempt: z.union([z.literal(1), z.literal(2)]),
    executionId: IdSchema,
    state: z.enum(['reserved', 'win', 'draw', 'failed', 'unresolved', 'truncated', 'cancelled']),
    objectHash: HashSchema.nullable(),
  })
  .refine(
    (value) =>
      ['win', 'draw', 'unresolved', 'truncated'].includes(value.state) ===
      (value.objectHash !== null),
    'Attempt state and receipt disagree',
  );
export const LeagueProgressSchema = z
  .strictObject({
    simulationHash: HashSchema,
    attempts: z.array(LeagueProgressAttemptSchema).max(2),
  })
  .superRefine((record, ctx) => {
    if (
      record.attempts.some(
        (a, i) =>
          a.attempt !== i + 1 || (i > 0 && ['win', 'draw'].includes(record.attempts[i - 1]!.state)),
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Attempt history must be consecutive and stop after a definitive result',
      });
  });
export type LeagueProgress = z.infer<typeof LeagueProgressSchema>;
export const LeagueProgressPageBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  records: z.array(LeagueProgressSchema).max(1000),
});
export const LeagueProgressPageSchema = LeagueProgressPageBodySchema.extend({ id: HashSchema });
export type LeagueProgressPage = z.infer<typeof LeagueProgressPageSchema>;
export const LeagueReservationBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: HashSchema,
  partitionId: HashSchema,
  executionId: IdSchema,
  progress: LeagueProgressPageSchema,
});
export const LeagueReservationSchema = LeagueReservationBodySchema.extend({ id: HashSchema });
export type LeagueReservation = z.infer<typeof LeagueReservationSchema>;
export const LeaguePartitionResultBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  reservationId: HashSchema,
  index: BatchIndexSchema,
  progress: LeagueProgressPageSchema,
  elapsedMs: z.number().int().min(0).max(3600000),
});
export const LeaguePartitionResultSchema = LeaguePartitionResultBodySchema.extend({
  id: HashSchema,
});
export type LeaguePartitionResult = z.infer<typeof LeaguePartitionResultSchema>;

export const LeagueEstimateInputSchema = z.strictObject({
  matchesPerPlan: z.number().int().min(1).max(1000),
  estimatedMsPerMatch: z.number().int().min(1).max(1800000),
  estimatedBytesPerMatch: z.number().int().min(1).max(40000000),
  estimatedFilesPerMatch: z.number().int().min(2).max(10000),
  retainedBytes: z.number().int().min(0).max(8000000000),
  retainedFiles: z.number().int().min(0).max(100000),
  maxReadRequests: z.number().int().min(1).max(10000000),
  maxWriteRequests: z.number().int().min(1).max(1000000),
  usedReadRequests: z.number().int().min(0).max(10000000),
  usedWriteRequests: z.number().int().min(0).max(1000000),
});
export type LeagueEstimateInput = z.infer<typeof LeagueEstimateInputSchema>;
