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
it('serves only a bounded exact pack range and reports whole-object metadata for HEAD', async () => {
  const fixture = bucket(),
    key = `packs/${'a'.repeat(64)}.bin`;
  const get = vi.fn(async () => ({
    size: 10,
    httpEtag: '"pack"',
    range: { offset: 2, length: 4 },
    body: new Blob([fixture.bytes]).stream(),
  }));
  fixture.env.REPLAYS.get = get as unknown as ReaderEnv['REPLAYS']['get'];
  const response = await readReplay(
    new Request(`https://reader.example/${key}`, {
      headers: { Range: 'bytes=2-5', Origin: 'https://apaapapapapa.github.io' },
    }),
    fixture.env,
  );
  expect(response.status).toBe(206);
  expect(await response.arrayBuffer()).toEqual(fixture.bytes.buffer);
  expect(get).toHaveBeenCalledExactlyOnceWith(key, { range: { offset: 2, length: 4 } });
  expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
  expect(response.headers.get('content-length')).toBe('4');
  expect(response.headers.get('content-type')).toBe('application/octet-stream');
  expect(response.headers.get('accept-ranges')).toBe('bytes');
  expect(response.headers.get('content-encoding')).toBeNull();
  expect((await readReplay(request(key, 'HEAD'), fixture.env)).status).toBe(200);
  const preflight = await readReplay(request(key, 'OPTIONS'), fixture.env);
  expect(preflight.headers.get('access-control-allow-headers')).toBe('Range');
  expect(preflight.headers.get('access-control-expose-headers')).toContain('Content-Range');
});
it.each([
  null,
  'bytes=1-',
  'bytes=-1',
  'bytes=0-1,2-3',
  'bytes=0-16777216',
  'bytes=9007199254740992-9007199254740993',
])('rejects pack range %s before storage', async (range) => {
  const fixture = bucket();
  const response = await readReplay(
    new Request(`https://reader.example/packs/${'a'.repeat(64)}.bin`, {
      headers: range ? { Range: range } : {},
    }),
    fixture.env,
  );
  expect(response.status).toBe(416);
  expect(fixture.get).not.toHaveBeenCalled();
});
it.each([undefined, { offset: 0, length: 2 }, { offset: 2, length: 1 }])(
  'rejects a missing, shifted or truncated R2 range',
  async (range) => {
    const fixture = bucket();
    fixture.env.REPLAYS.get = (async () => ({
      size: 4,
      httpEtag: '"pack"',
      range,
      body: new Blob([fixture.bytes]).stream(),
    })) as unknown as ReaderEnv['REPLAYS']['get'];
    expect(
      (
        await readReplay(
          new Request(`https://reader.example/packs/${'a'.repeat(64)}.bin`, {
            headers: { Range: 'bytes=2-3' },
          }),
          fixture.env,
        )
      ).status,
    ).toBe(503);
  },
);
it('returns 416 even when storage rejects an unsatisfiable offset before returning metadata', async () => {
  const fixture = bucket();
  fixture.env.REPLAYS.get = async () => {
    throw new Error('R2 range is unsatisfiable');
  };
  expect(
    (
      await readReplay(
        new Request(`https://reader.example/packs/${'a'.repeat(64)}.bin`, {
          headers: { Range: 'bytes=7-8' },
        }),
        fixture.env,
      )
    ).status,
  ).toBe(416);
  expect(fixture.head).toHaveBeenCalledTimes(1);
});
