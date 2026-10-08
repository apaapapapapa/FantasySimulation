import { z } from 'zod';
import { EnvironmentalHologramDisplaySchema, ResultSchema } from './records.ts';
import {
  BudgetSchema,
  MAX_BATTLE_STEPS,
  DEFAULT_BUDGET,
  HashSchema,
  IdSchema,
  ManifestSchema,
  ParticipantSchema,
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
// Additive HTTP input: persisted batch plans keep their explicitly seeded participants.
const UnseededParticipantSchema = ParticipantSchema.omit({ rngSeed: true, rngStream: true });
export const UnseededSpecInputSchema = SpecInputSchema.extend({
  participants: z.tuple([UnseededParticipantSchema, UnseededParticipantSchema]),
});
export const BattleInputSchema = z.union([SpecInputSchema, UnseededSpecInputSchema]);
export type BattleInput = z.infer<typeof BattleInputSchema>;
export const SpecSchema = z.strictObject({ simulationHash: HashSchema, manifest: ManifestSchema });
export type Spec = z.infer<typeof SpecSchema>;
export const JobRequestSchema = z
  .strictObject({
    spec: BattleInputSchema,
    budget: BudgetSchema.default(DEFAULT_BUDGET),
  })
  .superRefine(({ spec }, context) => {
    if (spec.participants.some((participant) => participant.skillLoadout !== undefined))
      context.addIssue({
        code: 'custom',
        path: ['spec', 'participants'],
        message: 'Skill loadouts require the dedicated skill battle endpoint',
      });
  });
export const MAX_STAGED_JOB_PAGE = 100;
export const StagedJobRequestSchema = z.strictObject({
  jobs: z
    // Preserve JobRequestSchema's dedicated-endpoint guard for every batch row.
    .array(JobRequestSchema.safeExtend({ key: IdSchema }))
    .min(1)
    .max(MAX_STAGED_JOB_PAGE),
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
const hologram = EnvironmentalHologramDisplaySchema.shape;
export const EnvironmentalHologramSensorProjectionSchema = z
  .strictObject({
    id: hologram.id,
    creatorId: hologram.creatorId,
    observerId: hologram.observerId,
    observerIds: hologram.observerIds,
    abilityId: hologram.abilityId,
    effectIndex: hologram.effectIndex,
    stageIndex: hologram.stageIndex,
    modality: hologram.modality,
    perceivedPosition: hologram.perceivedPosition,
    state: hologram.state,
    activatedAt: hologram.activatedAt,
    observedAt: hologram.observedAt,
    invalidatedAt: hologram.invalidatedAt,
    expiresAt: hologram.expiresAt,
  })
  .refine(
    (projection) =>
      projection.observerIds[0] === projection.observerId &&
      projection.activatedAt < projection.observedAt &&
      projection.observedAt < projection.invalidatedAt &&
      projection.invalidatedAt < projection.expiresAt,
    'Environmental hologram sensor projection lifecycle binding',
  );
export const ObserverSensorProjectionSchema = z
  .strictObject({
    observerId: IdSchema,
    environmentalHolograms: z.array(EnvironmentalHologramSensorProjectionSchema).max(8),
  })
  .refine(
    (view) =>
      view.environmentalHolograms.every(
        (hologram) =>
          hologram.observerId === view.observerId &&
          hologram.observerIds.length === 1 &&
          hologram.observerIds[0] === view.observerId,
      ),
    'Environmental hologram sensor projection observer binding',
  );
export const BattleSensorProjectionSchema = z
  .strictObject({
    replayId: IdSchema,
    step: z.number().int().min(0).max(MAX_BATTLE_STEPS),
    observers: z.array(ObserverSensorProjectionSchema).max(2),
  })
  .refine(
    (projection) =>
      new Set(projection.observers.map((observer) => observer.observerId)).size ===
      projection.observers.length,
    'Duplicate observer sensor projection',
  );
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
        sensorProjection: BattleSensorProjectionSchema.optional(),
      }),
    )
    .max(MAX_JOB_ATTEMPTS),
});
export const BattleResultResponseSchema = z.strictObject({
  id: IdSchema,
  result: ResultSchema,
  replayId: IdSchema,
});
