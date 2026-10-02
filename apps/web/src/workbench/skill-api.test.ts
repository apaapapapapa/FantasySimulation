import { afterEach, expect, it, vi } from 'vite-plus/test';
import { revisionHash, RevisionSchema, type Revision } from '@fantasy/domain/spatial';
import {
  DEFAULT_SKILL_CATALOG,
  createOrRecoverSkillAcquisition,
  sameSkillRevisionRef,
  skillLoadoutsForCatalog,
  skillWorkbenchApi,
  type SkillAcquisitionHead,
  type SkillLoadoutHead,
} from './skill-api.ts';

afterEach(() => vi.unstubAllGlobals());

async function abilityRevision(
  definitionOverrides: Record<string, unknown> = {},
): Promise<Extract<Revision, { kind: 'ability' }>> {
  const parsed = RevisionSchema.parse({
    kind: 'ability',
    id: 'transport-ability',
    revision: 1,
    schemaVersion: 1,
    contentHash: `sha256:${'0'.repeat(64)}`,
    definition: {
      name: 'Transport ability',
      originalText: '',
      trigger: 'action',
      target: 'enemy',
      condition: { kind: 'always' },
      costs: { hp: 0, mp: 1, uses: 0 },
      castSteps: 1,
      recoverySteps: 1,
      cooldownSteps: 0,
      movementWhileCasting: 'allow',
      rangeMm: 2000,
      aimErrorMilliDegrees: 0,
      attack: {
        kind: 'melee',
        reachMm: 1800,
        radiusMm: 200,
        activeSteps: 1,
        maxHitsPerTarget: 1,
      },
      effects: [{ kind: 'damage', amount: 1, attackScaleBps: 10_000, element: 'physical' }],
      ...definitionOverrides,
    },
  });
  if (parsed.kind !== 'ability') throw new Error('Expected ability fixture');
  return { ...parsed, contentHash: await revisionHash(parsed) };
}

it('targets the integrated immutable startup catalog by default', () => {
  expect(DEFAULT_SKILL_CATALOG).toEqual({ id: 'skill-catalog-v1', revision: 10 });
});

it('keeps exact refs and excludes loadouts from another catalog revision', () => {
  const hash = (digit: string) => `sha256:${digit.repeat(64)}` as const,
    catalog = { id: 'skills', revision: 2, contentHash: hash('2') },
    heads = [
      { id: 'matching', snapshot: { configuration: { catalog } } },
      {
        id: 'old',
        snapshot: {
          configuration: { catalog: { ...catalog, revision: 1, contentHash: hash('1') } },
        },
      },
    ] as unknown as SkillLoadoutHead[];
  expect(skillLoadoutsForCatalog(heads, catalog).map(({ id }) => id)).toEqual(['matching']);
  expect(sameSkillRevisionRef(catalog, { ...catalog })).toBe(true);
  expect(sameSkillRevisionRef(catalog, { ...catalog, contentHash: hash('3') })).toBe(false);
});

it('reads the confirmed bounded cursor pages for saved loadouts', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ items: [], nextCursor: 'loadout.after' }))
    .mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }));
  vi.stubGlobal('fetch', request);
  await expect(skillWorkbenchApi.listLoadouts()).resolves.toEqual([]);
  const calls = request.mock.calls as unknown as [string, RequestInit][];
  expect(calls.map(([url]) => url)).toEqual([
    '/api/skill-loadouts?limit=100',
    '/api/skill-loadouts?limit=100&cursor=loadout.after',
  ]);
});

it('loads actual ability revisions used by node detail instead of inferring runtime fields', async () => {
  const ability = await abilityRevision();
  const request = vi.fn(async () => Response.json({ items: [ability], nextCursor: null }));
  vi.stubGlobal('fetch', request);
  await expect(skillWorkbenchApi.listAbilities()).resolves.toEqual([ability]);
  expect(request).toHaveBeenCalledOnce();
  const calls = request.mock.calls as unknown as [string, RequestInit][];
  expect(calls[0]?.[0]).toBe('/api/revisions/ability?limit=10');
});

it('rejects a transport ability whose definition does not match its claimed content hash', async () => {
  const ability = await abilityRevision();
  const tampered = {
    ...ability,
    definition: { ...ability.definition, costs: { ...ability.definition.costs, mp: 999 } },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [tampered], nextCursor: null })),
  );
  await expect(skillWorkbenchApi.listAbilities()).rejects.toThrow('content hash mismatch');
});

it('rejects conflicting duplicate revision identities even when each hash is valid', async () => {
  const first = await abilityRevision();
  const second = await abilityRevision({ costs: { hp: 0, mp: 2, uses: 0 } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ items: [first, second], nextCursor: null })),
  );
  await expect(skillWorkbenchApi.listAbilities()).rejects.toThrow('Conflicting duplicate revision');
});

