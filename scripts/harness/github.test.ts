import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vite-plus/test';
import { createGateway } from './github.ts';
import { collectPages } from './github-collect.ts';
afterEach(() => vi.unstubAllGlobals());
describe('Octokit transport boundaries', () => {
  it('uses SDK auth and rejects writes, foreign URLs and request-budget excess', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    });
    const client = createGateway('fixture-only', { requests: 1, bytes: 1000, deadlineMs: 5000 });
    try {
      assert.deepEqual(await client.get('GET /repos/owner/repo'), { ok: true });
      await assert.rejects(client.get('POST /repos/owner/repo'));
      await assert.rejects(client.get('GET https://elsewhere.invalid'));
      await assert.rejects(client.query('mutation { dangerous }', {}));
      await assert.rejects(client.get('GET /repos/owner/repo'));
      assert.equal(calls, 1);
    } finally {
      client.close();
    }
  });
  it('preserves the response URL required by counted SDK pagination', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (calls === 1)
        headers.link =
          '<https://api.github.com/repos/owner/repo/commits/head/check-runs?page=2>; rel="next"';
      return new Response(JSON.stringify({ total_count: 2, check_runs: [{ id: calls }] }), {
        headers,
      });
    });
    const client = createGateway('fixture-only');
    try {
      assert.deepEqual(
        await collectPages(client, 'GET /repos/owner/repo/commits/head/check-runs'),
        [{ id: 1 }, { id: 2 }],
      );
      assert.equal(calls, 2);
    } finally {
      client.close();
    }
  });
  it('bounds response bytes before JSON parsing', async () => {
    vi.stubGlobal('fetch', async () => new Response('x'.repeat(1000)));
    const client = createGateway('fixture-only', { requests: 10, bytes: 10, deadlineMs: 5000 });
    try {
      await assert.rejects(client.get('GET /repos/owner/repo'));
    } finally {
      client.close();
    }
  });
  it('does not conceal rate limits by retrying indefinitely', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('{"message":"rate limited"}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      });
    });
    const client = createGateway('fixture-only');
    try {
      await assert.rejects(client.get('GET /repos/owner/repo'));
      assert.equal(calls, 1);
    } finally {
      client.close();
    }
  });
});
