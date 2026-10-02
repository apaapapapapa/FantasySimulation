import { chmod, mkdir, mkdtemp, rm, statfs, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '@fantasy/domain/spatial';
import { executionSource, Measurements, measureAsync } from '@fantasy/api/tooling';
import { sha256 } from '@fantasy/api/artifacts';
import { sealedTwoPartitionFixture } from '../apps/cli/test-support/league-pipeline.ts';
import { cloudInput, writeCloudJson } from '../apps/cli/src/league/league-cloud-files.ts';
import { pipelineContext, requiredPipeline } from './league-pipeline-context.ts';
import { PipelineArtifacts, type PipelineArtifact } from './league-pipeline-artifacts.ts';
import { pipelineCi } from './league-pipeline-policy.ts';
import { reserveSegmentServiceTrial } from './league-calibration-history.ts';
import { calibrationArchiveStream } from './league-calibration-upload.ts';
import {
  multipartDiagnosticRuntime,
  roundtripMultipartServiceDiagnostic,
} from './league-multipart-diagnostic.ts';
import { executeSealedSegmentServiceUpload } from './league-segment-service-executor.ts';
import {
  SEGMENT_SERVICE_LIMITS as limits,
  segmentServiceAdmission,
  validateSegmentServiceBudget,
} from './league-segment-service-policy.ts';
import type { SealedSegmentReceipt } from './league-sealed-zip-diagnostic.ts';
import type { TransportReservation } from './league-transport-reservation.ts';

/** Receipts alone are not authority; the caller must obtain ref from authenticated list(). */
export function matchSegmentServiceArtifact(
  refs: PipelineArtifact[],
  expected: { id: number; name: string; bytes: number; digest: string },
) {
  if (refs.length !== 1 || canonicalJson(refs[0]) !== canonicalJson(expected))
    throw new Error('Segment service immutable acknowledgement mismatch');
  return refs[0]!;
}

async function metricsUpload(
  root: string,
  report: unknown,
  receipt: SealedSegmentReceipt,
  ledger: TransportReservation,
  signal: AbortSignal,
) {
  const owned = await mkdtemp(join(root, '.sealed-segment-'));
  try {
    await chmod(owned, 0o700);
    const payload = Buffer.from(JSON.stringify(report));
    if (payload.length > limits.encodedMetricsBytes)
      throw new Error('Service metrics payload bound');
    const input = join(owned, 'phase-measurement.json');
    await writeFile(input, payload, { flag: 'wx', mode: 0o400 });
    const stream = await calibrationArchiveStream([input], owned);
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > limits.encodedMetricsBytes) throw new Error('Service metrics encoded bound');
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      stream.destroy();
    }
    const zip = Buffer.concat(chunks, bytes);
    const path = join(owned, receipt.name);
    await writeFile(path, zip, { flag: 'wx', mode: 0o400 });
    const expected = { ...receipt, bytes, digest: sha256(zip) };
    signal.throwIfAborted();
    ledger.reserve(expected.name, bytes);
    return await executeSealedSegmentServiceUpload(path, expected, signal);
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
}

