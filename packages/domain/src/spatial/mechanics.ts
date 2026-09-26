import { z } from 'zod';

// Kept exhaustive against the versioned JSON registry and every accepted schema variant.
export const MechanicIdSchema = z.enum([
  'absolute-evasion',
  'absolute-hit',
  'apply-status',
  'area',
  'attribute-absorption',
  'barrier',
  'beam',
  'causality',
  'contact',
  'counter',
  'damage',
  'dispel',
  'drain',
  'elemental-reaction',
  'existence-erasure',
  'flight',
  'force',
  'foresight',
  'heal',
  'immortality',
  'instant-death',
  'mind-read',
  'motion',
  'parry',
  'permanent',
  'periodic',
  'phasing',
  'piercing',
  'projectile',
  'projectile-deflection',
  'reaction-effects',
  'resource',
  'reveal',
  'revival',
  'seal',
  'shield',
  'silence',
  'stages',
  'status-adjustment',
  'teleport',
  'time-stop',
  'universal-victory',
  'visibility',
]);
export type MechanicId = z.infer<typeof MechanicIdSchema>;
export const ExperimentalRulesSchema = z.strictObject({
  mechanics: z
    .array(MechanicIdSchema)
    .min(1)
    .max(MechanicIdSchema.options.length)
    .refine(
      (ids) => ids.every((id, i) => i === 0 || ids[i - 1]! < id),
      'Experimental mechanics must be unique and in canonical ASCII order',
    ),
});
export type LeagueClass = 'standard' | 'experimental';
export const LeagueClassSchema = z.enum(['standard', 'experimental']);
export const rulesetClass = (rules: {
  experimental?: { mechanics: readonly MechanicId[] } | undefined;
}): LeagueClass => (rules.experimental === undefined ? 'standard' : 'experimental');
