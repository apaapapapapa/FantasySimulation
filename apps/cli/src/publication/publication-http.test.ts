import { afterEach, expect, it, vi } from 'vite-plus/test';
import { publicHttp } from './publication-http.ts';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
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
it('keeps league verification alive after a long upload while bounding each request and the whole phase', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('fixture timeout')), ms);
    return controller.signal;
  });
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_url, options) => {
      const signal = options!.signal!;
      signal.throwIfAborted();
      signals.push(signal);
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }),
  );
  const manual = publicHttp('https://viewer.example/');
  const league = publicHttp('https://viewer.example/', 7200000);
  await league('build.json', 4096);
  await vi.advanceTimersByTimeAsync(1800000); // Upload and HEAD verification take thirty minutes.
  await expect(manual('build.json', 4096)).rejects.toThrow('fixture timeout');
  await expect(league('build.json', 4096)).resolves.toEqual(Buffer.from('{}'));
  const last = signals.at(-1)!;
  expect(last.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(300000);
  expect(last.aborted).toBe(true); // The individual request still has a five-minute bound.
  await vi.advanceTimersByTimeAsync(5400000);
  await expect(league('build.json', 4096)).rejects.toThrow('fixture timeout');
  for (const invalid of [0, 7200001, 1.5, NaN])
    expect(() => publicHttp('https://viewer.example/', invalid)).toThrow('deadline');
});
