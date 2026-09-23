import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpus, availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { git } from './source.ts';
import { loadProfile, bytesHash, fixtureHash, type Capture, type Sample } from './load-contract.ts';
import type * as Engine from '../../packages/engine/src/spatial/index.ts';
import type * as Domain from '../../packages/domain/src/spatial/index.ts';
import type { Recipe } from './corpus.ts';

/** One pinned driver executes the target's real exported engine; generation/preparation is outside timing. */
export async function measure(
  root: string,
  expectedSha: string,
  corpusPath: string,
  profilePath: string,
  samples: number,
  runnerId: string,
  verification = false,
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
  const engine = (await import(
    pathToFileURL(join(root, 'packages/engine/src/spatial/index.ts')).href
  )) as typeof Engine;
  const domain = (await import(
    pathToFileURL(join(root, 'packages/domain/src/spatial/index.ts')).href
  )) as typeof Domain;
  const rows: Sample[] = [];
  for (const entry of corpus.entries) {
    const r = entry.recipe;
    const manifest =
      r.kind === 'sample'
        ? await engine.sampleManifest(r.maxSteps)
        : await engine.catalogManifest(r.left, r.right, r.scenario, r.maxSteps, r.seed);
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
  const [root, source, corpus, profile, output, count, runnerId, mode] = process.argv.slice(2);
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
  );
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
}
