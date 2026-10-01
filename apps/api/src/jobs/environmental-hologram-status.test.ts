import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, it, vi } from 'vite-plus/test';
import {
  BattleSensorProjectionSchema,
  DEFAULT_BUDGET,
  JobStatusSchema,
  ReplayManifestSchema,
  ReplayState,
  RevisionSchema,
  parseJson,
  replayChunkRecords,
  replayContext,
  type ActorDisplay,
  type ReplayManifest,
  type StreamRecord,
} from '@fantasy/domain/spatial';
import { reference, sealRevision } from '@fantasy/engine/spatial';
import { catalogManifest } from '@fantasy/samples';
import { summoningManifest } from '../../../../packages/engine/test-support/summoning.ts';
import { withReplayDirectory } from '../../test-support/replays.ts';
import { specInput } from '../../test-support/runtime.ts';
import { openStore, readSampleRevisions, type Store } from '../db/store.ts';
import { seedStartupData } from '../db/startup-data.ts';
import { createApp } from '../http/app.ts';
import { ArtifactStore } from '../replay/artifact-store.ts';
import { sanitizeEnvironmentalHologramSensorProjection } from '../replay/sensor-projection.ts';
import { BattleService } from './battle-service.ts';
import { JobStore } from './job-store.ts';

async function activeHologramRequest(store: Store, app: ReturnType<typeof createApp>) {
  const seeded = await seedStartupData(store),
    revisions = parseJson(RevisionSchema.array(), readSampleRevisions()),
    character = revisions.find(
      (revision) => revision.kind === 'character' && revision.id === 'swordsman',
    ),
    policy = revisions.find(
      (revision) => revision.kind === 'policy' && revision.id === 'swordsman-policy',
    ),
    summonSource = await summoningManifest(40),
    summon = summonSource.revisions.find(
      (revision) => revision.kind === 'ability' && revision.definition.summon,
    );
  if (character?.kind !== 'character' || policy?.kind !== 'policy' || summon?.kind !== 'ability')
    throw new Error('Missing production character, policy or dormant summon fixture');
  const dormantSummon = await sealRevision('ability', 'test-only-dormant-hologram-summon', 1, {
      ...summon.definition,
      condition: { kind: 'status', id: 'test-only-never-present', present: true },
    }),
    utilityPolicy = await sealRevision('policy', 'test-only-hologram-utility-policy', 1, {
      ...policy.definition,
      priorities: [],
    }),
    combined = await sealRevision('character', 'test-only-hologram-workbench-character', 1, {
      ...character.definition,
      abilities: [...character.definition.abilities, reference(dormantSummon)],
      policy: reference(utilityPolicy),
    });
  await store.seedRevisions([dormantSummon, utilityPolicy, combined]);

  const nodeId = 'skill.illusion-curse.rabbit.1',
    saved = await app.inject({
      method: 'POST',
      url: '/api/skill-loadouts',
      payload: {
        character: reference(combined),
        configuration: {
          schemaVersion: 1,
          id: 'loadout.production.hologram.rabbit.1',
          version: 1,
          catalog: seeded.skillCatalog.reference,
          eligibilityNodeIds: [nodeId],
          learnedNodeIds: [nodeId],
          enabledNodeIds: [nodeId],
        },
      },
    });
  expect(saved.statusCode).toBe(201);
  const input = await catalogManifest(
      'swordsman',
      'swordsman',
      'flat',
      6000,
      228,
      'standard-p6-group2-v1',
    ),
    spec = specInput(input);
  await store.seedRevisions(input.revisions);
  spec.participants[0]!.character = reference(combined);
  return {
    spec,
    budget: DEFAULT_BUDGET,
    loadouts: [{ actorId: 'left', loadout: saved.json().latest }],
  };
}

function sanitizedProjection(replayId: string, replay: ReplayState) {
  const checkpoint = replay.checkpoint();
  if (!checkpoint.state) throw new Error('Missing final replay state');
  return BattleSensorProjectionSchema.parse(
    sanitizeEnvironmentalHologramSensorProjection(
      replayId,
      checkpoint.step,
      checkpoint.state.actors,
    ),
  );
}

async function replayFromApi(app: ReturnType<typeof createApp>, replayId: string) {
  const response = await app.inject(`/api/replays/${replayId}`);
  expect(response.statusCode).toBe(200);
  const manifest = ReplayManifestSchema.parse(response.json());
  const context = await replayContext(manifest.input, manifest.simulationHash);
  const replay = new ReplayState(context);
  const saved: StreamRecord[] = [];
  for (const ref of manifest.chunks) {
    const file = await app.inject(`/api/replays/${replayId}/files/${ref.file}`);
    expect(file.statusCode).toBe(200);
    const records = replayChunkRecords(gunzipSync(file.rawPayload).toString('utf8'), ref);
    for (const record of records) {
      saved.push(replay.apply(record));
    }
  }
  return { manifest, context, replay, records: saved };
}

