import { z } from 'zod';
import {
  SkillAcquisitionRevisionSchema,
  SkillAcquisitionSelectionSchema,
} from './skill-acquisition.ts';
import {
  SkillConfigurationSchema,
  SkillConfigurationV2Schema,
  SkillLoadoutRevisionSchema,
  SkillLoadoutRevisionV2Schema,
} from './skill-loadout.ts';
import { SkillCatalogSchema } from './skill-system.ts';
import { JobRequestSchema } from './spatial/api.ts';
import { IdSchema, RefSchema } from './spatial/contracts.ts';

const version = z.number().int().min(1).max(1_000_000);
const revisionHeadFields = {
  id: IdSchema,
  version,
  latest: RefSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

function validateLoadoutHead(
  head: {
    id: string;
    version: number;
    latest: z.infer<typeof RefSchema>;
    snapshot: {
      id: string;
      revision: number;
      contentHash: string;
      configuration: { version: number };
    };
  },
  context: z.RefinementCtx,
) {
  if (
    head.latest.id !== head.id ||
    head.latest.revision !== head.snapshot.revision ||
    head.latest.contentHash !== head.snapshot.contentHash ||
    head.snapshot.id !== head.id ||
    head.version !== head.snapshot.configuration.version
  )
    context.addIssue({ code: 'custom', message: 'Skill loadout head mismatch' });
}

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
export const SkillLoadoutCreateV2Schema = z.strictObject({
  character: RefSchema,
  configuration: SkillConfigurationV2Schema,
});
export const SkillLoadoutPatchV2Schema = SkillLoadoutCreateV2Schema.extend({
  expectedVersion: version,
});
export const AnySkillLoadoutCreateSchema = z.union([
  SkillLoadoutCreateSchema,
  SkillLoadoutCreateV2Schema,
]);
export const AnySkillLoadoutPatchSchema = z.union([
  SkillLoadoutPatchSchema,
  SkillLoadoutPatchV2Schema,
]);
export type AnySkillLoadoutCreate = z.infer<typeof AnySkillLoadoutCreateSchema>;
export type AnySkillLoadoutPatch = z.infer<typeof AnySkillLoadoutPatchSchema>;

export const SkillLoadoutHeadSchema = z
  .strictObject({
    ...revisionHeadFields,
    schemaVersion: z.literal(1),
    snapshot: SkillLoadoutRevisionSchema,
  })
  .superRefine(validateLoadoutHead);
export type SkillLoadoutHead = z.infer<typeof SkillLoadoutHeadSchema>;
export const SkillLoadoutPageSchema = z.strictObject({
  items: z.array(SkillLoadoutHeadSchema).max(100),
  nextCursor: IdSchema.nullable(),
});
export type SkillLoadoutPage = z.infer<typeof SkillLoadoutPageSchema>;

export const SkillLoadoutHeadV2Schema = z
  .strictObject({
    ...revisionHeadFields,
    schemaVersion: z.literal(2),
    snapshot: SkillLoadoutRevisionV2Schema,
  })
  .superRefine(validateLoadoutHead);
export const AnySkillLoadoutHeadSchema = z.union([
  SkillLoadoutHeadSchema,
  SkillLoadoutHeadV2Schema,
]);
export type AnySkillLoadoutHead = z.infer<typeof AnySkillLoadoutHeadSchema>;
export const AnySkillLoadoutPageSchema = z.strictObject({
  items: z.array(AnySkillLoadoutHeadSchema).max(100),
  nextCursor: IdSchema.nullable(),
});

export const SkillAcquisitionCreateSchema = z.strictObject({
  selection: SkillAcquisitionSelectionSchema,
});
export const SkillAcquisitionPatchSchema = SkillAcquisitionCreateSchema.extend({
  expectedVersion: version,
});
export const SkillAcquisitionHeadSchema = z
  .strictObject({
    ...revisionHeadFields,
    schemaVersion: z.literal(1),
    authoritativeBoundary: z.literal(false),
    snapshot: SkillAcquisitionRevisionSchema,
  })
  .superRefine((head, context) => {
    if (
      head.latest.id !== head.id ||
      head.latest.revision !== head.snapshot.revision ||
      head.latest.contentHash !== head.snapshot.contentHash ||
      head.snapshot.id !== head.id ||
      head.version !== head.snapshot.revision
    )
      context.addIssue({ code: 'custom', message: 'Skill acquisition head mismatch' });
  });
export type SkillAcquisitionHead = z.infer<typeof SkillAcquisitionHeadSchema>;

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
