import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  DEFAULT_BUDGET,
  SpecInputSchema,
  canonicalJson,
  type Revision,
} from '@fantasy/domain/spatial';
import { catalogManifest } from '@fantasy/engine/spatial';
import { createBatchPlan, executionSource } from './batch-plan.ts';
import { runBatch, reconcileBatch } from './batch-runner.ts';
import { BattleBundles } from './battle-bundle.ts';
import { readBoundedFile, publishImmutableFile } from './replay-files.ts';

const readJson = async (path: string) =>
  JSON.parse((await readBoundedFile(resolve(path), 8_000_000)).toString('utf8')) as unknown;
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      workers: { type: 'string' },
      shard: { type: 'string' },
      deadline: { type: 'string' },
      'retry-failed': { type: 'boolean' },
    },
  });
  const [command, input, output, ...rest] = positionals;
  if (command === 'sample' && input && !output) {
    const revisions = new Map<string, Revision>(),
      matches = [];
    for (const [index, pair] of [
      ['archer', 'guardian'],
      ['fire-mage', 'ice-mage'],
    ].entries()) {
      const manifest = await catalogManifest(pair[0]!, pair[1]!, 'flat');
      for (const revision of manifest.revisions)
        revisions.set(`${revision.kind}:${revision.id}:${revision.revision}`, revision);
      const { seed, participants, ruleset, scenario } = manifest;
      matches.push({
        key: `sample-${index}`,
        spec: SpecInputSchema.parse({ seed, participants, ruleset, scenario }),
      });
    }
    await mkdir(dirname(resolve(input)), { recursive: true });
    await publishImmutableFile(
      resolve(input),
      canonicalJson({
        schemaVersion: 1,
        revisions: [...revisions.values()],
        matches,
        budget: DEFAULT_BUDGET,
        estimatedBytesPerMatch: 4 * 1024 ** 2,
        maxOutputBytes: 128 * 1024 ** 2,
        maxWorkBytes: 128 * 1024 ** 2,
      }),
    );
    console.log(resolve(input));
  } else if (command === 'plan' && input && output && !rest.length) {
    const plan = await createBatchPlan(await readJson(input), executionSource());
    await mkdir(dirname(resolve(output)), { recursive: true });
    await publishImmutableFile(resolve(output), canonicalJson(plan));
    console.log(
      canonicalJson({ planId: plan.id, slots: plan.slots.length, path: resolve(output) }),
    );
  } else if (command === 'run' && input && output && !rest.length) {
    const shard = (values.shard ?? '0/1').split('/').map(Number);
    if (shard.length !== 2) throw new Error('Shard must be index/count, with a zero-based index');
    const controller = new AbortController(),
      stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const result = await runBatch(await readJson(input), resolve(output), executionSource(), {
        workers: Number(values.workers ?? 1),
        shardIndex: shard[0]!,
        shardCount: shard[1]!,
        deadlineMs: Number(values.deadline ?? 1_800_000),
        retryFailed: values['retry-failed'] ?? false,
        signal: controller.signal,
      });
      console.log(
        canonicalJson({
          indexId: result.index.id,
          path: result.path,
          complete: result.index.complete,
          slots: result.index.slots.length,
          elapsedMs: result.elapsedMs,
        }),
      );
      if (!result.index.complete) process.exitCode = 2;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  } else if (command === 'check' && input && output && rest.length % 2 === 1) {
    const files = [output, ...rest],
      indexes = [];
    for (let i = 0; i < files.length; i += 2)
      indexes.push({
        index: await readJson(files[i]!),
        bundles: new BattleBundles(resolve(files[i + 1]!)),
      });
    const result = await reconcileBatch(await readJson(input), indexes);
    console.log(canonicalJson(result));
    if (!result.complete) process.exitCode = 2;
  } else
    throw new Error(
      'Usage: batch sample input.json | plan input.json plan.json | run plan.json output-dir [--workers 1 --shard 0/1 --deadline 1800000 --retry-failed] | check plan.json index.json bundle-root [index.json bundle-root ...]',
    );
}
await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
