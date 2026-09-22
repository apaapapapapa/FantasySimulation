import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  canonicalJson,
  contentHash,
  DraftInputSchema,
  DraftSchema,
  ManifestSchema,
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
  implementation,
  profile,
  prepareBattle,
  reference,
  revisionHash,
  sealRevision,
  type PreparedBattle,
} from '@fantasy/engine/spatial';
import { migrate } from './migrations.ts';
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
    case 'policy':
    case 'status':
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
): Revision[] {
  const found = new Map<string, Revision>();
  const visit = (r: Revision) => {
    const key = revisionKey(r);
    if (found.has(key)) return;
    if (found.size >= 256) throw new StoreError(400, 'Revision closure exceeds 256 entries');
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
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec(
        'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;',
      );
      migrate(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      if (value instanceof Promise) throw new Error('Database transactions cannot await');
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  getRevision(kind: DefinitionKind, id: string, revision?: number): Revision | undefined {
    const row =
      revision === undefined
        ? this.db
            .prepare(
              'SELECT revision_json FROM published_revisions WHERE kind=? AND definition_id=? ORDER BY revision DESC LIMIT 1',
            )
            .get(kind, id)
        : this.db
            .prepare(
              'SELECT revision_json FROM published_revisions WHERE kind=? AND definition_id=? AND revision=?',
            )
            .get(kind, id, revision);
    return row ? parseJson(RevisionSchema, jsonValue(row.revision_json)) : undefined;
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
    const rows = this.db
      .prepare(`SELECT r.revision_json FROM published_revisions r
      WHERE r.kind=? AND r.definition_id>? AND r.revision=(SELECT MAX(s.revision) FROM published_revisions s WHERE s.kind=r.kind AND s.definition_id=r.definition_id)
      ORDER BY r.definition_id LIMIT ?`)
      .all(kind, cursor, limit + 1);
    const items = rows
      .slice(0, limit)
      .map((row) => parseJson(RevisionSchema, jsonValue(row.revision_json)));
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }
  private insertRevision(revision: Revision, now: string) {
    this.db
      .prepare('INSERT INTO published_revisions VALUES (?,?,?,?,?,?)')
      .run(
        revision.kind,
        revision.id,
        revision.revision,
        revision.contentHash,
        canonicalJson(revision),
        now,
      );
  }
  async seedRevisions(input: unknown[]) {
    if (input.length > 256) throw new StoreError(400, 'Sample catalog exceeds revision limit');
    const revisions = input.map((r) => parseJson(RevisionSchema, r));
    for (const r of revisions)
      if (r.contentHash !== (await revisionHash(r)))
        throw new StoreError(400, 'Sample revision hash mismatch');
    this.transaction(() => {
      const additions = revisions.filter((r) => !this.getRevision(r.kind, r.id));
      const available = new Map(additions.map((r) => [revisionKey(r), r]));
      const get = (kind: DefinitionKind, ref: RevisionRef) => {
        const r =
          available.get(`${kind}:${ref.id}:${ref.revision}`) ?? this.requireRevision(kind, ref);
        if (r.contentHash !== ref.contentHash)
          throw new StoreError(409, 'Sample conflicts with an existing revision');
        return r;
      };
      resolveClosure(additions, get);
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
      this.db
        .prepare(
          'INSERT INTO definition_drafts (id,kind,definition_id,version,definition_json,published_json,created_at,updated_at,base_revision_json) VALUES (?,?,?,?,?,NULL,?,?,?)',
        )
        .run(
          id,
          draft.kind,
          draft.definitionId,
          1,
          canonicalJson(draft.definition),
          now,
          now,
          draft.base === null ? null : canonicalJson(draft.base),
        );
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
    const row = this.db.prepare('SELECT * FROM definition_drafts WHERE id=?').get(id);
    return row
      ? parseJson(DraftSchema, {
          id: row.id,
          kind: row.kind,
          definitionId: row.definition_id,
          base: row.base_revision_json === null ? null : jsonValue(row.base_revision_json),
          version: row.version,
          definition: jsonValue(row.definition_json),
          published: row.published_json === null ? null : jsonValue(row.published_json),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      : undefined;
  }
  patchDraft(id: string, expectedVersion: number, definition: unknown): Draft {
    const encoded = canonicalJson(definition);
    const result = this.db
      .prepare(
        'UPDATE definition_drafts SET definition_json=?,version=version+1,updated_at=? WHERE id=? AND version=? AND version<2147483647',
      )
      .run(encoded, new Date().toISOString(), id, expectedVersion);
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
      this.db
        .prepare(
          'UPDATE definition_drafts SET version=version+1,published_json=?,base_revision_json=?,updated_at=? WHERE id=? AND version=? AND version<2147483647',
        )
        .run(
          canonicalJson(reference(revision)),
          canonicalJson(reference(revision)),
          now,
          id,
          expectedVersion,
        );
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
    const revisions = resolveClosure(roots, (kind, ref) => this.requireRevision(kind, ref));
    return prepareBattle({
      ...request,
      schemaVersion: 3,
      eventSchemaVersion: 1,
      replaySchemaVersion: 1,
      engineVersion: 'spatial-v1.10',
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
    this.db
      .prepare('INSERT INTO battle_specs VALUES (?,?,?) ON CONFLICT(simulation_hash) DO NOTHING')
      .run(battle.simulationHash, encoded, new Date().toISOString());
    const row = this.db
      .prepare('SELECT manifest_json FROM battle_specs WHERE simulation_hash=?')
      .get(battle.simulationHash);
    if (row?.manifest_json !== encoded) throw new Error('Battle specification hash collision');
    return { simulationHash: battle.simulationHash, manifest: battle.manifest };
  }
  getSpec(simulationHash: string) {
    const row = this.db
      .prepare('SELECT manifest_json FROM battle_specs WHERE simulation_hash=?')
      .get(simulationHash);
    return row
      ? { simulationHash, manifest: parseJson(ManifestSchema, jsonValue(row.manifest_json)) }
      : undefined;
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
