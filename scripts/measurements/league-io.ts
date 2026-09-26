import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative, resolve } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import type { BundleReceipt, LeagueDefinition } from '@fantasy/domain/spatial';

type BundleMethod = 'verify' | 'importRecorded' | 'importConfirmed';
type FileMetric = { reads: number; readBytes: number; writes: number; writeBytes: number };
interface Stage {
  phase: string;
  wallMs: number;
  local: {
    readBytes: number;
    writeBytes: number;
    recordingReadBytes: number;
    recordingWriteBytes: number;
    files: Record<string, FileMetric>;
  };
  remote: Record<
    | 'get'
    | 'head'
    | 'list'
    | 'put'
    | 'delete'
    | 'readBytes'
    | 'writeBytes'
    | 'recordingReadBytes'
    | 'recordingWriteBytes',
    number
  >;
  worker: { get: number; readBytes: number; recordingReadBytes: number };
  bundles: Record<BundleMethod, { calls: number; receiptBytes: number; inclusiveMs: number }>;
  rssSampledPeakBytes: number;
  status?: 'passed' | 'rejected';
  error?: string;
  result?: unknown;
}
interface Case {
  name: string;
  description: string;
  stages: Stage[];
  skipped?: string[];
  artifacts?: unknown;
  rejectedBefore?: string[];
  cleanedPartialRestore?: boolean;
  remotePointerUnchanged?: boolean;
}

