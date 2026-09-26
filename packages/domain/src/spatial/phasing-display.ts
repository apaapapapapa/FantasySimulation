import { z } from 'zod';
import { IdSchema, RefSchema } from './contracts.ts';
import { PhasingSchema } from './spatial-operations.ts';

export const PhaseContributionSchema = PhasingSchema.extend({
  revision: RefSchema,
  causes: z.array(IdSchema).min(1).max(256),
});
export const BodyPhasingSchema = z.strictObject({
  active: z.array(PhaseContributionSchema).max(256),
  retained: z.array(PhaseContributionSchema).max(256),
  exitPending: z.boolean(),
  extendedIntervals: z.number().int().min(0).max(50),
});
export type BodyPhasing = z.infer<typeof BodyPhasingSchema>;
export type PhaseContribution = z.infer<typeof PhaseContributionSchema>;
