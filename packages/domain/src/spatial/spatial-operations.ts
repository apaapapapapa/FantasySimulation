import { z } from 'zod';

const dimension = z.number().int().min(1).max(50000);
const lifetime = z.number().int().min(1).max(6000);
export const SpatialPlacementSchema = z
  .strictObject({
    anchor: z.enum(['self', 'observed-enemy']),
    direction: z.enum(['front', 'back', 'left', 'right']),
    distanceMm: z.number().int().min(0).max(200000),
    maxDistanceMm: z.number().int().min(1).max(200000),
  })
  .refine((p) => p.distanceMm <= p.maxDistanceMm, 'Placement distance exceeds maximum');
export const SpatialShapeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sphere'), radiusMm: dimension }),
  z.strictObject({
    kind: z.literal('box'),
    sizeMm: z.strictObject({ x: dimension, y: dimension, z: dimension }),
    yawMilliDegrees: z.number().int().min(-180000).max(180000),
  }),
  z.strictObject({ kind: z.literal('cylinder'), radiusMm: dimension, heightMm: dimension }),
]);
const selector = z.enum(['none', 'owner', 'enemy', 'both']);
export const SpatialSelectorsSchema = z.strictObject({
  movement: selector,
  vision: selector,
  attack: selector,
});
export const BarrierSchema = z
  .strictObject({
    placement: SpatialPlacementSchema,
    shape: SpatialShapeSchema,
    durationSteps: lifetime,
    attachment: z.enum(['fixed', 'follow']),
    durability: z.number().int().min(1).max(1000000),
    blocks: SpatialSelectorsSchema,
  })
  .refine(
    (b) => Object.values(b.blocks).some((s) => s !== 'none'),
    'Barrier must block at least one layer',
  );
export const AreaAttackSchema = z
  .strictObject({
    kind: z.literal('area'),
    placement: SpatialPlacementSchema,
    shape: SpatialShapeSchema,
    durationSteps: lifetime,
    armDelaySteps: z.number().int().min(0).max(6000),
    periodSteps: lifetime,
  })
  .refine((a) => a.armDelaySteps < a.durationSteps, 'Area requires a pulse before expiry');
export const BeamAttackSchema = z.strictObject({
  kind: z.literal('beam'),
  radiusMm: z.number().int().min(0).max(1000),
});
export type SpatialShape = z.infer<typeof SpatialShapeSchema>;
export type SpatialPlacement = z.infer<typeof SpatialPlacementSchema>;
export type Barrier = z.infer<typeof BarrierSchema>;
