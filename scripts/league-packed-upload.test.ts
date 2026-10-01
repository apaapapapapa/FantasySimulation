import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { publicationLeagueSource } from '../apps/cli/test-support/leagues.ts';
import type { sealLeagueProducer } from '../apps/cli/src/league/league-producer.ts';
import type { PipelineArtifact } from './league-pipeline-artifacts.ts';
import * as uploads from './league-pipeline-upload.ts';
import { PackedLeagueUpload } from './league-packed-upload.ts';
import * as transport from '../apps/cli/src/league/league-producer-transport.ts';

vi.mock('../apps/cli/src/league/league-producer-transport.ts', async (original) => {
  const actual = await original<typeof transport>();
  return { ...actual, packedProducerDescriptor: vi.fn(), packedIndex: vi.fn() };
});

const identity = {
  source: publicationLeagueSource,
  runId: 123,
  runAttempt: 1,
  validatorDigest: 'sha256:' + 'b'.repeat(64),
};
// Scheduling units replace the already-validated descriptor boundary. They never
// claim producer authentication; transport tests exercise real proof/source/files.
const proof = { identity, runner: 0 } as Awaited<ReturnType<typeof sealLeagueProducer>>;
async function fixture(root: string, artifacts: PipelineArtifact[] = []) {
  const controller = new AbortController();
  const writer = new PackedLeagueUpload(
    join(root, 'packed'),
    identity,
    0,
    controller.signal,
    artifacts,
  );
  async function append(partition: number, bytes = 1, rejection?: Error) {
    const directory = join(root, `producer-${partition}`);
    await mkdir(directory);
    await writeFile(join(directory, 'payload'), 'x');
    if (rejection) vi.mocked(transport.packedProducerDescriptor).mockRejectedValueOnce(rejection);
    else
      vi.mocked(transport.packedProducerDescriptor).mockResolvedValueOnce({
        partition,
        files: [{ path: `partitions/${partition}/payload`, bytes }],
      } as unknown as Awaited<ReturnType<typeof transport.packedProducerDescriptor>>);
    return { directory, pending: writer.append(directory, proof) };
  }
  return { writer, controller, artifacts, append };
}
beforeEach(() => {
  vi.mocked(transport.packedProducerDescriptor).mockReset();
  vi.mocked(transport.packedIndex).mockImplementation(
    (_identity, _runner, _sequence, partitions) =>
      ({ partitions }) as unknown as ReturnType<typeof transport.packedIndex>,
  );
  vi.spyOn(uploads, 'uploadPipelineArtifact').mockImplementation(async (name, files, root) => {
    for (const file of files) await access(file);
    await access(join(root, 'index.json'));
    return { id: 456, name, digest: 'sha256:' + 'c'.repeat(64), bytes: 128 };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('flushes two accepted partitions together and finish drains a lone final partition', async () => {
  await withReplayDirectory(async (root) => {
    const f = await fixture(root);
    try {
      expect(await (await f.append(0)).pending).toBe(true);
      expect(uploads.uploadPipelineArtifact).not.toHaveBeenCalled();
      expect(await (await f.append(1)).pending).toBe(true);
      expect(uploads.uploadPipelineArtifact).toHaveBeenCalledTimes(1);
      expect(vi.mocked(uploads.uploadPipelineArtifact).mock.calls[0]?.[0]).toBe(
        'league-123-1-runner-0-pack-0',
      );
      expect(vi.mocked(uploads.uploadPipelineArtifact).mock.calls[0]?.[1]).toEqual([
        join(root, 'packed/0/index.json'),
        join(root, 'packed/0/partitions/0/payload'),
        join(root, 'packed/0/partitions/1/payload'),
      ]);
      await expect(access(join(root, 'packed/0'))).rejects.toThrow();
      await (
        await f.append(2)
      ).pending;
      await f.writer.finish();
      expect(uploads.uploadPipelineArtifact).toHaveBeenCalledTimes(2);
      expect(f.artifacts.map((artifact) => artifact.name)).toEqual([
        'league-123-1-runner-0-pack-0',
        'league-123-1-runner-0-pack-1',
      ]);
    } finally {
      await f.writer.close();
    }
  });
});

it('flushes at the five-second deadline, with no earlier upload', async () => {
  await withReplayDirectory(async (root) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = await fixture(root);
    try {
      await (
        await f.append(0)
      ).pending;
      await vi.advanceTimersByTimeAsync(4999);
      expect(uploads.uploadPipelineArtifact).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await f.writer.finish();
      expect(uploads.uploadPipelineArtifact).toHaveBeenCalledTimes(1);
    } finally {
      await f.writer.close();
    }
  });
});

it('flushes before combined raw bytes exceed 48 MiB, and preserves oversized legacy fallback', async () => {
  await withReplayDirectory(async (root) => {
    const f = await fixture(root);
    try {
      await (
        await f.append(0, 25 * 1024 ** 2)
      ).pending;
      await (
        await f.append(1, 25 * 1024 ** 2)
      ).pending;
      expect(uploads.uploadPipelineArtifact).toHaveBeenCalledTimes(1);
      const fallback = await f.append(2, 48 * 1024 ** 2);
      expect(await fallback.pending).toBe(false);
      expect(uploads.uploadPipelineArtifact).toHaveBeenCalledTimes(2);
      expect(await readFile(join(fallback.directory, 'payload'), 'utf8')).toBe('x');
      await f.writer.finish();
      expect(uploads.uploadPipelineArtifact).toHaveBeenCalledTimes(2);
    } finally {
      await f.writer.close();
    }
  });
});

it('retains upload failure, cleans its group, and refuses subsequent work', async () => {
  await withReplayDirectory(async (root) => {
    const failure = new Error('remote upload unavailable');
    vi.mocked(uploads.uploadPipelineArtifact).mockRejectedValueOnce(failure);
    const f = await fixture(root);
    try {
      await (
        await f.append(0)
      ).pending;
      await expect(f.writer.finish()).rejects.toBe(failure);
      await expect(access(join(root, 'packed/0'))).rejects.toThrow();
      await expect((await f.append(1)).pending).rejects.toBe(failure);
      await expect(f.writer.finish()).rejects.toBe(failure);
      expect(f.artifacts).toEqual([]);
      expect(uploads.uploadPipelineArtifact).toHaveBeenCalledTimes(1);
    } finally {
      await f.writer.close();
    }
  });
});

it('abort waits for an in-flight upload to settle before spool cleanup', async () => {
  await withReplayDirectory(async (root) => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(uploads.uploadPipelineArtifact).mockImplementationOnce(async (name) => {
      entered();
      await gate;
      return { id: 456, name, digest: 'sha256:' + 'c'.repeat(64), bytes: 128 };
    });
    const f = await fixture(root);
    await (
      await f.append(0)
    ).pending;
    const finish = f.writer.finish();
    const rejected = expect(finish).rejects.toThrow();
    await started;
    f.controller.abort();
    let drained = false;
    const close = f.writer.close().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    await access(join(root, 'packed/0/partitions/0/payload'));
    release();
    await rejected;
    await close;
    expect(drained).toBe(true);
    await expect(access(join(root, 'packed/0'))).rejects.toThrow();
    await expect(f.writer.flush()).rejects.toThrow();
  });
});

it.each(['index', 'artifact', 'spool', 'source'] as const)(
  'rejects %s boundary before uploading or moving the rejected producer',
  async (boundary) => {
    await withReplayDirectory(async (root) => {
      const artifacts =
        boundary === 'artifact'
          ? Array.from({ length: 30 }, (_, index) => ({
              id: index + 1,
              name: `league-existing-${index}`,
              digest: 'sha256:' + 'c'.repeat(64),
              bytes: 128,
            }))
          : [];
      const f = await fixture(root, artifacts);
      try {
        if (boundary === 'index')
          vi.mocked(transport.packedIndex).mockReturnValue({
            padding: 'x'.repeat(65536),
          } as unknown as ReturnType<typeof transport.packedIndex>);
        const item = await f.append(
          0,
          boundary === 'spool' ? 192 * 1024 ** 2 : 1,
          boundary === 'source' ? new Error('Source identity mismatch') : undefined,
        );
        if (boundary === 'artifact') {
          await item.pending;
          await expect(f.writer.finish()).rejects.toThrow(/quota/);
          await expect(access(join(root, 'packed/0'))).rejects.toThrow();
        } else if (boundary === 'index') {
          expect(await item.pending).toBe(false);
          await access(join(item.directory, 'payload'));
        } else {
          await expect(item.pending).rejects.toThrow(
            boundary === 'spool' ? /spool disk envelope/ : /Source identity/,
          );
          await access(join(item.directory, 'payload'));
        }
        expect(uploads.uploadPipelineArtifact).not.toHaveBeenCalled();
        expect(f.artifacts).toHaveLength(boundary === 'artifact' ? 30 : 0);
      } finally {
        await f.writer.close();
      }
    });
  },
);

it('rejects an eleventh partition without consuming its producer', async () => {
  await withReplayDirectory(async (root) => {
    const f = await fixture(root);
    try {
      for (let partition = 0; partition < 10; partition++)
        await (
          await f.append(partition)
        ).pending;
      const excess = await f.append(10);
      await expect(excess.pending).rejects.toThrow(/partition quota/);
      await access(join(excess.directory, 'payload'));
      expect(uploads.uploadPipelineArtifact).toHaveBeenCalledTimes(5);
      expect(transport.packedProducerDescriptor).toHaveBeenCalledTimes(10);
    } finally {
      await f.writer.close();
    }
  });
});

it('deadline upload failures remain terminal and close cancels pending deadlines', async () => {
  await withReplayDirectory(async (root) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const failure = new Error('deadline upload failed');
    vi.mocked(uploads.uploadPipelineArtifact).mockRejectedValueOnce(failure);
    const f = await fixture(root);
    await (
      await f.append(0)
    ).pending;
    await vi.advanceTimersByTimeAsync(5000);
    await expect(f.writer.finish()).rejects.toBe(failure);
    await f.writer.close();
    await expect(access(join(root, 'packed/0'))).rejects.toThrow();
    const cancelled = await fixture(join(root, 'cancelled'));
    await mkdir(join(root, 'cancelled'), { recursive: true });
    await (
      await cancelled.append(0)
    ).pending;
    await cancelled.writer.close();
    await vi.advanceTimersByTimeAsync(10000);
    expect(uploads.uploadPipelineArtifact).toHaveBeenCalledTimes(1);
    expect(cancelled.artifacts).toEqual([]);
    await expect(access(join(root, 'cancelled/packed/0'))).rejects.toThrow();
  });
});

it('only capacity-class index failures select fallback; malformed index failures remain terminal', async () => {
  await withReplayDirectory(async (root) => {
    const f = await fixture(root);
    try {
      await (
        await f.append(0)
      ).pending;
      vi.mocked(transport.packedIndex).mockImplementationOnce(() => {
        throw new transport.PackedCapacityError('index control capacity');
      });
      const fallback = await f.append(1);
      expect(await fallback.pending).toBe(false);
      expect(uploads.uploadPipelineArtifact).toHaveBeenCalledTimes(1);
      await access(join(fallback.directory, 'payload'));
      const malformed = new Error('Packed partition/path coverage mismatch');
      vi.mocked(transport.packedIndex).mockImplementationOnce(() => {
        throw malformed;
      });
      const rejected = await f.append(2);
      await expect(rejected.pending).rejects.toBe(malformed);
      await access(join(rejected.directory, 'payload'));
      await expect(f.writer.finish()).rejects.toBe(malformed);
      expect(uploads.uploadPipelineArtifact).toHaveBeenCalledTimes(1);
    } finally {
      await f.writer.close();
    }
  });
});

it.each(['source', 'run', 'attempt', 'runner'] as const)(
  'refuses foreign %s before descriptor work or producer movement',
  async (field) => {
    await withReplayDirectory(async (root) => {
      const f = await fixture(root);
      const directory = join(root, 'foreign');
      await mkdir(directory);
      await writeFile(join(directory, 'payload'), 'unchanged');
      const foreign = {
        identity: {
          ...identity,
          source:
            field === 'source' ? { ...identity.source, sha: 'a'.repeat(40) } : identity.source,
          runId: field === 'run' ? 124 : 123,
          runAttempt: field === 'attempt' ? 2 : 1,
        },
        runner: field === 'runner' ? 1 : 0,
      } as Awaited<ReturnType<typeof sealLeagueProducer>>;
      try {
        await expect(f.writer.append(directory, foreign)).rejects.toThrow();
        expect(transport.packedProducerDescriptor).not.toHaveBeenCalled();
        expect(uploads.uploadPipelineArtifact).not.toHaveBeenCalled();
        expect(await readFile(join(directory, 'payload'), 'utf8')).toBe('unchanged');
        expect(f.artifacts).toEqual([]);
      } finally {
        await f.writer.close();
      }
    });
  },
);
