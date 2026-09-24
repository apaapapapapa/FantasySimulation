import { readFileSync } from 'node:fs';
import { ReplayManifestSchema } from '@fantasy/domain/spatial';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { ValidationSchema } from '@fantasy/domain/spatial';
import { api, apiRevisionPage, executableRules, reference } from './api-client.ts';

function savedManifest() {
  return ReplayManifestSchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../test-fixtures/replays/swordsman-sky-mage-240/manifest.json', import.meta.url),
        'utf8',
      ),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());
it('uses the same origin and retains optimistic versions while validating responses', async () => {
  const request = vi.fn(async () => Response.json({ valid: true, issues: [] }));
  vi.stubGlobal('fetch', request);
  const controller = new AbortController();
  expect(
    await api('drafts/test/validate', ValidationSchema, {
      method: 'POST',
      body: { expectedVersion: 2 },
      signal: controller.signal,
    }),
  ).toEqual({ valid: true, issues: [] });
  expect(request.mock.calls[0]).toEqual([
    '/api/drafts/test/validate',
    {
      method: 'POST',
      body: '{"expectedVersion":2}',
      signal: controller.signal,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
    },
  ]);
});
it.each([
  [() => Response.json({ error: 'stale version' }, { status: 409 }), /API 409: stale version/],
  [() => Response.json({ valid: 'yes', issues: [] }), /応答形式/],
  [() => new Response('{broken'), /読み取れません/],
  [() => new Response(' '.repeat(1024 * 1024 + 1)), /exceeds/],
])(
  'does not treat a failed or invalid response as a completed operation',
  async (response, message) => {
    vi.stubGlobal('fetch', response);
    await expect(api('drafts/test/validate', ValidationSchema, { method: 'POST' })).rejects.toThrow(
      message,
    );
  },
);

it('reads a bounded revision page with large valid definitions and requests only ten rows', async () => {
  const manifest = savedManifest();
  const character = manifest.input.revisions.find((r) => r.kind === 'character')!;
  if (character.kind !== 'character') throw new Error('Fixture character');
  character.definition.originalText = '長'.repeat(20000);
  const page = {
    items: Array.from({ length: 10 }, (_, i) => ({ ...character, id: `large.${i}` })),
    nextCursor: 'large.9',
  };
  const request = vi.fn(async () => Response.json(page));
  vi.stubGlobal('fetch', request);
  expect((await apiRevisionPage('character', null)).items).toHaveLength(10);
  expect(request).toHaveBeenCalledWith('/api/revisions/character?limit=10', expect.any(Object));
});

it('uses only eligibility bound to the exact server revision, including absent metadata', () => {
  const rule = savedManifest().input.revisions.find((revision) => revision.kind === 'ruleset')!;
  const page = { items: [rule], nextCursor: null };
  expect(executableRules(page)).toEqual([]);
  const eligibility = { executable: true as const };
  expect(
    executableRules({ ...page, execution: [{ revision: reference(rule), eligibility }] }),
  ).toEqual([rule]);
  for (const revision of [
    { ...reference(rule), revision: rule.revision + 1 },
    { ...reference(rule), contentHash: `sha256:${'f'.repeat(64)}` },
  ])
    expect(executableRules({ ...page, execution: [{ revision, eligibility }] })).toEqual([]);
  expect(
    executableRules({
      ...page,
      execution: [
        {
          revision: reference(rule),
          eligibility: { executable: false, code: 'unsupported-rules', reason: 'saved' },
        },
      ],
    }),
  ).toEqual([]);
});
