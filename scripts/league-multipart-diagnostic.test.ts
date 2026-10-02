import { afterEach, expect, it, vi } from 'vite-plus/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { sha256 } from '@fantasy/api/artifacts';
import * as tooling from '@fantasy/api/tooling';
import {
  preparedPipeline,
  sealedTwoPartitionFixture,
} from '../apps/cli/test-support/league-pipeline.ts';
import { publicationLeagueSource } from '../apps/cli/test-support/leagues.ts';
import { cloudInput } from '../apps/cli/src/league/league-cloud-files.ts';
import * as runtime from './league-runtime.ts';
import {
  multipartDiagnosticInventory,
  multipartDiagnosticReservation,
  roundtripMultipartDiagnostic,
  roundtripMultipartServiceDiagnostic,
} from './league-multipart-diagnostic.ts';
import type { LocalSegmentSink } from './league-sealed-zip-diagnostic.ts';

vi.mock('@fantasy/api/tooling', async (original) => ({
  ...(await original<typeof import('@fantasy/api/tooling')>()),
  executionSource: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
it('restores two real sealed producers across file/partition boundaries while retaining exactly two full replay validations', async () => {
  await withReplayDirectory(async (root) => {
    const measured = new tooling.Measurements();
    const identity = {
      source: publicationLeagueSource,
      runId: 789,
      runAttempt: 2,
      validatorDigest: 'sha256:' + 'b'.repeat(64),
    };
    const fixture = await measured.run(() =>
      sealedTwoPartitionFixture(root, identity.source, identity),
    );
    expect(fixture.executionId).toBe('league-789-2');
    expect(
      fixture.sealed.every(
        (value) => value.proof.identity.runId === 789 && value.proof.identity.runAttempt === 2,
      ),
    ).toBe(true);
    const validations = measured.report().validation;
    expect(validations.uniqueReplays).toBeGreaterThan(0);
    expect(
      Object.values(validations.replays).every(
        (value) => value.calls === 2 && value.failures === 0,
      ),
    ).toBe(true);
    vi.mocked(tooling.executionSource).mockReturnValue(fixture.identity.source);
    // This test isolates orchestration. Runtime closure is exercised independently by runtime-read tests;
    // the local committed-source diagnostic separately uses the actual installed dependency graph.
    const distribution = join(root, 'runtime');
    await mkdir(distribution);
    const manifest = Buffer.from('orchestration-only runtime fixture');
    await writeFile(join(distribution, 'runtime.json'), manifest);
    const verify = vi.spyOn(runtime, 'verifyLeagueRuntime').mockResolvedValue({
      sourceSha: fixture.identity.source.sha,
      files: 0,
      bytes: 0,
      manifestHash: sha256(manifest),
      archiveHash: sha256(manifest),
      scope: 'local-dependency-snapshot',
      authenticatedMainCI: false,
    });
    const partitions = await Promise.all(
      fixture.sealed.map(async (value) => ({
        root: value.root,
        input: await cloudInput(fixture.preparedRoot, fixture.prepared, value.proof.partition),
      })),
    );
    const sink: LocalSegmentSink = async (stream, expected) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > expected.bytes) throw new Error('local sink grew');
        chunks.push(Buffer.from(chunk));
      }
      const zip = Buffer.concat(chunks, bytes);
      return { ...expected, bytes, digest: sha256(zip), zip };
    };
    const reservation = multipartDiagnosticReservation();
    const result = await measured.run(() =>
      roundtripMultipartDiagnostic({
        identity: fixture.identity,
        runner: 0,
        runners: 1,
        partitions,
        distribution,
        sink,
        reservation,
      }),
    );
    expect(measured.report().validation).toEqual(validations);
    expect(result).toMatchObject({
      mode: 'off',
      executionEnabled: false,
      schemaVersion: 3,
      runtime: { authenticatedMainCI: false },
      transport: { serviceRequests: 0, allocationAttempts: 1 },
    });
    expect(result.verified.map((value) => value.proof)).toEqual(
      fixture.sealed.map((value) => value.proof),
    );
    expect(result.reservation.reservedRefs).toBe(1);
    expect(verify).toHaveBeenCalledTimes(2);
    const service = await measured.run(() =>
      roundtripMultipartServiceDiagnostic({
        identity: fixture.identity,
        runner: 0,
        runners: 1,
        partitions,
        distribution,
        reservation: multipartDiagnosticReservation(),
        serviceExecutor: async (path, receipt) => {
          const zip = await readFile(path);
          return {
            terminated: true,
            artifact: { id: 987, name: receipt.name, bytes: zip.length, digest: sha256(zip) },
            zip,
          };
        },
      }),
    );
    expect(service.executionEnabled).toBe(false);
    expect(service.transport).toMatchObject({
      serviceCompatibility: 'executor-reported-unattested',
      publicSdkUploadCompatibility: 'unmeasured',
    });
    expect(measured.report().validation).toEqual(validations);
    await expect(
      multipartDiagnosticInventory([...partitions, partitions[0]!], fixture.identity, 0, 1),
    ).rejects.toThrow('duplicate');
    await expect(
      multipartDiagnosticInventory(partitions.slice(1), fixture.identity, 0, 1),
    ).rejects.toThrow('assigned partition');
    await expect(
      multipartDiagnosticInventory(partitions, { ...fixture.identity, runAttempt: 3 }, 0, 1),
    ).rejects.toThrow('identity');
    const alteredSink: LocalSegmentSink = async (stream, expected) => {
      const reply = await sink(stream, expected);
      reply.zip[reply.zip.length - 1] = reply.zip[reply.zip.length - 1]! ^ 1;
      return reply;
    };
    await expect(
      roundtripMultipartDiagnostic({
        identity: fixture.identity,
        runner: 0,
        runners: 1,
        partitions,
        distribution,
        sink: alteredSink,
        reservation,
        allocationAttempt: 1,
      }),
    ).rejects.toThrow('received ZIP');
    expect(reservation.snapshot().reservedRefs).toBe(2);
    await expect(
      roundtripMultipartDiagnostic({
        identity: fixture.identity,
        runner: 0,
        runners: 1,
        partitions,
        distribution,
        sink,
        reservation,
      }),
    ).rejects.toThrow('reused');
    expect(reservation.snapshot().reservedRefs).toBe(2);
  });
}, 60000);

it('rejects foreign fixture source and live cancellation before any prepared work', async () => {
  await withReplayDirectory(async (root) => {
    const identity = {
      source: { ...publicationLeagueSource, sha: 'f'.repeat(40) },
      runId: 789,
      runAttempt: 2,
      validatorDigest: 'sha256:' + 'b'.repeat(64),
    };
    await expect(preparedPipeline(root, 2, publicationLeagueSource, identity)).rejects.toThrow(
      'source/identity mismatch',
    );
    const controller = new AbortController();
    controller.abort(new Error('live cancel'));
    await expect(
      sealedTwoPartitionFixture(root, publicationLeagueSource, undefined, controller.signal),
    ).rejects.toThrow('live cancel');
    await expect(
      roundtripMultipartServiceDiagnostic({
        partitions: [],
        identity,
        runner: 0,
        runners: 1,
        distribution: 'unused',
        reservation: multipartDiagnosticReservation(),
        signal: controller.signal,
        serviceExecutor: async () => {
          throw new Error('must not execute');
        },
      }),
    ).rejects.toThrow('live cancel');
  });
});