// Observation only: preserve original operations, arguments, results and exceptions.
// Coordinator FileHandle reads/writes are exact API bytes; Worker I/O and streams are excluded.
const raw = { open: fs.open, readFile: fs.readFile, writeFile: fs.writeFile };
let active: Stage | undefined;
const root = resolve('.generated/io-investigation/data');
function local(direction: 'read' | 'write', path: unknown, bytes: number) {
  if (!active || typeof path !== 'string' || !resolve(path).startsWith(root + '/')) return;
  const byteKey = direction === 'read' ? 'readBytes' : 'writeBytes';
  active.local[byteKey] += bytes;
  const key = relative(root, resolve(path));
  const item = (active.local.files[key] ??= { reads: 0, readBytes: 0, writes: 0, writeBytes: 0 });
  item[direction === 'read' ? 'reads' : 'writes']++;
  item[byteKey] += bytes;
  if (/\/(?:objects|\.bundle-staging-[^/]+)\//.test('/' + key))
    active.local[direction === 'read' ? 'recordingReadBytes' : 'recordingWriteBytes'] += bytes;
}
fs.open = async (...args: Parameters<typeof fs.open>) => {
  const handle = await raw.open(...args);
  const read = handle.read.bind(handle),
    writeFile = handle.writeFile.bind(handle);
  handle.read = new Proxy(read, {
    async apply(target, receiver, values) {
      const result: { bytesRead: number } = await Reflect.apply(target, receiver, values);
      local('read', args[0], result.bytesRead);
      return result;
    },
  });
  handle.writeFile = new Proxy(writeFile, {
    async apply(target, receiver, values) {
      const result: unknown = await Reflect.apply(target, receiver, values);
      local('write', args[0], Buffer.byteLength(values[0]));
      return result;
    },
  });
  return handle;
};
fs.readFile = new Proxy(raw.readFile, {
  async apply(target, receiver, values) {
    const result: string | Buffer = await Reflect.apply(target, receiver, values);
    local('read', values[0], Buffer.byteLength(result));
    return result;
  },
});
fs.writeFile = new Proxy(raw.writeFile, {
  async apply(target, receiver, values) {
    const result: unknown = await Reflect.apply(target, receiver, values);
    local('write', values[0], Buffer.byteLength(values[1]));
    return result;
  },
});
syncBuiltinESMExports();

const { BattleBundles } = await import('@fantasy/api/artifacts');
const { leagueFixture } = await import('@fantasy/samples/testing');
const { SUPPORTED_REPLAY_FORMAT } = await import('@fantasy/domain');
const { PUBLICATION_MAX_BYTES, ExecutionSourceSchema } = await import('@fantasy/domain/spatial');
const { prepareCloudLeague, runCloudLeague, finishCloudLeague } =
  await import('../../apps/cli/src/league/league-cloud.ts');
const { probeLeague } = await import('../../apps/cli/src/league/league-probe.ts');
const { restorePublication } =
  await import('../../apps/cli/src/publication/publication-restore.ts');
const { publishPublication } = await import('../../apps/cli/src/publication/publication-remote.ts');
const { localPublicationGraph } =
  await import('../../apps/cli/src/publication/publication-graph.ts');
const { leagueArtifactFiles } = await import('../../apps/cli/src/league/league-artifact-files.ts');
function observeBundle<K extends BundleMethod>(name: K) {
  const original = BattleBundles.prototype[name];
  BattleBundles.prototype[name] = new Proxy(original, {
    async apply(target, receiver, args) {
      const stage = active,
        start = performance.now();
      if (stage) stage.bundles[name].calls++;
      try {
        const result: BundleReceipt = await Reflect.apply(target, receiver, args);
        if (stage) stage.bundles[name].receiptBytes += result.bytes;
        return result;
      } finally {
        if (stage) stage.bundles[name].inclusiveMs += performance.now() - start;
      }
    },
  });
}
for (const name of ['verify', 'importRecorded', 'importConfirmed'] as const) observeBundle(name);
class MeasuredStore {
  readonly objects = new Map<string, { data: Buffer; etag: string }>();
  version = 0;
  constructor(from?: MeasuredStore) {
    if (from)
      for (const [key, value] of from.objects)
        this.objects.set(key, { data: Buffer.from(value.data), etag: value.etag });
  }
  remainingRequests() {
    return 1_000_000;
  }
  note(method: 'get' | 'head' | 'list' | 'put' | 'delete', key: string, bytes = 0) {
    if (!active) return;
    active.remote[method]++;
    if (method === 'get') {
      active.remote.readBytes += bytes;
      if (key.startsWith('objects/')) active.remote.recordingReadBytes += bytes;
    }
    if (method === 'put') {
      active.remote.writeBytes += bytes;
      if (key.startsWith('objects/')) active.remote.recordingWriteBytes += bytes;
    }
  }
  async inventory() {
    this.note('list', '');
    return new Map([...this.objects].map(([key, value]) => [key, value.data.length]));
  }
  async read(key: string, limit: number) {
    const result = this.objects.get(key) ?? null;
    if (result && result.data.length > limit) throw new Error('Observation store read limit');
    this.note('get', key, result?.data.length ?? 0);
    return result;
  }
  async head(key: string) {
    this.note('head', key);
    return this.objects.get(key)?.data.length ?? null;
  }
  async put(key: string, data: Buffer, previous: string | null) {
    const old = this.objects.get(key);
    if (previous === null ? old !== undefined : old?.etag !== previous)
      throw new Error('Conditional conflict');
    this.note('put', key, data.length);
    this.objects.set(key, { data: Buffer.from(data), etag: `fixture-${++this.version}` });
  }
  async remove(key: string) {
    this.note('delete', key);
    this.objects.delete(key);
  }
  async worker(key: string, limit: number) {
    const value = this.objects.get(key);
    if (!value || value.data.length > limit)
      throw new Error('Worker fixture object missing/oversized');
    if (active) {
      active.worker.get++;
      active.worker.readBytes += value.data.length;
      if (key.startsWith('objects/')) active.worker.recordingReadBytes += value.data.length;
    }
    return value.data;
  }
}
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(
  sourceSha,
  'd6213977d0d4e3223000cfd61f9d9128fdf10d5a',
  'Use the recorded measurement source SHA',
);
const source = ExecutionSourceSchema.parse({
  sha: sourceSha,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
});
const env = {
  sourceSha,
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  node: process.version,
  pnpm: '11.27.1',
  platform: process.platform,
  arch: process.arch,
  kernel: os.release(),
  cpu: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length,
  memoryBytes: os.totalmem(),
  concurrency: { publication: 16, workersPerPartition: 2 },
  cache:
    'Fresh local restore and partition directories per case; in-memory remote store; OS page cache not flushed; no remote latency/cache emulation.',
};
assert.equal(env.sourceDirty, '', 'Use a clean source checkout');
const cases: Case[] = [];
const report = {
  schemaVersion: 1,
  kind: 'isolated-league-io-investigation',
  environment: env,
  command:
    'node --import ./apps/cli/node_modules/tsx/dist/loader.mjs .generated/io-investigation/measure.ts',
  scopeNotes: [
    'Application source is unchanged. Existing league fixture and real pipeline functions are used.',
    'S3 and Worker values are measured interface calls/bytes against an isolated in-memory adapter, not actual R2 requests, billing or network latency. Control leases, SDK retries and inventory pagination are excluded.',
    'Filesystem counts cover coordinator promise/FileHandle I/O beneath the isolated fixture root, not Worker thread/SQLite/stream writes. Publication and partition inventories separately capture output bytes.',
    'Bundle method times overlap and must not be added to stage wall time. RSS is sampled every 20 ms for the Node process (includes Workers and in-memory adapter), not a verified per-stage high-water mark.',
    'One repetition per scenario; timing is observation, not performance acceptance. 1 partition in measured scenarios; no cross-partition scaling claim.',
  ],
  cases,
};
let caseRecord: Case = { name: 'unstarted', description: '', stages: [] };
function measure<T>(name: string, fn: () => Promise<T>, expectedFailure?: false): Promise<T>;
function measure(name: string, fn: () => Promise<unknown>, expectedFailure: true): Promise<void>;
async function measure<T>(
  name: string,
  fn: () => Promise<T>,
  expectedFailure = false,
): Promise<T | undefined> {
  const bundleMetric = () => ({ calls: 0, receiptBytes: 0, inclusiveMs: 0 });
  const metric: Stage = {
    phase: name,
    wallMs: 0,
    local: {
      readBytes: 0,
      writeBytes: 0,
      recordingReadBytes: 0,
      recordingWriteBytes: 0,
      files: {},
    },
    remote: {
      get: 0,
      head: 0,
      list: 0,
      put: 0,
      delete: 0,
      readBytes: 0,
      writeBytes: 0,
      recordingReadBytes: 0,
      recordingWriteBytes: 0,
    },
    worker: { get: 0, readBytes: 0, recordingReadBytes: 0 },
    bundles: {
      verify: bundleMetric(),
      importRecorded: bundleMetric(),
      importConfirmed: bundleMetric(),
    },
    rssSampledPeakBytes: process.memoryUsage.rss(),
  };
  caseRecord.stages.push(metric);
  active = metric;
  const start = performance.now();
  const timer = setInterval(() => {
    metric.rssSampledPeakBytes = Math.max(metric.rssSampledPeakBytes, process.memoryUsage.rss());
  }, 20);
  let result: T | undefined;
  let rejected = false;
  try {
    result = await fn();
    metric.status = 'passed';
  } catch (error) {
    rejected = true;
    metric.status = 'rejected';
    metric.error = error instanceof Error ? error.message : 'unknown';
    if (!expectedFailure) throw error;
  } finally {
    clearInterval(timer);
    metric.wallMs = Math.round((performance.now() - start) * 100) / 100;
    metric.rssSampledPeakBytes = Math.max(metric.rssSampledPeakBytes, process.memoryUsage.rss());
    active = undefined;
    for (const m of Object.values(metric.bundles))
      m.inclusiveMs = Math.round(m.inclusiveMs * 100) / 100;
  }
  if (expectedFailure) assert.ok(rejected, 'Expected rejection was not observed');
  metric.result = result;
  console.log(
    JSON.stringify({
      case: caseRecord.name,
      phase: name,
      wallMs: metric.wallMs,
      status: metric.status,
      remote: metric.remote,
      bundleVerifications: metric.bundles.verify.calls,
    }),
  );
  return result;
}
const options = (store: MeasuredStore) => ({
  viewer: async () => ({
    schemaVersion: 1,
    sourceSha,
    publicationSchema: 1,
    replay: SUPPORTED_REPLAY_FORMAT,
  }),
  ancestor: (a: string, b: string) => a === sourceSha && b === sourceSha,
  worker: (key: string, limit: number) => store.worker(key, limit),
  maxTransferBytes: PUBLICATION_MAX_BYTES,
  maxWrites: 100000,
  maxWorkerRequests: 1000,
  concurrency: 16,
});
const inventory = (store: MeasuredStore) => ({
  files: store.objects.size,
  bytes: [...store.objects.values()].reduce((n, x) => n + x.data.length, 0),
  receipts: [...store.objects.keys()].filter((k) => k.endsWith('/receipt.json')).length,
  usedReadRequests: 10000,
  usedWriteRequests: 10000,
});
async function stagePublish(name: string, path: string, store: MeasuredStore) {
  // transferCloudLeague calls a full local graph for its lease estimate, then publishPublication calls it again.
  await measure(name + '-lease-graph', async () => {
    const graph = await localPublicationGraph(path);
    return { files: graph.files.size, bytes: graph.totalBytes, objects: graph.objects.size };
  });
  return measure(name, () => publishPublication(path, store, options(store)));
}
async function startPipeline(
  name: string,
  definition: LeagueDefinition,
  store: MeasuredStore,
  restore: boolean,
) {
  const path = join(root, name);
  await fs.mkdir(path, { recursive: true });
  const pub = join(path, 'public'),
    prep = join(path, 'prepared');
  if (restore)
    await measure('restore', () => restorePublication(pub, store, PUBLICATION_MAX_BYTES, 16));
  const plan = await measure('prepare', () =>
    prepareCloudLeague(definition, source, name, pub, prep, inventory(store)),
  );
  await stagePublish('admit', pub, store);
  return { name, path, pub, prep, plan, store };
}
type Pipeline = Awaited<ReturnType<typeof startPipeline>>;
async function runPartition({ name, path, prep }: Pipeline, index: number) {
  return measure('run-' + index, () =>
    runCloudLeague(
      join(prep, 'inputs', String(index)),
      join(path, 'results', String(index)),
      source,
      name,
    ),
  );
}
async function finishPipeline({ name, path, pub, prep, store }: Pipeline) {
  await measure('finish', () => finishCloudLeague(prep, join(path, 'results'), pub, source, name));
  await stagePublish('publish', pub, store);
}
async function finishSetup(
  name: string,
  definition: LeagueDefinition,
  store: MeasuredStore,
  restore = false,
  missing = false,
) {
  const pipeline = await startPipeline(name, definition, store, restore);
  if (!missing)
    for (let i = 0; i < pipeline.plan.prepared.inputs.length; i++) await runPartition(pipeline, i);
  await finishPipeline(pipeline);
}
async function caseStart(name: string, description: string) {
  caseRecord = { name, description, stages: [] };
  report.cases.push(caseRecord);
}
await fs.mkdir(root, { recursive: false });
const small = await leagueFixture(3, 1),
  large = await leagueFixture(4, 1);
const inputs = {
  small: { characters: 3, battlefields: 1, trials: 2, placements: 2, planned: 12 },
  large: { characters: 4, battlefields: 1, trials: 2, placements: 2, planned: 24 },
  masterSeed: 42,
  ruleset: small.ruleset,
};
await caseStart(
  'setup-complete-baseline',
  '12 real, small fixture battles; setup is recorded separately from comparisons',
);
const baseline = new MeasuredStore();
await finishSetup('baseline', small, baseline);
const baselineInventory = {
  ...inventory(baseline),
  recordingBytes: [...baseline.objects]
    .filter(([k]) => k.startsWith('objects/'))
    .reduce((n, [, v]) => n + v.data.length, 0),
  recordingFiles: [...baseline.objects.keys()].filter((k) => k.startsWith('objects/')).length,
};
await caseStart('unchanged', 'Same definitions/input, complete retained outcomes');
const unchanged = await measure('probe', () =>
  probeLeague(small, sourceSha, (k, l) => baseline.worker(k, l)),
);
assert.equal(unchanged.needed, false);
assert.ok(unchanged.estimate);
assert.equal(unchanged.estimate.compute, 0);
caseRecord.skipped = ['restore', 'prepare', 'admit', 'compute', 'finish', 'publish'];
type Estimate = NonNullable<Awaited<ReturnType<typeof probeLeague>>['estimate']>;
async function updated(
  name: string,
  store: MeasuredStore,
  expect: {
    description: string;
    estimate: Partial<Estimate>;
  },
) {
  await caseStart(name, expect.description);
  const probe = await measure('probe', () =>
    probeLeague(large, sourceSha, (k, l) => store.worker(k, l)),
  );
  assert.equal(probe.needed, true);
  assert.ok(probe.estimate);
  for (const [k, v] of Object.entries(expect.estimate))
    assert.equal(probe.estimate[k as keyof Estimate], v);
  const pipeline = await startPipeline(name, large, store, true);
  const { path, pub, prep, plan } = pipeline;
  // Artifact selection is measured without fabricating control reports or contacting GitHub.
  const baselineGraph = await measure('baseline-artifact-validation', async () => {
    const graph = await localPublicationGraph(pub);
    return { files: graph.files.size, bytes: graph.totalBytes, objects: graph.objects.size };
  });
  type ArtifactSize = { files: number; bytes: number };
  const artifact: {
    baselinePublic: typeof baselineGraph;
    input: ArtifactSize[];
    result: ArtifactSize[];
  } = {
    baselinePublic: baselineGraph,
    input: [],
    result: [],
  };
  for (let i = 0; i < plan.prepared.inputs.length; i++)
    artifact.input.push(
      await measure('input-artifact-' + i, async () => {
        const a = await leagueArtifactFiles(join(prep, 'inputs', String(i)), 'input');
        return { files: a.files.length, bytes: a.bytes };
      }),
    );
  for (let i = 0; i < plan.prepared.inputs.length; i++) {
    await runPartition(pipeline, i);
    artifact.result.push(
      await measure('result-artifact-' + i, async () => {
        const a = await leagueArtifactFiles(join(path, 'results', String(i)), 'result');
        return { files: a.files.length, bytes: a.bytes };
      }),
    );
  }
  await finishPipeline(pipeline);
  caseRecord.artifacts = artifact;
  const after = await probeLeague(large, sourceSha, (k, l) => store.worker(k, l));
  assert.equal(after.needed, false);
  assert.ok(after.estimate);
  assert.equal(after.estimate.reused, 24);
}
await updated('add-character', new MeasuredStore(baseline), {
  description: '3 to 4 characters: 12 reused slots, 12 new slots',
  estimate: { planned: 24, reused: 12, newMatches: 12, retries: 0 },
});
await caseStart(
  'setup-partial-baseline',
  '12 complete retained slots plus 12 reserved attempts whose Worker never returned',
);
const partial = new MeasuredStore(baseline);
await finishSetup('partial-baseline', large, partial, true, true);
await updated('retry-partial', new MeasuredStore(partial), {
  description: 'Retry only 12 missing slots of 24; retain 12 complete outcomes',
  estimate: { planned: 24, reused: 12, newMatches: 0, retries: 12 },
});
const corruptionKey = [...baseline.objects.keys()].find(
  (k) => k.startsWith('objects/') && k.endsWith('.gz'),
)!;
assert.ok(corruptionKey);
for (const fault of ['missing', 'corrupt'] as const) {
  await caseStart(
    'recording-' + fault,
    'Corruption exists only in cloned isolated adapter; restore must reject before prepare or publication',
  );
  const broken = new MeasuredStore(baseline),
    before = broken.objects.get('catalog/current.json')!.data;
  if (fault === 'missing') broken.objects.delete(corruptionKey);
  else {
    const v = broken.objects.get(corruptionKey)!;
    const data = Buffer.from(v.data);
    data[0] = data[0]! ^ 0xff;
    broken.objects.set(corruptionKey, { ...v, data });
  }
  const probe: Awaited<ReturnType<typeof probeLeague>> = await measure(
    'unchanged-probe',
    (): Promise<Awaited<ReturnType<typeof probeLeague>>> =>
      probeLeague(small, sourceSha, (k, l) => broken.worker(k, l)),
  );
  assert.equal(probe.needed, false);
  const changed: Awaited<ReturnType<typeof probeLeague>> = await measure(
    'changed-probe',
    (): Promise<Awaited<ReturnType<typeof probeLeague>>> =>
      probeLeague(large, sourceSha, (k, l) => broken.worker(k, l)),
  );
  assert.equal(changed.needed, true);
  const failedPath = join(root, 'recording-' + fault, 'public');
  await measure(
    'restore',
    () => restorePublication(failedPath, broken, PUBLICATION_MAX_BYTES, 16),
    true,
  );
  assert.equal(
    await fs.stat(failedPath).then(
      () => true,
      () => false,
    ),
    false,
  );
  assert.deepEqual(broken.objects.get('catalog/current.json')!.data, before);
  caseRecord.rejectedBefore = ['prepare', 'admit', 'compute', 'finish', 'publish'];
  caseRecord.cleanedPartialRestore = true;
  caseRecord.remotePointerUnchanged = true;
}
await raw.writeFile(
  '.generated/io-investigation/results.json',
  JSON.stringify(
    {
      ...report,
      inputs,
      baseline: baselineInventory,
      completedAt: new Date().toISOString(),
      processMaxRssKb: process.resourceUsage().maxRSS,
    },
    null,
    2,
  ) + '\n',
);
console.log('Saved .generated/io-investigation/results.json');
