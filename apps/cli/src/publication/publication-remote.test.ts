import { mkdtemp, rm, readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { BattleBundles } from '@fantasy/api/artifacts';
import { SUPPORTED_REPLAY_FORMAT } from '@fantasy/domain';
import { publicationFixture } from '../../test-support/publication.ts';
import { exportPublication } from './publication-export.ts';
import { localPublicationGraph } from './publication-graph.ts';
import { PublicationIo } from './publication-io.ts';
import { PUBLICATION_CONTROL_KEY } from './publication-files.ts';
import { leagueFailure, leagueFailureSummary } from '../league/league-diagnostics.ts';
import {
  publishPublication,
  prunePublication,
  type PublicationStore,
  type PublishOptions,
} from './publication-remote.ts';

class MemoryStore implements PublicationStore {
  listedEtags?: () => ReadonlyMap<string, string>;
  readonly objects = new Map<string, { data: Buffer; etag: string }>();
  readonly writes: string[] = [];
  readonly removed: string[] = [];
  private version = 0;
  remainingRequests() {
    return 100_000;
  }
  async inventory() {
    return new Map([...this.objects].map(([key, value]) => [key, value.data.length]));
  }
  async read(key: string) {
    return this.objects.get(key) ?? null;
  }
  async head(key: string) {
    return this.objects.get(key)?.data.length ?? null;
  }
  async put(key: string, data: Buffer, previous: string | null) {
    const old = this.objects.get(key);
    if (previous === null ? old !== undefined : old?.etag !== previous)
      throw new Error('Conditional conflict');
    this.writes.push(key);
    this.objects.set(key, { data: Buffer.from(data), etag: String(++this.version) });
  }
  async remove(key: string) {
    this.removed.push(key);
    this.objects.delete(key);
  }
}
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('starts the reserved transport after one full local validation and preserves readback', async () => {
  const { directory, store, options } = await setup();
  const verify = vi.spyOn(BattleBundles.prototype, 'verify');
  const start = vi.fn(async (graph: Awaited<ReturnType<typeof localPublicationGraph>>) => {
    expect(verify).toHaveBeenCalledTimes(graph.objects.size);
    expect(graph.files.has('catalog/current.json')).toBe(true);
    expect(store.writes).toEqual([]);
    return store;
  });
  const result = await publishPublication(directory, start, options);
  expect(start).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(result.status).toBe('verified');
  expect(store.writes.at(-1)).toBe('catalog/current.json');
});
it('does not reserve a data transport for a corrupt local publication', async () => {
  const { directory, store, options } = await setup();
  await writeFile(join(directory, 'catalog/current.json'), '{}');
  const start = vi.fn(async () => store);
  const error = await publishPublication(directory, start, options).catch(
    (error: unknown) => error,
  );
  expect(leagueFailure(error, { command: 'publish' })).toMatchObject({
    publicationState: 'not-committed',
    code: 'DATA_INVALID',
  });
  expect(start).not.toHaveBeenCalled();
  expect(store.writes).toEqual([]);
});
it('rejects changed local bytes after transport admission without committing the pointer', async () => {
  const { directory, store, options } = await setup();
  const error = await publishPublication(
    directory,
    async (graph) => {
      const artifact = [...graph.files.values()].find((file) => file.key.endsWith('.gz'))!;
      await writeFile(artifact.source!, Buffer.alloc(artifact.bytes));
      return store;
    },
    options,
  ).catch((error: unknown) => error);
  expect(leagueFailure(error, { command: 'publish' })).toMatchObject({
    publicationState: 'not-committed',
    code: 'DATA_INVALID',
  });
  expect(store.objects.has('catalog/current.json')).toBe(false);
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'remote-publication-'));
  roots.push(root);
  const fixture = await publicationFixture(join(root, 'batch'));
  const directory = join(root, 'public');
  await exportPublication(fixture.plan, [fixture], directory);
  const store = new MemoryStore();
  const options: PublishOptions = {
    viewer: async () => ({
      schemaVersion: 1,
      sourceSha: 'b'.repeat(40),
      publicationSchema: 1,
      replay: SUPPORTED_REPLAY_FORMAT,
    }),
    ancestor: (source, viewer) => source === 'a'.repeat(40) && viewer === 'b'.repeat(40),
    worker: async (key) => {
      const value = await store.read(key);
      if (!value) throw new Error('Missing worker object');
      return value.data;
    },
  };
  return { root, directory, fixture, store, options };
}
it.each([Buffer.from('{REMOTE_PRIVATE_SENTINEL'), Buffer.from([0xff])])(
  'reports malformed remote pointer as saved data without changing publication state',
  async (data) => {
    const { directory, store, options } = await setup();
    store.objects.set('catalog/current.json', { data, etag: 'fixture' });
    const error = await publishPublication(directory, store, options).catch(
      (error: unknown) => error,
    );
    const report = leagueFailure(error, { command: 'publish' });
    expect(report).toMatchObject({
      code: 'DATA_INVALID',
      publicationState: 'not-committed',
      retry: 'no',
    });
    expect(JSON.stringify(report) + leagueFailureSummary(report)).not.toContain(
      'REMOTE_PRIVATE_SENTINEL',
    );
    expect(store.writes).toEqual([]);
    expect((await store.read('catalog/current.json'))?.data).toEqual(data);
  },
);
it.each([1, 4])(
  'publishes with concurrency %s before current, verifies all sizes, and repeats without writes',
  async (concurrency) => {
    const { directory, store, options } = await setup();
    options.concurrency = concurrency;
    const result = await publishPublication(directory, store, options);
    expect(result.status).toBe('verified');
    expect(store.writes.at(-1)).toBe('catalog/current.json');
    const prefixes = store.writes.map((key) =>
      key.startsWith('objects/')
        ? 0
        : key.startsWith('sets/')
          ? key.endsWith('/set.json')
            ? 2
            : 1
          : key === 'catalog/current.json'
            ? 4
            : 3,
    );
    expect(prefixes).toEqual([...prefixes].sort((a, b) => a - b));
    const graph = await localPublicationGraph(directory);
    expect(store.objects.size).toBe(graph.files.size);
    const count = store.writes.length;
    expect(await publishPublication(directory, store, options)).toMatchObject({
      status: 'verified',
      writes: 0,
      addedFiles: 0,
    });
    expect(store.writes).toHaveLength(count);
  },
);
it.each(['viewer', 'capacity', 'writes', 'transfer', 'worker', 'transport'] as const)(
  'refuses %s preflight with zero writes',
  async (kind) => {
    const { directory, store, options } = await setup();
    if (kind === 'viewer') options.ancestor = () => false;
    if (kind === 'capacity') options.maxBytes = 1;
    if (kind === 'writes') options.maxWrites = 1;
    if (kind === 'transfer') options.maxTransferBytes = 1;
    if (kind === 'worker') options.maxWorkerRequests = 1;
    if (kind === 'transport') {
      options.maxWrites = 60000;
      store.remainingRequests = () => 1;
    }
    await expect(publishPublication(directory, store, options)).rejects.toMatchObject({
      phase: 'not-committed',
    });
    expect(store.writes).toEqual([]);
  },
);
it('dry run reports byte/request budgets without mutating storage', async () => {
  const { directory, store, options } = await setup();
  const result = await publishPublication(directory, store, { ...options, dryRun: true });
  expect(result.status).toBe('planned');
  expect(result.transferBytes).toBeGreaterThan(0);
  expect(result.reservedS3Requests).toBeGreaterThan(result.writes * 2);
  expect(store.writes).toEqual([]);
});
it('does not report a cancelled dry run on an empty destination as planned', async () => {
  const { directory, store, options } = await setup();
  const controller = new AbortController();
  const viewer = options.viewer;
  // Cancellation arrives after local validation, while no remote I/O stage is queued.
  const cancelled = publishPublication(directory, store, {
    ...options,
    dryRun: true,
    signal: controller.signal,
    viewer: async () => {
      controller.abort();
      return viewer();
    },
  });
  await expect(cancelled).rejects.toThrow();
  expect(store.writes).toEqual([]);
});
it('resumes interrupted immutable uploads and only recovers a lost response with exact bytes', async () => {
  const { directory, store, options } = await setup();
  const put = store.put.bind(store);
  let calls = 0;
  store.put = async (...args) => {
    if (++calls === 2) throw new Error('interrupted');
    await put(...args);
  };
  await expect(publishPublication(directory, store, options)).rejects.toMatchObject({
    phase: 'not-committed',
  });
  expect(store.objects.has('catalog/current.json')).toBe(false);
  store.put = async (...args) => {
    await put(...args);
    throw new Error('response lost');
  };
  expect((await publishPublication(directory, store, options)).status).toBe('verified');
});
it('never overwrites a colliding immutable object', async () => {
  const { directory, store, options, fixture } = await setup();
  const key = `objects/${fixture.receipt.objectHash.slice(7)}/receipt.json`;
  store.objects.set(key, { data: Buffer.from('{}'), etag: 'old' });
  await expect(publishPublication(directory, store, options)).rejects.toMatchObject({
    phase: 'not-committed',
  });
  expect(store.writes).toEqual([]);
});
it.each([true, false])(
  'proves listed objects by MD5 ETag without a GET, else falls back to a byte check (match %s)',
  async (matching) => {
    const { directory, store, options } = await setup();
    await publishPublication(directory, store, options);
    // The largest object has a size no other stored file shares.
    const [objectKey] = [...store.objects.keys()]
      .filter((key) => key.startsWith('objects/') && !key.endsWith('/receipt.json'))
      .sort((a, b) => store.objects.get(b)!.data.length - store.objects.get(a)!.data.length);
    const data = store.objects.get(objectKey!)!.data;
    const md5 = createHash('md5')
      .update(matching ? data : Buffer.from('other'))
      .digest('hex');
    store.listedEtags = () => new Map([[objectKey!, `"${md5}"`]]);
    const read = vi.spyOn(store, 'read');
    const head = vi.spyOn(store, 'head');
    const reserve = vi.spyOn(PublicationIo.prototype, 'run');
    await expect(
      publishPublication(directory, store, {
        ...options,
        // Reader read-back is a separate channel; only S3 byte checks are counted here.
        worker: async (key) => Buffer.from(store.objects.get(key)!.data),
      }),
    ).resolves.toMatchObject({ status: 'verified' });
    expect(read.mock.calls.some(([key]) => key === objectKey)).toBe(!matching);
    expect(head.mock.calls.some(([key]) => key === objectKey)).toBe(false);
    // Hashing the local file is charged to the in-flight byte budget like the GET fallback and
    // the Reader read-back of this sample-bundle object (one reservation each).
    expect(reserve.mock.calls.filter(([bytes]) => bytes === data.length)).toHaveLength(
      matching ? 2 : 3,
    );
  },
);
it('rejects a listed object whose ETag disagrees and whose bytes collide', async () => {
  const { directory, store, options, fixture } = await setup();
  const key = `objects/${fixture.receipt.objectHash.slice(7)}/manifest.json`;
  store.objects.set(key, { data: Buffer.from('{}'), etag: 'old' });
  store.listedEtags = () => new Map([[key, `"${createHash('md5').update('{}').digest('hex')}"`]]);
  await expect(publishPublication(directory, store, options)).rejects.toMatchObject({
    phase: 'not-committed',
  });
  expect(store.writes).toEqual([]);
});
it('rejects a second valid result for the same simulation even in an orphan with an ETag', async () => {
  const { root, directory, store, options } = await setup();
  const conflict = await publicationFixture(join(root, 'conflict'), 'complete', undefined, true);
  const key = `objects/${conflict.receipt.objectHash.slice(7)}/receipt.json`;
  const data = await readFile(join(conflict.object, 'receipt.json'));
  store.objects.set(key, { data, etag: 'old' });
  store.listedEtags = () => new Map([[key, `"${createHash('md5').update(data).digest('hex')}"`]]);
  const read = vi.spyOn(store, 'read');
  await expect(publishPublication(directory, store, options)).rejects.toMatchObject({
    phase: 'not-committed',
    cause: { message: 'Existing simulation result conflict' },
  });
  expect(read.mock.calls.some(([path]) => path === key)).toBe(true);
  expect(store.writes).toEqual([]);
});
it('does not commit when a listed object has disappeared before its byte check', async () => {
  const { directory, store, options } = await setup();
  const key = [...(await localPublicationGraph(directory)).files.keys()].find((k) =>
    k.startsWith('objects/'),
  )!;
  const listed = store.inventory.bind(store);
  // The listing still reports the object, but the bytes are gone: no HEAD shortcut may hide it.
  store.inventory = async () => new Map([...(await listed()), [key, 1]]);
  await expect(publishPublication(directory, store, options)).rejects.toMatchObject({
    phase: 'not-committed',
  });
  expect(store.objects.has('catalog/current.json')).toBe(false);
});
it('preserves a concurrent pointer and reports an uncertain commit safely', async () => {
  const { directory, store, options } = await setup();
  const put = store.put.bind(store);
  store.put = async (key, data, etag) => {
    if (key === 'catalog/current.json')
      store.objects.set(key, { data: Buffer.from('concurrent'), etag: 'race' });
    await put(key, data, etag);
  };
  await expect(publishPublication(directory, store, options)).rejects.toMatchObject({
    phase: 'commit-unknown',
  });
  expect((await store.read('catalog/current.json'))!.data.toString()).toBe('concurrent');
});
it('distinguishes committed data whose Worker read-back fails and recovers on repeat', async () => {
  const { directory, store, options } = await setup();
  await expect(
    publishPublication(directory, store, {
      ...options,
      worker: async () => Buffer.from('damaged'),
    }),
  ).rejects.toMatchObject({ phase: 'committed-unverified' });
  expect(store.objects.has('catalog/current.json')).toBe(true);
  expect(await publishPublication(directory, store, options)).toMatchObject({
    status: 'verified',
    writes: 0,
  });
});
it('retains every catalog ancestor and deletes only explicit, unreferenced keys', async () => {
  const { root, directory, store, options } = await setup();
  await publishPublication(directory, store, options);
  const oldKeys = [...store.objects.keys()];
  const second = await publicationFixture(join(root, 'second'), 'complete', 321);
  await exportPublication(second.plan, [second], directory);
  await publishPublication(directory, store, options);
  const orphan = `catalog/${'f'.repeat(64)}.json`;
  store.objects.set(PUBLICATION_CONTROL_KEY, {
    data: Buffer.from('private usage ledger'),
    etag: 'control',
  });
  store.objects.set(orphan, { data: Buffer.from('{}'), etag: 'orphan' });
  expect(await prunePublication(store)).toMatchObject({ status: 'planned', keys: [orphan] });
  expect(store.removed).toEqual([]);
  expect(await prunePublication(store, true)).toMatchObject({ status: 'deleted', keys: [orphan] });
  for (const key of oldKeys) expect(store.objects.has(key)).toBe(true);
});

