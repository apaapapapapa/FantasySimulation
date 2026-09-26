import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { and, asc, desc, eq, gt, lt, max, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { alias } from 'drizzle-orm/sqlite-core';
import { battleSpecs, definitionDrafts, publishedRevisions } from './schema.ts';
import {
  canonicalJson,
  revisionKey,
  requireRevision,
  revisionIndex,
  DraftInputSchema,
  DraftSchema,
  ManifestSchema,
  StoredManifestSchema,
  parseJson,
  RevisionSchema,
  SpecInputSchema,
  type DefinitionKind,
  type Draft,
  type Revision,
  type RevisionRef,
  type SpecInput,
} from '@fantasy/domain/spatial';
import {
  reference,
  ManifestBuilder,
  revisionHash,
  sealRevision,
  unsupportedExecutionReason,
  requireMechanics,
  requireExecutableRules,
  type PreparedBattle,
} from '@fantasy/engine/spatial';
import { repositoryRoot } from '../config.ts';

import { StoreError } from './store-error.ts';
export { StoreError } from './store-error.ts';
export function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('Invalid JSON in database');
  return JSON.parse(value) as unknown;
}
export class Store {
  readonly db: Database.Database;
  readonly orm: BetterSQLite3Database;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.orm = drizzle(this.db);
    try {
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('busy_timeout = 5000');
      // The official migrator and Kit share the same SQL, journal and receipts.
      migrate(this.orm, { migrationsFolder: join(repositoryRoot, 'db/drizzle') });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  transaction<T>(work: () => T): T {
    return this.orm.transaction(
      () => {
        const value = work();
        if (value instanceof Promise) throw new Error('Database transactions cannot await');
        return value;
      },
      { behavior: 'immediate' },
    );
  }
  getRevision(kind: DefinitionKind, id: string, revision?: number): Revision | undefined {
    const row = this.orm
      .select({ revisionJson: publishedRevisions.revisionJson })
      .from(publishedRevisions)
      .where(
        and(
          eq(publishedRevisions.kind, kind),
          eq(publishedRevisions.definitionId, id),
          revision === undefined ? undefined : eq(publishedRevisions.revision, revision),
        ),
      )
      .orderBy(desc(publishedRevisions.revision))
      .limit(1)
      .get();
    return row ? parseJson(RevisionSchema, jsonValue(row.revisionJson)) : undefined;
  }
  requireRevision(kind: DefinitionKind, ref: RevisionRef): Revision {
    return requireRevision((kind, ref) => this.getRevision(kind, ref.id, ref.revision), kind, ref);
  }
  listRevisions(kind: DefinitionKind, limit = 50, cursor = '') {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new StoreError('invalid-input', 'Page size must be 1..100');
    const latest = alias(publishedRevisions, 'latest');
    const last = this.orm
      .select({ value: max(latest.revision) })
      .from(latest)
      .where(
        and(
          eq(latest.kind, publishedRevisions.kind),
          eq(latest.definitionId, publishedRevisions.definitionId),
        ),
      );
    const rows = this.orm
      .select({ revisionJson: publishedRevisions.revisionJson })
      .from(publishedRevisions)
      .where(
        and(
          eq(publishedRevisions.kind, kind),
          gt(publishedRevisions.definitionId, cursor),
          eq(publishedRevisions.revision, last),
        ),
      )
      .orderBy(asc(publishedRevisions.definitionId))
      .limit(limit + 1)
      .all();
    const items = rows
      .slice(0, limit)
      .map((row) => parseJson(RevisionSchema, jsonValue(row.revisionJson)));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }
  private insertRevision(revision: Revision, now: string) {
    this.orm
      .insert(publishedRevisions)
      .values({
        kind: revision.kind,
        definitionId: revision.id,
        revision: revision.revision,
        contentHash: revision.contentHash,
        revisionJson: canonicalJson(revision),
        createdAt: now,
      })
      .run();
  }
  async seedRevisions(input: unknown[]) {
    return this.loadRevisions(input, 'missing-definition');
  }
  async loadPinnedRevisions(input: unknown[]) {
    return this.loadRevisions(input, 'exact-revision');
  }
  private async loadRevisions(input: unknown[], mode: 'missing-definition' | 'exact-revision') {
    if (input.length > (mode === 'exact-revision' ? 4096 : 256))
      throw new StoreError('invalid-input', 'Revision import exceeds its limit');
    const revisions = input.map((r) => parseJson(RevisionSchema, r));
    if (new Set(revisions.map(revisionKey)).size !== revisions.length)
      throw new StoreError('invalid-input', 'Duplicate revision identity');
    for (const r of revisions)
      if (r.contentHash !== (await revisionHash(r)))
        throw new StoreError('invalid-input', 'Sample revision hash mismatch');
    this.transaction(() => {
      const additions = revisions.filter((r) => {
        const existing = this.getRevision(
          r.kind,
          r.id,
          mode === 'exact-revision' ? r.revision : undefined,
        );
        if (existing && mode === 'exact-revision' && canonicalJson(existing) !== canonicalJson(r))
          throw new StoreError(
            'conflict',
            'Pinned revision conflicts with immutable stored content',
          );
        return !existing;
      });
      const available = new Map(additions.map((r) => [revisionKey(r), r]));
      const get = (kind: DefinitionKind, ref: RevisionRef) => {
        const r =
          available.get(`${kind}:${ref.id}:${ref.revision}`) ?? this.requireRevision(kind, ref);
        if (r.contentHash !== ref.contentHash)
          throw new StoreError('conflict', 'Sample conflicts with an existing revision');
        return r;
      };
      new ManifestBuilder(get).closure(additions, mode === 'exact-revision' ? 4096 : 256);
      const now = new Date().toISOString();
      for (const r of additions) this.insertRevision(r, now);
    });
  }
  createDraft(input: unknown): Draft {
    const draft = parseJson(DraftInputSchema, input),
      id = randomUUID(),
      now = new Date().toISOString();
    return this.transaction(() => {
      this.checkDraftBase(draft);
      this.orm
        .insert(definitionDrafts)
        .values({
          id,
          kind: draft.kind,
          definitionId: draft.definitionId,
          version: 1,
          definitionJson: canonicalJson(draft.definition),
          publishedJson: null,
          createdAt: now,
          updatedAt: now,
          baseRevisionJson: draft.base === null ? null : canonicalJson(draft.base),
        })
        .run();
      return this.getDraft(id)!;
    });
  }
  private checkDraftBase(draft: Pick<Draft, 'kind' | 'definitionId' | 'base'>) {
    const latest = this.getRevision(draft.kind, draft.definitionId);
    if (canonicalJson(latest ? reference(latest) : null) !== canonicalJson(draft.base))
      throw new StoreError(
        'conflict',
        'Published revision changed; create a draft from the current revision',
      );
  }
  getDraft(id: string): Draft | undefined {
    const row = this.orm.select().from(definitionDrafts).where(eq(definitionDrafts.id, id)).get();
    return row
      ? parseJson(DraftSchema, {
          id: row.id,
          kind: row.kind,
          definitionId: row.definitionId,
          base: row.baseRevisionJson === null ? null : jsonValue(row.baseRevisionJson),
          version: row.version,
          definition: jsonValue(row.definitionJson),
          published: row.publishedJson === null ? null : jsonValue(row.publishedJson),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
      : undefined;
  }
  patchDraft(id: string, expectedVersion: number, definition: unknown): Draft {
    const encoded = canonicalJson(definition);
    const result = this.orm
      .update(definitionDrafts)
      .set({
        definitionJson: encoded,
        version: sql`${definitionDrafts.version} + 1`,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(definitionDrafts.id, id),
          eq(definitionDrafts.version, expectedVersion),
          lt(definitionDrafts.version, 2147483647),
        ),
      )
      .run();
    if (!result.changes)
      throw new StoreError(
        this.getDraft(id) ? 'conflict' : 'not-found',
        'Draft missing or changed; reload before editing',
      );
    return this.getDraft(id)!;
  }
  private async candidate(id: string, expectedVersion?: number) {
    const draft = this.getDraft(id);
    if (!draft) throw new StoreError('not-found', 'Draft not found');
    if (expectedVersion !== undefined && draft.version !== expectedVersion)
      throw new StoreError('conflict', 'Draft changed; reload before publishing');
    this.checkDraftBase(draft);
    const parsed = parseJson(RevisionSchema, {
      kind: draft.kind,
      id: draft.definitionId,
      revision: 1,
      schemaVersion: 1,
      contentHash: `sha256:${'0'.repeat(64)}`,
      definition: draft.definition,
    });
    const revision = await sealRevision(parsed.kind, parsed.id, 1, parsed.definition);
    new ManifestBuilder((kind, ref) => this.requireRevision(kind, ref)).closure([revision]);
    return { draft, revision };
  }
  async validateDraft(id: string) {
    if (!this.getDraft(id)) throw new StoreError('not-found', 'Draft not found');
    try {
      await this.candidate(id);
      return { valid: true, issues: [] };
    } catch (error) {
      return {
        valid: false,
        issues: [(error instanceof Error ? error.message : 'Invalid definition').slice(0, 1000)],
      };
    }
  }
  async publishDraft(id: string, expectedVersion: number) {
    const { draft, revision } = await this.candidate(id, expectedVersion);
    return this.transaction(() => {
      if (this.getDraft(id)?.version !== draft.version)
        throw new StoreError('conflict', 'Draft changed during validation');
      this.checkDraftBase(draft);
      const last = this.getRevision(draft.kind, draft.definitionId);
      revision.revision = (last?.revision ?? 0) + 1;
      RevisionSchema.parse(revision);
      if (draft.version >= 2147483647) throw new StoreError('conflict', 'Draft version exhausted');
      const now = new Date().toISOString();
      this.insertRevision(revision, now);
      this.orm
        .update(definitionDrafts)
        .set({
          version: sql`${definitionDrafts.version} + 1`,
          publishedJson: canonicalJson(reference(revision)),
          baseRevisionJson: canonicalJson(reference(revision)),
          updatedAt: now,
        })
        .where(
          and(
            eq(definitionDrafts.id, id),
            eq(definitionDrafts.version, expectedVersion),
            lt(definitionDrafts.version, 2147483647),
          ),
        )
        .run();
      return { draft: this.getDraft(id)!, revision };
    });
  }
  async prepareSpec(input: SpecInput): Promise<PreparedBattle> {
    const request = parseJson(SpecInputSchema, input);
    return new ManifestBuilder((kind, ref) => this.requireRevision(kind, ref)).build(request);
  }
  saveSpec(battle: PreparedBattle) {
    const encoded = canonicalJson(battle.manifest);
    this.orm
      .insert(battleSpecs)
      .values({
        simulationHash: battle.simulationHash,
        manifestJson: encoded,
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing({ target: battleSpecs.simulationHash })
      .run();
    const row = this.orm
      .select({ manifestJson: battleSpecs.manifestJson })
      .from(battleSpecs)
      .where(eq(battleSpecs.simulationHash, battle.simulationHash))
      .get();
    if (row?.manifestJson !== encoded) throw new Error('Battle specification hash collision');
    return { simulationHash: battle.simulationHash, manifest: battle.manifest };
  }
  getSpec(simulationHash: string) {
    const row = this.orm
      .select({ manifestJson: battleSpecs.manifestJson })
      .from(battleSpecs)
      .where(eq(battleSpecs.simulationHash, simulationHash))
      .get();
    return row
      ? { simulationHash, manifest: parseJson(StoredManifestSchema, jsonValue(row.manifestJson)) }
      : undefined;
  }
  requireExecutableSpec(simulationHash: string) {
    const spec = this.getSpec(simulationHash);
    if (!spec) throw new StoreError('conflict', 'Saved specification is unavailable');
    const reason = unsupportedExecutionReason(spec.manifest);
    if (reason) throw new StoreError('conflict', reason);
    const manifest = parseJson(ManifestSchema, spec.manifest);
    const rules = requireRevision(revisionIndex(manifest.revisions), 'ruleset', manifest.ruleset);
    requireExecutableRules(rules.definition);
    requireMechanics(rules, manifest.revisions);
    return { simulationHash, manifest };
  }
}
export const openStore = (filename: string) => new Store(filename);
export function readSampleRevisions(): unknown[] {
  const value: unknown = JSON.parse(
    readFileSync(join(repositoryRoot, 'data/spatial/catalog.json'), 'utf8'),
  );
  if (!Array.isArray(value)) throw new Error('Invalid sample catalog');
  return value;
}
