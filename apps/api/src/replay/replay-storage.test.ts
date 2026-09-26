import { describe, expect, it } from 'vite-plus/test';
import { readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  ReplayState,
  replayContext,
  ResultSchema,
  type ReplayManifest,
} from '@fantasy/domain/spatial';
import saved from '../../../../packages/domain/fixtures/replay/mutual-hit.json' with { type: 'json' };
import { ReplayWriter } from './replay-writer.ts';
import {
  readReplayManifest,
  seekReplay,
  verifyReplay,
  verifyReplayDirectory,
} from './replay-reader.ts';
import { readBoundedFile, readCompressed, sha256 } from './replay-files.ts';
import { withReplayDirectory, recordedBattle, artifactBytes } from '../../test-support/replays.ts';

describe('bounded independent replay artifacts', () => {
  it.each([
    'record-schema',
    'record-json',
    'checkpoint-json',
    'record-gzip',
    'checkpoint-gzip',
    'record-truncated',
    'checkpoint-truncated',
    'record-utf8',
    'checkpoint-utf8',
    'record-size',
    'checkpoint-size',
    'record-overflow',
    'checkpoint-overflow',
    'record-file-length',
    'checkpoint-file-length',
  ])(
    'classifies saved %s corruption even when compressed checksums are consistent',
    async (kind) => {
      await withReplayDirectory(async (root) => {
        const { manifest } = await recordedBattle(root, 20);
        const directory = join(root, manifest.id);
        const ref = kind.startsWith('checkpoint') ? manifest.checkpoints[0]! : manifest.chunks[0]!;
        const original = await readCompressed(directory, ref);
        if (kind.endsWith('file-length')) {
          const file = join(directory, ref.file);
          await writeFile(
            file,
            Buffer.concat([await readFile(file), Buffer.from('PRIVATE_SIZE_SENTINEL')]),
          );
          await expect(verifyReplayDirectory(directory, manifest)).rejects.toMatchObject({
            code: 'DATA_INVALID',
          });
          return;
        }
        const raw =
          kind === 'checkpoint-json'
            ? '{'
            : kind.endsWith('utf8')
              ? Buffer.from([0xff])
              : kind === 'record-schema' || kind === 'record-json'
                ? [kind === 'record-schema' ? '{}' : '{', ...original.split('\n').slice(1)].join(
                    '\n',
                  )
                : original;
        const compressed = gzipSync(raw);
        const bytes = kind.endsWith('gzip')
          ? Buffer.from('invalid gzip')
          : kind.endsWith('truncated')
            ? compressed.subarray(0, -1)
            : compressed;
        await writeFile(join(directory, ref.file), bytes);
        Object.assign(ref, {
          bytes: bytes.length,
          rawBytes:
            Buffer.byteLength(raw) +
            (kind.endsWith('size') ? 1 : kind.endsWith('overflow') ? -1 : 0),
          checksum: sha256(bytes),
        });
        await expect(verifyReplayDirectory(directory, manifest)).rejects.toMatchObject({
          code: 'DATA_INVALID',
        });
      });
    },
  );
  it('rejects symlinks before reading their target through the opened handle', async () => {
    await withReplayDirectory(async (root) => {
      const target = join(root, 'target'),
        link = join(root, 'link');
      await writeFile(target, 'untrusted target');
      await symlink(target, link, 'file');
      await expect(readBoundedFile(link, 100)).rejects.toThrow();
      expect((await readBoundedFile(target, 100)).toString()).toBe('untrusted target');
    });
  });
  it('persists verified chunks, preserves logical hashes and restores a late seek independently', async () => {
    await withReplayDirectory(async (root) => {
      const { result, records, manifest } = await recordedBattle(root);
      expect(manifest.chunks.length).toBeGreaterThan(1);
      expect(artifactBytes(manifest)).toBeLessThan(16 * 1024 * 1024);
      expect(manifest.end).toEqual({ kind: 'result', result });
      const { checkpoint } = await verifyReplay(root, manifest.id);
      expect(checkpoint.lastRecord).toEqual(records.at(-1));
      const replay = new ReplayState(await replayContext(manifest.input, result.simulationHash));
      const targets = new Set([1, 100, records.length - 1, records.length]);
      for (const record of records) {
        replay.apply(record);
        if (targets.has(replay.checkpoint().nextRecord))
          expect(await seekReplay(root, manifest.id, replay.checkpoint().nextRecord)).toEqual(
            replay.checkpoint(),
          );
      }
      // A late seek reads its checkpoint/chunk only; full verification still detects missing earlier data.
      await rm(join(root, manifest.id, manifest.chunks[0]!.file));
      expect(await seekReplay(root, manifest.id, records.length)).toEqual(checkpoint);
      await expect(verifyReplay(root, manifest.id)).rejects.toThrow();
    });
  });
  it.each(['failed', 'cancelled'] as const)(
    'retains verified partial %s diagnostics without a fabricated outcome',
    async (kind) => {
      await withReplayDirectory(async (root) => {
        const result = ResultSchema.parse(saved.result);
        const writer = await ReplayWriter.create(root, {
          id: 'partial',
          attemptId: 'attempt',
          input: saved.input,
          simulationHash: result.simulationHash,
        });
        for (const record of saved.records.slice(0, 3)) await writer.append(record);
        const manifest = await writer.finish({ kind, reason: 'Execution stopped' }, null);
        expect(manifest.resultId).toBeNull();
        expect(manifest.records).toBe(3);
        expect((await verifyReplay(root, 'partial')).checkpoint.lastRecord?.kind).not.toBe(
          'terminal',
        );
      });
    },
  );
  it('does not expose a manifest on interrupted writes or mismatched results', async () => {
    await withReplayDirectory(async (root) => {
      const result = ResultSchema.parse(saved.result);
      const writer = await ReplayWriter.create(root, {
        id: 'interrupted',
        attemptId: 'attempt',
        input: saved.input,
        simulationHash: result.simulationHash,
      });
      for (const record of saved.records) await writer.append(record);
      await expect(
        writer.finish(
          { kind: 'result', result: { ...result, eventHash: `sha256:${'0'.repeat(64)}` } },
          'result',
        ),
      ).rejects.toThrow();
      await expect(readReplayManifest(root, 'interrupted')).rejects.toThrow();
      await writer.discard();
      expect(await readdir(root)).toEqual([]);
    });
  });
  it('rejects corrupted, missing and over-expanding bytes even with valid compressed checksums', async () => {
    await withReplayDirectory(async (root) => {
      const { manifest } = await recordedBattle(root, 20);
      const directory = join(root, manifest.id),
        ref = manifest.chunks[0]!;
      const original = await readFile(join(directory, ref.file));
      await writeFile(join(directory, ref.file), Buffer.from('corrupt'));
      await expect(verifyReplay(root, manifest.id)).rejects.toThrow(/checksum|size/);
      const bomb = gzipSync(Buffer.alloc(ref.rawBytes + 1, 65));
      await writeFile(join(directory, ref.file), bomb);
      await expect(
        readCompressed(directory, { ...ref, bytes: bomb.length, checksum: sha256(bomb) }),
      ).rejects.toThrow();
      await writeFile(join(directory, ref.file), original);
      await expect(readCompressed(directory, { ...ref, file: '../outside.gz' })).rejects.toThrow();
    });
  });
  it('compares each checkpoint against the actual verified prefix, beyond checksum matching', async () => {
    await withReplayDirectory(async (root) => {
      const { manifest } = await recordedBattle(root);
      const ref = manifest.checkpoints[1]!,
        directory = join(root, manifest.id);
      const checkpoint = JSON.parse(await readCompressed(directory, ref)) as {
        state: { actors: { resources: { hp: number } }[] };
      };
      checkpoint.state.actors[0]!.resources.hp--;
      const raw = JSON.stringify(checkpoint),
        bytes = gzipSync(raw);
      await writeFile(join(directory, ref.file), bytes);
      const changed: ReplayManifest = structuredClone(manifest);
      Object.assign(changed.checkpoints[1]!, {
        bytes: bytes.length,
        rawBytes: Buffer.byteLength(raw),
        checksum: sha256(bytes),
      });
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(changed));
      await expect(verifyReplay(root, manifest.id)).rejects.toThrow(/verified prefix/);
    });
  });
});
