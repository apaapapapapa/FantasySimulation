import { and, eq } from 'drizzle-orm';
import {
  SkillAcquisitionCreateSchema,
  SkillAcquisitionHeadSchema,
  SkillAcquisitionPatchSchema,
  SkillAcquisitionRevisionSchema,
  SkillAcquisitionSelectionSchema,
  canonicalJson,
  compareIds,
  parseCompleteSkillCatalog,
  parseJson,
  resolveSkillAcquisitionV1,
  skillAcquisitionRevisionHash,
  skillCatalogDigest,
  type RevisionRef,
  type SkillAcquisitionRevision,
  type SkillCatalog,
} from '@fantasy/domain';
import {
  skillAcquisitionHeads,
  skillAcquisitionRevisions,
  skillCatalogRevisions,
} from './schema.ts';
import { jsonValue, type Store } from './store.ts';
import { StoreError } from './store-error.ts';

function invalid(error: unknown): never {
  throw new StoreError(
    'invalid-input',
    (error instanceof Error ? error.message : 'Invalid skill acquisition').slice(0, 1000),
  );
}

const refKey = (ref: RevisionRef) => `${ref.id}@${ref.revision}:${ref.contentHash}`;

export class SkillAcquisitionStore {
  constructor(private readonly store: Store) {}

  private async requireCatalog(ref: RevisionRef): Promise<SkillCatalog> {
    const row = this.store.orm
      .select()
      .from(skillCatalogRevisions)
      .where(
        and(eq(skillCatalogRevisions.id, ref.id), eq(skillCatalogRevisions.revision, ref.revision)),
      )
      .get();
    if (!row) throw new StoreError('not-found', 'Skill catalog revision not found');
    const catalog = parseCompleteSkillCatalog(jsonValue(row.catalogJson)),
      digest = await skillCatalogDigest(catalog);
    if (digest !== row.contentHash || digest !== ref.contentHash)
      throw new StoreError('conflict', 'Skill catalog reference does not match stored content');
    return catalog;
  }

  private capabilities(characterRef: RevisionRef) {
    const character = this.store.requireRevision('character', characterRef);
    if (character.kind !== 'character') throw new StoreError('invalid-input', 'Expected character');
    const refs = new Map(character.definition.abilities.map((ref) => [refKey(ref), ref]));
    for (const equipmentRef of character.definition.equipment) {
      const equipment = this.store.requireRevision('equipment', equipmentRef);
      if (equipment.kind !== 'equipment')
        throw new StoreError('invalid-input', 'Expected equipment');
      for (const ref of equipment.definition.abilities) refs.set(refKey(ref), ref);
    }
    // Equipment revisions do not yet carry authoritative tags. Tagged nodes fail closed rather
    // than deriving inventory from appearance or trusting caller-supplied strings.
    return {
      equipmentTags: [],
      abilityRefs: [...refs.values()].sort((left, right) =>
        refKey(left).localeCompare(refKey(right), 'en'),
      ),
    };
  }

  private async resolveSnapshot(input: unknown): Promise<SkillAcquisitionRevision> {
    const selection = SkillAcquisitionSelectionSchema.parse(input),
      catalog = await this.requireCatalog(selection.catalog);
    this.store.requireRevision('character', selection.character);
    let content;
    try {
      content = await resolveSkillAcquisitionV1(
        catalog,
        {
          ...selection,
          learnedNodeIds: [...selection.learnedNodeIds].sort(compareIds),
        },
        this.capabilities(selection.character),
      );
    } catch (error) {
      invalid(error);
    }
    return SkillAcquisitionRevisionSchema.parse({
      ...content,
      contentHash: await skillAcquisitionRevisionHash(content),
    });
  }

  private insert(snapshot: SkillAcquisitionRevision, createdAt: string) {
    this.store.orm
      .insert(skillAcquisitionRevisions)
      .values({
        id: snapshot.id,
        revision: snapshot.revision,
        policyVersion: snapshot.policyVersion,
        contentHash: snapshot.contentHash,
        catalogId: snapshot.catalog.id,
        catalogRevision: snapshot.catalog.revision,
        characterJson: canonicalJson(snapshot.character),
        eligibilityJson: canonicalJson(snapshot.eligibilityNodeIds),
        learnedJson: canonicalJson(snapshot.learnedNodeIds),
        capabilitiesDigest: snapshot.capabilitiesDigest,
        createdAt,
      })
      .run();
  }

