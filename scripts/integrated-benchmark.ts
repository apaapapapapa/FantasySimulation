import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { availableParallelism, arch, cpus, platform, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  actorSeed,
  DEFAULT_BUDGET,
  type Manifest,
  type Revision,
} from '../packages/domain/src/spatial/index.ts';
import { catalogManifest, implementation } from '../packages/engine/src/spatial/index.ts';
import { createBatchPlan, executionSource } from '../apps/api/src/batch-plan.ts';
import { runBatch } from '../apps/api/src/batch-runner.ts';
import { openStore } from '../apps/api/src/store.ts';
import { BattlePool } from '../apps/api/src/worker-pool.ts';
import type { WorkerMetrics } from '../apps/api/src/battle-worker.ts';
import { artifactDirectory, git, sourceIdentity } from './harness/source.ts';
import { assessReport, type Check, type Report } from './harness/report.ts';
import profile from './harness/fixtures/integrated-profile.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const [relative, workersText, countText] = process.argv.slice(2);
const workers = Number(workersText),
  count = Number(countText);
if (
  !relative ||
  ![1, 4].includes(workers) ||
  !Number.isInteger(count) ||
  count < 20 ||
  count > 1000
)
  throw new Error(
    'Usage: node --import tsx ../../scripts/integrated-benchmark.ts .generated/harness/<fresh-run> <1|4 workers> <20..1000 matches>',
  );
const source = executionSource(),
  identity = sourceIdentity(root);
const output = artifactDirectory(root, relative),
  startedAt = new Date().toISOString();
const save = (name: string, value: unknown) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
const environment = {
  cpu: cpus()[0]?.model,
  cores: availableParallelism(),
  ram: totalmem(),
  platform: platform(),
  arch: arch(),
  node: process.version,
  storage: 'container overlay; physical device and IOPS undisclosed',
};
const inputs = await Promise.all(
  profile.cases.map((c) => catalogManifest(c.left, c.right, c.scenario, 6000, profile.seed)),
);
function inputAt(index: number): Manifest {
  const manifest = structuredClone(inputs[index % inputs.length]!);
  manifest.seed = profile.seed + index;
  for (const actor of manifest.participants)
    actor.rngSeed = actorSeed(manifest.seed, actor.rngStream);
  return manifest;
}
const revisions = new Map<string, Revision>();
for (const input of inputs)
  for (const revision of input.revisions)
    revisions.set(`${revision.kind}:${revision.id}:${revision.revision}`, revision);
const plan = await createBatchPlan(
  {
    schemaVersion: 1,
    revisions: [...revisions.values()],
    matches: Array.from({ length: count }, (_, index) => {
      const { seed, participants, ruleset, scenario } = inputAt(index);
      return {
        key: `match-${String(index).padStart(4, '0')}`,
        spec: { seed, participants, ruleset, scenario },
      };
    }),
    budget: DEFAULT_BUDGET,
    estimatedBytesPerMatch: profile.estimatedBytesPerMatch,
    maxOutputBytes: 16 * 1024 ** 3,
    maxWorkBytes: 16 * 1024 ** 3,
  },
  source,
);
save('inputs.json', { profile, source, environment, implementation, plan });
const memory: {
  elapsedMs: number;
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}[] = [];
const epoch = performance.now();
const sample = () => {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  memory.push({ elapsedMs: performance.now() - epoch, rss, heapUsed, external, arrayBuffers });
};
const sampler = setInterval(sample, 100);
sample();
const compute: {
  index: number;
  steps: number;
  outcome: string;
  wallMs: number;
  metrics: WorkerMetrics;
}[] = [];
let batch: Awaited<ReturnType<typeof runBatch>> | undefined;
let cache: Awaited<ReturnType<typeof runBatch>> | undefined;
let batchStart = 0,
  batchEnd = 0,
  failure: string | null = null;