it.each(['missing', 'corrupt', 'budget'] as const)(
  'refuses orphan deletion when retained payloads or request capacity are %s',
  async (failure) => {
    const { directory, store, options } = await setup();
    await publishPublication(directory, store, options);
    const orphan = `catalog/${'f'.repeat(64)}.json`;
    store.objects.set(orphan, { data: Buffer.from('{}'), etag: 'orphan' });
    const key = [...store.objects.keys()].find((key) => key.endsWith('.gz'))!;
    if (failure === 'missing') store.objects.delete(key);
    if (failure === 'corrupt') {
      const data = store.objects.get(key)!.data;
      data.writeUInt8(data.readUInt8(0) ^ 1, 0);
    }
    if (failure === 'budget') store.remainingRequests = () => 1;
    await expect(prunePublication(store, true)).rejects.toThrow();
    expect(store.removed).toEqual([]);
    expect(store.objects.has('catalog/current.json')).toBe(true);
    expect(store.objects.has(orphan)).toBe(true);
  },
);

it('rejects an old local generation after a newer publication without rolling back', async () => {
  const { root, directory, store, options } = await setup();
  const old = join(root, 'old');
  await cp(directory, old, { recursive: true });
  await publishPublication(directory, store, options);
  const second = await publicationFixture(join(root, 'next'), 'complete', 777);
  await exportPublication(second.plan, [second], directory);
  await publishPublication(directory, store, options);
  const pointer = await store.read('catalog/current.json'),
    writes = store.writes.length;
  await expect(publishPublication(old, store, options)).rejects.toMatchObject({
    phase: 'not-committed',
    cause: { message: 'Publication generation changed' },
  });
  expect(await store.read('catalog/current.json')).toEqual(pointer);
  expect(store.writes).toHaveLength(writes);
});
it('checks viewer compatibility again before replacing current', async () => {
  const { directory, store, options } = await setup();
  let calls = 0;
  const viewer = options.viewer;
  options.viewer = async () => (++calls === 1 ? viewer() : { schemaVersion: 999 });
  await expect(publishPublication(directory, store, options)).rejects.toMatchObject({
    phase: 'not-committed',
  });
  expect(store.objects.has('catalog/current.json')).toBe(false);
});
it('publishes missing planned slots with an explicit incomplete count', async () => {
  const { root, fixture, store, options } = await setup();
  const directory = join(root, 'incomplete');
  await exportPublication(fixture.plan, [], directory);
  expect(await publishPublication(directory, store, options)).toMatchObject({
    status: 'verified',
    incompleteRows: 1,
  });
});

