import { expect, it } from 'vite-plus/test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@fantasy/domain/spatial';
import { packedFixture, packedResponse } from '../../../../e2e/packed-fixtures.ts';
import { publicLibrary } from './public-source.ts';
import { openReplay } from './open-replay.ts';
import { seekStep } from './seek-step.ts';

function served(fault?: string) {
  const fixture = packedFixture(),
    requests: { key: string; range: string | null }[] = [];
  if (fault === 'v1-catalog') {
    const catalog = Buffer.from(
      canonicalJson({
        schemaVersion: 1,
        previousCatalogHash: null,
        sets: [
          {
            setHash: fixture.setHash,
            bytes: fixture.files.get(`sets/${fixture.setHash.slice(7)}/set.json`)!.length,
          },
        ],
      }),
    );
    const hash = createHash('sha256').update(catalog).digest('hex');
    fixture.files.set(`catalog/${hash}.json`, catalog);
    fixture.files.set(
      'catalog/current.json',
      Buffer.from(
        canonicalJson({
          schemaVersion: 1,
          catalogHash: 'sha256:' + hash,
          bytes: catalog.length,
        }),
      ),
    );
  }
  const request: typeof fetch = async (url, init) => {
    const key = new URL(url.toString()).pathname.slice(1),
      range = new Headers(init?.headers).get('range');
    requests.push({ key, range });
    const response = packedResponse(fixture.files, key, range),
      headers = new Headers(response.headers);
    let body = response.body,
      status = response.status;
    if (key === fixture.packPath) {
      if (fault === '200') status = 200;
      if (fault === 'range') headers.set('content-range', 'bytes 0-3/4');
      if (fault === 'size') headers.set('content-length', String(body.length + 1));
      if (fault === 'etag') headers.delete('etag');
      if (fault === 'encoding') headers.set('content-encoding', 'gzip');
      if (fault === 'corrupt') {
        body = Buffer.from(body);
        body[0] = body[0]! ^ 1;
      }
    }
    if (fault === 'index' && key.startsWith('pack-indexes/')) body = Buffer.from('{}');
    return new Response(new Uint8Array(body), { status, headers });
  };
  return { fixture, requests, library: publicLibrary('https://reader.example/', request) };
}
it('selects, opens and seeks historical recordings using only verified closed ranges', async () => {
  const { fixture, requests, library } = served();
  const catalog = await library.catalog(),
    set = await library.set(catalog.sets[0]!, catalog.schemaVersion);
  await library.page(fixture.setHash, set, 0);
  expect(requests).toHaveLength(4);
  expect(requests.every(({ range }) => range === null)).toBe(true);
  for (const row of fixture.rows) {
    const replay = await openReplay(library.source(row));
    expect(replay.manifest.id).toBe(row.replay.replayId);
    await seekStep(replay, 20);
    expect((await seekStep(replay, 2)).step).toBe(2);
    expect((await seekStep(replay, 30)).ended).toBe(true);
  }
  expect(requests.some(({ key }) => key.startsWith('objects/'))).toBe(false);
  expect(
    requests
      .filter(({ key }) => key.startsWith('packs/'))
      .every(({ range }) => /^bytes=\d+-\d+$/.test(range!)),
  ).toBe(true);
});
it('rejects an internally hashed v1 catalog pointing to a v2 set before loading a page or pack', async () => {
  const { library, requests } = served('v1-catalog');
  const catalog = await library.catalog();
  await expect(library.set(catalog.sets[0]!, catalog.schemaVersion)).rejects.toMatchObject({
    kind: 'damaged',
  });
  expect(requests).toHaveLength(3);
  expect(
    requests.some(({ key }) => key.startsWith('packs/') || key.startsWith('pack-indexes/')),
  ).toBe(false);
});
it.each(['200', 'range', 'size', 'etag', 'encoding', 'corrupt', 'index'])(
  'rejects %s before decoding, without retrying a whole pack',
  async (fault) => {
    const { fixture, requests, library } = served(fault);
    await expect(openReplay(library.source(fixture.rows[0]!))).rejects.toThrow();
    const packs = requests.filter(({ key }) => key.startsWith('packs/'));
    expect(packs.length).toBe(fault === 'index' ? 0 : 1);
    expect(packs.every(({ range }) => range !== null)).toBe(true);
  },
);
