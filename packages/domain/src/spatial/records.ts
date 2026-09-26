import { MAX_BATTLE_STEPS } from './contracts.ts';
import { z } from 'zod';
import {
  DamageDefenseSchema,
  ElementSchema,
  HashSchema,
  IdSchema,
  StageContactSchema,
  ReactionPointSchema,
} from './contracts.ts';
import { CognitionSchema } from './cognition.ts';
import { InterferencesSchema, TruncationDetailsSchema } from './interference-records.ts';

const step = z.number().int().min(0).max(MAX_BATTLE_STEPS);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PhysicalVectorSchema = z.strictObject({
  x: z.number().min(-2000).max(2000),
  y: z.number().min(-2000).max(2000),
  z: z.number().min(-2000).max(2000),
});
export const ResourceStateSchema = z.strictObject({
  hp: count,
  mp: count,
  shield: count,
  stamina: count.optional(),
});
export type ResourceState = z.infer<typeof ResourceStateSchema>;
export const MotionProjectionSchema = z
  .strictObject({
    fraction: z.number().min(0).max(1),
    kind: z.enum(['wall', 'body', 'stop']),
    normal: PhysicalVectorSchema.nullable(),
    obstacleId: IdSchema.optional(),
  })
  .refine(
    (p) =>
      p.kind === 'wall'
        ? !!p.normal &&
          !!p.obstacleId &&
          Math.abs(p.normal.x ** 2 + p.normal.y ** 2 + p.normal.z ** 2 - 1) < 1e-6
        : p.normal === null,
    'Collision projection normal',
  );
export type MotionProjection = z.infer<typeof MotionProjectionSchema>;
export const ForceContributionSchema = z
  .strictObject({
    id: IdSchema,
    actorId: IdSchema.nullable(),
    abilityId: IdSchema.nullable(),
    sourceActorId: IdSchema.optional(),
    startAt: z.number().int().min(1).max(MAX_BATTLE_STEPS),
    endAt: z.number().int().min(2).max(6100),
    velocityMmPerSecond: z.strictObject({
      x: z.number().int().min(-100000).max(100000),
      y: z.number().int().min(-100000).max(100000),
      z: z.number().int().min(-100000).max(100000),
    }),
    stage: StageContactSchema.optional(),
  })
  .refine((f) => f.endAt > f.startAt && f.endAt <= f.startAt + 100, 'Force duration');