it.each([16, 32, 64])(
  'shares one fresh inventory and one receipt GET at width %s',
  async (width) => {
    const { directory, store, options, fixture } = await setup();
    await publishPublication(directory, store, options);
    const inventory = vi.spyOn(store, 'inventory');
    const read = vi.spyOn(store, 'read');
    const head = vi.spyOn(store, 'head');
    const start = vi.fn(async () => ({ store, inventory: await store.inventory() }));
    const writes = store.writes.length;
    const result = await publishPublication(directory, start, {
      ...options,
      readConcurrency: width,
      writeConcurrency: width,
      headConcurrency: width,
      // Reader requests remain independently checked; do not count this separate channel as S3 GETs.
      worker: async (key) => Buffer.from(store.objects.get(key)!.data),
    });
    expect(result.status).toBe('verified');
    expect(start).toHaveBeenCalledTimes(1);
    expect(inventory).toHaveBeenCalledTimes(1);
    const key = `objects/${fixture.receipt.objectHash.slice(7)}/receipt.json`;
    expect(read.mock.calls.filter(([path]) => path === key)).toHaveLength(1);
    // Objects proved in this publication are not HEAD-checked a second time.
    expect(head.mock.calls.filter(([path]) => path !== 'catalog/current.json')).toHaveLength(0);
    expect(store.writes.length).toBe(writes);
  },
);

