import { and, eq } from 'drizzle-orm';
import {
  SkillCatalogRecordSchema,
  SkillLoadoutCreateSchema,
  SkillLoadoutHeadSchema,
  SkillLoadoutPatchSchema,
  SkillLoadoutRevisionSchema,
  canonicalJson,
  parseJson,
  parseCompleteSkillCatalog,
  resolveSkillLoadout,
  skillCatalogDigest,
  skillLoadoutRevisionHash,
  type RevisionRef,
  type SkillCatalog,
  type SkillLoadoutRevision,
} from '@fantasy/domain';
import { skillCatalogRevisions, skillLoadoutHeads, skillLoadoutRevisions } from './schema.ts';
import { jsonValue, type Store } from './store.ts';
import { StoreError } from './store-error.ts';

function invalid(error: unknown): never {
  throw new StoreError(
    'invalid-input',
    (error instanceof Error ? error.message : 'Invalid skill loadout').slice(0, 1000),
  );
}

export class SkillStore {
  constructor(private readonly store: Store) {}

  async seedCatalog(input: unknown) {
    const catalog = parseCompleteSkillCatalog(input),
      contentHash = await skillCatalogDigest(catalog),
      encoded = canonicalJson(catalog),
      now = new Date().toISOString();
    this.store.transaction(() => {
      const existing = this.store.orm
        .select()
        .from(skillCatalogRevisions)
        .where(
          and(
            eq(skillCatalogRevisions.id, catalog.id),
            eq(skillCatalogRevisions.revision, catalog.revision),
          ),
        )
        .get();
      if (existing) {
        if (existing.contentHash !== contentHash || existing.catalogJson !== encoded)
          throw new StoreError('conflict', 'Skill catalog revision is immutable');
        return;
      }
      this.store.orm
        .insert(skillCatalogRevisions)
        .values({
          id: catalog.id,
          revision: catalog.revision,
          contentHash,
          catalogJson: encoded,
          createdAt: now,
        })
        .run();
    });
    return SkillCatalogRecordSchema.parse({
      schemaVersion: 1,
      reference: { id: catalog.id, revision: catalog.revision, contentHash },
      catalog,
    });
  }

  async catalog(id: string, revision: number) {
    const row = this.store.orm
      .select()
      .from(skillCatalogRevisions)
      .where(and(eq(skillCatalogRevisions.id, id), eq(skillCatalogRevisions.revision, revision)))
      .get();
    if (!row) throw new StoreError('not-found', 'Skill catalog revision not found');
    const catalog = parseCompleteSkillCatalog(jsonValue(row.catalogJson)),
      contentHash = await skillCatalogDigest(catalog);
    if (
      catalog.id !== row.id ||
      catalog.revision !== row.revision ||
      contentHash !== row.contentHash
    )
      throw new StoreError('conflict', 'Stored skill catalog revision is corrupt');
    return SkillCatalogRecordSchema.parse({
      schemaVersion: 1,
      reference: { id: row.id, revision: row.revision, contentHash },
      catalog,
    });
  }

  private async requireCatalog(ref: RevisionRef): Promise<SkillCatalog> {
    const record = await this.catalog(ref.id, ref.revision);
    if (record.reference.contentHash !== ref.contentHash)
      throw new StoreError('conflict', 'Skill catalog reference does not match stored content');
    return record.catalog;
  }

  private async resolveSnapshot(
    character: RevisionRef,
    configurationInput: unknown,
    revision: number,
  ): Promise<SkillLoadoutRevision> {
    const configuration = SkillLoadoutCreateSchema.shape.configuration.parse(configurationInput);
    this.store.requireRevision('character', character);
    const catalog = await this.requireCatalog(configuration.catalog);
    let resolved;
    try {
      // Equipment tag contracts are not part of SK-02. Nodes requiring one fail closed.
      resolved = await resolveSkillLoadout(catalog, configuration, []);
      for (const node of resolved.nodeResolutions)
        for (const resolution of node.resolution) {
          if (resolution.kind === 'augment') {
            this.store.requireRevision('ability', resolution.baseAbility);
            this.store.requireRevision('ability', resolution.resolvedAbility);
          } else this.store.requireRevision('ability', resolution.ability);
        }
    } catch (error) {
      invalid(error);
    }
    const content = {
        schemaVersion: 1 as const,
        id: configuration.id,
        revision,
        character,
        configuration,
        resolved,
      },
      contentHash = await skillLoadoutRevisionHash(content);
    return SkillLoadoutRevisionSchema.parse({ ...content, contentHash });
  }

