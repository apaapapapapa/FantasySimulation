import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { and, asc, desc, eq, gt, lt, max, sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { alias } from 'drizzle-orm/sqlite-core';
import { battleSpecs, definitionDrafts, publishedRevisions } from './db/schema.ts';
import {
  canonicalJson,
  contentHash,
  CURRENT_ENGINE_VERSION,
  DraftInputSchema,
  DraftSchema,
  ManifestSchema,
  StoredManifestSchema,
  parseJson,
  RevisionSchema,
  SpecInputSchema,
  statusTransformationRefs,
  type DefinitionKind,
  type Draft,
  type Revision,
  type RevisionRef,
  type SpecInput,
} from '@fantasy/domain/spatial';
import {
  implementation,
  profile,
  prepareBattle,
  reference,
  revisionHash,
  sealRevision,
  unsupportedExecutionReason,
  type PreparedBattle,
} from '@fantasy/engine/spatial';
import { repositoryRoot } from './config.ts';

export class StoreError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
export function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('Invalid JSON in database');
  return JSON.parse(value) as unknown;
}
type Dependency = { kind: DefinitionKind; ref: RevisionRef };
function dependencies(revision: Revision): Dependency[] {
  switch (revision.kind) {
    case 'character':
      return [
        { kind: 'policy', ref: revision.definition.policy },
        ...revision.definition.abilities.map((ref) => ({ kind: 'ability' as const, ref })),
        ...revision.definition.equipment.map((ref) => ({ kind: 'equipment' as const, ref })),
      ];
    case 'equipment':
      return revision.definition.abilities.map((ref) => ({ kind: 'ability', ref }));
    case 'ability':
      return revision.definition.effects.flatMap((e) =>
        e.kind === 'apply-status' ? [{ kind: 'status' as const, ref: e.status }] : [],
      );
    case 'status':
      return statusTransformationRefs(revision.definition).map((ref) => ({ kind: 'status', ref }));
    case 'policy':
    case 'scenario':
    case 'ruleset':
      return [];
  }
}
const revisionKey = (r: Pick<Revision, 'kind' | 'id' | 'revision'>) =>
  `${r.kind}:${r.id}:${r.revision}`;
