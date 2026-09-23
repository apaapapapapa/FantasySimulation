import { z } from 'zod';
import { DamageDefenseSchema, ElementSchema, HashSchema, IdSchema } from './contracts.ts';
import { CognitionSchema } from './cognition.ts';

const step = z.number().int().min(0).max(6000);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PhysicalVectorSchema = z.strictObject({
  x: z.number().min(-2000).max(2000),
  y: z.number().min(-2000).max(2000),
  z: z.number().min(-2000).max(2000),
});
export const ResourceStateSchema = z.strictObject({ hp: count, mp: count, shield: count });
export type ResourceState = z.infer<typeof ResourceStateSchema>;
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
      'status-apply',
      'status-remove',
      'fizzle',
      'projectile-spawn',
      'projectile-remove',
      'land',
      'terminal',
      'diagnostic',
      'state',
      'decision',
      'knowledge',
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
  })
  .superRefine((event, ctx) => {
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
  }),
  z.strictObject({ kind: z.literal('truncated'), resource: IdSchema, reason: z.string().max(500) }),
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
  }),
});
export type BattleResult = z.infer<typeof ResultSchema>;