try {
  // Same real Worker and formal record generation, but no compression, database or artifact sink.
  const pool = new BattlePool(workers);
  try {
    for (let offset = 0; offset < 30; offset += workers) {
      await Promise.all(
        Array.from({ length: Math.min(workers, 30 - offset) }, async (_, lane) => {
          const index = offset + lane,
            start = performance.now();
          const result = await pool.run(
            inputAt(index),
            DEFAULT_BUDGET,
            async () => {},
            AbortSignal.timeout(30000),
          );
          compute.push({
            index,
            steps: result.result.steps,
            outcome: result.result.outcome.kind,
            wallMs: performance.now() - start,
            metrics: result.metrics,
          });
        }),
      );
    }
  } finally {
    await pool.close();
  }
  save('compute.json', compute);
  batchStart = performance.now() - epoch;
  batch = await runBatch(plan, join(output, 'batch'), source, { workers });
  batchEnd = performance.now() - epoch;
  save('batch.json', batch);
  // Same immutable plan, verified bundles; cache timing never enters new-compute percentiles.
  cache = await runBatch(plan, join(output, 'batch'), source, { workers });
  save('cache.json', cache);
} catch (error) {
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  clearInterval(sampler);
  sample();
  save('memory.json', memory);
}
const database = join(output, 'batch', '.work', 'database.sqlite');
const store = existsSync(database) ? openStore(database) : null;
let attempts: {
  id: string;
  state: string;
  startedAt: number;
  finishedAt: number | null;
  metrics: (WorkerMetrics & { totalMs: number }) | null;
}[];
try {
  const rows = store?.db
    .prepare(
      'SELECT a.id, a.state, a.started_at AS startedAt, a.finished_at AS finishedAt, m.metrics_json AS metricsJson FROM simulation_attempts a LEFT JOIN attempt_metrics m ON m.attempt_id = a.id ORDER BY a.started_at, a.id',
    )
    .all() as {
    id: string;
    state: string;
    startedAt: number;
    finishedAt: number | null;
    metricsJson: string | null;
  }[];
  attempts = (rows ?? []).map(({ metricsJson, ...row }) => ({
    ...row,
    metrics: metricsJson ? (JSON.parse(metricsJson) as WorkerMetrics & { totalMs: number }) : null,
  }));
} finally {
  store?.close();
}
save('attempts.json', attempts);
const quantiles = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: sorted[Math.floor(sorted.length / 2)] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
  };
};
const definitive = new Set(
  batch?.index.slots.flatMap((s) =>
    s.state === 'complete' && s.receipt ? [s.receipt.attemptId] : [],
  ) ?? [],
);
const warm = attempts.flatMap((a) =>
  a.state === 'completed' && definitive.has(a.id) && a.metrics && !a.metrics.cold
    ? [a.metrics]
    : [],
);
const computeWarm = compute.filter((c) => !c.metrics.cold && ['win', 'draw'].includes(c.outcome));
const batchSamples = memory.filter((s) => s.elapsedMs >= batchStart && s.elapsedMs <= batchEnd);
const secondHalf = batchSamples.filter((s) => s.elapsedMs >= (batchStart + batchEnd) / 2);
const later = secondHalf.filter((s) => s.elapsedMs >= batchStart + (batchEnd - batchStart) * 0.75);
const earlier = secondHalf.filter((s) => s.elapsedMs < batchStart + (batchEnd - batchStart) * 0.75);
const max = (values: number[]) => (values.length ? Math.max(...values) : null);
const earlierRss = max(earlier.map((s) => s.rss)),
  laterRss = max(later.map((s) => s.rss));
