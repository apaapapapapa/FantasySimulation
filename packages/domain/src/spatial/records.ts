import { z } from 'zod';
import { HashSchema, IdSchema } from './contracts.ts';

const step = z.number().int().min(0).max(6000);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PhysicalVectorSchema = z.strictObject({
  x: z.number().min(-2000).max(2000),
  y: z.number().min(-2000).max(2000),
  z: z.number().min(-2000).max(2000),
});
export const ResourceStateSchema = z.strictObject({ hp: count, mp: count, shield: count });
export type ResourceState = z.infer<typeof ResourceStateSchema>;
export const EventSchema = z.strictObject({
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
  ]),
  actorId: IdSchema.nullable(),
  targetId: IdSchema.nullable(),
  parentEventId: IdSchema.nullable(),
  abilityId: IdSchema.nullable(),
  ruleId: IdSchema,
  point: PhysicalVectorSchema.nullable(),
  before: ResourceStateSchema.nullable(),
  after: ResourceStateSchema.nullable(),
  amount: count.nullable(),
  reason: z.string().max(500),
});
export type BattleEvent = z.infer<typeof EventSchema>;
export const OutcomeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('win'), winner: IdSchema }),
  z.strictObject({ kind: z.literal('draw'), reason: z.enum(['mutual-defeat', 'time-limit']) }),
  z.strictObject({
    kind: z.literal('unresolved'),
    ruleId: IdSchema,
    revisions: z.array(IdSchema).max(64),
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
