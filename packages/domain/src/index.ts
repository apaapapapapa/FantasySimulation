import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const name = z.string().trim().min(1).max(80);
const stat = z.number().int().min(0).max(10_000);

export const ActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('weapon'),
    name,
    category: z.enum(['sword', 'staff', 'bow', 'unarmed']),
    power: stat,
  }),
  z.strictObject({
    kind: z.literal('magic'),
    name,
    element: z.enum(['fire', 'ice', 'lightning', 'arcane']),
    power: stat,
  }),
]);

export const AbilitySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('resistance'),
    name,
    damageType: z.enum(['physical', 'magical']),
    percent: z.number().int().min(0).max(100),
  }),
  z.strictObject({ kind: z.literal('regeneration'), name, hpPerRound: stat }),
]);

export const CharacterSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  name,
  description: z.string().max(2_000),
  stats: z.strictObject({
    maxHp: z.number().int().min(1).max(1_000_000),
    attack: stat,
    defense: stat,
    speed: stat,
  }),
  actions: z.array(ActionSchema).min(1).max(16),
  abilities: z.array(AbilitySchema).max(16),
});

export const RulesetSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  algorithm: z.literal('basic-v1'),
  maxRounds: z.number().int().min(1).max(500),
});

export const BattleRequestSchema = z.strictObject({ leftId: id, rightId: id });

export const BattleEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('attack'),
    round: z.number().int().positive(),
    actorId: id,
    targetId: id,
    actionName: name,
    damageType: z.enum(['physical', 'magical']),
    damage: z.number().int().nonnegative(),
    remainingHp: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('regeneration'),
    round: z.number().int().positive(),
    actorId: id,
    recoveredHp: z.number().int().nonnegative(),
    remainingHp: z.number().int().nonnegative(),
  }),
]);

export const BattleResultSchema = z.strictObject({
  rulesVersion: z.string(),
  winnerId: id.nullable(),
  reason: z.enum(['knockout', 'round-limit']),
  rounds: z.number().int().positive(),
  remainingHp: z.record(id, z.number().int().nonnegative()),
  events: z.array(BattleEventSchema),
});

export const BattleRecordSchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  participants: z.tuple([CharacterSchema, CharacterSchema]),
  result: BattleResultSchema,
});

export type Character = z.infer<typeof CharacterSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Ability = z.infer<typeof AbilitySchema>;
export type Ruleset = z.infer<typeof RulesetSchema>;
export type BattleEvent = z.infer<typeof BattleEventSchema>;
export type BattleResult = z.infer<typeof BattleResultSchema>;
export type BattleRecord = z.infer<typeof BattleRecordSchema>;

export function assertNever(value: never): never {
  throw new Error(`Unsupported variant: ${JSON.stringify(value)}`);
}
