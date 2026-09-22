import { z } from 'zod';
import { IdSchema, RefSchema } from './contracts.ts';
import {
  EventSchema,
  OutcomeSchema,
  PhysicalVectorSchema,
  ResourceStateSchema,
} from './records.ts';
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const step = z.number().int().min(0).max(6000);
export const StatusDisplaySchema = z.strictObject({
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
});
export const ActorDisplaySchema = z.strictObject({
  id: IdSchema,
  position: PhysicalVectorSchema,
  velocity: PhysicalVectorSchema,
  facing: PhysicalVectorSchema,
  grounded: z.boolean(),
  resources: ResourceStateSchema,
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
const fraction = z.number().min(0).max(1);
export const SegmentSchema = z
  .strictObject({
    start: PhysicalVectorSchema,
    end: PhysicalVectorSchema,
    from: fraction,
    to: fraction,
  })
  .refine((p) => p.from <= p.to, 'Reversed segment');
export const PathSchema = z.strictObject({
  entityId: IdSchema,
  segments: z.array(SegmentSchema).min(1).max(256),
});
export type DisplayPath = z.infer<typeof PathSchema>;
export const DisplayStateSchema = z.strictObject({
  actors: z.array(ActorDisplaySchema).length(2),
  projectiles: z.array(ProjectileDisplaySchema).max(256),
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
