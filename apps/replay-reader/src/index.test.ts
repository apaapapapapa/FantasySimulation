import { expect, it, vi } from 'vite-plus/test';
import { readReplay, type ReaderEnv } from './index.ts';

function bucket() {
  const bytes = new Uint8Array([31, 139, 8, 0]);
  const metadata = { size: bytes.length, httpEtag: '"stored-etag"' };
  const get = vi.fn(async () => ({ ...metadata, body: new Blob([bytes]).stream() }));
  const head = vi.fn(async () => metadata);
  const env = { REPLAYS: { get, head } } as unknown as ReaderEnv;
  return { bytes, get, head, env };
}
const key = `objects/${'a'.repeat(64)}/chunk-00000.ndjson.gz`;
const request = (path: string, method = 'GET', origin = 'https://apaapapapapa.github.io') =>
  new Request(`https://reader.example/${path}`, { method, headers: { origin } });

it('preserves compressed bytes and serves explicit types, immutable caching, CORS and HEAD', async () => {
  const fixture = bucket();
  const response = await readReplay(request(key), fixture.env);
  expect(response.status).toBe(200);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(fixture.bytes);
  expect(response.headers.get('content-type')).toBe('application/gzip');
  expect(response.headers.has('content-encoding')).toBe(false);
  expect(response.headers.get('cache-control')).toContain('immutable');
  expect(response.headers.get('access-control-allow-origin')).toBe(
    'https://apaapapapapa.github.io',
  );
  const onlyHead = await readReplay(request(key, 'HEAD'), fixture.env);
  expect(onlyHead.body).toBeNull();
  expect(onlyHead.headers.get('content-length')).toBe('4');
  expect(fixture.get).toHaveBeenCalledTimes(1);
  expect(fixture.head).toHaveBeenCalledExactlyOnceWith(key);
  const pointer = await readReplay(request('catalog/current.json'), fixture.env);
  expect(pointer.headers.get('cache-control')).toBe('public, max-age=30, no-transform');
  expect(pointer.headers.get('content-type')).toBe('application/json');
});
it.each([
  ['', 'GET', 404],
  ['objects/', 'GET', 404],
  ['control/league-usage.json', 'GET', 404],
  ['catalog/current.json?list-type=2', 'GET', 404],
  ['objects/%2e%2e%2fsecret', 'GET', 404],
  ['https://other.example/file', 'GET', 404],
  ['catalog/current.json', 'PUT', 405],
  ['catalog/current.json', 'POST', 405],
  ['catalog/current.json', 'DELETE', 405],
])('refuses %s %s before touching storage', async (path, method, status) => {
  const fixture = bucket();
  expect((await readReplay(request(path as string, method as string), fixture.env)).status).toBe(
    status,
  );
  expect(fixture.get).not.toHaveBeenCalled();
  expect(fixture.head).not.toHaveBeenCalled();
});
it('CORS is exact, OPTIONS is bounded, and public reads need no credentials', async () => {
  const fixture = bucket();
  const denied = await readReplay(
    request(key, 'GET', 'https://apaapapapapa.github.io.evil.example'),
    fixture.env,
  );
  expect(denied.status).toBe(403);
  expect(denied.headers.has('access-control-allow-origin')).toBe(false);
  expect((await readReplay(request(key, 'OPTIONS'), fixture.env)).status).toBe(204);
  expect(fixture.get).not.toHaveBeenCalled();
  expect((await readReplay(new Request(`https://reader.example/${key}`), fixture.env)).status).toBe(
    200,
  );
});
it('returns uncached, CORS-visible missing/storage errors without internal exception text', async () => {
  const fixture = bucket();
  fixture.env.REPLAYS.get = async () => null;
  const missing = await readReplay(request(key), fixture.env);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: 'not-published' });
  fixture.env.REPLAYS.get = async () => {
    throw new Error('private credential diagnostic');
  };
  const failed = await readReplay(request(key), fixture.env);
  expect(failed.status).toBe(503);
  expect(failed.headers.get('cache-control')).toBe('no-store');
  expect(await failed.json()).toEqual({ error: 'storage-unavailable' });
});
