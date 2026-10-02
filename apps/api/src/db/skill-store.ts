import { and, asc, eq, gt } from 'drizzle-orm';
import {
  AnySkillConfigurationSchema,
  AnySkillLoadoutHeadSchema,
  AnySkillLoadoutPageSchema,
  AnySkillLoadoutRevisionSchema,
  SkillLoadoutCreateSchema,
  SkillLoadoutCreateV2Schema,
  SkillLoadoutPatchSchema,
  SkillLoadoutPatchV2Schema,
  SkillCatalogRecordSchema,
  canonicalJson,
  compareIds,
  parseJson,
  parseCompleteSkillCatalog,
  resolveSkillLoadout,
  skillBattleReceipt,
  skillCatalogDigest,
  skillLoadoutRevisionHash,
  type RevisionRef,
  type AnySkillLoadoutCreate,
  type AnySkillLoadoutPatch,
  type SkillCatalog,
  type AnySkillLoadoutRevision,
  type AnyResolvedSkillLoadout,
} from '@fantasy/domain';
import { skillCatalogRevisions, skillLoadoutHeads, skillLoadoutRevisions } from './schema.ts';
import { SkillAcquisitionStore } from './skill-acquisition-store.ts';
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

  private validateV2Applicability(characterRef: RevisionRef, resolved: AnyResolvedSkillLoadout) {
    if (resolved.schemaVersion !== 2) return;
    const character = this.store.requireRevision('character', characterRef);
    if (character.kind !== 'character') throw new Error('Expected character revision');
    const equipped = new Map<string, RevisionRef>();
    for (const ref of character.definition.abilities) equipped.set(ref.id, ref);
    for (const equipmentRef of character.definition.equipment) {
      const equipment = this.store.requireRevision('equipment', equipmentRef);
      if (equipment.kind !== 'equipment') throw new Error('Expected equipment revision');
      for (const ref of equipment.definition.abilities) equipped.set(ref.id, ref);
    }
    for (const node of resolved.nodeResolutions)
      for (const resolution of node.resolution) {
        if (resolution.kind === 'augment') {
          const base = this.store.requireRevision('ability', resolution.baseAbility),
            replacement = this.store.requireRevision('ability', resolution.resolvedAbility),
            owned = equipped.get(base.id);
          if (!owned || canonicalJson(owned) !== canonicalJson(resolution.baseAbility))
            throw new Error(`Augment base ability is not in the character loadout: ${base.id}`);
          if (
            base.kind !== 'ability' ||
            replacement.kind !== 'ability' ||
            base.definition.trigger !== replacement.definition.trigger
          )
            throw new Error(`Augment must preserve ability trigger: ${base.id}`);
          continue;
        }
        const ability = this.store.requireRevision('ability', resolution.ability);
        if (ability.kind !== 'ability') throw new Error('Expected ability revision');
        if (resolution.kind === 'active-ability' && ability.definition.trigger !== 'action')
          throw new Error(`Active skill ability must use the action trigger: ${ability.id}`);
        if (resolution.kind === 'passive-ability' && ability.definition.trigger === 'action')
          throw new Error(`Passive skill ability cannot use the action trigger: ${ability.id}`);
        const previous = equipped.get(ability.id);
        if (previous && canonicalJson(previous) !== canonicalJson(resolution.ability))
          throw new Error(`Skill ability conflicts with equipped ability: ${ability.id}`);
      }
  }

  private async resolveSnapshot(
    character: RevisionRef,
    configurationInput: unknown,
    revision: number,
  ): Promise<AnySkillLoadoutRevision> {
    const parsedConfiguration = AnySkillConfigurationSchema.parse(configurationInput),
      configuration =
        parsedConfiguration.schemaVersion === 1
          ? {
              ...parsedConfiguration,
              eligibilityNodeIds: [...parsedConfiguration.eligibilityNodeIds].sort(compareIds),
              learnedNodeIds: [...parsedConfiguration.learnedNodeIds].sort(compareIds),
              enabledNodeIds: [...parsedConfiguration.enabledNodeIds].sort(compareIds),
            }
          : {
              ...parsedConfiguration,
              enabledNodeIds: [...parsedConfiguration.enabledNodeIds].sort(compareIds),
            };
    this.store.requireRevision('character', character);
    const catalog = await this.requireCatalog(configuration.catalog);
    let resolved;
    try {
      // Equipment tag contracts are not part of SK-02. Nodes requiring one fail closed.
      if (configuration.schemaVersion === 1)
        resolved = await resolveSkillLoadout(catalog, configuration, []);
      else {
        const acquisition = await new SkillAcquisitionStore(this.store).revision(
          configuration.acquisition,
        );
        if (canonicalJson(acquisition.character) !== canonicalJson(character))
          throw new Error('Skill acquisition character does not match loadout character');
        resolved = await resolveSkillLoadout(catalog, configuration, [], acquisition);
      }
      for (const node of resolved.nodeResolutions)
        for (const resolution of node.resolution) {
          if (resolution.kind === 'augment') {
            this.store.requireRevision('ability', resolution.baseAbility);
            this.store.requireRevision('ability', resolution.resolvedAbility);
          } else this.store.requireRevision('ability', resolution.ability);
        }
      this.validateV2Applicability(character, resolved);
    } catch (error) {
      invalid(error);
    }
    if (configuration.schemaVersion !== resolved.schemaVersion)
      throw new StoreError('conflict', 'Skill loadout resolver version mismatch');
    const content =
        configuration.schemaVersion === 1 && resolved.schemaVersion === 1
          ? {
              schemaVersion: 1 as const,
              id: configuration.id,
              revision,
              character,
              configuration,
              resolved,
            }
          : configuration.schemaVersion === 2 && resolved.schemaVersion === 2
            ? {
                schemaVersion: 2 as const,
                id: configuration.id,
                revision,
                character,
                configuration,
                resolved,
              }
            : invalid('Skill loadout resolver version mismatch'),
      contentHash = await skillLoadoutRevisionHash(content);
    const snapshot = AnySkillLoadoutRevisionSchema.parse({ ...content, contentHash });
    try {
      await skillBattleReceipt(snapshot);
    } catch (error) {
      invalid(error);
    }
    return snapshot;
  }

  private insertSnapshot(snapshot: AnySkillLoadoutRevision, createdAt: string) {
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

  private snapshotRow(id: string, revision: number): AnySkillLoadoutRevision | undefined {
    const row = this.store.orm
      .select()
      .from(skillLoadoutRevisions)
      .where(and(eq(skillLoadoutRevisions.id, id), eq(skillLoadoutRevisions.revision, revision)))
      .get();
    return row
      ? parseJson(AnySkillLoadoutRevisionSchema, {
          schemaVersion:
            (jsonValue(row.configurationJson) as { schemaVersion?: number }).schemaVersion === 2
              ? 2
              : 1,
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
    return AnySkillLoadoutHeadSchema.parse({
      schemaVersion: snapshot.schemaVersion,
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

  async list(limit: number, cursor?: string) {
    const rows = this.store.orm
        .select({ id: skillLoadoutHeads.id })
        .from(skillLoadoutHeads)
        .where(cursor ? gt(skillLoadoutHeads.id, cursor) : undefined)
        .orderBy(asc(skillLoadoutHeads.id))
        .limit(limit + 1)
        .all(),
      page = rows.slice(0, limit);
    return AnySkillLoadoutPageSchema.parse({
      items: await Promise.all(page.map(({ id }) => this.head(id))),
      nextCursor: rows.length > limit ? page.at(-1)!.id : null,
    });
  }

  async create(input: unknown) {
    return this.createParsed(parseJson(SkillLoadoutCreateV2Schema, input));
  }

  /** Preserve existing schema-v1 fixtures/history without exposing legacy writes over HTTP. */
  async createLegacy(input: unknown) {
    return this.createParsed(parseJson(SkillLoadoutCreateSchema, input));
  }

  private async createParsed(request: AnySkillLoadoutCreate) {
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
    return this.patchParsed(id, parseJson(SkillLoadoutPatchV2Schema, input));
  }

  /** Preserve controlled schema-v1 fixture construction; HTTP routes never call this method. */
  async patchLegacy(id: string, input: unknown) {
    return this.patchParsed(id, parseJson(SkillLoadoutPatchSchema, input));
  }

  private async patchParsed(id: string, request: AnySkillLoadoutPatch) {
    const nextVersion = request.expectedVersion + 1;
    if (request.configuration.id !== id)
      throw new StoreError('invalid-input', 'Skill loadout ID cannot change');
    if (request.configuration.version !== nextVersion)
      throw new StoreError('invalid-input', 'Skill configuration version must follow the head');
    const current = await this.head(id);
    if (current.version !== request.expectedVersion)
      throw new StoreError('conflict', 'Skill loadout changed; reload before saving');
    if (current.schemaVersion === 2 && request.configuration.schemaVersion === 1)
      throw new StoreError('invalid-input', 'Schema v2 loadouts cannot downgrade to schema v1');
    if (
      request.configuration.schemaVersion === 2 &&
      (canonicalJson(current.snapshot.character) !== canonicalJson(request.character) ||
        canonicalJson(current.snapshot.configuration.catalog) !==
          canonicalJson(request.configuration.catalog) ||
        (current.schemaVersion === 2 &&
          current.snapshot.configuration.acquisition.id !== request.configuration.acquisition.id))
    )
      throw new StoreError(
        'invalid-input',
        'Schema v2 loadout character, catalog and acquisition identity cannot change',
      );
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