it('isolates the skill battle endpoint and binds the saved revision to the selected actor', async () => {
  const response = {
    job: {
      id: 'job.skill',
      simulationHash: `sha256:${'a'.repeat(64)}`,
      state: 'queued',
      attempts: 0,
      maxAttempts: 3,
      resultId: null,
      error: null,
    },
  };
  const request = vi.fn(async () => Response.json(response));
  vi.stubGlobal('fetch', request);
  const loadout = {
    id: 'loadout.hero',
    revision: 3,
    contentHash: `sha256:${'b'.repeat(64)}`,
  };
  await skillWorkbenchApi.createBattleJob({
    actorId: 'left',
    skillLoadout: loadout,
    job: { spec: { seed: 42 }, budget: { maxBytes: 1024 } },
  });
  expect(request).toHaveBeenCalledOnce();
  const [url, options] = (request.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(url).toBe('/api/skill-battle-jobs');
  expect(JSON.parse(String(options?.body))).toEqual({
    spec: { seed: 42 },
    budget: { maxBytes: 1024 },
    loadouts: [{ actorId: 'left', loadout }],
  });
});

it('posts acquisition state before a V2 loadout bound to the returned exact revision', async () => {
  const hash = `sha256:${'a'.repeat(64)}` as const,
    laterHash = `sha256:${'b'.repeat(64)}` as const,
    timestamp = '2026-10-02T00:00:00.000Z',
    character = { id: 'character.hero', revision: 1, contentHash: hash },
    catalog = { id: 'skill-catalog-v1', revision: 10, contentHash: hash },
    acquisition = {
      schemaVersion: 1,
      authoritativeBoundary: false,
      id: 'loadout.hero.acquisition',
      version: 1,
      latest: { id: 'loadout.hero.acquisition', revision: 1, contentHash: laterHash },
      snapshot: {
        schemaVersion: 1,
        policyVersion: 'skill-acquisition-v1',
        id: 'loadout.hero.acquisition',
        revision: 1,
        contentHash: laterHash,
        character,
        catalog,
        eligibilityNodeIds: ['skill.magic.tiger.1'],
        learnedNodeIds: ['skill.magic.tiger.1'],
        capabilitiesDigest: hash,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    configuration = {
      schemaVersion: 2 as const,
      id: 'loadout.hero',
      version: 1,
      catalog,
      acquisition: acquisition.latest,
      enabledNodeIds: [],
    },
    resolved = {
      schemaVersion: 2,
      resolverVersion: 'skill-resolver-v1',
      configurationId: configuration.id,
      configurationVersion: 1,
      catalog,
      acquisition: acquisition.latest,
      learnedNodeIds: acquisition.snapshot.learnedNodeIds,
      explicitlyEnabledNodeIds: [],
      resolvedNodeIds: [],
      nodeResolutions: [],
      resolutionDigest: hash,
    },
    loadout = {
      schemaVersion: 2,
      id: configuration.id,
      version: 1,
      latest: { id: configuration.id, revision: 1, contentHash: hash },
      snapshot: {
        schemaVersion: 2,
        id: configuration.id,
        revision: 1,
        contentHash: hash,
        character,
        configuration,
        resolved,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(acquisition))
      .mockResolvedValueOnce(Response.json(loadout));
  vi.stubGlobal('fetch', request);

  const savedAcquisition = await skillWorkbenchApi.createAcquisition({
    schemaVersion: 1,
    id: acquisition.id,
    version: 1,
    character,
    catalog,
    learnedNodeIds: acquisition.snapshot.learnedNodeIds,
  });
  await expect(skillWorkbenchApi.createLoadout(character, configuration)).resolves.toMatchObject({
    schemaVersion: 2,
    snapshot: { configuration: { acquisition: savedAcquisition.latest } },
  });

  const calls = request.mock.calls as unknown as [string, RequestInit][];
  expect(calls.map(([url]) => url)).toEqual(['/api/skill-acquisitions', '/api/skill-loadouts']);
  expect(JSON.parse(String(calls[0]![1].body))).toMatchObject({
    selection: { id: acquisition.id, learnedNodeIds: ['skill.magic.tiger.1'] },
  });
  expect(JSON.parse(String(calls[1]![1].body))).toMatchObject({
    configuration: { schemaVersion: 2, acquisition: savedAcquisition.latest },
  });
});

it('recovers the exact version-one acquisition when a successful POST response is lost', async () => {
  const hash = `sha256:${'c'.repeat(64)}` as const,
    character = { id: 'character.retry', revision: 1, contentHash: hash },
    catalog = { id: 'catalog.retry', revision: 1, contentHash: hash },
    selection = {
      schemaVersion: 1 as const,
      id: 'loadout.retry.acquisition',
      version: 1,
      character,
      catalog,
      learnedNodeIds: ['skill.retry'],
    },
    recovered = {
      id: selection.id,
      version: 1,
      latest: { id: selection.id, revision: 1, contentHash: hash },
      snapshot: { character, catalog, learnedNodeIds: selection.learnedNodeIds },
    } as unknown as SkillAcquisitionHead,
    createAcquisition = vi.fn(async () => {
      throw new TypeError('response lost after commit');
    }),
    getAcquisition = vi.fn(async () => recovered);

  await expect(
    createOrRecoverSkillAcquisition({ createAcquisition, getAcquisition }, selection),
  ).resolves.toBe(recovered);
  expect(createAcquisition).toHaveBeenCalledOnce();
  expect(getAcquisition).toHaveBeenCalledExactlyOnceWith(selection.id);
  expect(recovered.latest.revision).toBe(1);
});
