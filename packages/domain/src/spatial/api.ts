import { z } from 'zod';
import { ResultSchema } from './records.ts';
import {
  BudgetSchema,
  MAX_BATTLE_STEPS,
  DEFAULT_BUDGET,
  HashSchema,
  IdSchema,
  ManifestSchema,
  RefSchema,
  RevisionSchema,
} from './contracts.ts';
export const DEFINITION_KINDS = [
  RevisionSchema.options[0].shape.kind.value,
  ...RevisionSchema.options.slice(1).map((schema) => schema.shape.kind.value),
] as const;
export const DefinitionKindSchema = z.enum(DEFINITION_KINDS);
export const ARTIFACT_RESERVATION_BYTES = 20 * 1024 ** 2;
export const MAX_JOB_ATTEMPTS = 3;
const version = z.number().int().min(1).max(2147483647);
export const DraftInputSchema = z.strictObject({
  kind: DefinitionKindSchema,
  definitionId: IdSchema,
  base: RefSchema.nullable(),
  definition: z.unknown(),
});
export const DraftPatchSchema = z.strictObject({
  expectedVersion: version,
  definition: z.unknown(),
});
export const ExpectedVersionSchema = z.strictObject({ expectedVersion: version });
export const DraftSchema = DraftInputSchema.extend({
  id: IdSchema,
  version,
  published: RefSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Draft = z.infer<typeof DraftSchema>;
export type DraftInput = z.infer<typeof DraftInputSchema>;
export const ExecutionEligibilitySchema = z.discriminatedUnion('executable', [
  z.strictObject({ executable: z.literal(true) }),
  z.strictObject({
    executable: z.literal(false),
    code: z.string().min(1).max(80),
    reason: z.string().max(1000),
  }),
]);
export const RevisionPageSchema = z.strictObject({
  items: z.array(RevisionSchema).max(100),
  nextCursor: IdSchema.nullable(),
  execution: z
    .array(z.strictObject({ revision: RefSchema, eligibility: ExecutionEligibilitySchema }))
    .max(100)
    .optional(),
});
export const ValidationSchema = z.strictObject({
  valid: z.boolean(),
  issues: z.array(z.string().max(1000)).max(32),
});
export const PublishResponseSchema = z.strictObject({
  draft: DraftSchema,
  revision: RevisionSchema,
});
export const SpecInputSchema = z.strictObject({
  seed: ManifestSchema.shape.seed,
  participants: ManifestSchema.shape.participants,
  ruleset: ManifestSchema.shape.ruleset,
  scenario: ManifestSchema.shape.scenario,
});
export type SpecInput = z.infer<typeof SpecInputSchema>;
export const SpecSchema = z.strictObject({ simulationHash: HashSchema, manifest: ManifestSchema });
export type Spec = z.infer<typeof SpecSchema>;
export const JobRequestSchema = z.strictObject({
  spec: SpecInputSchema,
  budget: BudgetSchema.default(DEFAULT_BUDGET),
});
export const RetryJobSchema = z.strictObject({
  expectedAttempts: z.number().int().min(0).max(MAX_JOB_ATTEMPTS),
  budget: BudgetSchema,
});

// The public projection used by clients; persistence-only columns are intentionally ignored.
export const JobViewSchema = z.object({
  id: IdSchema,
  simulationHash: HashSchema,
  state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  attempts: z.number().int().min(0).max(MAX_JOB_ATTEMPTS),
  maxAttempts: z.number().int().min(1).max(MAX_JOB_ATTEMPTS),
  resultId: IdSchema.nullable(),
  error: z.string().max(10000).nullable(),
  allowedOperations: z.strictObject({ cancel: z.boolean(), retry: z.boolean() }).optional(),
});
export const JobResponseSchema = z.object({ job: JobViewSchema });
export const JobStatusSchema = JobResponseSchema.extend({
  attempts: z
    .array(
      z.object({
        id: IdSchema,
        number: z.number().int().min(1).max(MAX_JOB_ATTEMPTS),
        state: z.enum(['running', 'completed', 'failed', 'cancelled', 'expired', 'conflict']),
        progressStep: z.number().int().min(0).max(MAX_BATTLE_STEPS),
        replayId: IdSchema.nullable(),
        error: z.string().max(10000).nullable(),
      }),
    )
    .max(MAX_JOB_ATTEMPTS),
});
export const BattleResultResponseSchema = z.strictObject({
  id: IdSchema,
  result: ResultSchema,
  replayId: IdSchema,
});
