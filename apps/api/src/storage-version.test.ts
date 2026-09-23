import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { CURRENT_ENGINE_VERSION } from '@fantasy/domain/spatial';
import { revisionHash } from '@fantasy/engine/spatial';
import { withReplayDirectory } from '../test-support/replays.ts';
import { legacyStorage, storageHashes } from '../test-support/storage.ts';
import { readConfig, repositoryRoot } from './config.ts';
import { defaultStoragePaths } from './storage-paths.ts';
import {
  assertStoragePaths,
  inspectDatabaseVersion,
  StorageVersionError,
} from './storage-version.ts';
import { openStore, readSampleRevisions } from './store.ts';
import { BattleRuntime } from './battle-runtime.ts';
import { createApp } from './app.ts';

afterEach(() => vi.unstubAllEnvs());
describe('battle-version storage admission', { timeout: 30000 }, () => {
  it('derives both default paths from the current engine while explicit paths remain explicit', () => {
    vi.stubEnv('DATABASE_PATH', undefined);
    vi.stubEnv('ARTIFACT_PATH', undefined);
    expect(readConfig()).toMatchObject({
      databasePath: join(repositoryRoot, 'data', CURRENT_ENGINE_VERSION, 'fantasy.sqlite'),
      artifactPath: join(repositoryRoot, 'data', CURRENT_ENGINE_VERSION, 'replays'),
    });
    vi.stubEnv('DATABASE_PATH', './custom.sqlite');
    vi.stubEnv('ARTIFACT_PATH', './custom-replays');
    expect(readConfig()).toMatchObject({
      databasePath: join(repositoryRoot, 'custom.sqlite'),
      artifactPath: join(repositoryRoot, 'custom-replays'),
    });
  });
  it('starts a new version, seeds and restarts without changing old DB/WAL/SHM, drafts or artifacts', async () => {
    await withReplayDirectory(async (directory) => {
      const oldDirectory = join(directory, 'old');
      mkdirSync(oldDirectory);
      const old = legacyStorage(oldDirectory);
      const before = storageHashes(oldDirectory);
      const filename = resolve(directory, defaultStoragePaths.databasePath),
        root = resolve(directory, defaultStoragePaths.artifactPath);
      try {
        for (let start = 0; start < 2; start++) {
          await assertStoragePaths(filename, root);
          const store = openStore(filename);
          await store.seedRevisions(readSampleRevisions());
          const runtime = await BattleRuntime.open(store, root);
          const app = createApp(store, false, runtime);
          try {
            expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
            expect(store.listRevisions('character').items).toHaveLength(13);
            expect(store.db.prepare('SELECT COUNT(*) n FROM definition_drafts').get()).toEqual({
              n: 0,
            });
            expect(inspectDatabaseVersion(filename)?.version).toBe(CURRENT_ENGINE_VERSION);
          } finally {
            await app.close();
            store.close();
          }
        }
        expect(storageHashes(oldDirectory)).toEqual(before);
      } finally {
        old.db.close();
      }
    });
  });
  it.each(['spatial-v1.10', null])(
    'rejects explicit DB version %s before parsing or writing',
    async (version) => {
      await withReplayDirectory(async (directory) => {
        const old = legacyStorage(directory, version);
        try {
          const before = storageHashes(directory);
          expect(() => openStore(old.filename)).toThrow(StorageVersionError);
          expect(() => openStore(old.filename)).toThrow(
            `stored=${version ?? 'unknown'}; current=${CURRENT_ENGINE_VERSION}`,
          );
          await expect(assertStoragePaths(old.filename, old.root)).rejects.toThrow(
            /DATABASE_PATH=.*ARTIFACT_PATH=/,
          );
          expect(storageHashes(directory)).toEqual(before);
        } finally {
          old.db.close();
        }
      });
    },
  );
  it('rejects an old artifact root before even creating the new database', async () => {
    await withReplayDirectory(async (directory) => {
      const old = legacyStorage(directory);
      try {
        const before = storageHashes(directory),
          fresh = join(directory, 'new', 'database.sqlite');
        await expect(assertStoragePaths(fresh, old.root)).rejects.toThrow(
          /stored=spatial-v1.10; current=spatial-v1.11/,
        );
        expect(existsSync(fresh)).toBe(false);
        expect(storageHashes(directory)).toEqual(before);
      } finally {
        old.db.close();
      }
    });
  });
  it.each(['empty', 'schema-only', 'not-sqlite'])(
    'refuses an existing %s DB without guessing',
    async (kind) => {
      await withReplayDirectory(async (directory) => {
        const filename = join(directory, 'unknown.sqlite');
        if (kind === 'schema-only') {
          const db = openStore(filename);
          db.close();
        } else writeFileSync(filename, kind === 'empty' ? '' : 'not SQLite');
        const before = storageHashes(directory);
        expect(() => openStore(filename)).toThrow(/stored=unknown/);
        expect(storageHashes(directory)).toEqual(before);
      });
    },
  );
  it('refuses mixed version evidence even when one stored ruleset is current', async () => {
    await withReplayDirectory(async (directory) => {
      const old = legacyStorage(directory);
      old.db
        .prepare('INSERT INTO published_revisions VALUES(?,?)')
        .run('ruleset', JSON.stringify({ definition: { rulesVersion: CURRENT_ENGINE_VERSION } }));
      try {
        expect(() => inspectDatabaseVersion(old.filename)).toThrow(
          /stored=spatial-v1.10, spatial-v1.11/,
        );
      } finally {
        old.db.close();
      }
    });
  });
  it('accepts current immutable BattleSpec evidence without requiring catalog seeding', async () => {
    await withReplayDirectory(async (directory) => {
      const filename = join(directory, 'spec.sqlite');
      const db = new Database(filename);
      db.exec('CREATE TABLE battle_specs(manifest_json TEXT)');
      db.prepare('INSERT INTO battle_specs VALUES(?)').run(
        JSON.stringify({ engineVersion: CURRENT_ENGINE_VERSION }),
      );
      db.close();
      expect(inspectDatabaseVersion(filename)?.version).toBe(CURRENT_ENGINE_VERSION);
    });
  });
  it('refuses importing or publishing old rules into a new database', async () => {
    const store = openStore(':memory:');
    try {
      await store.seedRevisions(readSampleRevisions());
      const rules = store.listRevisions('ruleset').items[0]!;
      if (rules.kind !== 'ruleset') throw new Error('Missing rules');
      const old = {
        ...rules,
        id: 'old-rules',
        definition: { ...rules.definition, rulesVersion: 'spatial-v1.10' },
      };
      old.contentHash = await revisionHash(old);
      await expect(store.loadPinnedRevisions([old])).rejects.toThrow(/cannot be stored/);
      expect(store.getRevision('ruleset', old.id)).toBeUndefined();
      const draft = store.createDraft({
        kind: 'ruleset',
        definitionId: old.id,
        base: null,
        definition: old.definition,
      });
      await expect(store.publishDraft(draft.id, 1)).rejects.toThrow(/current engine/);
      expect(store.getRevision('ruleset', old.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
