import { expect, it } from 'vite-plus/test';
import {
  PackIndexSchema,
  parsePackRange,
  assertPackResponse,
  PACK_RANGE_BYTES,
  assertPackedFiles,
} from './packs.ts';

const index = () => ({
  schemaVersion: 1,
  packHash: 'sha256:' + 'a'.repeat(64),
  packBytes: 8,
  entries: ['manifest.json', 'receipt.json'].map((file, i) => ({
    key: `objects/${'b'.repeat(64)}/${file}`,
    offset: i * 4,
    bytes: 4,
    checksum: 'sha256:' + 'c'.repeat(64),
    encoding: 'identity',
    rawBytes: 4,
  })),
});
it('checks large complete coverage and refuses repeated or missing logical references', () => {
  const base = PackIndexSchema.parse(index()).entries[0]!;
  const entries = Array.from({ length: 10000 }, (_, i) => ({
    ...base,
    key: `objects/${'b'.repeat(64)}/checkpoint-${String(i).padStart(5, '0')}.json.gz`,
    offset: i * 4,
  }));
  const expected = entries.map(({ key }) => ({ key, bytes: 4, checksum: base.checksum }));
  expect(() => assertPackedFiles(entries, expected)).not.toThrow();
  expect(() => assertPackedFiles([...entries.slice(1), entries[1]!], expected)).toThrow(
    'duplicate',
  );
  expect(() => assertPackedFiles(entries, [...expected.slice(1), expected[1]!])).toThrow(
    'duplicate',
  );
  expect(() => assertPackedFiles(entries.slice(1), expected)).toThrow('coverage');
});
it.each([
  'overlap',
  'gap',
  'duplicate',
  'order',
  'size',
  'overflow',
  'encoding',
  'expanded',
  'private',
])('rejects %s in an index before payload access', (fault) => {
  const value = index(),
    entry = value.entries[1]!;
  if (fault === 'overlap') entry.offset--;
  if (fault === 'gap') entry.offset++;
  if (fault === 'duplicate') entry.key = value.entries[0]!.key;
  if (fault === 'order') value.entries.reverse();
  if (fault === 'size') value.packBytes++;
  if (fault === 'overflow') entry.offset = Number.MAX_SAFE_INTEGER + 1;
  if (fault === 'encoding') entry.encoding = 'gzip';
  if (fault === 'expanded') entry.rawBytes++;
  if (fault === 'private') entry.key = 'control/league-usage.json';
  expect(PackIndexSchema.safeParse(value).success).toBe(false);
});
it('accepts exact coverage and rejects suffix, open, multiple, unsafe and oversized ranges', () => {
  expect(PackIndexSchema.parse(index()).packBytes).toBe(8);
  for (const value of [
    null,
    '',
    'bytes=1-',
    'bytes=-1',
    'bytes=0-1,3-4',
    'bytes=01-2',
    'bytes=2-1',
    'bytes=0-9007199254740992',
    `bytes=0-${PACK_RANGE_BYTES}`,
  ])
    expect(parsePackRange(value)).toBeNull();
  expect(parsePackRange('bytes=3-7')).toEqual({ offset: 3, bytes: 5 });
  expect(parsePackRange(`bytes=0-${PACK_RANGE_BYTES - 1}`)).toEqual({
    offset: 0,
    bytes: PACK_RANGE_BYTES,
  });
});
it('requires 206, exact range and size, ETag and byte-preserving transport', () => {
  const headers = new Headers({
    'Content-Range': 'bytes 3-7/8',
    'Content-Length': '5',
    ETag: '"pack"',
    'Accept-Ranges': 'bytes',
  });
  const range = { offset: 3, bytes: 5, total: 8 };
  expect(() => assertPackResponse(206, headers, range)).not.toThrow();
  expect(() => assertPackResponse(200, headers, range)).toThrow();
  for (const name of ['Content-Range', 'Content-Length', 'ETag', 'Accept-Ranges']) {
    const bad = new Headers(headers);
    bad.delete(name);
    expect(() => assertPackResponse(206, bad, range)).toThrow();
  }
  headers.set('Content-Encoding', 'gzip');
  expect(() => assertPackResponse(206, headers, range)).toThrow();
});
