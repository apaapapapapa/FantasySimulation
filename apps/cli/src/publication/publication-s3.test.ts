import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { PublicationS3, type S3PublicationBudget } from './publication-s3.ts';
import { PUBLICATION_CONTROL_KEY } from './publication-files.ts';

const stores: PublicationS3[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
});
function fixture(budget?: Partial<S3PublicationBudget>) {
  const send = vi.spyOn(S3Client.prototype, 'send');
  const store = new PublicationS3(
    {
      accountId: 'a'.repeat(32),
      bucket: 'public-replays',
      accessKeyId: 'fixture-access',
      secretAccessKey: 'fixture-secret',
    },
    budget,
  );
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

it('allows only explicit private-ledger operations and includes its bytes in inventory', async () => {
  const { store, send } = fixture({ maxAttempts: 1 });
  send.mockResolvedValue({} as never);
  const data = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      month: '2026-09',
      sequence: 1,
      leases: [
        {
          id: 'run-1',
          sourceSha: 'a'.repeat(40),
          day: '2026-09-25',
          classA: 600,
          classB: 10,
          worker: 0,
        },
      ],
    }),
  );
  await expect(store.put(PUBLICATION_CONTROL_KEY, data, null)).rejects.toThrow();
  await expect(store.read(PUBLICATION_CONTROL_KEY, 65536)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  await store.putControl(data, null);
  const command = send.mock.calls[0]![0] as unknown as { input: unknown };
  expect(command.input).toMatchObject({
    Key: PUBLICATION_CONTROL_KEY,
    IfNoneMatch: '*',
    CacheControl: 'private, no-store',
  });
  send.mockResolvedValueOnce({
    Contents: [{ Key: PUBLICATION_CONTROL_KEY, Size: data.length }],
  } as never);
  expect((await store.inventory()).get(PUBLICATION_CONTROL_KEY)).toBe(data.length);
  await expect(store.remove(PUBLICATION_CONTROL_KEY)).rejects.toThrow();
});

it('requires explicit league limits and charges failed requests before the next admission', async () => {
  const { store, send } = fixture({
    maxRequests: 1500000,
    maxClassARequests: 1,
    maxClassBRequests: 2,
    deadlineMs: 3600000,
    maxAttempts: 1,
  });
  send.mockResolvedValue({} as never);
  await store.put('catalog/current.json', Buffer.from('{}'), null);
  expect(await (send.mock.contexts[0] as S3Client).config.maxAttempts()).toBe(1);
  await expect(store.inventory()).rejects.toThrow('class budget');
  send.mockRejectedValue({ $metadata: { httpStatusCode: 503 } });
  await expect(store.head('catalog/current.json')).rejects.toThrow('HTTP 503');
  await expect(store.head('catalog/current.json')).rejects.toThrow('HTTP 503');
  await expect(store.head('catalog/current.json')).rejects.toThrow('S3 operation failed');
  expect(send).toHaveBeenCalledTimes(3);
  expect(store.metrics()).toMatchObject({
    logicalRequests: 3,
    classARequests: 1,
    classBRequests: 2,
    maxAttempts: 1,
  });
});

it.each([
  [403, 'REMOTE_AUTH'],
  [412, 'PUBLICATION_CONFLICT'],
  [503, 'REMOTE_UNAVAILABLE'],
  ['PRIVATE_STATUS_SENTINEL', 'REMOTE_UNAVAILABLE'],
])('classifies transport status %s without exposing vendor data', async (status, code) => {
  const { store, send } = fixture();
  send.mockRejectedValue({
    $metadata: { httpStatusCode: status },
    message: 'PRIVATE_STATUS_SENTINEL',
    cause: new Error('PRIVATE_STATUS_SENTINEL'),
  });
  await expect(store.head('catalog/current.json')).rejects.toMatchObject({ code });
  await expect(store.head('catalog/current.json')).rejects.not.toThrow('PRIVATE_STATUS_SENTINEL');
});

it.each([
  { maxRequests: 2000001 },
  { maxClassARequests: 900001 },
  { deadlineMs: 3600001 },
  { maxClassBRequests: 0 },
])('rejects an out-of-policy transport budget before any request', (budget) => {
  expect(() => fixture(budget)).toThrow('budget');
});

it.each(['before-admission', 'in-flight'] as const)(
  'classifies the transport deadline as budget exhaustion %s',
  async (phase) => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const { store, send } = fixture({ maxAttempts: 1 });
    if (phase === 'before-admission') controller.abort();
    send.mockImplementation(async () => {
      controller.abort();
      throw new Error('PRIVATE_TRANSPORT_SENTINEL');
    });
    await expect(store.put('catalog/current.json', Buffer.from('{}'), null)).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    expect(send).toHaveBeenCalledTimes(phase === 'before-admission' ? 0 : 1);
    expect(store.metrics().logicalRequests).toBe(phase === 'before-admission' ? 0 : 1);
    await expect(store.head('catalog/current.json')).rejects.not.toThrow(
      'PRIVATE_TRANSPORT_SENTINEL',
    );
  },
);