/** One bounded service diagnostic, never official league/R2/publication acceptance. */
export async function runSegmentServiceDiagnostic() {
  const root = resolve('.generated/league-segment-service');
  const controller = new AbortController(),
    measured = new Measurements();
  const cancel = () => controller.abort(new Error('Service diagnostic cancelled'));
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  const timer = setTimeout(cancel, 29 * 60000);
  const sample = setInterval(() => {
    measured.sample();
    if (process.memoryUsage().rss > limits.processRssBytes) cancel();
  }, 100);
  let stage = 'admission';
  try {
    await mkdir(root); // Existing trial namespace cannot be reused or reset.
    const disk = await statfs(root),
      free = disk.bavail * disk.bsize;
    if (!Number.isSafeInteger(free) || free < limits.minimumFreeDiskBytes)
      throw new Error('Service diagnostic free disk bound');
    const budget = JSON.parse(requiredPipeline('LEAGUE_CALIBRATION_BUDGET')) as unknown;
    const context = await pipelineContext(root, limits.metadataTotalBudget);
    if (process.platform !== 'linux' || context.identity.source.platform !== 'linux')
      throw new Error('Service diagnostic requires Linux identity');
    context.github = new PipelineArtifacts(
      context.token,
      context.identity,
      limits.metadataTotalBudget,
      'league-segment-service.yml',
      controller.signal,
    );
    context.github.reserveOtherMetadata(limits.reservedAdditional);
    validateSegmentServiceBudget(budget, context.identity.source.sha);
    if (context.identity.runAttempt !== 1)
      throw new Error('Service diagnostic accepts primary attempt1 only');
    await pipelineCi(context.github, context.ciRun, 'start');
    await context.github.authenticateRun();
    const history = await reserveSegmentServiceTrial(context.github, context.identity, budget);
    const retained = await context.github.request(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts',
      { run_id: context.identity.runId, per_page: 1 },
    );
    const admission = segmentServiceAdmission({
      runAttempt: context.identity.runAttempt,
      existingArtifacts: retained.total_count,
    });
    // No earlier primary/control allocation may be silently restarted in this one-shot job.
    if (retained.total_count !== 0) throw new Error('Service diagnostic already has an allocation');
    const distribution = resolve('.generated/runtime-distribution');
    const runtime = await multipartDiagnosticRuntime(distribution, context.identity);
    const startedAt = new Date().toISOString(),
      started = performance.now();
    const result = await measured.run(async () => {
      controller.signal.throwIfAborted();
      stage = 'fresh-compute-and-seal';
      const fixture = await measureAsync(stage, () =>
        sealedTwoPartitionFixture(
          join(root, 'fixture'),
          { ...context.identity.source, platform: 'linux' },
          context.identity,
          controller.signal,
        ),
      );
      const validations = measured.report().validation;
      if (
        validations.uniqueReplays !== limits.matches ||
        Object.values(validations.replays).some(
          (value) => value.calls !== 2 || value.failures !== 0,
        ) ||
        fixture.prepared.plan.partitions.length !== limits.partitions
      )
        throw new Error('Service diagnostic fresh validation coverage mismatch');
      const partitions = await Promise.all(
        fixture.sealed.map(async (value) => ({
          root: value.root,
          input: await cloudInput(fixture.preparedRoot, fixture.prepared, value.proof.partition),
        })),
      );
      let authenticatedReceipt: PipelineArtifact | undefined;
      let childMeasurement:
        | {
            childMaxRssKiB: number;
            sampledCombinedRssBytes: number;
            physicalHttpRequests: number;
            physicalHttpRequestLimit: number;
          }
        | undefined;
      stage = 'sealed-version7-roundtrip';
      const diagnostic = await measureAsync(stage, () =>
        roundtripMultipartServiceDiagnostic({
          partitions,
          identity: context.identity,
          runner: 0,
          runners: 1,
          distribution,
          reservation: admission.reservation,
          signal: controller.signal,
          serviceExecutor: async (path, expected) => {
            validateSegmentServiceBudget(budget, context.identity.source.sha);
            if (
              expected.bytes > limits.encodedSegmentBytes ||
              expected.bytes + limits.sdkBufferBytes > limits.queueBytes ||
              process.resourceUsage().maxRSS * 1024 > limits.processRssBytes
            )
              throw new Error('Service upload byte/queue/lifetime RSS bound');
            const upload = await measureAsync('service.sdk.upload', () =>
              executeSealedSegmentServiceUpload(path, expected, controller.signal),
            );
            childMeasurement = {
              childMaxRssKiB: upload.childMaxRssKiB,
              sampledCombinedRssBytes: upload.sampledCombinedRssBytes,
              physicalHttpRequests: upload.physicalHttpRequests,
              physicalHttpRequestLimit: upload.physicalHttpRequestLimit,
            };
            authenticatedReceipt = matchSegmentServiceArtifact(
              await context.github.list(expected.name),
              upload.artifact,
            );
            const zip = await measureAsync('service.authenticated.download', () =>
              context.github.archive(authenticatedReceipt!, limits.encodedSegmentBytes),
            );
            return { ...upload, zip };
          },
        }),
      );
      if (
        !authenticatedReceipt ||
        canonicalJson(measured.report().validation) !== canonicalJson(validations)
      )
        throw new Error('Service receipt/validation identity mismatch');
      stage = 'source-and-runtime-finish';
      await pipelineCi(context.github, context.ciRun, 'finish');
      await context.github.authenticateRun();
      controller.signal.throwIfAborted();
      if (
        canonicalJson(executionSource()) !== canonicalJson(context.identity.source) ||
        (await multipartDiagnosticRuntime(distribution, context.identity)).runtimeHash !==
          runtime.runtimeHash ||
        process.resourceUsage().maxRSS * 1024 > limits.processRssBytes
      )
        throw new Error('Service diagnostic source/runtime/lifetime RSS changed');
      return {
        schemaVersion: 1,
        identity: context.identity,
        ciRun: context.ciRun,
        runtime,
        history,
        limits,
        availableDiskBytes: free,
        authenticatedReceipt,
        childMeasurement,
        startedAt,
        finishedAt: new Date().toISOString(),
        freshComputationToReadbackMs: performance.now() - started,
        serviceCompatibility: 'public-sdk-version7-same-sealed-zip-readback',
        formalAcceptance: false,
        runtimeAuthority:
          'reviewed-required-main-ci-bootstrap-before-fresh-command; not a serialized-receipt or loaded-module attestation',
        producerChecks: diagnostic.verified.map((value) => ({
          partition: value.proof.partition,
          resultHash: value.proof.resultHash,
        })),
        reservationBeforeMetrics: admission.reservation.snapshot(),
        metadata: context.github.metrics(),
        measurement: measured.report(),
        rssScope:
          '100ms sampled parent/child aggregate plus lifetime peaks; not a hard allocation cap',
        timingScope:
          'compute/seal through authenticated readback and final checks; excludes prior queue/setup/bootstrap and following metrics upload',
      };
    });
    stage = 'metrics-upload';
    validateSegmentServiceBudget(budget, context.identity.source.sha);
    controller.signal.throwIfAborted();
    await writeCloudJson(join(root, 'receipt.json'), result);
    const metrics = await metricsUpload(
      root,
      result,
      {
        name: `${context.prefix}-service-metrics.zip`,
        bytes: 1,
        digest: sha256(Buffer.alloc(0)),
        sourceSha: context.identity.source.sha,
        runtimeHash: runtime.runtimeHash,
        allocationAttempt: 0,
      },
      admission.reservation,
      controller.signal,
    );
    matchSegmentServiceArtifact(await context.github.list(metrics.artifact.name), metrics.artifact);
    console.log(
      JSON.stringify({
        segmentServiceDiagnostic: 'completed',
        identity: context.identity,
        receipt: result.authenticatedReceipt,
        metrics: metrics.artifact,
        reservation: admission.reservation.snapshot(),
        metadata: context.github.metrics(),
        formalAcceptance: false,
      }),
    );
  } catch {
    process.exitCode = 1;
    console.error(
      JSON.stringify({
        segmentServiceDiagnostic: 'failed',
        stage,
        formalAcceptance: false,
        allocationOutcome: 'retain all prior/uncertain allocations; no automatic retry',
      }),
    );
  } finally {
    clearTimeout(timer);
    clearInterval(sample);
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runSegmentServiceDiagnostic();
