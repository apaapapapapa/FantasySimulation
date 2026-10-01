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
  replayChunkRecords,
  replayContext,
  type ActorDisplay,
  type ReplayManifest,
  type StreamRecord,
} from '@fantasy/domain/spatial';
import {
  ManifestBuilder,
  sealRevision,
} from '../../../../packages/engine/src/spatial/manifest-builder.ts';
import { environmentalHologramManifest } from '../../../../packages/engine/test-support/environmental-holograms.ts';
import { withReplayDirectory } from '../../test-support/replays.ts';
import { specInput } from '../../test-support/runtime.ts';
import { openStore } from '../db/store.ts';
import { createApp } from '../http/app.ts';
import { ArtifactStore } from '../replay/artifact-store.ts';
import { sanitizeEnvironmentalHologramSensorProjection } from '../replay/sensor-projection.ts';
import { BattleService } from './battle-service.ts';
import { JobStore } from './job-store.ts';

async function activeHologramManifest() {
  let input = await environmentalHologramManifest(40);
  const oldAbility = input.revisions.find(
    (revision) => revision.kind === 'ability' && revision.id === 'sk07-hologram',
  );
  if (!oldAbility || oldAbility.kind !== 'ability') throw new Error('Missing hologram ability');
  const ability = await sealRevision('ability', oldAbility.id, oldAbility.revision, {
    ...oldAbility.definition,
    effects: oldAbility.definition.effects.map((effect) =>
      effect.kind === 'environmental-hologram' ? { ...effect, durationSteps: 300 } : effect,
    ),
  });
  input = await ManifestBuilder.relink(input, [{ from: oldAbility, to: ability }]);
  return input;
}

function sanitizedProjection(replayId: string, replay: ReplayState) {
  const checkpoint = replay.checkpoint();
  if (!checkpoint.state) throw new Error('Missing final replay state');
  return BattleSensorProjectionSchema.parse({
    replayId,
    step: checkpoint.step,
    observers: checkpoint.state.actors.map((actor) => ({
      observerId: actor.id,
      environmentalHolograms: (actor.sensorView?.environmentalHolograms ?? []).map(
        ({ sourcePosition: _, ...hologram }) => hologram,
      ),
    })),
  });
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
  return { manifest, replay, records: saved };
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
        .mockImplementation(async function (this: ArtifactStore, replayId: string) {
          manifestReads++;
          const opened = await files.call(this, replayId);
          return {
            ...opened,
            read: async (file: string) => {
              reads.push(file);
              return opened.read(file);
            },
          };
        });
      try {
        const input = await activeHologramManifest();
        await store.seedRevisions(input.revisions);
        const submitted = await app.inject({
          method: 'POST',
          url: '/api/battle-jobs',
          headers: { 'x-client-id': 'hologram-status', 'idempotency-key': 'actual-worker' },
          payload: { spec: specInput(input), budget: DEFAULT_BUDGET },
        });
        expect(submitted.statusCode).toBe(202);
        const id: string = submitted.json().job.id;
        const done = await runtime.wait(id);
        expect(done.state).toBe('completed');
        const replayId = new JobStore(store).result(done.resultId!)!.replayId;
        const savedManifest = await runtime.replay(replayId);

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
        const input = await activeHologramManifest();
        await store.seedRevisions(input.revisions);
        const job = await runtime.submit(
          specInput(input),
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
