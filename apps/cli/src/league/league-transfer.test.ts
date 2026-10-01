import { beforeEach, afterEach, expect, it, vi } from 'vite-plus/test';
import { billingObservation } from '../../test-support/league-billing.ts';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withReplayDirectory } from '@fantasy/api/testing';
import { leagueFixture } from '@fantasy/samples/testing';
import { PublicationS3 } from '../publication/publication-s3.ts';
import { prepareCloudLeague } from './league-cloud.ts';
import { transferCloudLeague } from './league-transfer.ts';
import { publicationLeagueSource } from '../../test-support/leagues.ts';
import { sha256 } from '@fantasy/api/artifacts';
import { leagueFailure, leagueFailureSummary } from './league-diagnostics.ts';
import { withMilestonePublication } from '../../test-support/league-milestones.ts';
import { probeLeague } from './league-probe.ts';
import { publicationFixture } from '../../test-support/publication.ts';
import { exportPublication } from '../publication/publication-export.ts';
import { SUPPORTED_REPLAY_FORMAT } from '@fantasy/domain';

afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-25T12:00:00Z')));
const config = {
  accountId: 'a'.repeat(32),
  bucket: 'fixture-bucket',
  accessKeyId: 'fixture',
  secretAccessKey: 'fixture',
  billingObservation: billingObservation(),
};
const identity = { id: 'fixture-restore', sourceSha: 'b'.repeat(40), day: '2026-09-25' };
it.each(['catalog', 'source', 'definition', 'mode', 'hold', 'checksum'])(
  'rejects a stale or invalid %s binding before restore leases or inventory',
  async (change) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const write = vi.spyOn(PublicationS3.prototype, 'putControl');
    const ledger = vi.spyOn(PublicationS3.prototype, 'readControl');
    const inventory = vi.spyOn(PublicationS3.prototype, 'inventory');
    await withMilestonePublication(async (fixture) => {
      const probe = await probeLeague(
        fixture.definition,
        identity.sourceSha,
        fixture.read,
        'publish',
      );
      const definition = structuredClone(fixture.definition);
      if (change === 'catalog') probe.catalogHash = `sha256:${'c'.repeat(64)}`;
      if (change === 'source') probe.sourceSha = 'c'.repeat(40);
      if (change === 'definition') definition.name += ' changed';
      if (change === 'mode') probe.mode = 'dry-run';
      if (change === 'hold') probe.needed = false;
      if (change === 'checksum')
        fixture.files.set(`catalog/${probe.catalogHash!.slice(7)}.json`, Buffer.from('{}'));
      vi.spyOn(PublicationS3.prototype, 'read').mockImplementation(async (key) => {
        const data = fixture.files.get(key);
        return data ? { data: Buffer.from(data), etag: 'fixture' } : null;
      });
      await expect(
        transferCloudLeague(
          config,
          join(fixture.root, 'restored'),
          join(fixture.root, 'reports'),
          identity,
          undefined,
          { probe, definition },
        ),
      ).rejects.toMatchObject({
        code: change === 'checksum' ? 'DATA_INVALID' : 'IDENTITY_MISMATCH',
      });
      expect(write).not.toHaveBeenCalled();
      expect(ledger).not.toHaveBeenCalled();
      expect(inventory).not.toHaveBeenCalled();
    });
  },
);