it(
  'returns a bounded sanitized artifact projection through Worker SQLite HTTP and restart',
  { timeout: 30_000 },
  async () => {
    await withReplayDirectory(async (directory) => {
      const filename = join(directory, 'database.sqlite');
      const root = join(directory, 'replays');
      let store = openStore(filename);
      let runtime = await BattleService.open(store, root);
      let app = createApp(store, false, runtime);
      const reads: string[] = [];
      let manifestReads = 0;
      const files = ArtifactStore.prototype.files;
      const filesSpy = vi
        .spyOn(ArtifactStore.prototype, 'files')
        .mockImplementation(async function (
          this: ArtifactStore,
          replayId: string,
          expectedAttemptId?: string,
        ) {
          manifestReads++;
          const opened = await files.call(this, replayId, expectedAttemptId);
          return {
            ...opened,
            read: async (file: string) => {
              reads.push(file);
              return opened.read(file);
            },
          };
        });
      try {
        const request = await activeHologramRequest(store, app);
        expect(request.spec.ruleset).toEqual({
          id: 'standard-p6-group2-v1',
          revision: 1,
          contentHash: 'sha256:7a29dffc918f926dfe030ea3ae9bf488d582abae743179cb60617cbd1c7016d3',
        });
        const submitted = await app.inject({
          method: 'POST',
          url: '/api/skill-battle-jobs',
          headers: { 'x-client-id': 'hologram-status', 'idempotency-key': 'actual-worker' },
          payload: request,
        });
        if (submitted.statusCode !== 202)
          throw new Error(`${submitted.statusCode}: ${submitted.body}`);
        const id: string = submitted.json().job.id;
        const done = await runtime.wait(id);
        if (done.state !== 'completed') throw new Error(JSON.stringify(done));
        const replayId = new JobStore(store).result(done.resultId!)!.replayId;
        const savedManifest = await runtime.replay(replayId);
        expect(savedManifest.input.schemaVersion).toBe(9);

        reads.length = 0;
        manifestReads = 0;
        const response = await app.inject(`/api/battle-jobs/${id}`);
        expect(response.statusCode).toBe(200);
        const rawStatus = response.json();
        const status = JobStatusSchema.parse(rawStatus);
        const completed = status.attempts.at(-1)!;
        const projection = completed.sensorProjection;
        expect(projection).toBeDefined();
        expect(projection?.replayId).toBe(completed.replayId);
        expect(projection?.observers).toHaveLength(2);
        expect(
          projection?.observers.every((observer) => observer.environmentalHolograms.length <= 8),
        ).toBe(true);
        const holograms = projection?.observers.flatMap(
          (observer) => observer.environmentalHolograms,
        );
        expect(holograms?.length).toBeGreaterThan(0);
        expect(holograms?.length).toBeLessThanOrEqual(16);
        expect(JSON.stringify(projection)).not.toMatch(/sourcePosition|rng|policy|mind/i);
        expect(JSON.stringify(rawStatus.attempts.at(-1)?.sensorProjection)).not.toMatch(
          /sourcePosition|rng|policy|mind/i,
        );
        expect(manifestReads).toBe(1);
        expect(reads).toEqual([
          savedManifest.checkpoints.at(-1)!.file,
          savedManifest.chunks.at(-1)!.file,
        ]);

        const opened = await replayFromApi(app, replayId);
        expect(opened.manifest.input.schemaVersion).toBe(9);
        expect(opened.manifest.input.ruleset).toEqual(request.spec.ruleset);
        expect(opened.manifest.input.participants[0]?.skillLoadout).toMatchObject({
          resolvedNodeIds: ['skill.illusion-curse.rabbit.1'],
          nodeResolutions: [
            {
              nodeId: 'skill.illusion-curse.rabbit.1',
              resolution: [
                {
                  kind: 'active-ability',
                  ability: { id: 'side-step-image-v1', revision: 1 },
                },
              ],
            },
          ],
        });
        expect(sanitizedProjection(replayId, opened.replay)).toEqual(projection);
        const lifecycle = opened.records
          .flatMap((record) => ('events' in record ? record.events : []))
          .filter((event) => event.environmentalHologram);
        const projected = holograms![0]!;
        const ownLifecycle = lifecycle.filter(
          (event) => event.environmentalHologram?.id === projected.id,
        );
        expect(ownLifecycle.map((event) => event.environmentalHologram!.transition)).toEqual([
          'activated',
          'observed',
          'invalidated',
        ]);
        const {
          sourcePosition: _,
          transition: __,
          ...fromReplay
        } = ownLifecycle.at(-1)!.environmentalHologram!;
        expect(fromReplay).toEqual(projected);

        const checkpoint = opened.replay.checkpoint();
        const actor = checkpoint.state!.actors.find(
          (candidate) => candidate.id === projected.observerId,
        )!;
        const template = actor.sensorView!.environmentalHolograms[0]!;
        const overflowActors = ['observer-z', 'observer-x', 'observer-y'].map(
          (observerId): ActorDisplay => ({
            ...actor,
            id: observerId,
            sensorView: {
              environmentalHolograms: Array.from({ length: 10 }, (_, index) => ({
                ...template,
                id: `overflow-${observerId}-${9 - index}`,
                observerId,
                observerIds: [observerId],
              })),
            },
          }),
        );
        const bounded = sanitizeEnvironmentalHologramSensorProjection(
          replayId,
          checkpoint.step,
          overflowActors,
        );
        const reordered = sanitizeEnvironmentalHologramSensorProjection(
          replayId,
          checkpoint.step,
          [...overflowActors].reverse().map((candidate) => ({
            ...candidate,
            sensorView: {
              environmentalHolograms: [...candidate.sensorView!.environmentalHolograms].reverse(),
            },
          })),
        );
        expect(bounded).toEqual(reordered);
        expect(bounded.observers.map((observer) => observer.observerId)).toEqual([
          'observer-x',
          'observer-y',
        ]);
        expect(bounded.observers.map((observer) => observer.environmentalHolograms.length)).toEqual(
          [8, 8],
        );
        expect(JSON.stringify(bounded)).not.toContain('sourcePosition');

        const otherSpec = structuredClone(request.spec);
        otherSpec.participants[0].position.x += 250;
        const otherSubmitted = await app.inject({
          method: 'POST',
          url: '/api/battle-jobs',
          headers: { 'x-client-id': 'hologram-status', 'idempotency-key': 'other-attempt' },
          payload: { spec: otherSpec, budget: DEFAULT_BUDGET },
        });
        expect(otherSubmitted.statusCode).toBe(202);
        const otherDone = await runtime.wait(otherSubmitted.json().job.id);
        expect(otherDone.state).toBe('completed');
        const jobs = new JobStore(store);
        const attempt = jobs.attempts(id)[0]!;
        const otherAttempt = jobs.attempts(otherDone.id)[0]!;
        expect(otherAttempt.replayId).not.toBe(replayId);
        expect(
          store.db
            .prepare('UPDATE simulation_attempts SET replay_id = ? WHERE id = ?')
            .run(otherAttempt.replayId, attempt.id).changes,
        ).toBe(1);
        const swapped = await app.inject(`/api/battle-jobs/${id}`);
        expect(swapped.statusCode).toBe(503);
        expect(swapped.json().error).toMatch(/attempt binding/);
        expect(jobs.artifact(replayId)?.state).toBe('ready');
        expect(jobs.artifact(otherAttempt.replayId!)?.state).toBe('ready');
        expect(
          store.db
            .prepare('UPDATE simulation_attempts SET replay_id = ? WHERE id = ?')
            .run(replayId, attempt.id).changes,
        ).toBe(1);

        await app.close();
        await runtime.close();
        store.close();
        store = openStore(filename);
        runtime = await BattleService.open(store, root);
        app = createApp(store, false, runtime);

        reads.length = 0;
        manifestReads = 0;
        const restored = JobStatusSchema.parse((await app.inject(`/api/battle-jobs/${id}`)).json());
        expect(restored.attempts.at(-1)?.sensorProjection).toEqual(projection);
        expect(manifestReads).toBe(1);
        expect(reads).toEqual([
          savedManifest.checkpoints.at(-1)!.file,
          savedManifest.chunks.at(-1)!.file,
        ]);

        const manifestResponse = await app.inject(`/api/replays/${replayId}`);
        const manifest = ReplayManifestSchema.parse(manifestResponse.json()) as ReplayManifest;
        const finalCheckpoint = manifest.checkpoints.at(-1)!;
        const path = join(root, replayId, finalCheckpoint.file);
        const bytes = await readFile(path);
        bytes[0] = bytes[0]! ^ 1;
        await writeFile(path, bytes);
        const damaged = await app.inject(`/api/battle-jobs/${id}`);
        expect(damaged.statusCode).toBe(503);
        expect(new JobStore(store).artifact(replayId)?.state).toBe('corrupt');
      } finally {
        filesSpy.mockRestore();
        await app.close();
        await runtime.close();
        if (store.db.open) store.close();
      }
    });
  },
);

it(
  'omits observer projection from a non-completed attempt even when a diagnostic is saved',
  { timeout: 30_000 },
  async () => {
    await withReplayDirectory(async (directory) => {
      const store = openStore(join(directory, 'database.sqlite'));
      const runtime = await BattleService.open(store, join(directory, 'replays'), { timeoutMs: 1 });
      const app = createApp(store, false, runtime);
      try {
        const request = await activeHologramRequest(store, app);
        const job = await runtime.submit(
          request.spec,
          'hologram-status-failed',
          'actual-worker',
          DEFAULT_BUDGET,
        );
        const done = await runtime.wait(job.id);
        expect(done.state).toBe('failed');
        const status = JobStatusSchema.parse(
          (await app.inject(`/api/battle-jobs/${job.id}`)).json(),
        );
        expect(status.attempts).toHaveLength(1);
        expect(status.attempts[0]?.state).toBe('failed');
        expect(status.attempts[0]?.replayId).not.toBeNull();
        expect(status.attempts[0]?.sensorProjection).toBeUndefined();
      } finally {
        await app.close();
        await runtime.close();
        store.close();
      }
    });
  },
);
