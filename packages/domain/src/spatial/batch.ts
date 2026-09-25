import { z } from 'zod';
import {
  BudgetSchema,
  HashSchema,
  IdSchema,
  RevisionSchema,
  StoredManifestSchema,
} from './contracts.ts';
import { SpecInputSchema, ARTIFACT_RESERVATION_BYTES } from './api.ts';
import { ResultSchema } from './records.ts';

export const ExecutionSourceSchema = z.strictObject({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  node: z.string().max(40),
  platform: z.enum(['linux', 'win32']),
  arch: z.literal('x64'),
});
export const BatchInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revisions: z.array(RevisionSchema).min(4).max(4096),
  matches: z
    .array(z.strictObject({ key: IdSchema, spec: SpecInputSchema }))
    .min(1)
    .max(1000),
  budget: BudgetSchema,
  estimatedBytesPerMatch: z.number().int().min(1).max(ARTIFACT_RESERVATION_BYTES),
  maxOutputBytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1024 ** 3),
  maxWorkBytes: z
    .number()
    .int()
    .min(2 * ARTIFACT_RESERVATION_BYTES)
    .max(16 * 1024 ** 3),
});
export const PlannedMatchSchema = z.strictObject({
  id: HashSchema,
  key: IdSchema,
  simulationHash: HashSchema,
  spec: SpecInputSchema,
});
export const BatchPlanBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: ExecutionSourceSchema,
  engineVersion: StoredManifestSchema.shape.engineVersion,
  implementationDigest: HashSchema,
  revisions: BatchInputSchema.shape.revisions,
  slots: z.array(PlannedMatchSchema).min(1).max(1000),
  budget: BudgetSchema,
  estimatedBytesPerMatch: BatchInputSchema.shape.estimatedBytesPerMatch,
  maxOutputBytes: BatchInputSchema.shape.maxOutputBytes,
  maxWorkBytes: BatchInputSchema.shape.maxWorkBytes,
});
export const BatchPlanSchema = BatchPlanBodySchema.extend({ id: HashSchema });
export type BatchPlan = z.infer<typeof BatchPlanSchema>;
export type ExecutionSource = z.infer<typeof ExecutionSourceSchema>;
export const BundleReceiptBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: ExecutionSourceSchema,
  simulationHash: HashSchema,
  resultId: IdSchema,
  attemptId: IdSchema,
  replayId: IdSchema,
  resultHash: HashSchema,
  manifestChecksum: HashSchema,
  bytes: z.number().int().positive().max(ARTIFACT_RESERVATION_BYTES),
  result: ResultSchema,
});
export const BundleReceiptSchema = BundleReceiptBodySchema.extend({ objectHash: HashSchema });
export type BundleReceipt = z.infer<typeof BundleReceiptSchema>;
export const BatchSlotResultSchema = z.strictObject({
  slotId: HashSchema,
  simulationHash: HashSchema,
  state: z.enum(['complete', 'failed', 'unresolved', 'truncated', 'pending']),
  receipt: BundleReceiptSchema.nullable(),
  reused: z.boolean(),
  reason: z.string().max(1000),
});
export const BatchIndexBodySchema = z.strictObject({
  schemaVersion: z.literal(1),
  planId: HashSchema,
  source: ExecutionSourceSchema,
  shardIndex: z.number().int().min(0).max(63),
  shardCount: z.number().int().min(1).max(64),
  slots: z.array(BatchSlotResultSchema).max(1000),
  complete: z.boolean(),
});
export const BatchIndexSchema = BatchIndexBodySchema.extend({ id: HashSchema });
export type BatchIndex = z.infer<typeof BatchIndexSchema>;
