import { ClockDisplaySchema } from './clocks.ts';
import { BodyPhasingSchema } from './phasing-display.ts';
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
  ProjectileDeflectionSchema,
  SensoryCueDisplaySchema,
} from './records.ts';
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const step = z.number().int().min(0).max(MAX_BATTLE_STEPS);
const fraction = z.number().min(0).max(1);
export const RequiredReplayFeaturesSchema = z
  .array(
    z.enum([
      'subject-clocks-v1',
      'deferred-contacts-v1',
      'sensory-cues-v1',
      'dependent-entities-v1',
    ]),
  )
  .min(2)
  .max(4)
  .refine(
    (features) =>
      features[0] === 'subject-clocks-v1' &&
      features[1] === 'deferred-contacts-v1' &&
      [
        '',
        'sensory-cues-v1',
        'dependent-entities-v1',
        'sensory-cues-v1,dependent-entities-v1',
      ].includes(features.slice(2).join(',')),
    'Replay features must use the canonical compatible prefix order',
  );
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
  endStep: z.number().int().min(1).max(12300),
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
  clock: ClockDisplaySchema.optional(),
  forceSchedule: z.array(ForceContributionSchema).max(256).optional(),
  phasing: BodyPhasingSchema.nullable().optional(),
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
  revivals: z.number().int().min(0).max(4).optional(),
  immortalityUsed: z.number().int().min(0).max(4).optional(),
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
  sensoryCues: z.array(SensoryCueDisplaySchema).max(8).optional(),
});
export type ActorDisplay = z.infer<typeof ActorDisplaySchema>;
export const ActorDeltaSchema = ActorDisplaySchema.partial().required({ id: true });
export type ActorDelta = z.infer<typeof ActorDeltaSchema>;
export const ProjectileDisplaySchema = z.strictObject({
  clock: ClockDisplaySchema.optional(),
  id: IdSchema,
  ownerId: IdSchema,
  abilityId: IdSchema,
  position: PhysicalVectorSchema,
  velocity: PhysicalVectorSchema,
  radiusMm: z.number().int().min(1).max(5000),
  launchStep: step,
  endStep: z.number().int().min(1).max(12300),
  deflection: ProjectileDeflectionSchema.optional(),
  stage: StageContactSchema.optional(),
});
export type ProjectileDisplay = z.infer<typeof ProjectileDisplaySchema>;
export const ProjectileDeltaSchema = ProjectileDisplaySchema.pick({
  id: true,
  position: true,
  velocity: true,
}).extend({
  ownerId: IdSchema.optional(),
  deflection: ProjectileDeflectionSchema.optional(),
  clock: ClockDisplaySchema.optional(),
  endStep: z.number().int().min(1).max(12300).optional(),
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
    endStep: z.number().int().min(1).max(12300),
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
export const DependentDisplaySchema = z.strictObject({
  id: IdSchema,
  profile: z.literal('scout-rat-v1'),
  ownerId: IdSchema,
  hostileOwnerId: IdSchema,
  abilityId: IdSchema,
  ordinal: z.number().int().min(0).max(7),
  position: PhysicalVectorSchema,
  body: BodySchema,
  hp: z.number().int().min(0).max(1_000_000),
  maxHp: z.number().int().min(1).max(1_000_000),
  createdAt: step,
  expiresAt: z.number().int().min(1).max(12300),
  nextActionAt: z.number().int().min(0).max(12300),
  nextUpkeepAt: z.number().int().min(0).max(12300),
  rngState: z.number().int().min(0).max(0xffff_ffff),
  clock: z
    .strictObject({
      controlId: IdSchema,
      frozenFrom: step,
      frozenUntil: z.number().int().min(1).max(12300),
    })
    .refine((clock) => clock.frozenFrom < clock.frozenUntil, 'Invalid dependent clock window')
    .optional(),
});
export type DependentDisplay = z.infer<typeof DependentDisplaySchema>;
export const DependentChangesSchema = z.strictObject({
  spawn: z.array(DependentDisplaySchema).max(2),
  update: z.array(DependentDisplaySchema).max(2),
  remove: z
    .array(
      z.strictObject({
        id: IdSchema,
        reason: z.enum(['expired', 'dismissed', 'owner-defeated', 'upkeep']),
      }),
    )
    .max(2),
});
export type DependentChanges = z.infer<typeof DependentChangesSchema>;
export const DisplayStateSchema = z.strictObject({
  actors: z.array(ActorDisplaySchema).length(2),
  projectiles: z.array(ProjectileDisplaySchema).max(256),
  objects: z.array(SpatialObjectDisplaySchema).max(256).optional(),
  dependents: z.array(DependentDisplaySchema).max(4).optional(),
});
export type DisplayState = z.infer<typeof DisplayStateSchema>;
export const StreamRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('initial'),
    requiredFeatures: RequiredReplayFeaturesSchema.optional(),
    schemaVersion: z.literal(1),
    step: z.literal(0),
    state: DisplayStateSchema,
  }),
  z.strictObject({
    kind: z.literal('boundary'),
    schemaVersion: z.literal(1),
    step,
    objects: SpatialObjectChangesSchema.optional(),
    dependents: DependentChangesSchema.optional(),
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
      dependents: DependentChangesSchema.optional(),
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
