import { expect, it, vi } from 'vite-plus/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { recordedBattle, withReplayDirectory } from '../../test-support/replays.ts';
import { Measurements } from '../measurements.ts';
import { verifyReplayDirectory } from './replay-reader.ts';
import { readCompressed, sha256 } from './replay-files.ts';
import { assertPublicData } from './replay-public.ts';
import { ReplayVerificationPool, replayVerificationWorkers } from './verification-pool.ts';

it('inspects the original records in the same bounded decode pass as semantic verification', async () => {
  await withReplayDirectory(async (root) => {
    const { manifest } = await recordedBattle(root, 20);
    const directory = join(root, manifest.id);
    const expected = await verifyReplayDirectory(directory, manifest);
    const inspection = vi.fn(assertPublicData);
    const measurement = new Measurements();
    const actual = await measurement.run(() => verifyReplayDirectory(directory, manifest, inspection));
    expect(actual).toEqual(expected);
    expect(inspection).toHaveBeenCalledTimes(1 + manifest.chunks.length + manifest.records);
    expect(measurement.report().validation.calls).toBe(1);
    expect(measurement.report().stages.decompress?.count).toBe(2 * manifest.chunks.length);
    const ref = manifest.checkpoints[0]!;
    const checkpoint = JSON.parse(await readCompressed(directory, ref)) as Record<string, unknown>;
    checkpoint.absolutePath = '/private/fixture';
    const text = JSON.stringify(checkpoint);
    const compressed = gzipSync(text);
    const changed = structuredClone(manifest);
    Object.assign(changed.checkpoints[0]!, {
      checksum: sha256(compressed), bytes: compressed.length, rawBytes: Buffer.byteLength(text),
    });
    await writeFile(join(directory, ref.file), compressed);
    // The privacy error must precede checkpoint/schema normalization, not inspect a stripped value.
    await expect(verifyReplayDirectory(directory, changed, assertPublicData)).rejects.toThrow(
      'Private field is not publishable',
    );
  });
}, 30000);

it('uses the existing full validator in a secret-free Worker and rejects corruption', async () => {
  await withReplayDirectory(async (root) => {
    const { manifest } = await recordedBattle(root, 20);
    const directory = join(root, manifest.id);
    const pool = new ReplayVerificationPool(1);
    try {
      expect(pool.pool.options.env).toEqual({});
      const measurement = new Measurements();
      await measurement.run(() => pool.verify(directory, manifest, true));
      expect(measurement.report().validation).toMatchObject({ calls: 1, failures: undefined });
      expect(measurement.report().validation.replays[manifest.id]).toEqual({ calls: 1, failures: 0 });
      const path = join(directory, manifest.chunks[0]!.file);
      const original = await readFile(path);
      const broken = Buffer.from(original);
      broken[0] = broken[0]! ^ 1;
      await writeFile(path, broken);
      await expect(pool.verify(directory, manifest, true)).rejects.toMatchObject({ code: 'DATA_INVALID' });
      await writeFile(path, original);
      await pool.verify(directory, manifest, true);
    } finally {
      await pool.close();
    }
    await expect(pool.verify(directory, manifest, true)).rejects.toThrow('closed');
  });
}, 30000);

it('rejects aborted and dead Workers rather than issuing verification success', async () => {
  await withReplayDirectory(async (root) => {
    const { manifest } = await recordedBattle(root, 20);
    const controller = new AbortController();
    const pool = new ReplayVerificationPool(1, controller.signal);
    try {
      controller.abort();
      await expect(pool.verify(join(root, manifest.id), manifest, false)).rejects.toThrow();
    } finally {
      await pool.close();
    }
    const dead = new ReplayVerificationPool(1);
    try {
      await dead.pool.destroy();
      await expect(dead.verify(join(root, manifest.id), manifest, false)).rejects.toThrow();
    } finally {
      await dead.close();
    }
  });
}, 30000);

it.each([0, -1, 1.5, 5, Number.NaN])('rejects invalid replay Worker count %s', (workers) => {
  expect(() => replayVerificationWorkers(workers)).toThrow('one to four');
});