function resolveClosure(
  roots: Revision[],
  get: (kind: DefinitionKind, ref: RevisionRef) => Revision,
  limit = 256,
): Revision[] {
  const found = new Map<string, Revision>();
  const visit = (r: Revision) => {
    const key = revisionKey(r);
    if (found.has(key)) return;
    if (found.size >= limit) throw new StoreError(400, `Revision closure exceeds ${limit} entries`);
    found.set(key, r);
    for (const d of dependencies(r)) visit(get(d.kind, d.ref));
  };
  roots.forEach(visit);
  for (const r of found.values())
    if (r.kind === 'character') {
      const policy = get('policy', r.definition.policy);
      const equipment = r.definition.equipment.map((ref) => get('equipment', ref));
      const abilities = [
        ...r.definition.abilities,
        ...equipment.flatMap((e) => (e.kind === 'equipment' ? e.definition.abilities : [])),
      ];
      const ids = new Set(abilities.map((a) => a.id));
      if (ids.size !== abilities.length) throw new StoreError(400, 'Duplicate actor ability');
      if (
        policy.kind !== 'policy' ||
        policy.definition.priorities.some((p) => !ids.has(p.abilityId))
      )
        throw new StoreError(400, 'Policy references an unavailable ability');
    }
  return [...found.values()];
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
    const r = this.getRevision(kind, ref.id, ref.revision);
    if (!r || r.contentHash !== ref.contentHash)
      throw new StoreError(400, `Missing or mismatched ${kind} revision: ${ref.id}`);
    return r;
  }
  listRevisions(kind: DefinitionKind, limit = 50, cursor = '') {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new StoreError(400, 'Page size must be 1..100');
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
      throw new StoreError(400, 'Revision import exceeds its limit');
    const revisions = input.map((r) => parseJson(RevisionSchema, r));
    if (new Set(revisions.map(revisionKey)).size !== revisions.length)
      throw new StoreError(400, 'Duplicate revision identity');
    for (const r of revisions)
      if (r.contentHash !== (await revisionHash(r)))
        throw new StoreError(400, 'Sample revision hash mismatch');
    this.transaction(() => {
      const additions = revisions.filter((r) => {
        const existing = this.getRevision(
          r.kind,
          r.id,
          mode === 'exact-revision' ? r.revision : undefined,
        );
        if (existing && mode === 'exact-revision' && canonicalJson(existing) !== canonicalJson(r))
          throw new StoreError(409, 'Pinned revision conflicts with immutable stored content');
        return !existing;
      });
      const available = new Map(additions.map((r) => [revisionKey(r), r]));
      const get = (kind: DefinitionKind, ref: RevisionRef) => {
        const r =
          available.get(`${kind}:${ref.id}:${ref.revision}`) ?? this.requireRevision(kind, ref);
        if (r.contentHash !== ref.contentHash)
          throw new StoreError(409, 'Sample conflicts with an existing revision');
        return r;
      };
      resolveClosure(additions, get, mode === 'exact-revision' ? 4096 : 256);
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
        409,
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
        this.getDraft(id) ? 409 : 404,
        'Draft missing or changed; reload before editing',
      );
    return this.getDraft(id)!;
  }
  private async candidate(id: string, expectedVersion?: number) {
    const draft = this.getDraft(id);
    if (!draft) throw new StoreError(404, 'Draft not found');
    if (expectedVersion !== undefined && draft.version !== expectedVersion)
      throw new StoreError(409, 'Draft changed; reload before publishing');
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
    resolveClosure([revision], (kind, ref) => this.requireRevision(kind, ref));
    return { draft, revision };
  }
  async validateDraft(id: string) {
    if (!this.getDraft(id)) throw new StoreError(404, 'Draft not found');
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
        throw new StoreError(409, 'Draft changed during validation');
      this.checkDraftBase(draft);
      const last = this.getRevision(draft.kind, draft.definitionId);
      revision.revision = (last?.revision ?? 0) + 1;
      RevisionSchema.parse(revision);
      if (draft.version >= 2147483647) throw new StoreError(409, 'Draft version exhausted');
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
    const roots = [
      ...request.participants.map((p) => this.requireRevision('character', p.character)),
      this.requireRevision('ruleset', request.ruleset),
      this.requireRevision('scenario', request.scenario),
    ];
    const rules = roots.find((r) => r.kind === 'ruleset')!;
    if (
      rules.kind === 'ruleset' &&
      (rules.definition.rulesVersion !== CURRENT_ENGINE_VERSION || !rules.definition.ai)
    )
      throw new StoreError(
        409,
        `Unsupported rules version: saved ${rules.definition.rulesVersion}, current ${CURRENT_ENGINE_VERSION}; select a current rules revision`,
      );
    const revisions = resolveClosure(roots, (kind, ref) => this.requireRevision(kind, ref));
    return prepareBattle({
      ...request,
      schemaVersion: 3,
      eventSchemaVersion: 1,
      replaySchemaVersion: 1,
      engineVersion: CURRENT_ENGINE_VERSION,
      aiProfile: 'observed-utility-v1',
      implementationDigest: implementation.digest,
      physicsProfileHash: await contentHash(profile),
      physicsProfile: profile,
      wasmHash: implementation.wasm,
      angleTableHash: implementation.table,
      prng: 'xorshift32-v1',
      seedDerivation: 'actor-stream-v1',
      revisions,
    });
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
    if (!spec) throw new StoreError(409, 'Saved specification is unavailable');
    const reason = unsupportedExecutionReason(spec.manifest);
    if (reason) throw new StoreError(409, reason);
    return { simulationHash, manifest: parseJson(ManifestSchema, spec.manifest) };
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
