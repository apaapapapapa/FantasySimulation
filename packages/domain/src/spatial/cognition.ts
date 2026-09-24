import { z } from 'zod';
import {
  AppearanceSchema,
  DamageDefenseSchema,
  ElementSchema,
  IdSchema,
  RefSchema,
  Vec3Schema,
  StatusCategorySchema,
  AdjustmentTargetSchema,
  AbilityCategorySchema,
  ObservedPhaseSchema,
  ObservedStageSchema,
  ObservedReactionSchema,
  ReactionPointSchema,
  PostureSchema,
} from './contracts.ts';

const tick = z.number().int().min(0).max(8000),
  bps = z.number().int().min(0).max(10000);
const quantity = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const ObservedStatusSchema = z.strictObject({
  id: IdSchema,
  categories: z.array(StatusCategorySchema).max(8),
  benefit: z.enum(['beneficial', 'harmful', 'neutral']),
  removable: z.boolean(),
  adjustments: z
    .array(
      z.strictObject({
        target: AdjustmentTargetSchema,
        direction: z.enum(['higher', 'lower']),
        element: ElementSchema.optional(),
        category: AbilityCategorySchema.optional(),
      }),
    )
    .max(32)
    .optional(),
  reactions: z
    .array(
      z.strictObject({
        element: ElementSchema,
        response: z.enum(['none', 'remove', 'strengthen', 'transform']),
        damage: z.enum(['normal', 'higher', 'lower']),
      }),
    )
    .max(16),
});
export type ObservedStatus = z.infer<typeof ObservedStatusSchema>;
const ObservedStatusesSchema = z.array(ObservedStatusSchema).max(64);
export const ObservedSurfaceSchema = z.strictObject({
  pointMm: Vec3Schema,
  normalBps: Vec3Schema,
  sampledAt: tick,
  availableAt: tick,
});
export type ObservedSurface = z.infer<typeof ObservedSurfaceSchema>;
export const EstimateRangeSchema = z
  .strictObject({ low: quantity, high: quantity })
  .refine((v) => v.low <= v.high);
export const ExperienceSchema = z
  .strictObject({
    eventId: IdSchema,
    targetId: IdSchema,
    ability: RefSchema,
    element: ElementSchema,
    defense: DamageDefenseSchema.optional(),
    kind: z.enum(['impact', 'shield', 'uncertain', 'reveal']),
    sampledAt: tick,
    availableAt: tick,
    expiresAt: tick,
    basePower: quantity,
    distanceBand: z.number().int().min(0).max(200),
    range: EstimateRangeSchema.nullable(),
    impactBand: z.enum(['minimal', 'weak', 'normal', 'strong']).optional(),
    confidenceBps: bps,
    observedStatuses: ObservedStatusesSchema.optional(),
  })
  .superRefine((e, ctx) => {
    if (e.availableAt < e.sampledAt || e.expiresAt < e.sampledAt)
      ctx.addIssue({ code: 'custom', message: 'Experience time precedes observation' });
    if ((e.kind === 'impact' || e.kind === 'reveal') !== (!!e.range || !!e.impactBand))
      ctx.addIssue({ code: 'custom', message: 'Only measured impact/reveal carries a range' });
    if (e.impactBand && (e.kind !== 'impact' || e.range !== null))
      ctx.addIssue({ code: 'custom', message: 'Relative impact carries only a band' });
    if (e.kind === 'reveal' && (e.basePower !== 0 || (e.range?.high ?? 0) > 10000))
      ctx.addIssue({ code: 'custom', message: 'Reveal is a bounded field, not damage' });
  });