  async revision(ref: RevisionRef) {
    const row = this.store.orm
      .select()
      .from(skillAcquisitionRevisions)
      .where(
        and(
          eq(skillAcquisitionRevisions.id, ref.id),
          eq(skillAcquisitionRevisions.revision, ref.revision),
        ),
      )
      .get();
    if (!row) throw new StoreError('not-found', 'Skill acquisition revision not found');
    const catalogRow = this.store.orm
      .select({ contentHash: skillCatalogRevisions.contentHash })
      .from(skillCatalogRevisions)
      .where(
        and(
          eq(skillCatalogRevisions.id, row.catalogId),
          eq(skillCatalogRevisions.revision, row.catalogRevision),
        ),
      )
      .get();
    if (!catalogRow) throw new StoreError('conflict', 'Skill acquisition catalog is missing');
    const snapshot = parseJson(SkillAcquisitionRevisionSchema, {
        schemaVersion: 1,
        policyVersion: row.policyVersion,
        id: row.id,
        revision: row.revision,
        contentHash: row.contentHash,
        character: jsonValue(row.characterJson),
        catalog: {
          id: row.catalogId,
          revision: row.catalogRevision,
          contentHash: catalogRow.contentHash,
        },
        eligibilityNodeIds: jsonValue(row.eligibilityJson),
        learnedNodeIds: jsonValue(row.learnedJson),
        capabilitiesDigest: row.capabilitiesDigest,
      }),
      { contentHash, ...content } = snapshot;
    if (
      contentHash !== ref.contentHash ||
      contentHash !== (await skillAcquisitionRevisionHash(content))
    )
      throw new StoreError('conflict', 'Skill acquisition revision is corrupt or mismatched');
    await this.requireCatalog(snapshot.catalog);
    this.store.requireRevision('character', snapshot.character);
    return snapshot;
  }

  async head(id: string) {
    const row = this.store.orm
      .select()
      .from(skillAcquisitionHeads)
      .where(eq(skillAcquisitionHeads.id, id))
      .get();
    if (!row) throw new StoreError('not-found', 'Skill acquisition not found');
    const snapshot = await this.revision({
      id: row.id,
      revision: row.latestRevision,
      contentHash: row.latestContentHash,
    });
    return SkillAcquisitionHeadSchema.parse({
      schemaVersion: 1,
      authoritativeBoundary: false,
      id: row.id,
      version: row.version,
      latest: { id: row.id, revision: row.latestRevision, contentHash: row.latestContentHash },
      snapshot,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async create(input: unknown) {
    const request = parseJson(SkillAcquisitionCreateSchema, input);
    if (request.selection.version !== 1)
      throw new StoreError('invalid-input', 'New skill acquisition version must be 1');
    const snapshot = await this.resolveSnapshot(request.selection),
      now = new Date().toISOString();
    this.store.transaction(() => {
      if (
        this.store.orm
          .select({ id: skillAcquisitionHeads.id })
          .from(skillAcquisitionHeads)
          .where(eq(skillAcquisitionHeads.id, snapshot.id))
          .get()
      )
        throw new StoreError('conflict', 'Skill acquisition already exists');
      this.insert(snapshot, now);
      this.store.orm
        .insert(skillAcquisitionHeads)
        .values({
          id: snapshot.id,
          version: 1,
          latestRevision: 1,
          latestContentHash: snapshot.contentHash,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    });
    return this.head(snapshot.id);
  }

  async patch(id: string, input: unknown) {
    const request = parseJson(SkillAcquisitionPatchSchema, input),
      nextVersion = request.expectedVersion + 1;
    if (request.selection.id !== id)
      throw new StoreError('invalid-input', 'Skill acquisition ID cannot change');
    if (request.selection.version !== nextVersion)
      throw new StoreError('invalid-input', 'Skill acquisition version must follow the head');
    const current = await this.head(id);
    if (current.version !== request.expectedVersion)
      throw new StoreError('conflict', 'Skill acquisition changed; reload before saving');
    if (
      canonicalJson(current.snapshot.character) !== canonicalJson(request.selection.character) ||
      canonicalJson(current.snapshot.catalog) !== canonicalJson(request.selection.catalog)
    )
      throw new StoreError(
        'invalid-input',
        'Skill acquisition character and catalog cannot change',
      );
    const snapshot = await this.resolveSnapshot(request.selection),
      now = new Date().toISOString();
    this.store.transaction(() => {
      const locked = this.store.orm
        .select({ version: skillAcquisitionHeads.version })
        .from(skillAcquisitionHeads)
        .where(eq(skillAcquisitionHeads.id, id))
        .get();
      if (locked?.version !== request.expectedVersion)
        throw new StoreError('conflict', 'Skill acquisition changed; reload before saving');
      this.insert(snapshot, now);
      const result = this.store.orm
        .update(skillAcquisitionHeads)
        .set({
          version: nextVersion,
          latestRevision: nextVersion,
          latestContentHash: snapshot.contentHash,
          updatedAt: now,
        })
        .where(
          and(
            eq(skillAcquisitionHeads.id, id),
            eq(skillAcquisitionHeads.version, request.expectedVersion),
          ),
        )
        .run();
      if (!result.changes)
        throw new StoreError('conflict', 'Skill acquisition changed; reload before saving');
    });
    return this.head(id);
  }
}