export type ForceContribution = z.infer<typeof ForceContributionSchema>;
export const ReactionContextSchema = z.strictObject({
  activationId: IdSchema,
  point: ReactionPointSchema,
  wave: z.number().int().min(0).max(8),
  depth: z.number().int().min(1).max(8),
});
export type ReactionContext = z.infer<typeof ReactionContextSchema>;
export const ProjectileDeflectionSchema = z.strictObject({
  eventId: IdSchema,
  originalOwnerId: IdSchema,
  ownerId: IdSchema,
  step,
  subtimeMicros: z.number().int().min(0).max(1000000),
  point: PhysicalVectorSchema,
  position: PhysicalVectorSchema,
  incomingVelocity: PhysicalVectorSchema,
  velocity: PhysicalVectorSchema,
  basis: z.enum(['observed-position', 'reverse-incoming']),
  observedPosition: PhysicalVectorSchema.optional(),
  powerBps: z.number().int().min(0).max(30000),
  activations: z
    .array(z.strictObject({ abilityId: IdSchema, context: ReactionContextSchema }))
    .min(1)
    .max(64),
});
export type ProjectileDeflection = z.infer<typeof ProjectileDeflectionSchema>;
export const EventSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: IdSchema,
    sequence: count,
    step,
    phase: z.enum(['boundary', 'declaration', 'launch', 'contact', 'resolution', 'terminal']),
    subtimeMicros: z.number().int().min(0).max(1000000),
    kind: z.enum([
      'cast-start',
      'launch',
      'hit',
      'damage',
      'heal',
      'shield',
      'cost',
      'resource',
      'status-apply',
      'status-remove',
      'fizzle',
      'projectile-spawn',
      'projectile-remove',
      'projectile-deflect',
      'land',
      'terminal',
      'diagnostic',
      'state',
      'decision',
      'knowledge',
      'stage-start',
      'stage-end',
      'stage-interrupt',
      'force',
      'reaction',
    ]),
    actorId: IdSchema.nullable(),
    targetId: IdSchema.nullable(),
    entityId: IdSchema.nullable(),
    parentEventId: IdSchema.nullable(),
    causes: z.array(IdSchema).max(65536),
    abilityId: IdSchema.nullable(),
    ruleId: IdSchema,
    point: PhysicalVectorSchema.nullable(),
    before: ResourceStateSchema.nullable(),
    after: ResourceStateSchema.nullable(),
    amount: count.nullable(),
    damage: z
      .strictObject({
        defenseApplied: count,
        afterDefense: count,
        afterResistance: count,
        calculation: z
          .strictObject({
            element: ElementSchema,
            component: z.enum(['physical', 'elemental']),
            defense: DamageDefenseSchema,
            basePower: count,
            afterModifiers: count,
          })
          .optional(),
        absorbed: z.strictObject({
          numerator: z.string().regex(/^\d{1,40}$/),
          denominator: z.string().regex(/^[1-9]\d{0,39}$/),
        }),
        toHp: z.strictObject({
          numerator: z.string().regex(/^\d{1,40}$/),
          denominator: z.string().regex(/^[1-9]\d{0,39}$/),
        }),
      })
      .nullable(),
    reason: z.string().max(500),
    cognition: CognitionSchema.optional(),
    stage: StageContactSchema.optional(),
    force: ForceContributionSchema.optional(),
    reaction: ReactionContextSchema.optional(),
    wave: z.number().int().min(0).max(8).optional(),
    sourceActorId: IdSchema.optional(),
    sourceProjectileId: IdSchema.optional(),
    projectileDeflection: ProjectileDeflectionSchema.optional(),
  })
  .superRefine((event, ctx) => {
    if (event.kind === 'reaction' && (!event.reaction || !event.actorId || !event.abilityId))
      ctx.addIssue({
        code: 'custom',
        message: 'Reaction activation/lifecycle requires an owner and context',
      });
    if (
      (event.kind === 'force') !== !!event.force ||
      (event.force &&
        (event.force.id !== event.id ||
          event.force.actorId !== event.actorId ||
          event.force.abilityId !== event.abilityId ||
          event.force.startAt !== event.step ||
          !event.targetId))
    )
      ctx.addIssue({ code: 'custom', message: 'Force must match its accepted contact event' });
    const subjective = event.kind === 'decision' || event.kind === 'knowledge';
    if (
      subjective !== !!event.cognition ||
      (event.cognition &&
        (event.cognition.kind !== event.kind ||
          !event.actorId ||
          event.before !== null ||
          event.after !== null ||
          event.amount !== null ||
          event.damage !== null))
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Subjective cognition must match its event and contain no authoritative resource result',
      });
  });
export type BattleEvent = z.infer<typeof EventSchema>;
export const OutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('win'), winner: IdSchema }),
  z.strictObject({ kind: z.literal('draw'), reason: z.enum(['mutual-defeat', 'time-limit']) }),
  z.strictObject({
    kind: z.literal('unresolved'),
    ruleId: IdSchema,
    revisions: z.array(IdSchema).max(256),
    reason: z.string().max(500),
    interferences: InterferencesSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('truncated'),
    resource: IdSchema,
    reason: z.string().max(500),
    details: TruncationDetailsSchema.optional(),
  }),
]);
export type Outcome = z.infer<typeof OutcomeSchema>;
export const ResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  simulationHash: HashSchema,
  eventHash: HashSchema,
  trajectoryHash: HashSchema,
  tsStateHash: HashSchema,
  physicsStateHash: HashSchema,
  steps: step,
  outcome: OutcomeSchema,
  stats: z.strictObject({
    events: count,
    logBytes: count,
    casts: count,
    candidates: count,
    pathNodes: count,
    peakProjectiles: count,
    reactionAttempts: count.optional(),
  }),
});
export type BattleResult = z.infer<typeof ResultSchema>;
