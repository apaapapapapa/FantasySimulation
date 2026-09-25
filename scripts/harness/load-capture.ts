import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus, availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { git } from './source.ts';
import {
  loadProfile,
  loadShardCases,
  bytesHash,
  fixtureHash,
  type Capture,
  type Sample,
} from './load-contract.ts';
import type * as Engine from '@fantasy/engine/spatial';
import type * as Domain from '@fantasy/domain/spatial';
import type * as Samples from '@fantasy/samples';
import type { Recipe } from './corpus.ts';

const targetPackages = {
  '@fantasy/engine/spatial': 'engine',
  '@fantasy/domain/spatial': 'domain',
  '@fantasy/samples': 'samples',
} as const;
/** Resolve each target checkout's public export, never the driver's installed workspace. */
export function targetEntry(root: string, entry: keyof typeof targetPackages): string {
  if (!Object.hasOwn(targetPackages, entry)) throw new Error('Unknown load target entry');
  const directory = realpathSync(join(root, 'packages', targetPackages[entry]));
  const resolver = createRequire(join(directory, 'package.json'));
  const resolved = realpathSync(resolver.resolve(entry));
  const sub = relative(directory, resolved);
  if (sub === '..' || sub.startsWith('..' + sep) || resolve(directory, sub) !== resolved)
    throw new Error('Load target export escapes its workspace package');
  return pathToFileURL(resolved).href;
}

/** One pinned driver executes the target's real exported engine; generation/preparation is outside timing. */
export async function measure(
  root: string,
  expectedSha: string,
  corpusPath: string,
  profilePath: string,
  samples: number,
  runnerId: string,
  verification = false,
  shard: number | null = null,
): Promise<Capture> {
  const dirty = Boolean(git(root, ['status', '--porcelain']));
  if (git(root, ['rev-parse', 'HEAD']) !== expectedSha || (dirty && !verification))
    throw new Error('Load target must be the exact clean SHA');
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 5)
    throw new Error('Invalid trial count');
  const corpusBytes = readFileSync(corpusPath),
    profileBytes = readFileSync(profilePath);
  const corpus = JSON.parse(corpusBytes.toString('utf8')) as {
    entries: { id: string; recipe: Recipe; identity: { inputHash: string } }[];
  };
  const profile = loadProfile(JSON.parse(profileBytes.toString('utf8')));
  if (
    Object.keys(profile.limits).sort().join() !==
    corpus.entries
      .map((e) => e.id)
      .sort()
      .join()
  )
    throw new Error('Profile/fixture coverage mismatch');
  const engine = (await import(targetEntry(root, '@fantasy/engine/spatial'))) as typeof Engine;
  const domain = (await import(targetEntry(root, '@fantasy/domain/spatial'))) as typeof Domain;
  // The same driver must measure the immutable pre-separation baseline as well.
  const samplesApi = (
    existsSync(join(root, 'packages/samples/package.json'))
      ? await import(targetEntry(root, '@fantasy/samples'))
      : engine
  ) as typeof Samples;
  const rows: Sample[] = [];
  const selected = shard === null ? Object.keys(profile.limits) : loadShardCases(profile, shard);
  for (const entry of corpus.entries.filter((entry) => selected.includes(entry.id))) {
    const r = entry.recipe;
    const manifest =
      r.kind === 'sample'
        ? await samplesApi.sampleManifest(r.maxSteps)
        : await samplesApi.catalogManifest(r.left, r.right, r.scenario, r.maxSteps, r.seed);
    const prepared = await engine.prepareBattle(manifest);
    const { implementationDigest: _, ...semantic } = prepared.manifest;
    const inputHash = await domain.contentHash(semantic);
    if (inputHash !== entry.identity.inputHash)
      throw new Error(`Target cannot execute pinned input ${entry.id}`);
    for (let trial = -profile.warmups; trial < samples; trial++) {
      const cpu = process.cpuUsage(),
        started = performance.now();
      const run = await engine.runPreparedBattle(prepared);
      const elapsedMs = performance.now() - started,
        used = process.cpuUsage(cpu);
      const { casts, candidates, pathNodes, events, logBytes } = run.result.stats;
      const trajectoryBytes = run.records.reduce(
        (sum, record) => sum + Buffer.byteLength(domain.trajectoryHashLine(record)),
        0,
      );
      if (trial >= 0)
        rows.push({
          id: entry.id,
          inputHash,
          outcome: run.result.outcome.kind,
          costs: {
            steps: run.result.steps,
            casts,
            candidates,
            pathNodes,
            events,
            logBytes,
            trajectoryBytes,
          },
          elapsedMs,
          cpuMicros: used.user + used.system,
          peakRssBytes: process.platform === 'win32' ? null : process.resourceUsage().maxRSS * 1024,
          memoryReason:
            process.platform === 'win32'
              ? 'No verified process high-water RSS measurement on this Windows profile'
              : null,
        });
    }
  }
  const driverRoot = fileURLToPath(new URL('../../', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager: string;
  };
  const installed = JSON.parse(readFileSync(join(root, 'node_modules/.modules.yaml'), 'utf8')) as {
    packageManager: string;
  };
  if (installed.packageManager !== pkg.packageManager)
    throw new Error('Installed package manager differs from pinned toolchain');
  if (process.version !== `v${readFileSync(join(root, '.node-version'), 'utf8').trim()}`)
    throw new Error('Pinned target Node unavailable');
  return {
    schemaVersion: 1,
    sourceState: dirty ? 'working-tree' : 'clean',
    runnerId,
    sourceSha: expectedSha,
    driverSha: git(driverRoot, ['rev-parse', 'HEAD']),
    driverHash: bytesHash(readFileSync(fileURLToPath(import.meta.url))),
    corpusHash: bytesHash(corpusBytes),
    fixtureHash: fixtureHash(corpus),
    profileHash: bytesHash(profileBytes),
    engine: engine.implementation,
    toolchain: {
      node: process.version,
      packageManager: pkg.packageManager,
      lockHash: bytesHash(readFileSync(join(root, 'pnpm-lock.yaml'))),
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      cores: availableParallelism(),
    },
    samples: rows,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, source, corpus, profile, output, count, runnerId, mode, shard] =
    process.argv.slice(2);
  if (!root || !source || !corpus || !profile || !output || !runnerId)
    throw new Error('Missing capture arguments');
  const result = await measure(
    root,
    source,
    corpus,
    profile,
    Number(count),
    runnerId,
    mode === 'verification',
    shard === undefined ? null : Number(shard),
  );
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
}