it('does not reuse an inventory snapshot across publication calls', async () => {
  const { root, directory, store, options } = await setup();
  const start = async () => ({ store, inventory: await store.inventory() });
  await publishPublication(directory, start, options);
  const conflict = await publicationFixture(
    join(root, 'later-orphan'),
    'complete',
    undefined,
    true,
  );
  const key = `objects/${conflict.receipt.objectHash.slice(7)}/receipt.json`;
  store.objects.set(key, {
    data: await readFile(join(conflict.object, 'receipt.json')),
    etag: 'new',
  });
  const writes = store.writes.length;
  await expect(publishPublication(directory, start, options)).rejects.toMatchObject({
    phase: 'committed-unverified',
    cause: { message: 'Existing simulation result conflict' },
  });
  expect(store.writes.length).toBe(writes);
});

it.each(['quoted', 'bare', 'uppercase', 'missing', 'multipart', 'mismatch', 'size'])(
  'uses receipt ETag evidence only with matching verified bytes and size: %s',
  async (kind) => {
    const { directory, store, options, fixture } = await setup();
    await publishPublication(directory, store, options);
    const key = `objects/${fixture.receipt.objectHash.slice(7)}/receipt.json`;
    const md5 = createHash('md5').update(store.objects.get(key)!.data).digest('hex');
    const tags: Record<string, string> = {
      quoted: `"${md5}"`,
      bare: md5,
      uppercase: `"${md5.toUpperCase()}"`,
      multipart: `"${md5}-2"`,
      mismatch: `"${'0'.repeat(32)}"`,
      size: `"${md5}"`,
    };
    store.listedEtags = () => new Map(kind === 'missing' ? [] : [[key, tags[kind]!]]);
    if (kind === 'size') {
      const inventory = store.inventory.bind(store);
      store.inventory = async () => {
        const listed = await inventory();
        listed.set(key, listed.get(key)! + 1);
        return listed;
      };
    }
    const read = vi.spyOn(store, 'read');
    await publishPublication(directory, store, {
      ...options,
      worker: async (path) => Buffer.from(store.objects.get(path)!.data),
    });
    expect(read.mock.calls.filter(([path]) => path === key)).toHaveLength(
      ['quoted', 'bare', 'uppercase'].includes(kind) ? 0 : 1,
    );
  },
);

it.each([false, true])(
  'covers every remaining request including uncertain PUT recovery, unchanged=%s',
  async (unchanged) => {
    const { directory, store, options } = await setup();
    if (unchanged) await publishPublication(directory, store, options);
    const save = store.put.bind(store);
    store.put = async (...args) => {
      await save(...args);
      throw new Error('lost successful PUT response');
    };
    const calls = [vi.spyOn(store, 'read'), vi.spyOn(store, 'head'), vi.spyOn(store, 'put')];
    const count = () => calls.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    let before = 0;
    const report = await publishPublication(directory, store, {
      ...options,
      worker: async (key) => Buffer.from(store.objects.get(key)!.data),
      observe: () => {
        before = count();
      },
    });
    expect(count() - before).toBe(report.reservedS3Requests);
    if (unchanged) expect(report.reservedS3Requests).toBe(4);
    expect(report.status).toBe('verified');
  },
);
