import { z } from 'zod';
import { IdSchema } from './contracts.ts';

const tick = z.number().int().min(0).max(16000);
// Slow actions can have a future deadline beyond the finite battle horizon.
const deadline = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const ClockDisplaySchema = z.strictObject({
  projectionAsOfGlobalStep: tick,
  subjectStep: tick,
  pausedSteps: z.number().int().min(0).max(300),
  periods: z
    .array(z.strictObject({ from: tick, to: tick }))
    .max(4)
    .optional(),
  frozen: z.strictObject({ controlId: IdSchema, from: tick, until: tick }).optional(),
  deadlines: z
    .array(
      z.strictObject({
        key: z.string().min(1).max(100),
        domain: z.enum(['action', 'motion', 'status', 'projectile']),
        at: deadline,
        remainingSteps: deadline,
        projectedStep: deadline,
      }),
    )
    .max(10000),
});
export type ClockDisplay = z.infer<typeof ClockDisplaySchema>;
export const StopRecordSchema = z.strictObject({
  state: z.enum(['queued', 'activated', 'fizzle', 'capture', 'release']),
  controlId: IdSchema,
  durationSteps: z.number().int().min(1).max(100),
  reservedSteps: z.number().int().min(0).max(300),
  uses: z.number().int().min(0).max(4),
  executedSteps: z.number().int().min(0).max(300),
  contacts: z.number().int().min(0).max(256),
  operations: z.number().int().min(0).max(4096),
  bytes: z.number().int().min(0).max(65536),
});

/** Project an already recorded global stamp onto the current subject timer cache. */
export function projectClockStamp(clock: ClockDisplay | undefined, stamp: number, global: number) {
  return (
    stamp +
    (clock?.periods ?? []).reduce(
      (n, period) => n + Math.max(0, Math.min(global, period.to) - Math.max(stamp, period.from)),
      0,
    ) +
    (clock?.frozen ? Math.max(0, global - Math.max(stamp, clock.frozen.from)) : 0)
  );
}

export const StopReplaySchema = z.strictObject({
  controls: z
    .array(
      z.strictObject({
        id: IdSchema,
        ownerId: IdSchema,
        targetId: IdSchema,
        from: tick,
        until: tick,
        releasedAt: tick.optional(),
        operations: z.number().int().min(0).max(4096),
      }),
    )
    .max(4),
  contacts: z.number().int().min(0).max(256),
  operations: z.number().int().min(0).max(4096),
  bytes: z.number().int().min(0).max(65536),
});
export type StopReplay = z.infer<typeof StopReplaySchema>;
