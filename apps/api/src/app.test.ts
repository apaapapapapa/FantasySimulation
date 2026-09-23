import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  DraftSchema,
  PublishResponseSchema,
  RevisionPageSchema,
  SpecInputSchema,
  type Definition,
} from '@fantasy/domain/spatial';
import { catalogManifest, reference } from '@fantasy/engine/spatial';
import { createApp } from './app.ts';
import { openStore, readSampleRevisions } from './store.ts';
const apps: ReturnType<typeof createApp>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function file() {
  const dir = mkdtempSync(join(tmpdir(), 'fantasy-spatial-test-'));
  directories.push(dir);
  return join(dir, 'test.sqlite');
}
async function setup(filename = ':memory:') {
  const store = openStore(filename);
  await store.seedRevisions(readSampleRevisions());
  const app = createApp(store);
  apps.push(app);
  return { store, app };
}
describe('3D revision API and Drizzle persistence', () => {
  it('serves paged immutable characters, rules and scenarios using shared contracts', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/api/health' })).json()).toMatchObject({
      status: 'ok',
      migrationTool: 'drizzle',
    });
    const page = RevisionPageSchema.parse(
      (await app.inject({ url: '/api/characters?limit=4' })).json(),
    );
    expect(page.items).toHaveLength(4);
    const next = RevisionPageSchema.parse(
      (await app.inject({ url: '/api/characters?limit=100&cursor=' + page.nextCursor })).json(),
    );
    expect(next.items).toHaveLength(11);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...page.items, ...next.items].map((r) => r.id)).size).toBe(15);
    expect((await app.inject({ url: '/api/characters?limit=101' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/characters/missing' })).statusCode).toBe(404);
    for (const path of ['rulesets', 'scenarios', 'revisions/ability'])
      expect(
        RevisionPageSchema.parse((await app.inject({ url: '/api/' + path })).json()).items.length,
      ).toBeGreaterThan(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/battles',
          payload: { leftId: 'a', rightId: 'b' },
        })
      ).statusCode,
    ).toBe(404);
  });
  it('keeps invalid drafts editable and refuses unknown effects and missing typed references on publication', async () => {
    const { app, store } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/drafts',
      payload: {
        kind: 'ability',
        definitionId: 'unknown',
        base: null,
        definition: { effects: [{ kind: 'absolute-win' }] },
      },
    });
    expect(response.statusCode).toBe(201);
    const draft = DraftSchema.parse(response.json());
    expect(
      (await app.inject({ method: 'POST', url: `/api/drafts/${draft.id}/validate` })).json().valid,
    ).toBe(false);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/drafts/${draft.id}/publish`,
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(400);
    expect(store.getRevision('ability', 'unknown')).toBeUndefined();
    const definition = structuredClone(
      store.getRevision('character', 'swordsman')!.definition,
    ) as Definition<'character'>;
    definition.policy.id = 'missing-policy';
    const missing = store.createDraft({
      kind: 'character',
      definitionId: 'new',
      base: null,
      definition,
    });
    expect((await store.validateDraft(missing.id)).valid).toBe(false);
    await expect(store.publishDraft(missing.id, 1)).rejects.toThrow(/Missing/);
  });
  it('publishes new revisions with optimistic editing and rejects old edits or double publication', async () => {
    const { app, store } = await setup();
    const original = store.getRevision('character', 'swordsman')!;
    const d = store.createDraft({
      kind: 'character',
      definitionId: original.id,
      base: reference(original),
      definition: original.definition,
    });
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/drafts/${d.id}`,
      payload: { expectedVersion: 1, definition: { ...original.definition, name: '変更後' } },
    });
    expect(patch.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/drafts/${d.id}`,
          payload: { expectedVersion: 1, definition: original.definition },
        })
      ).statusCode,
    ).toBe(409);
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: 'POST',
          url: `/api/drafts/${d.id}/publish`,
          payload: { expectedVersion: 2 },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([201, 409]);
    const published = PublishResponseSchema.parse(
      responses.find((r) => r.statusCode === 201)!.json(),
    );
    expect(published.revision.revision).toBe(2);
    expect(published.draft.version).toBe(3);
    expect(store.getRevision('character', 'swordsman', 1)).toEqual(original);
    expect(store.getRevision('character', 'swordsman')?.definition.name).toBe('変更後');
    expect(() =>
      store.db.prepare("DELETE FROM published_revisions WHERE kind='character'").run(),
    ).toThrow(/cannot be deleted/);
    expect(() =>
      store.db.prepare("UPDATE published_revisions SET content_hash='changed'").run(),
    ).toThrow(/immutable/);
  });
  it('rejects separate drafts based on superseded revisions, including across connections', async () => {
    const filename = file(),
      { store, app } = await setup(filename);
    const original = store.getRevision('character', 'swordsman')!;
    const input = {
      kind: original.kind,
      definitionId: original.id,
      base: reference(original),
      definition: original.definition,
    };
    const first = store.createDraft(input),
      stale = store.createDraft(input);
    const second = openStore(filename);
    try {
      expect(second.getDraft(stale.id)?.base).toEqual(reference(original));
      const attempts = await Promise.allSettled([
        store.publishDraft(first.id, 1),
        second.publishDraft(stale.id, 1),
      ]);
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { statusCode: 409 },
      });
      // Asynchronous validation does not guarantee that the first caller wins.
      const winner = attempts[0]!.status === 'fulfilled' ? first : stale;
      const loser = winner.id === first.id ? stale : first;
      expect(store.getRevision('character', original.id)?.revision).toBe(2);
      expect(store.getDraft(winner.id)?.version).toBe(2);
      expect(store.getDraft(loser.id)?.version).toBe(1);
      expect(store.getDraft(loser.id)?.base).toEqual(reference(original));
      expect((await second.validateDraft(loser.id)).valid).toBe(false);
      const response = await app.inject({ method: 'POST', url: '/api/drafts', payload: input });
      expect(response.statusCode).toBe(409);
      // Its own successful publication advances the base for the next edit.
      const own = store.getDraft(winner.id)!;
      expect(own.base).toEqual(own.published);
      store.patchDraft(own.id, own.version, { ...original.definition, name: '次の編集' });
      expect((await store.publishDraft(own.id, own.version + 1)).revision.revision).toBe(3);
    } finally {
      second.close();
    }
  });
  it('allows exactly one first publication for two new-ID drafts', async () => {
    const { store } = await setup(),
      original = store.getRevision('character', 'swordsman')!;
    const input = {
      kind: original.kind,
      definitionId: 'new',
      base: null,
      definition: original.definition,
    };
    const drafts = [store.createDraft(input), store.createDraft(input)];
    const attempts = await Promise.allSettled(drafts.map((d) => store.publishDraft(d.id, 1)));
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { statusCode: 409 },
    });
    expect(store.getRevision('character', 'new')?.revision).toBe(1);
  });
  it('rechecks a draft after asynchronous validation without publishing a stale snapshot', async () => {
    const { store } = await setup(),
      r = store.getRevision('character', 'swordsman')!;
    const draft = store.createDraft({
      kind: r.kind,
      definitionId: 'new-swordsman',
      base: null,
      definition: r.definition,
    });
    const pending = store.publishDraft(draft.id, 1);
    store.patchDraft(draft.id, 1, { ...r.definition, name: '編集競合' });
    await expect(pending).rejects.toMatchObject({ statusCode: 409 });
    expect(store.getRevision('character', 'new-swordsman')).toBeUndefined();
  });
  it('persists resolved specifications across restart and keeps later edits and seeding out of the saved input', async () => {
    const filename = file(),
      first = await setup(filename);
    const sample = await catalogManifest(),
      request = SpecInputSchema.parse({
        seed: sample.seed,
        participants: sample.participants,
        ruleset: sample.ruleset,
        scenario: sample.scenario,
      });
    const battle = await first.store.prepareSpec(request),
      spec = first.store.saveSpec(battle);
    expect(first.store.saveSpec(battle)).toEqual(spec);
    const old = first.store.getRevision('character', 'swordsman')!;
    const draft = first.store.createDraft({
      kind: 'character',
      definitionId: old.id,
      base: reference(old),
      definition: { ...old.definition, name: '後の編集' },
    });
    await first.store.publishDraft(draft.id, 1);
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    const second = await setup(filename);
    expect(second.store.getSpec(spec.simulationHash)).toEqual(spec);
    expect(second.store.getRevision('character', 'swordsman')?.revision).toBe(2);
    expect((await second.store.prepareSpec(request)).simulationHash).toBe(spec.simulationHash);
    expect(
      second.store.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM battle_specs').get()?.n,
    ).toBe(1);
    expect(() =>
      second.store.db.prepare("UPDATE battle_specs SET manifest_json='{}'").run(),
    ).toThrow(/immutable/);
  });
  it('initializes only current tables and preserves unrelated legacy data', async () => {
    const { store } = await setup();
    expect(
      store.db
        .prepare("SELECT name FROM sqlite_schema WHERE name IN ('characters','rulesets','battles')")
        .all(),
    ).toEqual([]);
    const filename = file(),
      db = new Database(filename);
    db.exec(
      "CREATE TABLE schema_generation(id INTEGER PRIMARY KEY,generation TEXT); INSERT INTO schema_generation VALUES(1,'local-v1'); CREATE TABLE schema_migrations(name TEXT,checksum TEXT); CREATE TABLE valuable(value TEXT); INSERT INTO valuable VALUES('keep');",
    );
    db.close();
    const adopted = openStore(filename);
    adopted.close();
    const read = new Database(filename);
    try {
      expect(read.prepare<[], { value: string }>('SELECT value FROM valuable').get()?.value).toBe(
        'keep',
      );
    } finally {
      read.close();
    }
  });
  it('rejects oversized requests and malformed JSON before writing a draft', async () => {
    const { app, store } = await setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/drafts',
          payload: { padding: 'x'.repeat(512 * 1024) },
        })
      ).statusCode,
    ).toBe(413);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/drafts',
          headers: { 'content-type': 'application/json' },
          payload: '{',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      store.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM definition_drafts').get()?.n,
    ).toBe(0);
  });
});
