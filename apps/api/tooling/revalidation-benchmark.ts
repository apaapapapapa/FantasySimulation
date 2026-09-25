import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cpus, availableParallelism, platform } from 'node:os';
import { execFileSync } from 'node:child_process';
import { prepareBattle, runPreparedBattle, implementation } from '@fantasy/engine/spatial';
import { catalogManifest } from '@fantasy/samples';
import { canonicalJson } from '@fantasy/domain/spatial';
import { ReplayWriter } from '../src/replay-writer.ts';
import {
  readReplayManifest,
  verifyReplayDirectory,
  verifyReplayChecksums,
} from '../src/replay-reader.ts';
import { sha256 } from '../src/replay-files.ts';

// Run from the repository root with the API's tsx loader and a fresh output directory.
const root = resolve(process.argv[2] ?? '.generated/revalidation-benchmark');
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--untracked-files=normal'))
  throw new Error('Measurement requires a clean committed source tree');
await mkdir(root, { recursive: true });
const seed = 20260923;
const receipt = {
  source: git('rev-parse', 'HEAD'),
  tree: git('rev-parse', 'HEAD^{tree}'),
  implementation,
  node: process.version,
  platform: platform(),
  cpu: cpus()[0]?.model,
  cores: availableParallelism(),
  storage: 'record the physical device separately; this command cannot identify it',
  seed,
  startedAt: new Date().toISOString(),
  cases: [] as Awaited<ReturnType<typeof measure>>[],
};
async function measure(left: string, right: string, scenario: string, maxSteps: number) {
  const battle = await prepareBattle(await catalogManifest(left, right, scenario, maxSteps, seed));
  const output = await runPreparedBattle(battle);
  const id = 'measure-' + maxSteps,
    writer = await ReplayWriter.create(root, {
      id,
      attemptId: 'attempt-' + maxSteps,
      simulationHash: battle.simulationHash,
      input: battle.manifest,
    });
  for (const record of output.records) await writer.append(record);
  const saved = await writer.finish(
    { kind: 'result', result: output.result },
    'result-' + maxSteps,
  );
  const checksum = sha256(canonicalJson(saved)),
    directory = join(root, id);
  const measurement = {
    left,
    right,
    scenario,
    maxSteps,
    steps: output.result.steps,
    records: saved.records,
    bytes:
      Buffer.byteLength(canonicalJson(saved)) +
      [...saved.chunks, ...saved.checkpoints].reduce((n, r) => n + r.bytes, 0),
    rawBytes: [...saved.chunks, ...saved.checkpoints].reduce((n, r) => n + r.rawBytes, 0),
    fullMs: [] as number[],
    checksumMs: [] as number[],
  };
  for (let i = 0; i < 3; i++)
    for (const mode of i % 2 === 0 ? ['full', 'checksum'] : ['checksum', 'full']) {
      const start = performance.now(),
        manifest = await readReplayManifest(root, id, checksum);
      if (mode === 'full') await verifyReplayDirectory(directory, manifest);
      else await verifyReplayChecksums(directory, manifest);
      (mode === 'full' ? measurement.fullMs : measurement.checksumMs).push(
        performance.now() - start,
      );
    }
  return measurement;
}
receipt.cases.push(await measure('archer', 'guardian', 'flat', 50));
receipt.cases.push(await measure('guardian', 'guardian', 'pillars', 6000));
await writeFile(
  join(root, 'measurement.json'),
  JSON.stringify({ ...receipt, finishedAt: new Date().toISOString() }, null, 2) + '\n',
);
console.log(join(root, 'measurement.json'));