  private insertSnapshot(snapshot: SkillLoadoutRevision, createdAt: string) {
    this.store.orm
      .insert(skillLoadoutRevisions)
      .values({
        id: snapshot.id,
        revision: snapshot.revision,
        contentHash: snapshot.contentHash,
        catalogId: snapshot.configuration.catalog.id,
        catalogRevision: snapshot.configuration.catalog.revision,
        characterJson: canonicalJson(snapshot.character),
        configurationJson: canonicalJson(snapshot.configuration),
        resolvedJson: canonicalJson(snapshot.resolved),
        createdAt,
      })
      .run();
  }

  private snapshotRow(id: string, revision: number): SkillLoadoutRevision | undefined {
    const row = this.store.orm
      .select()
      .from(skillLoadoutRevisions)
      .where(and(eq(skillLoadoutRevisions.id, id), eq(skillLoadoutRevisions.revision, revision)))
      .get();
    return row
      ? parseJson(SkillLoadoutRevisionSchema, {
          schemaVersion: 1,
          id: row.id,
          revision: row.revision,
          contentHash: row.contentHash,
          character: jsonValue(row.characterJson),
          configuration: jsonValue(row.configurationJson),
          resolved: jsonValue(row.resolvedJson),
        })
      : undefined;
  }

  async revision(ref: RevisionRef) {
    const snapshot = this.snapshotRow(ref.id, ref.revision);
    if (!snapshot) throw new StoreError('not-found', 'Skill loadout revision not found');
    const { contentHash, ...content } = snapshot;
    if (
      contentHash !== ref.contentHash ||
      contentHash !== (await skillLoadoutRevisionHash(content))
    )
      throw new StoreError('conflict', 'Skill loadout revision is corrupt or mismatched');
    await this.requireCatalog(snapshot.configuration.catalog);
    this.store.requireRevision('character', snapshot.character);
    return snapshot;
  }

  async head(id: string) {
    const row = this.store.orm
      .select()
      .from(skillLoadoutHeads)
      .where(eq(skillLoadoutHeads.id, id))
      .get();
    if (!row) throw new StoreError('not-found', 'Skill loadout not found');
    const snapshot = await this.revision({
      id: row.id,
      revision: row.latestRevision,
      contentHash: row.latestContentHash,
    });
    return SkillLoadoutHeadSchema.parse({
      schemaVersion: 1,
      id: row.id,
      version: row.version,
      latest: {
        id: row.id,
        revision: row.latestRevision,
        contentHash: row.latestContentHash,
      },
      snapshot,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async create(input: unknown) {
    const request = parseJson(SkillLoadoutCreateSchema, input);
    if (request.configuration.version !== 1)
      throw new StoreError('invalid-input', 'New skill loadout version must be 1');
    const snapshot = await this.resolveSnapshot(request.character, request.configuration, 1),
      now = new Date().toISOString();
    this.store.transaction(() => {
      if (
        this.store.orm
          .select({ id: skillLoadoutHeads.id })
          .from(skillLoadoutHeads)
          .where(eq(skillLoadoutHeads.id, snapshot.id))
          .get()
      )
        throw new StoreError('conflict', 'Skill loadout already exists');
      this.insertSnapshot(snapshot, now);
      this.store.orm
        .insert(skillLoadoutHeads)
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
    const request = parseJson(SkillLoadoutPatchSchema, input),
      nextVersion = request.expectedVersion + 1;
    if (request.configuration.id !== id)
      throw new StoreError('invalid-input', 'Skill loadout ID cannot change');
    if (request.configuration.version !== nextVersion)
      throw new StoreError('invalid-input', 'Skill configuration version must follow the head');
    const current = await this.head(id);
    if (current.version !== request.expectedVersion)
      throw new StoreError('conflict', 'Skill loadout changed; reload before saving');
    const snapshot = await this.resolveSnapshot(
        request.character,
        request.configuration,
        nextVersion,
      ),
      now = new Date().toISOString();
    this.store.transaction(() => {
      const locked = this.store.orm
        .select({ version: skillLoadoutHeads.version })
        .from(skillLoadoutHeads)
        .where(eq(skillLoadoutHeads.id, id))
        .get();
      if (locked?.version !== request.expectedVersion)
        throw new StoreError('conflict', 'Skill loadout changed; reload before saving');
      this.insertSnapshot(snapshot, now);
      const result = this.store.orm
        .update(skillLoadoutHeads)
        .set({
          version: nextVersion,
          latestRevision: nextVersion,
          latestContentHash: snapshot.contentHash,
          updatedAt: now,
        })
        .where(
          and(eq(skillLoadoutHeads.id, id), eq(skillLoadoutHeads.version, request.expectedVersion)),
        )
        .run();
      if (!result.changes)
        throw new StoreError('conflict', 'Skill loadout changed; reload before saving');
    });
    return this.head(id);
  }
}