it.each(['pointer-json', 'pointer-utf8', 'catalog-json', 'catalog-utf8'])(
  'classifies malformed remote %s before consuming a lease',
  async (kind) => {
    const secret = 'REMOTE_JSON_PRIVATE_SENTINEL';
    const damaged = kind.endsWith('utf8') ? Buffer.from([0xff]) : Buffer.from(`{${secret}`);
    const pointer = kind.startsWith('pointer')
      ? damaged
      : Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            catalogHash: sha256(damaged),
            bytes: damaged.length,
          }),
        );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(PublicationS3.prototype, 'readControl').mockResolvedValue(null);
    vi.spyOn(PublicationS3.prototype, 'read').mockImplementation(async (key) => ({
      data: key === 'catalog/current.json' ? pointer : damaged,
      etag: 'fixture',
    }));
    const write = vi.spyOn(PublicationS3.prototype, 'putControl');
    await withReplayDirectory(async (root) => {
      const error = await transferCloudLeague(
        config,
        join(root, 'public'),
        join(root, 'reports'),
        identity,
      ).catch((error: unknown) => error);
      const report = leagueFailure(error, { command: 'restore' });
      expect(report).toMatchObject({ code: 'DATA_INVALID', phase: 'restoration', retry: 'no' });
      expect(JSON.stringify(report) + leagueFailureSummary(report)).not.toContain(secret);
      expect(write).not.toHaveBeenCalled();
    });
  },
);
it('requires durable inventory/data leases before restore and never reuses the same failed lease', async () => {
  const ledger = mockUsageLedger();
  vi.spyOn(PublicationS3.prototype, 'inventory').mockResolvedValue(new Map());
  const read = vi.spyOn(PublicationS3.prototype, 'read').mockImplementation(async () => {
    const current = ledger();
    if (current) {
      const ids = JSON.parse(current.data.toString()).leases.map((l: { id: string }) => l.id);
      expect(ids).toContain('fixture-restore');
      expect(ids).toContain('fixture-restore-inventory');
    }
    return null;
  });
  const timeouts = vi.spyOn(AbortSignal, 'timeout');
  await withReplayDirectory(async (root) => {
    const inventory = await transferCloudLeague(
      config,
      join(root, 'public'),
      join(root, 'reports'),
      identity,
      undefined,
      {
        probe: await probeLeague(
          await leagueFixture(2, 1),
          identity.sourceSha,
          async () => {
            const { PublicReadFailure } = await import('../publication/publication-http.ts');
            throw new PublicReadFailure(404);
          },
          'publish',
        ),
        definition: await leagueFixture(2, 1),
      },
    );
    expect(inventory).toMatchObject({ files: 1, bytes: 65536, usedWriteRequests: 10601 });
    // Restore keeps the one-hour S3 transport bound; only publication gets three hours.
    expect(timeouts.mock.calls.map(([ms]) => ms)).toContain(3_600_000);
    expect(timeouts.mock.calls.map(([ms]) => ms)).not.toContain(10_800_000);
    const count = read.mock.calls.length;
    await expect(
      transferCloudLeague(config, join(root, 'retry'), join(root, 'reports'), identity),
    ).rejects.toThrow('already consumed');
    expect(read).toHaveBeenCalledTimes(count);
  });
});
it('refuses to bootstrap a deleted usage ledger when durable league reservations already exist', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(PublicationS3.prototype, 'readControl').mockResolvedValue(null);
  const write = vi.spyOn(PublicationS3.prototype, 'putControl');
  await withReplayDirectory(async (root) => {
    const publicRoot = join(root, 'public');
    await prepareCloudLeague(
      await leagueFixture(2, 1),
      publicationLeagueSource,
      'prior',
      publicRoot,
      join(root, 'prepared'),
      { files: 0, bytes: 0, receipts: 0, usedReadRequests: 10000, usedWriteRequests: 10000 },
    );
    vi.spyOn(PublicationS3.prototype, 'read').mockImplementation(async (key) => ({
      data: await readFile(join(publicRoot, key)),
      etag: 'fixture',
    }));
    await expect(
      transferCloudLeague(config, join(root, 'restored'), join(root, 'reports'), identity),
    ).rejects.toThrow('ledger is missing');
    expect(write).not.toHaveBeenCalled();
  });
});

function mockUsageLedger() {
  let current: Awaited<ReturnType<PublicationS3['readControl']>> = null;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(PublicationS3.prototype, 'readControl').mockImplementation(async () => current);
  vi.spyOn(PublicationS3.prototype, 'putControl').mockImplementation(async (data, etag) => {
    if ((current?.etag ?? null) !== etag) throw new Error('CAS conflict');
    current = { data: Buffer.from(data), etag: String(JSON.parse(data.toString()).sequence) };
  });
  return () => current;
}