const bytes = batch?.index.slots.flatMap((s) => (s.receipt ? [s.receipt.bytes] : [])) ?? [];
const summary = {
  source,
  environment,
  implementation,
  workers,
  count,
  failure,
  batchMs: batch?.elapsedMs ?? null,
  cacheMs: cache?.elapsedMs ?? null,
  newComputations: attempts.length,
  complete: batch?.index.complete ?? false,
  reused: batch?.index.slots.filter((s) => s.reused).length ?? null,
  cold: attempts.filter((a) => a.metrics?.cold),
  warmSavedMs: quantiles(warm.map((m) => m.totalMs)),
  warmComputeMs: quantiles(computeWarm.map((c) => c.metrics.computeMs)),
  computeWithoutSaveWallMs: quantiles(computeWarm.map((c) => c.wallMs)),
  processRssPeak: max(batchSamples.map((s) => s.rss)),
  latterHalfRssGrowth:
    earlierRss === null || laterRss === null ? null : Math.max(0, laterRss - earlierRss),
  workerHeapPeak: max(warm.map((m) => m.heapUsed)),
  workerExternalPeak: max(warm.map((m) => m.external)),
  workerArrayBuffersPeak: max(warm.map((m) => m.arrayBuffers)),
  workerWasmPeak: max(warm.map((m) => m.wasmLinearBytes)),
  artifactBytesPeak: max(bytes),
  artifactBytesTotal: bytes.reduce((n, b) => n + b, 0),
  completedStressMatches:
    batch?.index.slots.filter((s) => s.state === 'complete' && s.receipt!.result.steps === 6000)
      .length ?? 0,
  unmeasured: {
    piscinaQueueMs:
      'Runtime dispatches only available slots; per-task Piscina queue latency is not exposed by this adapter',
    tsVersusWasmCpu: 'Compute contains both TS and WASM; not separately instrumented',
  },
  interpretation:
    'Worker compute excludes backpressure; totalMs includes formal logs, gzip and canonical SQLite/artifact persistence. Batch elapsed also includes bundle verification/export. RSS is sampled every 100ms; heap/external/arrayBuffers/WASM overlap and must not be summed. Cache verification is separate. Smaller counts are profiling only, never a 1000-match pass.',
};
save('summary.json', summary);
const checks: Check[] = [];
const check = (id: string, ok: boolean | null, reason: string) =>
  checks.push({
    id,
    required: true,
    status: ok === null ? 'unknown' : ok ? 'pass' : 'fail',
    reason,
    evidence: [{ uri: `${relative}/summary.json`, sourceSha: source.sha }],
  });
check(
  'integrated:source',
  git(root, ['status', '--porcelain', '--untracked-files=normal']) === '' &&
    git(root, ['rev-parse', 'HEAD']) === source.sha,
  'Clean unchanged source',
);
check(
  'integrated:complete',
  !failure &&
    batch?.index.complete === true &&
    attempts.length === count &&
    attempts.every((a) => a.state === 'completed' && a.metrics !== null) &&
    batch.index.slots.every((s) => !s.reused),
  'Every planned match must execute and finish; no cached/truncated/failed substitutions',
);
check(
  'integrated:cache',
  cache?.index.complete === true && cache.index.slots.every((s) => s.reused),
  'Every repeated immutable input must reuse a verified bundle',
);
check(
  'integrated:full-batch',
  count === 1000
    ? summary.complete && summary.batchMs !== null && summary.batchMs <= 1800000
    : null,
  'Actual 1000 new matches, at most 4 Workers, at most 30 minutes',
);
check(
  'integrated:latency',
  summary.warmSavedMs.median === null || summary.warmSavedMs.p95 === null
    ? null
    : summary.warmSavedMs.median <= 4000 && summary.warmSavedMs.p95 <= 8000,
  'Warm formal logging, compression and persistence median <=4s, p95 <=8s',
);
check(
  'integrated:rss',
  summary.processRssPeak === null ? null : summary.processRssPeak <= 1.5 * 1024 ** 3,
  'Sampled whole-process RSS <=1.5 GiB',
);
check(
  'integrated:heap',
  summary.workerHeapPeak === null ? null : summary.workerHeapPeak <= 128 * 1024 ** 2,
  'Worker JS heap <=128 MiB',
);
check(
  'integrated:growth',
  summary.latterHalfRssGrowth === null ? null : summary.latterHalfRssGrowth <= 64 * 1024 ** 2,
  'Later-half RSS high-water growth <=64 MiB',
);
check(
  'integrated:storage',
  bytes.length === count &&
    summary.artifactBytesPeak !== null &&
    summary.artifactBytesPeak <= 16 * 1024 ** 2 &&
    summary.artifactBytesTotal <= 16 * 1024 ** 3,
  'Compressed artifacts <=16 MiB/match and <=16 GiB total',
);
check(
  'integrated:stress',
  summary.completedStressMatches > 0 &&
    compute.some((c) => c.steps < 6000 && ['win', 'draw'].includes(c.outcome)),
  'Both early outcomes and complete 6000-step inputs were measured',
);
const report: Report = {
  ...identity,
  schemaVersion: 1,
  producer: 'integrated-benchmark',
  startedAt,
  finishedAt: new Date().toISOString(),
  checks,
};
save('report.json', report);
const assessment = assessReport(
  report,
  checks.map((c) => c.id),
);
save('assessment.json', assessment);
console.log(JSON.stringify({ output, summary, assessment }, null, 2));
process.exitCode = assessment.exitCode;
