import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { DEFAULT_BUDGET, type BattleInput } from '@fantasy/domain/spatial';
import { reference } from '@fantasy/engine/spatial';
import { skillPersistenceFixture } from '../../test-support/skills.ts';
import { openStore } from '../db/store.ts';
import type { BattleService } from '../jobs/battle-service.ts';
import { createApp } from './app.ts';

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function setup() {
  const store = openStore(':memory:'),
    fixture = await skillPersistenceFixture(store, 'route'),
    submit = vi.fn(async (_input: BattleInput) => ({
      id: 'job.skill',
      simulationHash: `sha256:${'4'.repeat(64)}`,
      state: 'queued' as const,
      attempts: 0,
      maxAttempts: 3,
      resultId: null,
      error: null,
    })),
    close = vi.fn(async () => undefined),
    runtime = { submit, close } as unknown as BattleService,
    app = createApp(store, false, runtime);
  apps.push(app);
  return {
    ...fixture,
    app,
    store,
    submit,
  };
}

describe('skill loadout API', () => {
  it('saves, reloads and CAS-updates a server-resolved immutable loadout', async () => {
    const { app, character, configuration } = await setup(),
      created = await app.inject({
        method: 'POST',
        url: '/api/skill-loadouts',
        payload: { character: reference(character), configuration },
      });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: configuration.id, version: 1 });
    expect((await app.inject(`/api/skill-loadouts/${configuration.id}`)).json()).toEqual(
      created.json(),
    );
    expect((await app.inject('/api/skill-loadouts?limit=1')).json()).toMatchObject({
      items: [{ id: configuration.id, version: 1 }],
      nextCursor: null,
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/skill-loadouts/${configuration.id}`,
      payload: {
        expectedVersion: 1,
        character: reference(character),
        configuration: { ...configuration, version: 2 },
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ version: 2, latest: { revision: 2 } });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/skill-loadouts/${configuration.id}`,
          payload: {
            expectedVersion: 1,
            character: reference(character),
            configuration: { ...configuration, version: 2 },
          },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('injects only an immutable loadout receipt and creates no job for invalid refs', async () => {
    const { app, submit, manifest, character, configuration } = await setup(),
      created = (
        await app.inject({
          method: 'POST',
          url: '/api/skill-loadouts',
          payload: { character: reference(character), configuration },
        })
      ).json(),
      spec = {
        seed: manifest.seed,
        participants: manifest.participants,
        ruleset: manifest.ruleset,
        scenario: manifest.scenario,
      },
      base = {
        spec,
        budget: DEFAULT_BUDGET,
      },
      headers = { 'x-client-id': 'skill-test', 'idempotency-key': 'invalid' };
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/skill-battle-jobs',
      headers,
      payload: {
        ...base,
        loadouts: [
          {
            actorId: manifest.participants[0].actorId,
            loadout: { ...created.latest, contentHash: `sha256:${'3'.repeat(64)}` },
          },
        ],
      },
    });
    expect(invalid.statusCode).toBe(409);
    expect(submit).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/skill-battle-jobs',
      headers: { ...headers, 'idempotency-key': 'valid' },
      payload: {
        ...base,
        loadouts: [{ actorId: manifest.participants[0].actorId, loadout: created.latest }],
      },
    });
    expect(accepted.statusCode).toBe(202);
    expect(submit).toHaveBeenCalledOnce();
    const submitted = submit.mock.calls[0]![0];
    expect(submitted.participants[0].skillLoadout).toMatchObject({
      loadout: created.latest,
      resolvedNodeIds: [configuration.enabledNodeIds[0]],
    });
    expect(submitted.participants[1].skillLoadout).toBeUndefined();
  });
});
