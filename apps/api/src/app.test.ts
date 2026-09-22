import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { BattleRecordSchema, CharacterSchema } from '@fantasy/domain';
import { DEFAULT_RULESET } from '@fantasy/engine';
import { createApp } from './app.ts';
import { openStore, readSampleCharacters } from './store.ts';

const apps: ReturnType<typeof createApp>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup(filename = ':memory:') {
  const store = openStore(filename);
  store.seedCharacters(readSampleCharacters());
  const app = createApp(store);
  apps.push(app);
  return { store, app };
}

describe('API and SQLite integration', () => {
  it('serves health and validated characters', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/api/health' })).json()).toMatchObject({ status: 'ok' });
    const response = await app.inject({ url: '/api/characters' });
    expect(CharacterSchema.array().parse(response.json())).toHaveLength(2);
  });

  it('creates and updates JSON characters with validation', async () => {
    const { app, store } = setup();
    const character = {
      ...CharacterSchema.parse(readSampleCharacters()[0]),
      id: 'new-hero',
      name: 'New hero',
    };
    expect(
      (await app.inject({ method: 'POST', url: '/api/characters', payload: character })).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/characters',
          payload: { ...character, name: 'Updated' },
        })
      ).statusCode,
    ).toBe(200);
    expect(store.getCharacter('new-hero')?.name).toBe('Updated');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/characters',
          payload: { ...character, actions: [] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/characters',
          headers: { 'content-type': 'application/json' },
          payload: '{',
        })
      ).statusCode,
    ).toBe(400);
    expect(store.getCharacter('new-hero')?.actions.length).toBeGreaterThan(0);
  });

  it('persists battle snapshots across restarts without overwriting edited characters', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fantasy-test-'));
    directories.push(directory);
    const filename = join(directory, 'test.sqlite');
    const first = setup(filename);
    const response = await first.app.inject({
      method: 'POST',
      url: '/api/battles',
      payload: { leftId: 'aegis-knight', rightId: 'ember-mage' },
    });
    expect(response.statusCode).toBe(201);
    const original = BattleRecordSchema.parse(response.json());
    first.store.saveCharacter({ ...original.participants[0], name: '変更後' });
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    const second = setup(filename);
    expect(second.store.getCharacter('aegis-knight')?.name).toBe('変更後');
    const saved = BattleRecordSchema.array().parse(
      (await second.app.inject({ url: '/api/battles' })).json(),
    );
    expect(saved).toEqual([original]);
    expect(saved[0]?.participants[0].name).toBe('蒼盾の騎士');
  });

  it('rejects invalid or missing opponents without creating history', async () => {
    const { app, store } = setup();
    for (const payload of [{}, { leftId: 'aegis-knight', rightId: 'aegis-knight' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/battles', payload })).statusCode).toBe(
        400,
      );
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/battles',
          payload: { leftId: 'missing', rightId: 'ember-mage' },
        })
      ).statusCode,
    ).toBe(404);
    expect(store.listBattles()).toEqual([]);
  });

  it('prevents reusing a rules version for a different configuration', () => {
    const { store } = setup();
    expect(() => store.registerRuleset({ ...DEFAULT_RULESET, maxRounds: 2 })).toThrow(
      'version bump',
    );
  });

  it('rejects oversized bodies', async () => {
    const { app } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/characters',
      payload: { padding: 'x'.repeat(65_536) },
    });
    expect(response.statusCode).toBe(413);
  });
});
