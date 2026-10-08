import { and, eq } from 'drizzle-orm';
import {
  SkillCatalogRecordSchema,
  revisionRefKey,
  parseCompleteSkillCatalog,
  skillCatalogDigest,
  type RevisionRef,
  type SkillCatalog,
} from '@fantasy/domain';
import { skillCatalogRevisions } from './schema.ts';
import { jsonValue, type Store } from './store.ts';
import { StoreError } from './store-error.ts';

/** Read one immutable catalog revision; a row whose content no longer matches is corrupt. */
export async function readSkillCatalogRecord(store: Store, id: string, revision: number) {
  const row = store.orm
    .select()
    .from(skillCatalogRevisions)
    .where(and(eq(skillCatalogRevisions.id, id), eq(skillCatalogRevisions.revision, revision)))
    .get();
  if (!row) throw new StoreError('not-found', 'Skill catalog revision not found');
  const catalog = parseCompleteSkillCatalog(jsonValue(row.catalogJson)),
    contentHash = await skillCatalogDigest(catalog);
  if (catalog.id !== row.id || catalog.revision !== row.revision || contentHash !== row.contentHash)
    throw new StoreError('conflict', 'Stored skill catalog revision is corrupt');
  return SkillCatalogRecordSchema.parse({
    schemaVersion: 1,
    reference: { id: row.id, revision: row.revision, contentHash },
    catalog,
  });
}

/** Resolve an exact catalog reference; another content hash for the revision is a conflict. */
export async function requireSkillCatalog(store: Store, ref: RevisionRef): Promise<SkillCatalog> {
  const record = await readSkillCatalogRecord(store, ref.id, ref.revision);
  if (record.reference.contentHash !== ref.contentHash)
    throw new StoreError('conflict', 'Skill catalog reference does not match stored content');
  return record.catalog;
}

/** The character's own ability refs followed by each equipment's refs, in definition order. */
export function characterAbilityRefs(store: Store, characterRef: RevisionRef): RevisionRef[] {
  const character = store.requireRevision('character', characterRef);
  return [
    ...character.definition.abilities,
    ...character.definition.equipment.flatMap(
      (ref) => store.requireRevision('equipment', ref).definition.abilities,
    ),
  ];
}

/** Server-owned equipment capabilities; tags remain unavailable until an authoritative contract exists. */
export function characterSkillCapabilities(store: Store, characterRef: RevisionRef) {
  const refs = new Map(
    characterAbilityRefs(store, characterRef).map((ref) => [revisionRefKey(ref), ref]),
  );
  return { equipmentTags: [], abilityRefs: [...refs.values()] };
}
