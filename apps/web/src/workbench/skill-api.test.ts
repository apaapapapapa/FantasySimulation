import { afterEach, expect, it, vi } from 'vite-plus/test';
import { revisionHash, RevisionSchema, type Revision } from '@fantasy/domain/spatial';
import {
  DEFAULT_SKILL_CATALOG,
  sameSkillRevisionRef,
  skillLoadoutsForCatalog,
  skillWorkbenchApi,
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
