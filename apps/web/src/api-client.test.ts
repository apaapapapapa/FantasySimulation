import { afterEach, expect, it, vi } from 'vite-plus/test';
import { ValidationSchema } from '@fantasy/domain/spatial';
import { api } from './api-client.ts';

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
  [() => new Response(' '.repeat(512 * 1024 + 1)), /exceeds/],
])(
  'does not treat a failed or invalid response as a completed operation',
  async (response, message) => {
    vi.stubGlobal('fetch', response);
    await expect(api('drafts/test/validate', ValidationSchema, { method: 'POST' })).rejects.toThrow(
      message,
    );
  },
);
