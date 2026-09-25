import { expect, it } from 'vite-plus/test';
import { PublicMatchPageSchema, ReplayManifestSchema } from '@fantasy/domain/spatial';
import { publicFixtures } from '../../../../e2e/publication-fixtures.ts';
import { publicLibrary } from './public-source.ts';
import { openReplay } from './open-replay.ts';
import { seekStep } from './seek-step.ts';
import { selectionFiles, selectionGenerations } from '../../../../e2e/selection-fixtures.ts';

const root = 'http://127.0.0.1:12345/fixtures/';
const files = publicFixtures(process.cwd());
const pages = [...files]
  .filter(([key]) => key.startsWith('sets/') && !key.endsWith('/set.json'))
  .map(([, value]) => PublicMatchPageSchema.parse(JSON.parse(value.toString())));
const row = pages.flatMap((page) => page.rows).find((row) => row.state === 'complete')!;
function served(change?: (key: string) => Response | undefined, fixtureFiles = files) {
  const requests: string[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    expect(url.startsWith(root)).toBe(true);
    expect(init?.credentials).toBe('omit');
    expect(init?.redirect).toBe('error');
    const key = url.slice(root.length);
    requests.push(key);
    const altered = change?.(key);
    if (altered) return altered;
    const bytes = fixtureFiles.get(key);
    return bytes
      ? new Response(new Uint8Array(bytes), {
          headers: {
            'content-type': key.endsWith('.gz') ? 'application/gzip' : 'application/json',
          },
        })
      : new Response(null, { status: 404 });
  };
  return { library: publicLibrary(root, request), requests };
}

it('loads only catalog/set/one page before selection, then verifies and seeks the saved recording', async () => {
  const { library, requests } = served();
  const catalog = await library.catalog();
  const ref = catalog.sets.find(
    (ref) =>
      ref.setHash === 'sha256:71eea377f98a8600756ebafdb13cb3cc4fa2df88bdf9ee9b79e5018a4fbfa60a',
  )!;
  const set = await library.set(ref);
  const page = await library.page(ref.setHash, set, 1);
  expect(set.totalRows).toBe(1000);
  expect(page.rows).toHaveLength(100);
  expect(requests).toHaveLength(4);
  expect(requests.some((key) => key.startsWith('objects/'))).toBe(false);
  const replay = await openReplay(library.source(row));
  const before = await seekStep(replay, 130);
  await seekStep(replay, 200);
  expect((await seekStep(replay, 130)).checkpoint()).toEqual(before.checkpoint());
  const final = await seekStep(replay, 240);
  expect(final.step).toBe(240);
  expect(final.ended).toBe(true);
  expect(final.checkpoint().lastRecord).toMatchObject({ kind: 'terminal' });
});

it.each(['missing', 'corrupt', 'http-gzip', 'oversize'] as const)(
  'rejects %s artifact bytes instead of presenting a successful replay',
  async (failure) => {
    const { library } = served((key) => {
      if (!key.endsWith('/chunk-00000.ndjson.gz')) return;
      if (failure === 'missing') return new Response(null, { status: 404 });
      if (failure === 'http-gzip')
        return new Response(new Uint8Array(files.get(key)!), {
          headers: { 'content-type': 'application/gzip', 'content-encoding': 'gzip' },
        });
      return new Response(
        failure === 'oversize'
          ? new Uint8Array(files.get(key)!.length + 1)
          : new Uint8Array([0, 1, 2]),
        { headers: { 'content-type': 'application/gzip' } },
      );
    });
    const replay = await openReplay(library.source(row));
    await expect(seekStep(replay, 1)).rejects.toThrow();
  },
);

it('binds the selected immutable row to receipt/manifest rather than trusting a path', async () => {
  const { library } = served();
  const wrong = structuredClone(row);
  wrong.seed++;
  await expect(openReplay(library.source(wrong))).rejects.toThrow();
  const source = library.source(row);
  const manifest = ReplayManifestSchema.parse(await source.manifest());
  await expect(source.file({ ...manifest.chunks[0]!, file: '../untrusted.gz' })).rejects.toThrow(
    'verified manifest',
  );
});

