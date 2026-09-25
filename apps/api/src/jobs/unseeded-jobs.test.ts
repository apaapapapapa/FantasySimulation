import { expect, it } from 'vite-plus/test';
import { actorSeed } from '@fantasy/domain/spatial';
import { withRuntime } from '../../test-support/runtime.ts';
import { createApp } from '../http/app.ts';

it('derives actor streams on the server and accepts the equivalent persisted batch input', async () => {
  await withRuntime(async ({ runtime, store, spec }) => {
    const app = createApp(store, false, runtime);
    const unseeded = {
      ...spec,
      participants: spec.participants.map(({ actorId, character, position, facing }) => ({
        actorId,
        character,
        position,
        facing,
      })),
    };
    const headers = { 'x-client-id': 'seedless', 'idempotency-key': 'same' };
    try {
      const fresh = await app.inject({
        method: 'POST',
        url: '/api/battle-jobs',
        headers,
        payload: { spec: unseeded },
      });
      expect(fresh.statusCode).toBe(202);
      const job = fresh.json().job;
      const saved = store.getSpec(job.simulationHash)!;
      expect(
        saved.manifest.participants.map(({ rngStream, rngSeed }) => ({ rngStream, rngSeed })),
      ).toEqual([
        { rngStream: 0, rngSeed: actorSeed(spec.seed, 0) },
        { rngStream: 1, rngSeed: actorSeed(spec.seed, 1) },
      ]);
      const legacy = await app.inject({
        method: 'POST',
        url: '/api/battle-jobs',
        headers,
        payload: { spec },
      });
      expect(legacy.json().job.id).toBe(job.id);
      expect(legacy.json().job.simulationHash).toBe(job.simulationHash);
      const mixed = await app.inject({
        method: 'POST',
        url: '/api/battle-jobs',
        headers,
        payload: {
          spec: { ...unseeded, participants: [spec.participants[0], unseeded.participants[1]] },
        },
      });
      expect(mixed.statusCode).toBe(400);
      expect((await runtime.wait(job.id)).state).toBe('completed');
    } finally {
      await app.close();
    }
  });
}, 30_000);
