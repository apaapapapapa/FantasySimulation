import { z } from 'zod';
import { SkillConfigurationSchema, SkillLoadoutRevisionSchema } from './skill-loadout.ts';
import { SkillCatalogSchema } from './skill-system.ts';
import { JobRequestSchema } from './spatial/api.ts';
import { IdSchema, RefSchema } from './spatial/contracts.ts';

const version = z.number().int().min(1).max(1_000_000);

export const SkillCatalogRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    reference: RefSchema,
    catalog: SkillCatalogSchema,
  })
  .superRefine((record, context) => {
    if (
      record.reference.id !== record.catalog.id ||
      record.reference.revision !== record.catalog.revision
    )
      context.addIssue({ code: 'custom', message: 'Skill catalog identity mismatch' });
  });
export type SkillCatalogRecord = z.infer<typeof SkillCatalogRecordSchema>;

export const SkillLoadoutCreateSchema = z.strictObject({
  character: RefSchema,
  configuration: SkillConfigurationSchema,
});
export const SkillLoadoutPatchSchema = SkillLoadoutCreateSchema.extend({
  expectedVersion: version,
});
export type SkillLoadoutCreate = z.infer<typeof SkillLoadoutCreateSchema>;
export type SkillLoadoutPatch = z.infer<typeof SkillLoadoutPatchSchema>;

export const SkillLoadoutHeadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: IdSchema,
    version,
    latest: RefSchema,
    snapshot: SkillLoadoutRevisionSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .superRefine((head, context) => {
    if (
      head.latest.id !== head.id ||
      head.latest.revision !== head.snapshot.revision ||
      head.latest.contentHash !== head.snapshot.contentHash ||
      head.snapshot.id !== head.id ||
      head.version !== head.snapshot.configuration.version
    )
      context.addIssue({ code: 'custom', message: 'Skill loadout head mismatch' });
  });
export type SkillLoadoutHead = z.infer<typeof SkillLoadoutHeadSchema>;
export const SkillLoadoutPageSchema = z.strictObject({
  items: z.array(SkillLoadoutHeadSchema).max(100),
  nextCursor: IdSchema.nullable(),
});
export type SkillLoadoutPage = z.infer<typeof SkillLoadoutPageSchema>;

// JobRequestSchema carries the guard that rejects caller-supplied receipts. Keep
// that refinement when adding the server-resolved loadout references.
export const SkillBattleJobRequestSchema = JobRequestSchema.safeExtend({
  loadouts: z
    .array(z.strictObject({ actorId: IdSchema, loadout: RefSchema }))
    .min(1)
    .max(2),
}).superRefine((request, context) => {
  const ids = request.loadouts.map(({ actorId }) => actorId);
  if (new Set(ids).size !== ids.length)
    context.addIssue({ code: 'custom', message: 'Skill battle actor IDs must be unique' });
});
export type SkillBattleJobRequest = z.infer<typeof SkillBattleJobRequestSchema>;