/** In-memory bucket for publication tests; `put` may be overridden per test. */
function mockObjectStore() {
  const objects = new Map<string, Buffer>();
  const inventory = vi
    .spyOn(PublicationS3.prototype, 'inventory')
    .mockImplementation(async () => new Map([...objects].map(([key, data]) => [key, data.length])));
  vi.spyOn(PublicationS3.prototype, 'read').mockImplementation(async (key) => {
    const data = objects.get(key);
    return data ? { data: Buffer.from(data), etag: 'fixture' } : null;
  });
  vi.spyOn(PublicationS3.prototype, 'head').mockImplementation(
    async (key) => objects.get(key)?.length ?? null,
  );
  const put = vi.spyOn(PublicationS3.prototype, 'put').mockImplementation(async (key, data) => {
    objects.set(key, Buffer.from(data));
  });
  return { objects, inventory, put };
}
/** Exports a fixture publication once and returns a publisher bound to that directory. */
async function publicationTransfer(root: string, objects: ReadonlyMap<string, Buffer>) {
  const fixture = await publicationFixture(join(root, 'input'));
  const directory = join(root, 'public');
  await exportPublication(fixture.plan, [fixture], directory);
  return (id: string) =>
    transferCloudLeague(
      config,
      directory,
      join(root, 'reports'),
      { ...identity, id },
      {
        viewer: async () => ({
          schemaVersion: 1,
          sourceSha: 'b'.repeat(40),
          publicationSchema: 1,
          replay: SUPPORTED_REPLAY_FORMAT,
        }),
        ancestor: () => true,
        worker: async (key) => Buffer.from(objects.get(key)!),
      },
    );
}

it('resumes an interrupted publication without rewriting stored objects, within a three-hour transport', async () => {
  mockUsageLedger();
  const { objects, put } = mockObjectStore();
  const written: string[] = [];
  let failAfter = 2;
  put.mockImplementation(async (key, data) => {
    if (failAfter-- === 0) throw new Error('interrupted transport');
    written.push(key);
    objects.set(key, Buffer.from(data));
  });
  const timeouts = vi.spyOn(AbortSignal, 'timeout');
  await withReplayDirectory(async (root) => {
    const publish = await publicationTransfer(root, objects);
    await expect(publish('publish-interrupted')).rejects.toThrow();
    const stored = new Set(objects.keys());
    expect(stored.size).toBeGreaterThan(0);
    expect(objects.has('catalog/current.json')).toBe(false);
    failAfter = Infinity;
    // The listing's MD5 ETags prove the interrupted attempt's objects without downloading them.
    vi.spyOn(PublicationS3.prototype, 'listedEtags').mockImplementation(
      () =>
        new Map(
          [...objects].map(([key, data]) => [
            key,
            `"${createHash('md5').update(data).digest('hex')}"`,
          ]),
        ),
    );
    const read = vi.mocked(PublicationS3.prototype.read);
    read.mockClear();
    await publish('publish-resumed');
    expect(objects.has('catalog/current.json')).toBe(true);
    expect(
      read.mock.calls.filter(([key]) => stored.has(key) && !key.endsWith('/receipt.json')),
    ).toHaveLength(0);
    // Objects stored by the interrupted attempt are verified, never uploaded again.
    expect(written.filter((key) => stored.has(key))).toHaveLength(stored.size);
    expect(new Set(written).size).toBe(written.length);
  });
  const deadlines = timeouts.mock.calls.map(([ms]) => ms);
  expect(deadlines).toContain(10_800_000);
  expect(deadlines).not.toContain(3_600_000);
});
it('uses one post-validation inventory for both lease admission and publication', async () => {
  mockUsageLedger();
  const { objects, inventory } = mockObjectStore();
  await withReplayDirectory(async (root) => {
    await (
      await publicationTransfer(root, objects)
    )('publish-one-list');
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(objects.has('catalog/current.json')).toBe(true);
  });
});
