import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  replayContext,
  ReplayState,
  StreamRecordSchema,
  type ReplayCheckpoint,
  type ReplayManifest,
} from '@fantasy/domain/spatial';
import { apiReplaySource } from './api-source.ts';
import { ReplayLoadError } from './artifacts.ts';
import { openReplay } from './open-replay.ts';
import { seekStep } from './seek-step.ts';
import { ReplayPlayer } from './replay-player.ts';
import { buildSceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';
import { NO_OVERLAYS } from './overlays.ts';
import { ReplayResources } from './ReplayResources.tsx';

// Fixed bytes from the real ReplayWriter; see test-fixtures/replays/provenance.json.
const ID = 'swordsman-sky-mage-240';
const ROOT = `/api/replays/${ID}`;
const FIXTURE = new URL(`../../test-fixtures/replays/${ID}/`, import.meta.url);
type Served = { manifest: unknown; files: Map<string, Uint8Array<ArrayBuffer>> };

async function savedReplay() {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const name of await readdir(FIXTURE))
    files.set(name, new Uint8Array(await readFile(new URL(name, FIXTURE))));
  const manifest = JSON.parse(
    Buffer.from(files.get('manifest.json')!).toString(),
  ) as ReplayManifest;
  return { manifest, files };
}
/** Mirrors the local API routes and content types; `respond` injects a failure for one URL. */
function fakeApi(served: Served, respond?: (url: string) => Response | undefined) {
  const requests: string[] = [];
  const fetch = (url: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    requests.push(url);
    const custom = respond?.(url);
    if (custom) return Promise.resolve(custom);
    if (url === ROOT)
      return Promise.resolve(
        new Response(JSON.stringify(served.manifest), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      );
    const file = served.files.get(url.slice(`${ROOT}/files/`.length));
    if (url.startsWith(`${ROOT}/files/`) && file)
      return Promise.resolve(
        new Response(file, { headers: { 'content-type': 'application/gzip' } }),
      );
    return Promise.resolve(Response.json({ error: 'Replay not found' }, { status: 404 }));
  };
  return { fetch, requests };
}
const open = (served: Served, respond?: (url: string) => Response | undefined) => {
  const api = fakeApi(served, respond);
  return { api, opening: openReplay(apiReplaySource(ID, { fetch: api.fetch })) };
};
/** Independent oracle: Node zlib and full sequential application, not the adapter under test. */
async function sequentialCheckpoints({ manifest, files }: Awaited<ReturnType<typeof savedReplay>>) {
  const replay = new ReplayState(await replayContext(manifest.input, manifest.simulationHash));
  const saved: ReplayCheckpoint[] = [replay.checkpoint()];
  for (const chunk of manifest.chunks)
    for (const line of gunzipSync(files.get(chunk.file)!).toString().trimEnd().split('\n')) {
      replay.apply(JSON.parse(line));
      saved.push(replay.checkpoint());
    }
  return saved;
}
/** Replace one file and re-seal its manifest reference, as a well-formed but wrong writer would. */
function replaceFile(
  served: { manifest: ReplayManifest; files: Served['files'] },
  file: string,
  raw: Buffer,
  rawBytes = raw.length,
) {
  const bytes = new Uint8Array(gzipSync(raw));
  served.files.set(file, bytes);
  const ref = [...served.manifest.chunks, ...served.manifest.checkpoints].find(
    (r) => r.file === file,
  )!;
  Object.assign(ref, {
    bytes: bytes.length,
    rawBytes,
    checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
}
const expand = (served: Served, file: string) => gunzipSync(served.files.get(file)!);
const abortOnChunk = (controller: AbortController, file: string) => (url: string) => {
  if (url.endsWith(file) && !controller.signal.aborted) {
    controller.abort();
    throw controller.signal.reason;
  }
  return undefined;
};

describe('saved replay loading through the local API adapter', () => {
  it('pairs a hit with its own interval at event time and never invents point-less launch positions', async () => {
    const saved = await savedReplay();
    const opened = await open(saved).opening;
    const records = saved.manifest.chunks.flatMap((chunk) =>
      gunzipSync(saved.files.get(chunk.file)!)
        .toString()
        .trim()
        .split('\n')
        .map((line) => StreamRecordSchema.parse(JSON.parse(line))),
    );
    const interval = records.find(
      (r) =>
        r.kind === 'interval' &&
        r.events.some(
          (e) => e.kind === 'hit' && e.point && r.paths.some((p) => p.entityId === e.entityId),
        ),
    )!;
    expect(interval?.kind).toBe('interval');
    if (interval.kind !== 'interval') throw new Error('Expected recorded hit fixture');
    const hit = interval.events.find(
      (e) => e.kind === 'hit' && e.point && interval.paths.some((p) => p.entityId === e.entityId),
    )!;
    const frame = await new ReplayPlayer(opened).frame(hit.step);
    const model = buildSceneModel(
      opened.context,
      frame.checkpoint,
      frame.records,
      frame.events,
      frame.eventRecords,
    );
    expect(model.rays.some((r) => r.id.startsWith(hit.id))).toBe(true);
    const launch = records
      .flatMap((r) => ('events' in r ? r.events : []))
      .find((e) => e.kind === 'launch' && !e.point)!;
    expect(launch).toBeDefined();
    const launched = await new ReplayPlayer(opened).frame(launch.step);
    const effects = buildSceneModel(
      opened.context,
      launched.checkpoint,
      launched.records,
      launched.events,
      launched.eventRecords,
    ).effects;
    expect(effects.some((effect) => effect.id === launch.id)).toBe(false);
    const svg = renderToStaticMarkup(
      createElement(Scene2D, {
        model,
        overlays: { vision: true, collision: true, paths: true, hits: true, rays: true },
      }),
    );
    expect(svg).toContain('#f3e59b');
    expect(svg).toContain('#97d6ff');
  });
  it('draws recorded posture dimensions and all same-step paths without guessing missing hit coordinates', async () => {
    const opened = await open(await savedReplay()).opening;
    const frame = await new ReplayPlayer(opened).frame(240);
    const actor = frame.checkpoint.state!.actors[0]!;
    // Projection-only input: no new combat or capability is claimed by this fixture.
    actor.posture = {
      current: 'crouching',
      body: { ...opened.context.actors[0]!.character.body, radiusMm: 150, heightMm: 600 },
    };
    const snapshot = structuredClone(frame);
    const model = buildSceneModel(opened.context, frame.checkpoint, frame.records, frame.events);
    expect(model.actors[0]).toMatchObject({ radius: 0.15, length: 0.3 });
    expect(model.paths.length).toBeGreaterThan(0); // terminal must not hide this step's interval
    expect(model.events).toEqual(
      frame.events
        .filter((e) => e.kind === 'hit' && e.point)
        .map((e) => ({ id: e.id, position: [e.point!.x, e.point!.y, e.point!.z] })),
    );
    expect(model.rays).toEqual([]); // no recorded origin/hit pairing in this frame
    const html = renderToStaticMarkup(
      createElement(ReplayResources, { context: opened.context, checkpoint: frame.checkpoint }),
    );
    expect(html).toContain('aria-label="' + actor.id + ' hp"');
    expect(html).toContain('<meter');
    expect(html).toContain('crouching');
    expect(frame).toEqual(snapshot);
  });
  it('skips intermediate chunks on a distant seek and retains every event at the displayed step', async () => {
    const saved = await savedReplay(),
      { api, opening } = open(saved);
    const player = new ReplayPlayer(await opening);
    await player.frame(0);
    await player.frame(240);
    expect(api.requests.filter((url) => url.endsWith('.ndjson.gz'))).toEqual([
      `${ROOT}/files/chunk-00000.ndjson.gz`,
      `${ROOT}/files/chunk-00003.ndjson.gz`,
    ]);
    const records = saved.manifest.chunks.flatMap((ref) =>
      expand(saved, ref.file)
        .toString()
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
    for (const step of [240, 0, 91, 92, 159, 160, 239, 240, 240]) {
      const frame = await player.frame(step);
      expect(frame.records).toEqual(
        records.filter(
          (record) => (record.kind === 'interval' ? record.toStep : record.step) === step,
        ),
      );
      expect(frame.checkpoint.step).toBe(step);
      expect(frame.events).toEqual(
        records.flatMap((r) => r.events ?? []).filter((e) => e.step === step),
      );
    }
  });
  it('projects every forward step with one validation per chunk, and restores backward seeks', async () => {
    const saved = await savedReplay(),
      expected = await sequentialCheckpoints(saved);
    const player = new ReplayPlayer(await open(saved).opening);
    const applied = vi.spyOn(ReplayState.prototype, 'apply');
    try {
      for (let step = 0; step <= 240; step++)
        expect(await player.seek(step)).toEqual(expected.findLast((value) => value.step === step));
      expect(applied).toHaveBeenCalledTimes(saved.manifest.records);
      const snapshot = await player.seek(240);
      snapshot.state!.actors[0]!.resources.hp = -1;
      expect(await player.seek(240)).toEqual(expected.at(-1));
      expect(applied).toHaveBeenCalledTimes(saved.manifest.records);
      for (const step of [100, 0, 91, 159, 240])
        expect(await player.seek(step)).toEqual(expected.findLast((value) => value.step === step));
      // The bounded cache evicts older validated chunks, which are validated again on return.
      expect(applied.mock.calls.length).toBeGreaterThan(saved.manifest.records);
      await expect(player.seek(241)).rejects.toThrow(RangeError);
      await expect(player.seek(10, AbortSignal.abort())).rejects.toMatchObject({ kind: 'aborted' });
    } finally {
      applied.mockRestore();
    }
  });
  it('builds shared scene geometry and the 2D fallback without a browser or WebGL', async () => {
    const opened = await open(await savedReplay()).opening;
    const checkpoint = await new ReplayPlayer(opened).seek(90);
    const before = structuredClone(checkpoint);
    const model = buildSceneModel(opened.context, checkpoint);
    expect(model.actors.map((a) => a.position)).toEqual(
      checkpoint.state!.actors.map((a) => [a.position.x, a.position.y, a.position.z]),
    );
    expect(model.actors[0]!.radius).toBe(opened.context.actors[0]!.character.body.radiusMm / 1000);
    expect(model.follow).toEqual(model.actors[0]!.position);
    expect(model.span).toBeGreaterThan(0);
    expect(model.paths.length).toBeGreaterThan(0);
    const svg = renderToStaticMarkup(
      createElement(Scene2D, { model, overlays: { ...NO_OVERLAYS, paths: true } }),
    );
    expect(svg).toContain('保存ログの2D表示');
    expect(svg).toContain('<line');
    expect(checkpoint).toEqual(before);
  });
  it('rejects valid-checksum semantic corruption before publishing a playback frame', async () => {
    const saved = await savedReplay();
    const file = 'chunk-00000.ndjson.gz';
    const lines = expand(saved, file).toString().trimEnd().split('\n');
    const initial = JSON.parse(lines[0]!);
    initial.state.actors[0].resources.hp = 999999;
    lines[0] = JSON.stringify(initial);
    replaceFile(saved, file, Buffer.from(lines.join('\n') + '\n'));
    await expect(
      open(saved).opening.then((opened) => new ReplayPlayer(opened).seek(0)),
    ).rejects.toMatchObject({ kind: 'damaged' });
  });
  it('normalizes accepted checkpoint entity order for random and forward playback', async () => {
    const saved = await savedReplay(),
      expected = await sequentialCheckpoints(saved);
    for (const ref of saved.manifest.checkpoints) {
      const checkpoint = JSON.parse(expand(saved, ref.file).toString()) as ReplayCheckpoint;
      if (!checkpoint.state) continue;
      checkpoint.state.actors.reverse();
      checkpoint.state.projectiles.reverse();
      replaceFile(saved, ref.file, Buffer.from(JSON.stringify(checkpoint)));
    }
    const player = new ReplayPlayer(await open(saved).opening);
    for (const step of [100, 159, 240, 0, 240])
      expect(await player.seek(step)).toEqual(expected.findLast((value) => value.step === step));
  });
  it('keeps the last cursor and validated chunk when a forward load is cancelled', async () => {
    const saved = await savedReplay(),
      expected = await sequentialCheckpoints(saved);
    const controller = new AbortController();
    const { opening } = open(saved, abortOnChunk(controller, 'chunk-00001.ndjson.gz'));
    const player = new ReplayPlayer(await opening);
    await player.seek(10);
    await expect(player.seek(100, controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
    const applied = vi.spyOn(ReplayState.prototype, 'apply');
    try {
      expect(await player.seek(11)).toEqual(expected.findLast((value) => value.step === 11));
      expect(applied).not.toHaveBeenCalled();
      expect(await player.seek(100)).toEqual(expected.findLast((value) => value.step === 100));
    } finally {
      applied.mockRestore();
    }
  });
  it('rejects a resealed checkpoint that disagrees with the preceding chunk', async () => {
    const saved = await savedReplay(),
      file = 'checkpoint-00001.json.gz';
    const checkpoint = JSON.parse(expand(saved, file).toString()) as ReplayCheckpoint;
    checkpoint.state!.actors[0]!.position.x += 0.001;
    replaceFile(saved, file, Buffer.from(JSON.stringify(checkpoint)));
    const player = new ReplayPlayer(await open(saved).opening);
    await player.seek(90);
    await expect(player.seek(92)).rejects.toMatchObject({
      kind: 'damaged',
    });
  });
  it('seeks final step states across chunk boundaries without duplicating boundary events', async () => {
    const saved = await savedReplay(),
      expected = await sequentialCheckpoints(saved);
    const opened = await open(saved).opening;
    for (const step of [0, 1, 90, 91, 92, 158, 159, 160, 238, 239, 240, 100, 0]) {
      const state = await seekStep(opened, step);
      expect(state.checkpoint()).toEqual(expected.findLast((value) => value.step === step));
    }
    await expect(seekStep(opened, 241)).rejects.toThrow(RangeError);
    const controller = new AbortController();
    controller.abort();
    await expect(seekStep(opened, 1, controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
  });
  it('restores record cursors across all chunks from verified files only', async () => {
    const saved = await savedReplay(),
      expected = await sequentialCheckpoints(saved);
    const { api, opening } = open(saved),
      opened = await opening;
    expect(opened.manifest).toEqual(saved.manifest);
    expect(expected).toHaveLength(244);
    for (const [cursor, checkpoint] of expected.entries())
      expect((await opened.seek(cursor)).checkpoint()).toEqual(checkpoint);
    // The default cache holds all four checkpoints and chunks: each file is fetched once.
    expect(api.requests).toHaveLength(9);
    expect(new Set(api.requests).size).toBe(9);
  });
  it('fetches only the checkpoint and chunk that a seek needs', async () => {
    const { api, opening } = open(await savedReplay()),
      opened = await opening;
    expect(api.requests).toEqual([ROOT]);
    await opened.seek(243);
    // The first record of a chunk is restored from its checkpoint alone.
    await opened.seek(161);
    expect(api.requests.slice(1)).toEqual([
      `${ROOT}/files/checkpoint-00003.json.gz`,
      `${ROOT}/files/chunk-00003.ndjson.gz`,
      `${ROOT}/files/checkpoint-00002.json.gz`,
    ]);
    expect(Object.isFrozen(await opened.records(2))).toBe(true);
    await expect(opened.seek(244)).rejects.toThrow(RangeError);
    await expect(opened.records(4)).rejects.toThrow(RangeError);
  });
  it('bounds the cache of decoded files', async () => {
    const api = fakeApi(await savedReplay());
    const opened = await openReplay(apiReplaySource(ID, { fetch: api.fetch }), {
      cachedFiles: 2,
    });
    for (const cursor of [10, 240, 11]) await opened.seek(cursor);
    const fetched = (file: string) => api.requests.filter((url) => url.endsWith(file)).length;
    expect([fetched('chunk-00000.ndjson.gz'), fetched('chunk-00003.ndjson.gz')]).toEqual([2, 1]);
  });
  it.each([
    ['manifest schema', { schemaVersion: 2 }],
    ['recording profile', { profile: { id: 'display-ndjson-gzip-v2' } }],
    ['stored input schema', { input: { schemaVersion: 4 } }],
    ['display schema', { input: { replaySchemaVersion: 2 } }],
  ])('rejects an unsupported %s instead of guessing', async (_, change) => {
    const saved = await savedReplay();
    const manifest = structuredClone(saved.manifest) as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(change))
      manifest[key] =
        typeof value === 'object' ? { ...(manifest[key] as object), ...value } : value;
    await expect(open({ ...saved, manifest }).opening).rejects.toMatchObject({
      kind: 'unsupported',
    });
  });
  it.each([
    [
      'a result reference that disagrees with the terminal result',
      (saved: Awaited<ReturnType<typeof savedReplay>>) => {
        saved.manifest = { ...saved.manifest, resultId: null };
      },
      0,
      /manifest is invalid/,
    ],
    [
      'a manifest for another replay ID',
      (saved: Awaited<ReturnType<typeof savedReplay>>) => {
        saved.manifest = { ...saved.manifest, id: 'another-replay' };
      },
      0,
      /requested ID/,
    ],
    [
      'a flipped compressed byte',
      (saved: Awaited<ReturnType<typeof savedReplay>>) => {
        const bytes = saved.files.get('chunk-00001.ndjson.gz')!;
        bytes[40] = bytes[40]! ^ 0xff;
      },
      100,
      /size and checksum/,
    ],
    [
      'an expansion beyond the declared size',
      (saved: Awaited<ReturnType<typeof savedReplay>>) => {
        const declared = saved.manifest.chunks[3]!.rawBytes;
        replaceFile(saved, 'chunk-00003.ndjson.gz', Buffer.alloc(declared + 1, 65), declared);
      },
      240,
      /exceeds/,
    ],
    [
      'invalid UTF-8 behind a valid checksum',
      (saved: Awaited<ReturnType<typeof savedReplay>>) => {
        replaceFile(saved, 'chunk-00003.ndjson.gz', Buffer.alloc(64, 0xff));
      },
      240,
      /UTF-8/,
    ],
    [
      'a checkpoint copied from another chunk',
      (saved: Awaited<ReturnType<typeof savedReplay>>) => {
        replaceFile(saved, 'checkpoint-00002.json.gz', expand(saved, 'checkpoint-00001.json.gz'));
      },
      170,
      /seek checkpoint index/,
    ],
    [
      'a chunk that lost its last record',
      (saved: Awaited<ReturnType<typeof savedReplay>>) => {
        const lines = expand(saved, 'chunk-00003.ndjson.gz').toString().trimEnd().split('\n');
        replaceFile(
          saved,
          'chunk-00003.ndjson.gz',
          Buffer.from(`${lines.slice(0, -1).join('\n')}\n`),
        );
      },
      240,
      /chunk record count/,
    ],
  ])('reports %s as damaged', async (_, damage, cursor, reason) => {
    const saved = await savedReplay();
    damage(saved);
    await expect(open(saved).opening.then((opened) => opened.seek(cursor))).rejects.toMatchObject({
      kind: 'damaged',
      message: expect.stringMatching(reason),
    });
    await expect(
      open(saved).opening.then((opened) =>
        new ReplayPlayer(opened).seek(Math.min(cursor, opened.manifest.lastVerifiedStep ?? 0)),
      ),
    ).rejects.toMatchObject({ kind: 'damaged' });
  });
  it('rejects a response body longer than its reference while reading', async () => {
    const saved = await savedReplay(),
      chunk = saved.files.get('chunk-00000.ndjson.gz')!;
    const padded = new Uint8Array(chunk.length + 1);
    padded.set(chunk);
    const { opening } = open(saved, (url) =>
      url.endsWith('chunk-00000.ndjson.gz')
        ? new Response(padded, { headers: { 'content-type': 'application/gzip' } })
        : undefined,
    );
    await expect((await opening).seek(5)).rejects.toMatchObject({
      kind: 'damaged',
      message: expect.stringMatching(/exceeds/),
    });
  });
  it.each([
    [404, 'damaged'],
    [503, 'damaged'],
    [500, 'unavailable'],
    [429, 'limit'],
  ])('maps a %i manifest response to %s', async (status, kind) => {
    const { opening } = open(await savedReplay(), (url) =>
      url === ROOT
        ? Response.json({ error: 'Replay is corrupt; result held' }, { status })
        : undefined,
    );
    await expect(opening).rejects.toMatchObject({ kind });
  });
  it('treats network failures and altered transport as delivery errors', async () => {
    const saved = await savedReplay();
    const failures: ((url: string) => Response | undefined)[] = [
      () => {
        throw new TypeError('fetch failed');
      },
      (url) =>
        url === ROOT
          ? new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
          : undefined,
      (url) =>
        url.endsWith('.gz')
          ? new Response(saved.files.get('chunk-00000.ndjson.gz')!, {
              headers: { 'content-type': 'application/gzip', 'content-encoding': 'gzip' },
            })
          : undefined,
    ];
    for (const failure of failures)
      await expect(
        open(saved, failure).opening.then((opened) => opened.seek(5)),
      ).rejects.toMatchObject({
        kind: 'unavailable',
      });
    expect(() => apiReplaySource('../other')).toThrow(ReplayLoadError);
  });
  it('never delivers a cancelled load and refetches the file it interrupted', async () => {
    const saved = await savedReplay();
    const early = fakeApi(saved);
    await expect(
      openReplay(apiReplaySource(ID, { fetch: early.fetch }), { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(early.requests).toEqual([]);
    const controller = new AbortController();
    const { api, opening } = open(saved, abortOnChunk(controller, 'chunk-00001.ndjson.gz'));
    const opened = await opening;
    await expect(opened.seek(100, controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
    // The interrupted chunk was not cached; a later seek fetches and verifies it again.
    expect((await opened.seek(100)).nextRecord).toBe(100);
    expect(api.requests.filter((url) => url.endsWith('chunk-00001.ndjson.gz'))).toHaveLength(2);
  });
  it('does not keep a file whose request is cancelled while it is being verified', async () => {
    const api = fakeApi(await savedReplay()),
      transport = apiReplaySource(ID, { fetch: api.fetch }),
      controller = new AbortController();
    const opened = await openReplay({
      manifest: (signal) => transport.manifest(signal),
      async file(ref, signal) {
        const bytes = await transport.file(ref, signal);
        // Delivered in full; the checksum, gzip and record checks have not run yet.
        if (ref.file === 'chunk-00002.ndjson.gz') controller.abort();
        return bytes;
      },
    });
    await expect(opened.seek(170, controller.signal)).rejects.toMatchObject({ kind: 'aborted' });
    expect((await opened.seek(170)).nextRecord).toBe(170);
    // The checkpoint finished before the cancellation and is reused; the chunk is fetched again.
    const fetched = (file: string) => api.requests.filter((url) => url.endsWith(file)).length;
    expect([fetched('checkpoint-00002.json.gz'), fetched('chunk-00002.ndjson.gz')]).toEqual([1, 2]);
  });
});
