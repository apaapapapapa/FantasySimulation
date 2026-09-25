import { JobStore } from '../jobs/job-store.ts';
import { cp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vite-plus/test';
import { DEFAULT_BUDGET, type Revision } from '@fantasy/domain/spatial';
import { prepareBattle, reference } from '@fantasy/engine/spatial';
import { withReplayDirectory } from '../../test-support/replays.ts';
import { openStore, readSampleRevisions } from './store.ts';
import { createApp } from '../http/app.ts';
import { BattleService } from '../jobs/battle-service.ts';
import { BattlePool } from '../jobs/worker-pool.ts';
import legacy from '../../fixtures/compatibility/v1.10/metadata.json' with { type: 'json' };
import observed from '../../fixtures/compatibility/v1.11/metadata.json' with { type: 'json' };

describe('previous-code database and replay compatibility', () => {
  it.each([
    { version: 'v1.10', metadata: legacy, knowledge: undefined },
    { version: 'v1.11', metadata: observed, knowledge: 'surveyed' },
  ])(
    'opens $version without rewriting definitions or executing its engine',
    async ({ version, metadata, knowledge }) => {
      await withReplayDirectory(async (directory) => {
        const fixture = new URL(`../../fixtures/compatibility/${version}/`, import.meta.url);
        const filename = join(directory, 'fixture.sqlite');
        const root = join(directory, 'replays');
        // Restore a SQL export captured with the recorded old commit. Production migrations remain Drizzle-only.
        const db = new Database(filename);
        db.pragma('foreign_keys = OFF');
        db.exec(gunzipSync(await readFile(new URL('database.sql.gz', fixture))).toString('utf8'));
        expect(db.pragma('foreign_key_check')).toEqual([]);
        // Relocate only the stopped synthetic fixture's host/path; preserve its store identity.
        expect(
          db
            .prepare('UPDATE runtime_owner SET artifact_root = ?, hostname = ? WHERE pid = 0')
            .run(root, hostname()).changes,
        ).toBe(1);
        db.close();
        await cp(new URL('replays/', fixture), root, { recursive: true });
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const file = join(root, entry.name, 'manifest.json');
          await writeFile(file, gunzipSync(await readFile(`${file}.gz`)));
          await unlink(`${file}.gz`);
        }
        const store = openStore(filename);
        const before = store.getRevision('scenario', 'flat', 1)!;
        expect(before.definition).toHaveProperty('name');
        expect(before.kind === 'scenario' && before.definition.terrainKnowledge).toBe(knowledge);
        const saved = store.getSpec(metadata.complete.simulationHash)!;
        expect(saved.manifest.engineVersion).toBe(metadata.engineVersion);
        await expect(prepareBattle(saved.manifest)).rejects.toThrow(/Unsupported engine/);
        await store.seedRevisions(readSampleRevisions());
        expect(store.getRevision('scenario', 'flat', 1)).toEqual(before);
        const surveyed = store.getRevision('scenario', 'flat-surveyed-v1', 1)!;
        expect(surveyed.definition).toHaveProperty('terrainKnowledge', 'surveyed');
        const run = vi.spyOn(BattlePool.prototype, 'run');
        const runtime = await BattleService.open(store, root),
          jobs = new JobStore(store);
        const app = createApp(store, false, runtime);
        try {
          expect((await app.inject('/api/health')).statusCode).toBe(200);
          expect((await app.inject('/api/rulesets')).statusCode).toBe(200);
          const characters = (await app.inject('/api/characters')).json<{ items: Revision[] }>();
          expect(characters.items.length).toBeGreaterThanOrEqual(13);
          const revision = await app.inject('/api/revisions/scenario/flat/1');
          expect(revision.json()).toEqual(before);
          expect((await app.inject('/api/characters/archer')).statusCode).toBe(200);
          const result = await app.inject(`/api/battle-results/${metadata.complete.resultId}`);
          expect(result.statusCode).toBe(200);
          expect(result.json().result.steps).toBe(25);
          const replayId: string = result.json().replayId;
          const replay = (await app.inject(`/api/replays/${replayId}`)).json();
          const file: string = replay.chunks[0].file;
          const chunk = await app.inject(`/api/replays/${replayId}/files/${file}`);
          expect(chunk.statusCode).toBe(200);
          expect([...chunk.rawPayload.subarray(0, 2)]).toEqual([31, 139]);
          for (const id of [metadata.pending, metadata.interrupted]) {
            const failed = await runtime.wait(id);
            expect(failed.state).toBe('failed');
            expect(failed.error).toMatch(/Unsupported engine/);
            const retry = await app.inject({
              method: 'POST',
              url: `/api/battle-jobs/${id}/retry`,
              payload: { expectedAttempts: failed.attempts, budget: DEFAULT_BUDGET },
            });
            expect(retry.statusCode).toBe(409);
            expect(retry.json().error).toMatch(/Unsupported engine/);
            expect(jobs.get(id)?.attempts).toBe(failed.attempts);
            expect(runtime.status(id).job.allowedOperations.retry).toBe(false);
          }
          expect(run).not.toHaveBeenCalled();
          await writeFile(join(root, replayId, file), 'damaged fixture copy');
          await expect(runtime.replay(replayId)).rejects.toThrow(/corrupt/);
          const recovery = await app.inject({
            method: 'POST',
            url: `/api/battle-results/${metadata.complete.resultId}/replay-recovery`,
            headers: { 'x-client-id': 'compat', 'idempotency-key': 'restore' },
            payload: { budget: DEFAULT_BUDGET },
          });
          expect(recovery.statusCode).toBe(409);
          expect(recovery.json().error).toMatch(/unsupported/);
          if (version === 'v1.10') {
            const old = store.getRevision('ruleset', 'standard', 1)!;
            const creation = await app.inject({
              method: 'POST',
              url: '/api/battle-jobs',
              headers: { 'x-client-id': 'compat', 'idempotency-key': 'old-rules' },
              payload: { spec: { ...metadata.spec, ruleset: reference(old) } },
            });
            expect(creation.statusCode).toBe(409);
            expect(creation.json().error).toMatch(/Unsupported rules version/);
          }
          expect(store.getSpec(metadata.complete.simulationHash)).toEqual(saved);
          expect(jobs.result(metadata.complete.resultId!)).toBeDefined();
        } finally {
          await app.close();
          run.mockRestore();
        }
      });
    },
  );
});
