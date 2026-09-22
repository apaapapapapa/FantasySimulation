import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  DraftSchema,
  PublishResponseSchema,
  RevisionPageSchema,
  SpecInputSchema,
  type Definition,
} from '@fantasy/domain/spatial';
import { catalogManifest } from '@fantasy/engine/spatial';
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
describe('3D revision API and new SQLite generation', () => {
  it('serves paged immutable characters, rules and scenarios using shared contracts', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/api/health' })).json()).toMatchObject({
      status: 'ok',
      schemaGeneration: 'spatial-v1',
    });
    const page = RevisionPageSchema.parse(
      (await app.inject({ url: '/api/characters?limit=4' })).json(),
    );
    expect(page.items).toHaveLength(4);
    const next = RevisionPageSchema.parse(
      (await app.inject({ url: '/api/characters?limit=100&cursor=' + page.nextCursor })).json(),
    );
    expect(next.items).toHaveLength(6);
    expect(next.nextCursor).toBeNull();
    expect(new Set([...page.items, ...next.items].map((r) => r.id)).size).toBe(10);
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
    const missing = store.createDraft({ kind: 'character', definitionId: 'new', definition });
    expect((await store.validateDraft(missing.id)).valid).toBe(false);
    await expect(store.publishDraft(missing.id, 1)).rejects.toThrow(/Missing/);
  });
  it('publishes new revisions with optimistic editing and rejects old edits or double publication', async () => {
    const { app, store } = await setup();
    const original = store.getRevision('character', 'swordsman')!;
    const d = store.createDraft({
      kind: 'character',
      definitionId: original.id,
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
    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409]);
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
  it('rechecks a draft after asynchronous validation without publishing a stale snapshot', async () => {
    const { store } = await setup(),
      r = store.getRevision('character', 'swordsman')!;
    const draft = store.createDraft({
      kind: r.kind,
      definitionId: 'new-swordsman',
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
      definition: { ...old.definition, name: '後の編集' },
    });
    await first.store.publishDraft(draft.id, 1);
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    const second = await setup(filename);
    expect(second.store.getSpec(spec.simulationHash)).toEqual(spec);
    expect(second.store.getRevision('character', 'swordsman')?.revision).toBe(2);
    expect((await second.store.prepareSpec(request)).simulationHash).toBe(spec.simulationHash);
    expect(second.store.db.prepare('SELECT COUNT(*) AS n FROM battle_specs').get()?.n).toBe(1);
    expect(() =>
      second.store.db.prepare("UPDATE battle_specs SET manifest_json='{}'").run(),
    ).toThrow(/immutable/);
  });
  it('initializes only the new tables and refuses another generation without destroying it', async () => {
    const { store } = await setup();
    expect(
      store.db
        .prepare("SELECT name FROM sqlite_schema WHERE name IN ('characters','rulesets','battles')")
        .all(),
    ).toEqual([]);
    const filename = file(),
      db = new DatabaseSync(filename);
    db.exec(
      "CREATE TABLE schema_generation(id INTEGER PRIMARY KEY,generation TEXT); INSERT INTO schema_generation VALUES(1,'local-v1'); CREATE TABLE schema_migrations(name TEXT,checksum TEXT); CREATE TABLE valuable(value TEXT); INSERT INTO valuable VALUES('keep');",
    );
    db.close();
    expect(() => openStore(filename)).toThrow(/Unsupported database/);
    const read = new DatabaseSync(filename);
    try {
      expect(read.prepare('SELECT value FROM valuable').get()?.value).toBe('keep');
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
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM definition_drafts').get()?.n).toBe(0);
  });
});
