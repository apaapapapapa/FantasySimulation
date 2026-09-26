import { afterEach, expect, it, vi } from 'vite-plus/test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { withReplayDirectory } from '@fantasy/api/testing';
import { leagueFixture } from '@fantasy/samples/testing';
import { PublicationS3 } from '../publication/publication-s3.ts';
import { prepareCloudLeague } from './league-cloud.ts';
import { transferCloudLeague } from './league-transfer.ts';
import { publicationLeagueSource } from '../../test-support/leagues.ts';
import { sha256 } from '@fantasy/api/artifacts';
import { leagueFailure, leagueFailureSummary } from './league-diagnostics.ts';

afterEach(() => vi.restoreAllMocks());
const config = {
  accountId: 'a'.repeat(32),
  bucket: 'fixture-bucket',
  accessKeyId: 'fixture',
  secretAccessKey: 'fixture',
};
const identity = { id: 'fixture-restore', sourceSha: 'b'.repeat(40), day: '2026-09-25' };
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
  let current: Awaited<ReturnType<PublicationS3['readControl']>> = null;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(PublicationS3.prototype, 'readControl').mockImplementation(async () => current);
  vi.spyOn(PublicationS3.prototype, 'putControl').mockImplementation(async (data, etag) => {
    if ((current?.etag ?? null) !== etag) throw new Error('CAS conflict');
    current = { data: Buffer.from(data), etag: String(JSON.parse(data.toString()).sequence) };
  });
  vi.spyOn(PublicationS3.prototype, 'inventory').mockResolvedValue(new Map());
  const read = vi.spyOn(PublicationS3.prototype, 'read').mockImplementation(async () => {
    if (current) {
      const ids = JSON.parse(current.data.toString()).leases.map((l: { id: string }) => l.id);
      expect(ids).toContain('fixture-restore');
      expect(ids).toContain('fixture-restore-inventory');
    }
    return null;
  });
  await withReplayDirectory(async (root) => {
    const inventory = await transferCloudLeague(
      config,
      join(root, 'public'),
      join(root, 'reports'),
      identity,
    );
    expect(inventory).toMatchObject({ files: 1, bytes: 65536, usedWriteRequests: 10601 });
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