export type Experience = z.infer<typeof ExperienceSchema>;
export const CandidateAssessmentSchema = z.strictObject({
  key: z.string().min(1).max(100),
  kind: z.enum(['ability', 'dodge', 'move', 'wait']),
  abilityId: IdSchema.nullable(),
  weight: z.number().int().min(0).max(1_000_000),
  weightBeforeCutoff: z.number().int().min(0).max(1_000_000).optional(),
  totalWeight: z.number().int().min(1).max(40_000_000),
  successBps: bps,
  killBps: bps,
  survivalBps: bps,
  efficacyBps: z.number().int().min(0).max(30000),
  confidenceBps: bps,
  durationSteps: tick,
  costBps: bps,
  exploration: quantity,
  evidence: z.array(IdSchema).max(32),
  reason: z.string().max(300),
  reapplication: z
    .array(
      z.strictObject({
        statusId: IdSchema,
        intervalSteps: quantity,
        effectiveSteps: quantity,
        basis: z.enum(['self-application', 'visible-element']),
        evidence: z.array(IdSchema).max(32),
      }),
    )
    .max(64)
    .optional(),
});
export type CandidateAssessment = z.infer<typeof CandidateAssessmentSchema>;
export const ReactionEstimateSchema = z.strictObject({
  abilityId: IdSchema,
  point: ReactionPointSchema,
  response: z.enum(['parry', 'effects', 'counter']),
  readyAt: quantity,
  remainingUses: quantity.nullable(),
  eligible: z.boolean(),
  reason: z.string().max(100),
  assessment: CandidateAssessmentSchema,
});
export type ReactionEstimate = z.infer<typeof ReactionEstimateSchema>;
const RandomDrawSchema = z.strictObject({
  purpose: z.enum(['action', 'dodge', 'movement', 'search', 'cover']),
  before: quantity,
  after: quantity,
  draws: z.number().int().min(0).max(128),
  selection: z.string().max(100),
});
// PRNG states span uint32 independently of the wider exact integer quantities.
const DrawSchema = RandomDrawSchema.extend({
  before: z.number().int().min(0).max(0xffffffff),
  after: z.number().int().min(0).max(0xffffffff),
});
export const CognitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('knowledge'),
    perspective: z.literal('subjective'),
    learned: z.array(ExperienceSchema).max(32),
    expired: z.array(IdSchema).max(32),
    statusObservation: z
      .strictObject({
        targetId: IdSchema,
        sampledAt: tick,
        availableAt: tick,
        statuses: ObservedStatusesSchema,
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('decision'),
    cover: z
      .strictObject({
        goalMm: Vec3Schema.optional(),
        posture: PostureSchema.optional(),
        candidates: z
          .array(
            z.strictObject({
              key: z.string().max(100),
              weight: quantity,
              weightBeforeCutoff: quantity.optional(),
            }),
          )
          .max(25),
        draw: DrawSchema,
      })
      .optional(),
    search: z
      .strictObject({
        forced: z.boolean(),
        waitSteps: tick,
        selection: z.string().max(100),
        checkedAt: z.array(tick.nullable()).max(25),
        goalMm: Vec3Schema.nullable().optional(),
        cues: z
          .array(
            z.strictObject({
              id: IdSchema,
              sampledAt: tick,
              availableAt: tick,
              originMm: Vec3Schema,
              directionBps: Vec3Schema,
            }),
          )
          .max(8)
          .optional(),
        candidates: z
          .array(
            z.strictObject({
              key: z.string().max(100),
              weight: quantity,
              weightBeforeCutoff: quantity.optional(),
            }),
          )
          .max(25),
        draw: DrawSchema.optional(),
      })
      .optional(),
    locomotion: z
      .strictObject({
        gait: z.enum(['walk', 'run', 'slow']),
        stamina: quantity,
        exhausted: z.boolean(),
        reserveStamina: quantity,
      })
      .optional(),
    perspective: z.literal('subjective'),
    sampledAt: tick.nullable(),
    availableAt: tick.nullable(),
    targetId: IdSchema.nullable(),
    targetObservedAt: tick.nullable(),
    targetAvailableAt: tick.nullable(),
    appearance: AppearanceSchema.nullable(),
    wounds: z.enum(['unknown', 'unhurt', 'hurt', 'severe', 'critical']),
    observedStatuses: ObservedStatusesSchema.optional(),
    conditionObservation: z
      .strictObject({
        phase: ObservedPhaseSchema.nullable(),
        facingBps: Vec3Schema,
      })
      .optional(),
    targetPositionMm: Vec3Schema.nullable(),
    observedProjectiles: z.array(IdSchema).max(32),
    terrain: z.array(ObservedSurfaceSchema).max(64),
    candidates: z.array(CandidateAssessmentSchema).max(35),
    excluded: z
      .array(z.strictObject({ abilityId: IdSchema, reason: z.string().max(100) }))
      .max(160),
    selection: z.string().max(100),
    movementSlot: z
      .strictObject({
        selection: z.enum(['dodge', 'move', 'wait']),
        candidates: z.array(CandidateAssessmentSchema).max(2),
        excluded: z.array(z.string().max(100)).max(4),
        draw: DrawSchema,
      })
      .optional(),
    observedStage: ObservedStageSchema.optional(),
    observedReaction: ObservedReactionSchema.optional(),
    observedPosture: PostureSchema.optional(),
    reactions: z.array(ReactionEstimateSchema).max(160).optional(),
    reactionReserve: z.strictObject({ hp: quantity, mp: quantity, stamina: quantity }).optional(),
    method: z.enum(['sole', 'weighted', 'exploration', 'equal', 'none']),
    draws: z.array(DrawSchema).max(2),
    directions: z
      .array(
        z.strictObject({
          key: z.enum(['up', 'down', 'left', 'right']),
          weight: quantity,
          weightBeforeCutoff: z.number().int().min(0).max(1_000_000).optional(),
          reason: z.string().max(100),
        }),
      )
      .max(4),
  }),
]);
export type Cognition = z.infer<typeof CognitionSchema>;
