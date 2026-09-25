import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { PublicationS3 } from './publication-s3.ts';

const stores: PublicationS3[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
});
function fixture() {
  const send = vi.spyOn(S3Client.prototype, 'send');
  const store = new PublicationS3({
    accountId: 'a'.repeat(32),
    bucket: 'public-replays',
    accessKeyId: 'fixture-access',
    secretAccessKey: 'fixture-secret',
  });
  stores.push(store);
  return { store, send };
}
it('uses conditional writes, explicit MIME/cache and no HTTP gzip encoding', async () => {
  const { store, send } = fixture();
  send.mockResolvedValue({} as never);
  await store.put(`objects/${'a'.repeat(64)}/chunk-00000.ndjson.gz`, Buffer.from([31, 139]), null);
  await store.put('catalog/current.json', Buffer.from('{}'), '"previous"');
  const [immutable, pointer] = send.mock.calls.map(
    (call) => (call[0] as unknown as { input: unknown }).input,
  );
  expect(immutable).toMatchObject({
    Bucket: 'public-replays',
    ContentType: 'application/gzip',
    IfNoneMatch: '*',
  });
  expect(immutable).not.toHaveProperty('ContentEncoding');
  expect(pointer).toMatchObject({
    IfMatch: '"previous"',
    CacheControl: 'public, max-age=30, no-transform',
  });
  expect(pointer).not.toHaveProperty('IfNoneMatch');
  expect(store.remainingRequests()).toBe(99998);
});
it('paginates inventory, refuses unexpected keys and stops repeated cursors', async () => {
  const { store, send } = fixture();
  send.mockResolvedValueOnce({
    Contents: [{ Key: 'catalog/current.json', Size: 123 }],
    IsTruncated: true,
    NextContinuationToken: 'page-2',
  } as never);
  send.mockResolvedValueOnce({
    Contents: [{ Key: `catalog/${'a'.repeat(64)}.json`, Size: 456 }],
    IsTruncated: false,
  } as never);
  expect([...(await store.inventory()).values()]).toEqual([123, 456]);
  expect(store.remainingRequests()).toBe(99998);
  send.mockResolvedValueOnce({
    Contents: [{ Key: 'private.env', Size: 1 }],
    IsTruncated: false,
  } as never);
  await expect(store.inventory()).rejects.toThrow();
  send.mockResolvedValue({
    Contents: [],
    IsTruncated: true,
    NextContinuationToken: 'stuck',
  } as never);
  await expect(store.inventory()).rejects.toThrow('Incomplete S3 inventory');
});
it('bounds streamed objects, distinguishes absence and strips vendor/credential diagnostics', async () => {
  const { store, send } = fixture();
  send.mockResolvedValueOnce({
    ETag: '"etag"',
    Body: { transformToWebStream: () => new Blob(['too large']).stream() },
  } as never);
  await expect(store.read('catalog/current.json', 2)).rejects.toThrow('S3 operation failed');
  send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
  expect(await store.read('catalog/current.json', 2)).toBeNull();
  send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 403 }, message: 'fixture-secret' });
  await expect(store.head('catalog/current.json')).rejects.toThrow('HTTP 403');
  await expect(store.remove('catalog/current.json')).rejects.toThrow('Cannot delete');
});
