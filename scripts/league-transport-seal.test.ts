import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { withReplayDirectory } from '@fantasy/api/testing';
import * as artifacts from '@fantasy/api/artifacts';
import * as tooling from '@fantasy/api/tooling';
import { canonicalJson } from '@fantasy/domain/spatial';
import * as encoder from './league-calibration-upload.ts';
import { artifactZipEntries, realArtifactZip } from './test-support/league-zip.ts';
import { extractLeagueArchive } from './league-archive.ts';
import {
  sealOffModeTransport,
  readOffModeTransportSeal,
  requirePrecomputeTransportOutput,
  closeOffModeTransportSeal,
  type TransportSeal,
} from './league-transport-seal.ts';

vi.mock('@fantasy/api/tooling', async (original) => ({
  ...(await original<typeof import('@fantasy/api/tooling')>()),
  executionSource: () => ({
    sha: 'a'.repeat(40),
    node: process.versions.node,
    platform: 'linux',
    arch: 'x64',
  }),
}));
const held: TransportSeal[] = [];
afterEach(() => {
  for (const value of held.splice(0)) closeOffModeTransportSeal(value);
  vi.restoreAllMocks();
});
async function ownedSeal(root: string, request: unknown) {
  const witness = await sealOffModeTransport(root, request);
  held.push(witness);
  return witness;
}
const hash = (letter: string) => 'sha256:' + letter.repeat(64);
it.skipIf(process.platform !== 'linux')(
  'rejects a FIFO in the shared bounded reader without waiting for a writer',
  async () => {
    await withReplayDirectory(async (root) => {
      const fifo = join(root, 'fifo');
      execFileSync('mkfifo', [fifo]);
      await expect(artifacts.readBoundedFile(fifo, 1024)).rejects.toThrow('type limit');
    });
  },
);
async function fixture(root: string) {
  const key = 'packs/' + 'c'.repeat(64) + '.bin';
  await mkdir(join(root, 'public/packs'), { recursive: true });
  const path = join(root, 'public', key),
    payload = Buffer.from('AAAA');
  await writeFile(path, payload);
  const result = Buffer.from('{}');
  await writeFile(join(root, 'result.json'), result);
  const identity = {
    source: { sha: 'a'.repeat(40), node: process.versions.node, platform: 'linux', arch: 'x64' },
    runId: 123,
    runAttempt: 1,
    validatorDigest: hash('b'),
  };
  const proof = {
    schemaVersion: 1,
    identity,
    runner: 0,
    partition: 0,
    partitionId: hash('d'),
    planId: hash('e'),
    inputHash: hash('f'),
    resultHash: artifacts.sha256(result),
    setHash: hash('1'),
    files: [{ key, bytes: payload.length, checksum: artifacts.sha256(payload) }],
  };
  const proofBytes = Buffer.from(canonicalJson(proof));
  await writeFile(join(root, 'proof.json'), proofBytes);
  return {
    path,
    payload,
    proof,
    request: {
      identity,
      planId: proof.planId,
      inputHash: proof.inputHash,
      proofHash: artifacts.sha256(proofBytes),
      runner: 0,
      partition: 0,
      compressionLevel: 0,
    },
  };
}
it('seals actual SDK bytes and copies the immutable snapshot without enabling execution', async () => {
  await withReplayDirectory(async (root) => {
    const { request, path } = await fixture(root);
    const witness = await ownedSeal(root, request);
    const report = readOffModeTransportSeal(witness, request);
    expect(report).toMatchObject({
      mode: 'off',
      executionEnabled: false,
      stage: 'postcompute-measured',
    });
    expect(artifacts.sha256(report.zip)).toBe(witness.digest);
    const extracted = join(root, 'after-seal');
    expect(
      await extractLeagueArchive(report.zip, extracted, () => true, false, 'store-files-v1'),
    ).toMatchObject({ files: 3 });
    await writeFile(path, 'BBBB');
    report.zip.fill(0);
    const next = readOffModeTransportSeal(witness, request);
    expect(artifacts.sha256(next.zip)).toBe(witness.digest);
    expect(
      await readFile(join(extracted, 'public', 'packs/' + 'c'.repeat(64) + '.bin'), 'utf8'),
    ).toBe('AAAA');
    expect(() => readOffModeTransportSeal(JSON.parse(JSON.stringify(witness)), request)).toThrow(
      'process-local',
    );
  });
});
it.each(['planId', 'inputHash', 'proofHash'] as const)(
  'rejects a substituted %s anchor',
  async (field) => {
    await withReplayDirectory(async (root) => {
      const { request } = await fixture(root);
      await expect(sealOffModeTransport(root, { ...request, [field]: hash('9') })).rejects.toThrow(
        'binding',
      );
    });
  },
);
it.each(['runner', 'partition'] as const)('rejects a substituted %s assignment', async (field) => {
  await withReplayDirectory(async (root) => {
    const { request } = await fixture(root);
    await expect(sealOffModeTransport(root, { ...request, [field]: 1 })).rejects.toThrow('binding');
  });
});
it('cannot reuse a genuine witness under a changed source or request', async () => {
  await withReplayDirectory(async (root) => {
    const { request } = await fixture(root);
    const witness = await ownedSeal(root, request);
    expect(() => readOffModeTransportSeal(witness, { ...request, proofHash: hash('9') })).toThrow(
      'binding',
    );
    vi.spyOn(tooling, 'executionSource').mockReturnValue({
      ...request.identity.source,
      platform: 'linux',
      arch: 'x64',
      sha: '9'.repeat(40),
    });
    expect(() => readOffModeTransportSeal(witness, request)).toThrow('source');
  });
});
it.each(['source', 'runAttempt', 'validatorDigest'] as const)(
  'rejects a substituted identity %s',
  async (field) => {
    await withReplayDirectory(async (root) => {
      const { request } = await fixture(root);
      const identity = structuredClone(request.identity);
      if (field === 'source') identity.source.sha = '9'.repeat(40);
      else if (field === 'runAttempt') identity.runAttempt = 2;
      else identity.validatorDigest = hash('9');
      await expect(sealOffModeTransport(root, { ...request, identity })).rejects.toThrow(
        /source|binding/,
      );
    });
  },
);
it.each([
  'extra',
  'empty-directory',
  'missing',
  'same-size',
  'long-name',
  'leaf-link',
  'parent-link',
] as const)('rejects %s source inventory', async (change) => {
  await withReplayDirectory(async (root) => {
    const { request, path } = await fixture(root);
    if (change === 'extra') await writeFile(join(root, 'extra.json'), '{}');
    else if (change === 'empty-directory') await mkdir(join(root, 'extra'));
    else if (change === 'missing') await rm(path);
    else if (change === 'same-size') await writeFile(path, 'BBBB');
    else if (change === 'long-name') {
      const directory = join(root, 'x'.repeat(120));
      await mkdir(directory);
      await writeFile(join(directory, 'x'.repeat(140)), 'x');
    } else if (change === 'leaf-link') {
      await rm(path);
      await symlink(join(root, 'result.json'), path);
    } else {
      await rename(join(root, 'public'), join(root, 'relocated'));
      await symlink(join(root, 'relocated'), join(root, 'public'));
    }
    await expect(sealOffModeTransport(root, request)).rejects.toThrow();
  });
});
it('rejects unsupported declared compression before invoking the encoder', async () => {
  await withReplayDirectory(async (root) => {
    const { request } = await fixture(root);
    const factory = vi.spyOn(encoder, 'calibrationArchiveStream');
    await expect(sealOffModeTransport(root, { ...request, compressionLevel: 1 })).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
});
it('rejects actual SDK compressed bytes despite a STORE declaration', async () => {
  await withReplayDirectory(async (root) => {
    const { request, path } = await fixture(root);
    const bytes = await realArtifactZip(
      [path, join(root, 'proof.json'), join(root, 'result.json')],
      root,
      1,
    );
    vi.spyOn(encoder, 'calibrationArchiveStream').mockResolvedValue(Readable.from([bytes]));
    await expect(sealOffModeTransport(root, request)).rejects.toThrow('STORE');
  });
});
it.each([false, true])(
  'rejects encoding-time same-size mutation, restored ABA=%s',
  async (restore) => {
    await withReplayDirectory(async (root) => {
      const { request, path, payload } = await fixture(root);
      const metadata = await stat(path),
        original = encoder.calibrationArchiveStream;
      vi.spyOn(encoder, 'calibrationArchiveStream').mockImplementation(async (files, directory) => {
        await writeFile(path, 'BBBB');
        const stream = await original(files, directory);
        return Readable.from(
          (async function* () {
            for await (const chunk of stream) yield chunk;
            if (restore) {
              await writeFile(path, payload);
              await utimes(path, metadata.atime, metadata.mtime);
            }
          })(),
        );
      });
      await expect(sealOffModeTransport(root, request)).rejects.toThrow(/changed/);
    });
  },
);
it('rejects a format-defining encoder file mismatch instead of trusting a version label', async () => {
  await withReplayDirectory(async (root) => {
    const { request } = await fixture(root);
    const original = artifacts.readBoundedFile;
    vi.spyOn(artifacts, 'readBoundedFile').mockImplementation(async (path, ...args) =>
      path.endsWith('/internal/upload/zip.js')
        ? Buffer.from('changed encoder')
        : original(path, ...args),
    );
    await expect(sealOffModeTransport(root, request)).rejects.toThrow('provenance mismatch');
  });
});
it('verifies ZIP payload independently even if a private snapshot is corrupted', async () => {
  await withReplayDirectory(async (root) => {
    const { request } = await fixture(root),
      original = encoder.calibrationArchiveStream;
    vi.spyOn(encoder, 'calibrationArchiveStream').mockImplementation(async (files, directory) => {
      const file = files.find((path) => path.endsWith('.bin'))!;
      await chmod(file, 0o600);
      await writeFile(file, 'BBBB');
      return original(files, directory);
    });
    await expect(sealOffModeTransport(root, request)).rejects.toThrow('ZIP contents changed');
  });
});
it('reserves one active/retained seal and invalidates the witness on explicit release', async () => {
  await withReplayDirectory(async (root) => {
    const { request } = await fixture(root),
      original = encoder.calibrationArchiveStream;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(encoder, 'calibrationArchiveStream').mockImplementation(async (files, directory) => {
      entered();
      await barrier;
      return original(files, directory);
    });
    const pending = ownedSeal(root, request);
    await Promise.race([started, pending]);
    try {
      await expect(sealOffModeTransport(root, request)).rejects.toThrow('slot reserved');
    } finally {
      release();
    }
    const witness = await pending;
    await expect(sealOffModeTransport(root, request)).rejects.toThrow('slot reserved');
    closeOffModeTransportSeal(witness);
    held.pop();
    expect(() => readOffModeTransportSeal(witness, request)).toThrow('process-local');
    expect(() => closeOffModeTransportSeal(witness)).toThrow('process-local');
    await ownedSeal(root, request);
  });
});
it.each(['before', 'during'] as const)(
  'cancels %s encoding without abandoning an SDK stream or retaining a witness',
  async (phase) => {
    await withReplayDirectory(async (root) => {
      const { request } = await fixture(root),
        controller = new AbortController();
      let drained = false;
      const original = encoder.calibrationArchiveStream;
      const factory = vi
        .spyOn(encoder, 'calibrationArchiveStream')
        .mockImplementation(async (files, directory) => {
          const stream = await original(files, directory);
          return Readable.from(
            (async function* () {
              for await (const chunk of stream) {
                yield chunk;
                controller.abort();
              }
              drained = true;
            })(),
          );
        });
      if (phase === 'before') controller.abort();
      await expect(sealOffModeTransport(root, request, controller.signal)).rejects.toThrow();
      if (phase === 'before') expect(factory).not.toHaveBeenCalled();
      else expect(drained).toBe(true);
      factory.mockRestore();
      await ownedSeal(root, request);
    });
  },
);
it('refuses authentic measured evidence as a deterministic precompute output bound', async () => {
  await withReplayDirectory(async (root) => {
    const { request } = await fixture(root);
    const witness = await ownedSeal(root, request);
    const model = {
      schemaVersion: 2,
      mode: 'off',
      sourceSha: request.identity.source.sha,
      planId: request.planId,
      inputs: [
        {
          partition: 0,
          inputHash: request.inputHash,
          output: {
            kind: 'deterministic-next-fit-v1',
            sourceSha: request.identity.source.sha,
            inputHash: request.inputHash,
            proofHash: request.proofHash,
            controlBytesUpper: 1024,
            totalFileBytesUpper: 4096,
            maxFileBytesUpper: 1024,
            fileCountUpper: 3,
          },
        },
      ],
      assignments: [{ runner: 0, partitions: [0] }],
    };
    expect(() => requirePrecomputeTransportOutput(model, witness)).toThrow(
      'future output upper bound',
    );
    expect(() =>
      requirePrecomputeTransportOutput({ ...model, sourceSha: '9'.repeat(40) }, witness),
    ).toThrow();
    expect(() => requirePrecomputeTransportOutput(model, { ...witness })).toThrow('process-local');
  });
});
it.each(['descriptor', 'hidden', 'extra'])(
  'rejects %s ZIP discrepancy with the shared strict parser',
  async (change) => {
    await withReplayDirectory(async (root) => {
      const { request, path } = await fixture(root);
      let bytes = await realArtifactZip(
        [path, join(root, 'proof.json'), join(root, 'result.json')],
        root,
      );
      if (change === 'descriptor') {
        const descriptor = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
        expect(descriptor).toBeGreaterThan(0);
        bytes[descriptor + 4] = bytes[descriptor + 4]! ^ 1;
      } else if (change === 'hidden') {
        bytes = Buffer.concat([Buffer.from('hidden'), bytes]);
      } else {
        const entries = [
          { name: 'public/packs/' + 'c'.repeat(64) + '.bin', payload: Buffer.from('AAAA') },
          { name: 'proof.json', payload: await readFile(join(root, 'proof.json')) },
          { name: 'result.json', payload: await readFile(join(root, 'result.json')) },
          { name: 'extra', payload: Buffer.from('x') },
        ];
        bytes = artifactZipEntries(entries);
      }
      vi.spyOn(encoder, 'calibrationArchiveStream').mockResolvedValue(Readable.from([bytes]));
      await expect(sealOffModeTransport(root, request)).rejects.toThrow();
    });
  },
);
