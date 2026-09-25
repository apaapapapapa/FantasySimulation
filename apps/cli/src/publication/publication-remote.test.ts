import { mkdtemp, rm, readFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vite-plus/test';
import { SUPPORTED_REPLAY_FORMAT } from '@fantasy/domain';
import { publicationFixture } from '../../test-support/publication.ts';
import { exportPublication } from './publication-export.ts';
import { localPublicationGraph } from './publication-graph.ts';
import { PUBLICATION_CONTROL_KEY } from './publication-files.ts';
import {
  publishPublication,
  prunePublication,
  type PublicationStore,
  type PublishOptions,
} from './publication-remote.ts';

class MemoryStore implements PublicationStore {
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
it('rejects a second valid result for the same simulation even in an orphan', async () => {
  const { root, directory, store, options } = await setup();
  const conflict = await publicationFixture(join(root, 'conflict'), 'complete', undefined, true);
  const key = `objects/${conflict.receipt.objectHash.slice(7)}/receipt.json`;
  store.objects.set(key, {
    data: await readFile(join(conflict.object, 'receipt.json')),
    etag: 'old',
  });
  await expect(publishPublication(directory, store, options)).rejects.toMatchObject({
    phase: 'not-committed',
    cause: { message: 'Existing simulation result conflict' },
  });
  expect(store.writes).toEqual([]);
});
it('does not commit when a referenced HEAD is missing', async () => {
  const { directory, store, options } = await setup();
  store.head = async () => null;
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
