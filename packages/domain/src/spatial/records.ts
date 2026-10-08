import { StopRecordSchema } from './clocks.ts';
import { MAX_BATTLE_STEPS } from './contracts.ts';
import { z } from 'zod';
import {
  DamageDefenseSchema,
  ElementSchema,
  HashSchema,
  IdSchema,
  StageContactSchema,
  ReactionPointSchema,
  RefSchema,
  EffectSchema,
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
export const SensoryCueDisplaySchema = z.strictObject({
  id: IdSchema,
  creatorId: IdSchema,
  observerId: IdSchema,
  modality: z.literal('visual'),
  perceivedOrigin: PhysicalVectorSchema,
  emittedAt: step,
  deliveredAt: step,
  expiresAt: z.number().int().min(1).max(7000),
  discoveredAt: z.number().int().min(1).max(7000),
  confidenceBps: z.number().int().min(1).max(10000),
});
export const EnvironmentalHologramDisplaySchema = z
  .strictObject({
    id: IdSchema,
    creatorId: IdSchema,
    observerId: IdSchema,
    observerIds: z.array(IdSchema).length(1),
    abilityId: IdSchema,
    effectIndex: z.number().int().min(0).max(31),
    stageIndex: z.number().int().min(0).max(15).optional(),
    modality: z.literal('visual'),
    sourcePosition: PhysicalVectorSchema,
    perceivedPosition: PhysicalVectorSchema,
    state: z.enum(['active-unobserved', 'observed', 'invalidated']),
    activatedAt: step,
    observedAt: z.number().int().min(1).max(7000),
    invalidatedAt: z.number().int().min(1).max(7000),
    expiresAt: z.number().int().min(1).max(7000),
  })
  .refine(
    (hologram) =>
      hologram.observerIds[0] === hologram.observerId &&
      hologram.activatedAt < hologram.observedAt &&
      hologram.observedAt < hologram.invalidatedAt &&
      hologram.invalidatedAt < hologram.expiresAt,
    'Environmental hologram observer and lifecycle binding',
  );
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
export const DeferredEffectSchema = z.strictObject({
  id: IdSchema,
  controlId: IdSchema,
  capturedAt: step,
  actorId: IdSchema,
  targetId: IdSchema,
  abilityId: IdSchema,
  effect: EffectSchema,
  effectIndex: z.number().int().min(0).max(31).optional(),
  stageIndex: z.number().int().min(0).max(15).optional(),
  sourcePosition: PhysicalVectorSchema.optional(),
  sourceActorId: IdSchema.optional(),
  sourceProjectileId: IdSchema.optional(),
  deflection: ProjectileDeflectionSchema.optional(),
});
export type DeferredEffect = z.infer<typeof DeferredEffectSchema>;
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
      'revival',
      'defeat',
      'immortality',
      'evasion',
      'time-stop',
      'teleport',
      'sensory-cue',
      'environmental-hologram',
      'dependent-create',
      'dependent-command',
      'dependent-act',
      'dependent-despawn',
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
        guard: z
          .strictObject({
            before: count,
            after: count,
            responses: z
              .array(
                z.strictObject({
                  activationId: IdSchema,
                  retainedDamageBps: z.number().int().min(1).max(9999),
                }),
              )
              .min(1)
              .max(64),
          })
          .optional(),
        absorption: z
          .strictObject({ element: ElementSchema, converted: count, healing: count })
          .optional(),
        drain: z
          .strictObject({
            basis: z.strictObject({
              numerator: z.string().regex(/^\d{1,40}$/),
              denominator: z.string().regex(/^[1-9]\d{0,39}$/),
            }),
            healing: count,
          })
          .optional(),
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
    revival: z.strictObject({ use: z.number().int().min(1).max(4) }).optional(),
    defeat: z
      .strictObject({
        applied: z.boolean(),
        reason: z.enum(['accepted', 'immune', 'condition', 'already-defeated']),
      })
      .optional(),
    immortality: z
      .strictObject({ use: z.number().int().min(1).max(4), status: RefSchema })
      .optional(),
    timeStop: StopRecordSchema.extend({
      captured: z.array(DeferredEffectSchema).max(4096).optional(),
    }).optional(),
    deferrals: z.array(IdSchema).min(1).max(16).optional(),
    evasion: z.strictObject({ statuses: z.array(RefSchema).min(1).max(64) }).optional(),
    teleport: z.strictObject({ from: PhysicalVectorSchema, to: PhysicalVectorSchema }).optional(),
    sensoryCue: SensoryCueDisplaySchema.extend({
      transition: z.enum(['emitted', 'delivered', 'discovered', 'cleansed', 'expired']),
    }).optional(),
    environmentalHologram: EnvironmentalHologramDisplaySchema.extend({
      transition: z.enum(['activated', 'observed', 'invalidated', 'expired']),
    }).optional(),
    dependent: z
      .strictObject({
        transition: z.enum(['create', 'command', 'act', 'despawn']),
        ownerId: IdSchema,
        hostileOwnerId: IdSchema,
        ordinal: z.number().int().min(0).max(7),
        nextActionAt: z.number().int().min(0).max(12300).optional(),
        observedTargetIds: z.array(IdSchema).min(1).max(9).optional(),
        reason: z.enum(['expired', 'dismissed', 'owner-defeated', 'upkeep']).optional(),
      })
      .optional(),
    wave: z.number().int().min(0).max(8).optional(),
    sourceActorId: IdSchema.optional(),
    sourceProjectileId: IdSchema.optional(),
    projectileDeflection: ProjectileDeflectionSchema.optional(),
  })
  .superRefine((event, ctx) => {
    const dependentKinds = [
      'dependent-create',
      'dependent-command',
      'dependent-act',
      'dependent-despawn',
    ] as const;
    if (
      dependentKinds.includes(event.kind as (typeof dependentKinds)[number]) !==
        !!event.dependent ||
      (event.dependent &&
        (!event.entityId ||
          event.actorId !== event.dependent.ownerId ||
          (!['dependent-command', 'dependent-act'].includes(event.kind) &&
            event.targetId !== event.dependent.hostileOwnerId) ||
          (['dependent-command', 'dependent-act'].includes(event.kind) &&
            (!event.targetId || event.targetId === event.dependent.ownerId)) ||
          event.dependent.ownerId === event.dependent.hostileOwnerId ||
          event.dependent.transition !== event.kind.slice('dependent-'.length)))
    )
      ctx.addIssue({ code: 'custom', message: 'Dependent event identity/transition mismatch' });
    if (event.damage?.guard) {
      const ids = event.damage.guard.responses.map((response) => response.activationId);
      if (
        event.kind !== 'damage' ||
        event.damage.guard.after > event.damage.guard.before ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !event.causes.includes(id))
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Guard requires unique causal activations and non-increasing damage',
        });
    }
    if (
      (event.kind === 'sensory-cue') !== !!event.sensoryCue ||
      (event.sensoryCue &&
        (event.entityId !== event.sensoryCue.id ||
          event.actorId !== event.sensoryCue.creatorId ||
          event.targetId !== event.sensoryCue.observerId ||
          event.actorId === event.targetId))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Sensory cue events require bound creator, observer and cue identity',
      });
    if (
      (event.kind === 'environmental-hologram') !== !!event.environmentalHologram ||
      (event.environmentalHologram &&
        (event.entityId !== event.environmentalHologram.id ||
          event.actorId !== event.environmentalHologram.creatorId ||
          event.targetId !== event.environmentalHologram.observerId ||
          event.actorId === event.targetId))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Environmental hologram events require bound creator, observer and identity',
      });
    if (
      (event.kind === 'time-stop') !== !!event.timeStop ||
      (event.timeStop && (!event.actorId || !event.targetId || event.actorId === event.targetId))
    )
      ctx.addIssue({ code: 'custom', message: 'Time stop requires opposing source and target' });
    if (
      (event.kind === 'evasion') !== !!event.evasion ||
      (event.evasion && (!event.actorId || !event.targetId || event.actorId === event.targetId))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Evasion requires opposing contact actors and status references',
      });
    if (
      (event.kind === 'defeat') !== !!event.defeat ||
      (event.defeat &&
        (!event.targetId ||
          !event.actorId ||
          !event.abilityId ||
          event.defeat.applied !== (event.defeat.reason === 'accepted')))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Defeat requires a contact and explicit request result',
      });
    if (
      (event.kind === 'immortality') !== !!event.immortality ||
      (event.immortality &&
        (!event.actorId ||
          event.actorId !== event.targetId ||
          !event.before ||
          event.before.hp < 1 ||
          event.after?.hp !== 1))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Immortality requires a living owner and HP1 transition',
      });
    if (
      (event.kind === 'revival') !== !!event.revival ||
      (event.revival &&
        (!event.reaction ||
          event.reaction.point !== 'before-defeat' ||
          !event.actorId ||
          !event.abilityId))
    )
      ctx.addIssue({ code: 'custom', message: 'Revival requires before-defeat owner and use' });
    if (
      (event.kind === 'teleport') !== !!event.teleport ||
      (event.teleport && (event.phase !== 'boundary' || !event.actorId || !event.abilityId))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Teleport requires a boundary owner and displacement',
      });
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
