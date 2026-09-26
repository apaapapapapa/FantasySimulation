import { MAX_BATTLE_STEPS } from './contracts.ts';
import { SpatialShapeSchema, SpatialSelectorsSchema } from './spatial-operations.ts';
import { z } from 'zod';
import { IdSchema, RefSchema, StageContactSchema, PostureSchema, BodySchema } from './contracts.ts';
import {
  EventSchema,
  OutcomeSchema,
  PhysicalVectorSchema,
  ResourceStateSchema,
  ForceContributionSchema,
  MotionProjectionSchema,
  ReactionContextSchema,
} from './records.ts';
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const step = z.number().int().min(0).max(MAX_BATTLE_STEPS);
const fraction = z.number().min(0).max(1);
export const SegmentSchema = z
  .strictObject({
    start: PhysicalVectorSchema,
    end: PhysicalVectorSchema,
    from: fraction,
    to: fraction,
  })
  .refine((p) => p.from <= p.to, 'Reversed segment');
export const AttackGeometrySchema = z.union([
  z.strictObject({
    kind: z.enum(['sphere', 'ray']),
    radiusMm: z.number().int().min(0).max(5000),
    segments: z.array(SegmentSchema).min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal('blade'),
    radiusMm: z.number().int().min(1).max(5000),
    poses: z
      .array(z.strictObject({ fraction, root: PhysicalVectorSchema, tip: PhysicalVectorSchema }))
      .min(1)
      .max(257),
  }),
]);
export type AttackGeometry = z.infer<typeof AttackGeometrySchema>;
export const ReactionDisplaySchema = z.strictObject({
  context: ReactionContextSchema,
  abilityId: IdSchema,
  targetId: IdSchema,
  activatedAt: step,
  readyAt: step,
  recoveryUntil: count,
  cooldownUntil: count,
  state: z.enum(['applied', 'queued', 'released', 'cancelled']),
  geometry: AttackGeometrySchema.optional(),
});
export type ReactionDisplay = z.infer<typeof ReactionDisplaySchema>;
export const StageDisplaySchema = z.strictObject({
  contact: StageContactSchema,
  startAt: count,
  endAt: count,
  state: z.enum(['preparing', 'active', 'waiting', 'complete', 'interrupted']),
  shape: z.enum([
    'direct',
    'melee',
    'hitscan',
    'projectile',
    'arc',
    'radial',
    'area',
    'beam',
    'hold',
  ]),
  geometry: AttackGeometrySchema.optional(),
  motion: z
    .strictObject({
      fromStep: step,
      kind: z.enum(['dash', 'retreat', 'leap']),
      applied: z.boolean(),
      direction: PhysicalVectorSchema,
      speedMmPerSecond: z.number().int().min(1).max(100000),
      accelerationMmPerSecond2: z.number().int().min(1).max(1000000),
    })
    .optional(),
});
export const StatusDisplaySchema = z.strictObject({
  flightStaminaPerSecond: z.number().int().min(0).max(1_000_000).optional(),
  revision: RefSchema,
  startStep: step,
  endStep: z.number().int().min(1).max(12000),
  stacks: z.number().int().min(1).max(32),
});
export const ActionDisplaySchema = z.strictObject({
  id: IdSchema,
  abilityId: IdSchema,
  startedAt: step,
  launchAt: count,
  recoveryUntil: count,
  phase: z.enum(['cast', 'active', 'recovery']),
  activeUntil: count.optional(),
  stage: StageDisplaySchema.optional(),
});
export const ActorDisplaySchema = z.strictObject({
  id: IdSchema,
  position: PhysicalVectorSchema,
  velocity: PhysicalVectorSchema,
  facing: PhysicalVectorSchema,
  grounded: z.boolean(),
  posture: z
    .strictObject({
      current: PostureSchema,
      body: BodySchema,
      transition: z.strictObject({ to: PostureSchema, completeAt: count }).optional(),
    })
    .optional(),
  reactions: z.array(ReactionDisplaySchema).max(160).optional(),
  force: z
    .strictObject({
      fromStep: step,
      active: z.boolean(),
      contributors: z.array(ForceContributionSchema).max(256),
      capMmPerSecond: z.number().int().min(1).max(100000),
      capped: z.boolean(),
      applied: PhysicalVectorSchema,
      gravityBefore: PhysicalVectorSchema.nullable(),
      gravityAfter: PhysicalVectorSchema.nullable(),
      incident: PhysicalVectorSchema.nullable(),
      projectedForce: PhysicalVectorSchema.nullable(),
      projections: z.array(MotionProjectionSchema).max(129),
    })
    .nullable()
    .optional(),
  resources: ResourceStateSchema,
  locomotion: z
    .strictObject({
      mode: z.enum(['idle', 'walk', 'run', 'slow', 'flight']),
      jumping: z.boolean(),
      dodging: z.boolean(),
    })
    .optional(),
  statuses: z.array(StatusDisplaySchema).max(8192),
  action: ActionDisplaySchema.nullable(),
});
export type ActorDisplay = z.infer<typeof ActorDisplaySchema>;
export const ActorDeltaSchema = ActorDisplaySchema.partial().required({ id: true });
export type ActorDelta = z.infer<typeof ActorDeltaSchema>;
export const ProjectileDisplaySchema = z.strictObject({
  id: IdSchema,
  ownerId: IdSchema,
  abilityId: IdSchema,
  position: PhysicalVectorSchema,
  velocity: PhysicalVectorSchema,
  radiusMm: z.number().int().min(1).max(5000),
  launchStep: step,
  endStep: z.number().int().min(1).max(12000),
  stage: StageContactSchema.optional(),
});
export type ProjectileDisplay = z.infer<typeof ProjectileDisplaySchema>;
export const ProjectileDeltaSchema = ProjectileDisplaySchema.pick({
  id: true,
  position: true,
  velocity: true,
});
export const ProjectileChangesSchema = z.strictObject({
  spawn: z.array(ProjectileDisplaySchema).max(2),
  update: z.array(ProjectileDeltaSchema).max(256),
  remove: z
    .array(
      z.strictObject({
        id: IdSchema,
        subtimeMicros: z.number().int().min(0).max(1000000),
        reason: z.enum(['body', 'wall', 'expired']),
      }),
    )
    .max(256),
});
export type ProjectileChanges = z.infer<typeof ProjectileChangesSchema>;
export const PathSchema = z.strictObject({
  entityId: IdSchema,
  segments: z.array(SegmentSchema).min(1).max(256),
});
export type DisplayPath = z.infer<typeof PathSchema>;
export const SpatialObjectDisplaySchema = z
  .strictObject({
    id: IdSchema,
    kind: z.enum(['barrier', 'area', 'beam']),
    ownerId: IdSchema,
    abilityId: IdSchema,
    cause: IdSchema,
    launchStep: step,
    activeFrom: step,
    endStep: z.number().int().min(1).max(12000),
    position: PhysicalVectorSchema,
    attachment: z.enum(['fixed', 'follow']),
    stage: StageContactSchema.optional(),
    shape: SpatialShapeSchema.optional(),
    direction: PhysicalVectorSchema.optional(),
    radiusMm: z.number().int().min(0).max(1000).optional(),
    geometry: AttackGeometrySchema.optional(),
    durability: z.number().int().min(0).max(1000000).optional(),
    maxDurability: z.number().int().min(1).max(1000000).optional(),
    blocks: SpatialSelectorsSchema.optional(),
  })
  .superRefine((o, ctx) => {
    if (
      o.activeFrom >= o.endStep ||
      o.launchStep > o.activeFrom ||
      (o.kind === 'beam'
        ? !o.direction ||
          o.radiusMm === undefined ||
          o.shape !== undefined ||
          o.attachment !== 'follow'
        : !o.shape ||
          o.direction !== undefined ||
          o.radiusMm !== undefined ||
          o.geometry !== undefined)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid spatial object geometry/window' });
    if (
      o.kind === 'barrier'
        ? o.durability === undefined ||
          o.maxDurability === undefined ||
          o.durability > o.maxDurability ||
          !o.blocks
        : o.durability !== undefined || o.maxDurability !== undefined || o.blocks !== undefined
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid spatial object durability' });
  });
export type SpatialObjectDisplay = z.infer<typeof SpatialObjectDisplaySchema>;
export const SpatialObjectChangesSchema = z.strictObject({
  spawn: z.array(SpatialObjectDisplaySchema).max(256),
  update: z.array(SpatialObjectDisplaySchema).max(256),
  remove: z
    .array(
      z.strictObject({
        id: IdSchema,
        reason: z.enum(['expired', 'broken', 'source-interrupted', 'battle-ended']),
      }),
    )
    .max(256),
});
export type SpatialObjectChanges = z.infer<typeof SpatialObjectChangesSchema>;
export const DisplayStateSchema = z.strictObject({
  actors: z.array(ActorDisplaySchema).length(2),
  projectiles: z.array(ProjectileDisplaySchema).max(256),
  objects: z.array(SpatialObjectDisplaySchema).max(256).optional(),
});
export type DisplayState = z.infer<typeof DisplayStateSchema>;
export const StreamRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('initial'),
    schemaVersion: z.literal(1),
    step: z.literal(0),
    state: DisplayStateSchema,
  }),
  z.strictObject({
    kind: z.literal('boundary'),
    schemaVersion: z.literal(1),
    step,
    objects: SpatialObjectChangesSchema.optional(),
    changes: z.array(ActorDeltaSchema).max(2),
    events: z.array(EventSchema).max(50000),
  }),
  z
    .strictObject({
      kind: z.literal('interval'),
      schemaVersion: z.literal(1),
      fromStep: step,
      toStep: step,
      paths: z.array(PathSchema).max(258),
      projectiles: ProjectileChangesSchema,
      objects: SpatialObjectChangesSchema.optional(),
      changes: z.array(ActorDeltaSchema).max(2),
      events: z.array(EventSchema).max(50000),
    })
    .refine((r) => r.toStep === r.fromStep + 1, 'An interval must cover exactly one step'),
  z.strictObject({
    kind: z.literal('terminal'),
    schemaVersion: z.literal(1),
    step,
    outcome: OutcomeSchema,
    events: z.array(EventSchema).length(1),
  }),
]);
export type StreamRecord = z.infer<typeof StreamRecordSchema>;