it('opens each pinned seed, exchanged placement, separate attempt and reused bundle', async () => {
  const [original, reused, retried] = selectionGenerations;
  expect(original!.rows.map((row) => row.seed).sort()).toEqual([1, 2, 2]);
  const exchanged = original!.rows.filter((row) => row.seed === 2);
  expect(exchanged[0]!.participants[0].position).toEqual(exchanged[1]!.participants[1].position);
  expect(exchanged[0]!.participants[0].actorId).toBe(exchanged[1]!.participants[1].actorId);
  for (const first of original!.rows) {
    const cached = reused!.rows.find((row) => row.slotId === first.slotId)!;
    const next = retried!.rows.find((row) => row.slotId === first.slotId)!;
    expect(cached.reused).toBe(true);
    expect(cached.replay).toEqual(first.replay);
    expect(next.simulationHash).toBe(first.simulationHash);
    expect(next.result).toEqual(first.result);
    expect(next.replay!.attemptId).not.toBe(first.replay!.attemptId);
    expect(next.replay!.objectHash).not.toBe(first.replay!.objectHash);
  }
  for (const generation of selectionGenerations) {
    for (const selected of generation.rows) {
      const { library, requests } = served(undefined, selectionFiles);
      const replay = await openReplay(library.source(selected));
      expect(replay.manifest).toMatchObject({
        simulationHash: selected.simulationHash,
        id: selected.replay!.replayId,
        resultId: selected.replay!.resultId,
        attemptId: selected.replay!.attemptId,
        input: {
          seed: selected.seed,
          participants: selected.participants.map(
            ({ character: { name: _, ...character }, ...p }) => ({ ...p, character }),
          ),
        },
        end: { kind: 'result', result: selected.result },
      });
      expect((await seekStep(replay, 30)).ended).toBe(true);
      expect(
        requests.every((key) => key.startsWith(`objects/${selected.replay!.objectHash.slice(7)}/`)),
      ).toBe(true);
    }
  }
});

it.each(['simulation', 'attempt', 'result', 'bundle', 'placement', 'outcome'] as const)(
  'refuses a row with mismatched %s before loading any recording chunk',
  async (field) => {
    const { library, requests } = served(undefined, selectionFiles);
    const selected = structuredClone(selectionGenerations[0]!.rows[0]!);
    if (field === 'simulation') selected.simulationHash = 'sha256:' + 'f'.repeat(64);
    if (field === 'attempt') selected.replay!.attemptId = 'wrong-attempt';
    if (field === 'result') selected.replay!.resultId = 'wrong-result';
    if (field === 'bundle')
      selected.replay!.objectHash = selectionGenerations[2]!.rows[0]!.replay!.objectHash;
    if (field === 'placement') selected.participants[0].position.x++;
    if (field === 'outcome') selected.result!.steps--;
    await expect(openReplay(library.source(selected))).rejects.toThrow();
    expect(requests.some((key) => key.endsWith('.gz'))).toBe(false);
  },
);

it('rejects aborted late responses and invalid public roots', async () => {
  const controller = new AbortController();
  const library = publicLibrary(root, async () => {
    controller.abort();
    return Response.json({});
  });
  await expect(library.catalog(controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
  for (const url of [
    'file:///tmp/logs',
    'https://user:secret@example.test/data/',
    root + '?token=x',
    root + '#fragment',
  ])
    expect(() => publicLibrary(url)).toThrow();
});

it.each([
  [404, '', 'gone'],
  [429, '', 'limit'],
  [503, '<h1>Error 1027</h1>', 'limit'],
  [503, '{"error":"storage-unavailable"}', 'unavailable'],
  [503, 'x'.repeat(20000), 'unavailable'],
] as const)('distinguishes HTTP %s %s as %s', async (status, body, kind) => {
  const { library } = served(() => new Response(body, { status }));
  await expect(library.catalog()).rejects.toMatchObject({ kind });
});
