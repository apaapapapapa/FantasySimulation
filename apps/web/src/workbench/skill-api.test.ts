import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  DEFAULT_SKILL_CATALOG,
  sameSkillRevisionRef,
  skillLoadoutsForCatalog,
  skillWorkbenchApi,
  type SkillLoadoutHead,
} from './skill-api.ts';

afterEach(() => vi.unstubAllGlobals());

it('targets the integrated immutable startup catalog by default', () => {
  expect(DEFAULT_SKILL_CATALOG).toEqual({ id: 'skill-catalog-v1', revision: 3 });
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
