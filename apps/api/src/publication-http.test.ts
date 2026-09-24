import { afterEach, expect, it, vi } from 'vite-plus/test';
import { publicHttp } from './publication-http.ts';
afterEach(() => vi.unstubAllGlobals());
it('refuses credential-bearing roots, redirects, wrong types and changed gzip transport', async () => {
  expect(() => publicHttp('https://user:secret@example.com/')).toThrow('public HTTPS');
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const read = publicHttp('https://reader.example/');
  for (const response of [
    new Response('redirect', { status: 302 }),
    new Response('text', { headers: { 'content-type': 'text/plain' } }),
    new Response('gzip', {
      headers: { 'content-type': 'application/gzip', 'content-encoding': 'gzip' },
    }),
  ]) {
    fetch.mockResolvedValueOnce(response);
    await expect(read('file.gz', 100)).rejects.toThrow('Public read-back failed');
  }
  expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
  await expect(read('https://other.example/file', 100)).rejects.toThrow('Invalid public');
});
it('cancels oversized read-back and preserves exact compressed bytes', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const read = publicHttp('https://reader.example/');
  const bytes = Buffer.from([31, 139, 8, 0]);
  fetch.mockResolvedValueOnce(
    new Response(bytes, { headers: { 'content-type': 'application/gzip' } }),
  );
  expect(await read('chunk.gz', 4)).toEqual(bytes);
  fetch.mockResolvedValueOnce(
    new Response(bytes, { headers: { 'content-type': 'application/gzip' } }),
  );
  await expect(read('chunk.gz', 3)).rejects.toThrow('byte budget');
});
