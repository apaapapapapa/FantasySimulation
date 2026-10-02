import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { withReplayDirectory } from '@fantasy/api/testing';
import { calibrationEncodedBytes } from './league-calibration-upload.ts';
import { inspectTransportZipBound } from './league-transport-zip-bound.ts';

const encoder = 'actions-artifact-6.2.1-store-files-v1';
const envelope = {
  encoder,
  rawBytesUpper: 48 * 1024 ** 2,
  fileCountUpper: 4096,
  maxNameBytesUpper: 256,
};
it('bounds maximum modeled archive below the unchanged 64MiB receiver cap without enabling execution', () => {
  const report = inspectTransportZipBound(envelope);
  expect(report.encodedBytesUpper).toBe(52805654);
  expect(report.encodedBytesUpper).toBeLessThan(64 * 1024 ** 2);
  expect(report.executionEnabled).toBe(false);
  expect(report.remainingGates).toContain('authenticated-output-proof');
  expect(report.remainingGates).toContain('same-source-whole-critical-path');
});
it.each([
  { encoder: 'unknown' },
  { rawBytesUpper: 48 * 1024 ** 2 + 1 },
  { rawBytesUpper: -1 },
  { rawBytesUpper: NaN },
  { rawBytesUpper: 0.5 },
  { fileCountUpper: 0 },
  { fileCountUpper: 4097 },
  { fileCountUpper: Infinity },
  { maxNameBytesUpper: 0 },
  { maxNameBytesUpper: 257 },
  { maxNameBytesUpper: 1.5 },
])('rejects an unsupported encoding claim %j', (change) => {
  expect(() => inspectTransportZipBound({ ...envelope, ...change })).toThrow('Unsupported');
});
it.each([0, 1, 65536])(
  'covers real pinned SDK STORE bytes with nested Unicode names and %i payload bytes',
  async (size) => {
    await withReplayDirectory(async (root) => {
      await mkdir(join(root, 'nested'));
      const name = 'nested/記録.bin';
      const file = join(root, name);
      // Incompressible-looking bytes also detect accidental compressed-format assumptions.
      await writeFile(
        file,
        Buffer.from(Array.from({ length: size }, (_, i) => (i * 73 + 19) % 256)),
      );
      const report = inspectTransportZipBound({
        encoder,
        rawBytesUpper: size,
        fileCountUpper: 1,
        maxNameBytesUpper: Buffer.byteLength(name),
      });
      const actual = await calibrationEncodedBytes([file], root, report.encodedBytesUpper);
      expect(actual).toBeLessThanOrEqual(report.encodedBytesUpper);
      expect(actual).toBeGreaterThanOrEqual(size + 76 + 2 * Buffer.byteLength(name) + 22);
    });
  },
);
it('covers maximum payload, entry count and name length using the real local encoder', async () => {
  await withReplayDirectory(async (root) => {
    await mkdir(join(root, 'd'));
    const files: string[] = [];
    for (let start = 0; start < 4096; start += 32) {
      await Promise.all(
        Array.from({ length: 32 }, async (_, offset) => {
          const index = start + offset;
          const name = 'd/' + String(index).padStart(4, '0') + 'x'.repeat(250);
          expect(Buffer.byteLength(name)).toBe(256);
          const file = join(root, name);
          await writeFile(file, index === 0 ? Buffer.alloc(48 * 1024 ** 2, 113) : Buffer.alloc(0));
          files[index] = file;
        }),
      );
    }
    const report = inspectTransportZipBound(envelope);
    expect(
      await calibrationEncodedBytes(files, root, report.encodedBytesUpper),
    ).toBeLessThanOrEqual(report.encodedBytesUpper);
  });
}, 30000);
