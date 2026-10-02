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
  it('creates, reloads and CAS-respecs authoritative acquisition history over HTTP', async () => {
    const { app, character, catalogRecord, target } = await setup(),
      selection = {
        schemaVersion: 1,
        id: 'acquisition.route',
        version: 1,
        character: reference(character),
        catalog: catalogRecord.reference,
        learnedNodeIds: [target],
      },
      created = await app.inject({
        method: 'POST',
        url: '/api/skill-acquisitions',
        payload: { selection },
      });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id: selection.id,
      version: 1,
      authoritativeBoundary: true,
      snapshot: { learnedNodeIds: [target] },
    });
    expect((await app.inject(`/api/skill-acquisitions/${selection.id}`)).json()).toEqual(
      created.json(),
    );

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/skill-acquisitions/${selection.id}`,
      payload: {
        expectedVersion: 1,
        selection: { ...selection, version: 2, learnedNodeIds: [] },
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      version: 2,
      latest: { revision: 2 },
      snapshot: { learnedNodeIds: [] },
    });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/skill-acquisitions/${selection.id}`,
          payload: {
            expectedVersion: 1,
            selection: { ...selection, version: 2, learnedNodeIds: [] },
          },
        })
      ).statusCode,
    ).toBe(409);
  });

  it('rejects legacy HTTP writes without mutating a readable V1 head', async () => {
    const { app, skills, character, catalogRecord, configuration, target } = await setup(),
      characterRef = reference(character),
      legacy = await skills.createLegacy({ character: characterRef, configuration }),
      original = (await app.inject(`/api/skill-loadouts/${configuration.id}`)).json();
    expect(original).toEqual(legacy);

    const rejectedCreate = await app.inject({
      method: 'POST',
      url: '/api/skill-loadouts',
      payload: {
        character: characterRef,
        configuration: { ...configuration, id: 'loadout.route-new-legacy' },
      },
    });
    expect(rejectedCreate.statusCode).toBe(400);
    expect((await app.inject('/api/skill-loadouts/loadout.route-new-legacy')).statusCode).toBe(404);

    const rejectedPatch = await app.inject({
      method: 'PATCH',
      url: `/api/skill-loadouts/${configuration.id}`,
      payload: {
        expectedVersion: 1,
        character: characterRef,
        configuration: { ...configuration, version: 2 },
      },
    });
    expect(rejectedPatch.statusCode).toBe(400);
    expect((await app.inject(`/api/skill-loadouts/${configuration.id}`)).json()).toEqual(original);

    const acquisition = (
        await app.inject({
          method: 'POST',
          url: '/api/skill-acquisitions',
          payload: {
            selection: {
              schemaVersion: 1,
              id: 'acquisition.route-upgrade',
              version: 1,
              character: characterRef,
              catalog: catalogRecord.reference,
              learnedNodeIds: [target],
            },
          },
        })
      ).json(),
      upgradedConfiguration = {
        schemaVersion: 2 as const,
        id: configuration.id,
        version: 2,
        catalog: catalogRecord.reference,
        acquisition: acquisition.latest,
        enabledNodeIds: [target],
      },
      upgraded = await app.inject({
        method: 'PATCH',
        url: `/api/skill-loadouts/${configuration.id}`,
        payload: {
          expectedVersion: 1,
          character: characterRef,
          configuration: upgradedConfiguration,
        },
      });
    expect(upgraded.statusCode).toBe(200);
    expect(upgraded.json()).toMatchObject({ schemaVersion: 2, version: 2 });

    const downgrade = await app.inject({
      method: 'PATCH',
      url: `/api/skill-loadouts/${configuration.id}`,
      payload: {
        expectedVersion: 2,
        character: characterRef,
        configuration: { ...configuration, version: 3 },
      },
    });
    expect(downgrade.statusCode).toBe(400);
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/skill-loadouts/${configuration.id}`,
      payload: {
        expectedVersion: 1,
        character: characterRef,
        configuration: upgradedConfiguration,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect((await app.inject(`/api/skill-loadouts/${configuration.id}`)).json()).toEqual(
      upgraded.json(),
    );
  });

  it('creates and CAS-updates a V2 loadout bound to an exact acquisition revision', async () => {
    const { app, character, catalogRecord, configuration, target } = await setup(),
      acquisition = (
        await app.inject({
          method: 'POST',
          url: '/api/skill-acquisitions',
          payload: {
            selection: {
              schemaVersion: 1,
              id: 'acquisition.route-loadout',
              version: 1,
              character: reference(character),
              catalog: catalogRecord.reference,
              learnedNodeIds: [target],
            },
          },
        })
      ).json(),
      v2 = {
        schemaVersion: 2,
        id: configuration.id,
        version: 1,
        catalog: catalogRecord.reference,
        acquisition: acquisition.latest,
        enabledNodeIds: configuration.enabledNodeIds,
      },
      created = await app.inject({
        method: 'POST',
        url: '/api/skill-loadouts',
        payload: { character: reference(character), configuration: v2 },
      });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      schemaVersion: 2,
      version: 1,
      snapshot: {
        configuration: { acquisition: acquisition.latest },
        resolved: { acquisition: acquisition.latest },
      },
    });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/skill-loadouts/${configuration.id}`,
      payload: {
        expectedVersion: 1,
        character: reference(character),
        configuration: { ...v2, version: 2 },
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      schemaVersion: 2,
      version: 2,
      latest: { revision: 2 },
      snapshot: {
        configuration: { acquisition: acquisition.latest },
        resolved: { acquisition: acquisition.latest },
      },
    });
  });

  it('injects only an immutable loadout receipt and creates no job for invalid refs', async () => {
    const { app, submit, manifest, character, catalogRecord, configuration, target } =
        await setup(),
      acquisition = (
        await app.inject({
          method: 'POST',
          url: '/api/skill-acquisitions',
          payload: {
            selection: {
              schemaVersion: 1,
              id: 'acquisition.route-job',
              version: 1,
              character: reference(character),
              catalog: catalogRecord.reference,
              learnedNodeIds: [target],
            },
          },
        })
      ).json(),
      v2 = {
        schemaVersion: 2 as const,
        id: configuration.id,
        version: 1,
        catalog: catalogRecord.reference,
        acquisition: acquisition.latest,
        enabledNodeIds: [target],
      },
      created = (
        await app.inject({
          method: 'POST',
          url: '/api/skill-loadouts',
          payload: { character: reference(character), configuration: v2 },
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
      resolvedNodeIds: [target],
    });
    expect(submitted.participants[1].skillLoadout).toBeUndefined();
  });
});
