import { z } from 'zod';
import { IdSchema, RefSchema, MAX_BATTLE_STEPS } from './contracts.ts';
import { canonicalJson } from './canonical.ts';

export const INTERFERENCE_LIMITS = {
  entries: 16,
  actors: 2,
  causes: 32,
  revisions: 64,
  bytes: 32768,
} as const;
export const InterferencePointSchema = z.enum([
  'startup',
  'boundary',
  'contact',
  'before-hit',
  'after-damage',
  'before-defeat',
  'status-commit',
]);
const step = z.number().int().min(0).max(MAX_BATTLE_STEPS);
const wave = z.number().int().min(0).max(8).nullable();
export const InterferenceRevisionSchema = RefSchema.extend({ kind: z.enum(['ability', 'status']) });
export const InterferenceCauseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('event'), eventId: IdSchema }),
  z
    .strictObject({
      kind: z.literal('attempt'),
      step,
      point: InterferencePointSchema,
      wave,
      actorId: IdSchema.nullable(),
      ability: RefSchema.nullable(),
      ordinal: z.number().int().min(0).max(1_000_000),
    })
    .superRefine((cause, ctx) => {
      if (cause.ability && !cause.actorId)
        ctx.addIssue({ code: 'custom', message: 'Attempt ability requires its actor' });
      if (
        ['before-hit', 'after-damage', 'before-defeat'].includes(cause.point) &&
        cause.wave === null
      )
        ctx.addIssue({ code: 'custom', message: 'Reaction attempt requires a wave' });
      if (['startup', 'boundary', 'status-commit'].includes(cause.point) && cause.wave !== null)
        ctx.addIssue({ code: 'custom', message: 'Outside-wave attempt requires null wave' });
    }),
]);
export const InterferenceSchema = z
  .strictObject({
    step,
    point: InterferencePointSchema,
    wave,
    actors: z.array(IdSchema).min(1).max(INTERFERENCE_LIMITS.actors),
    causes: z.array(InterferenceCauseSchema).min(1).max(INTERFERENCE_LIMITS.causes),
    revisions: z.array(InterferenceRevisionSchema).min(1).max(INTERFERENCE_LIMITS.revisions),
    ruleId: IdSchema,
  })
  .superRefine((entry, ctx) => {
    for (const items of [entry.actors, entry.causes, entry.revisions])
      if (new Set(items.map((item) => canonicalJson(item))).size !== items.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate interference context' });
    if (
      ['before-hit', 'after-damage', 'before-defeat'].includes(entry.point) &&
      entry.wave === null
    )
      ctx.addIssue({ code: 'custom', message: 'Reaction interference requires a wave' });
    if (['startup', 'boundary', 'status-commit'].includes(entry.point) && entry.wave !== null)
      ctx.addIssue({ code: 'custom', message: 'Outside-wave interference requires null wave' });
    if (entry.causes.some((cause) => cause.kind === 'attempt' && cause.step !== entry.step))
      ctx.addIssue({ code: 'custom', message: 'Attempt must belong to the failing boundary' });
  });
export const InterferencesSchema = z
  .array(InterferenceSchema)
  .min(1)
  .max(INTERFERENCE_LIMITS.entries)
  .refine(
    (entries) =>
      new TextEncoder().encode(canonicalJson(entries)).length <= INTERFERENCE_LIMITS.bytes,
    'Interference context byte limit',
  );
export type Interference = z.infer<typeof InterferenceSchema>;
export type InterferenceCause = z.infer<typeof InterferenceCauseSchema>;
export const TruncationDetailsSchema = z
  .strictObject({
    observed: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    limit: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    cause: z.string().min(1).max(500),
    context: InterferencesSchema.optional(),
  })
  .refine((v) => v.observed > v.limit, 'Truncation must exceed its limit');
export type TruncationDetails = z.infer<typeof TruncationDetailsSchema>;
