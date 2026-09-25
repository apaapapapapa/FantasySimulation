// Reviewed fixture preparation only. E2E reads exported bytes without running battles.
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchInputSchema } from '@fantasy/domain/spatial';
import { BattleBundles } from '@fantasy/api/artifacts';
import { exportPublication } from '@fantasy/cli/export';
import { readPublication } from '@fantasy/cli/testing';
import { batchInput } from '@fantasy/api/testing';
import { createBatchPlan, runBatch } from '@fantasy/api/tooling';
import { savePublicFixtures } from './publication-fixtures.ts';

const temporary = await mkdtemp(join(tmpdir(), 'fantasy-selection-fixture-'));
try {
  const input = await batchInput(2);
  const exchanged = structuredClone(input.matches[1]!);
  exchanged.key = 'exchanged-placement';
  const [left, right] = exchanged.spec.participants;
  [left.position, right.position] = [right.position, left.position];
  [left.facing, right.facing] = [right.facing, left.facing];
  [left.actorId, right.actorId] = [right.actorId, left.actorId];
  input.matches.push(exchanged);
  const source = {
    sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.versions.node,
    platform: 'linux' as const,
    arch: 'x64' as const,
  };
  const plan = await createBatchPlan(BatchInputSchema.parse(input), source);
  const published = join(temporary, 'published');
  const generations = [];
  for (const kind of ['original', 'reused', 'another-attempt'] as const) {
    const root = join(temporary, kind === 'another-attempt' ? 'second' : 'first');
    const { index } = await runBatch(plan, root, source);
    if (!index.complete) throw new Error('Expected completed selection fixture');
    const result = await exportPublication(
      plan,
      [{ index, bundles: new BattleBundles(root) }],
      published,
    );
    generations.push({ kind, setHash: result.setHash });
  }
  const data = await readPublication(published);
  await savePublicFixtures(published, 'apps/web/test-fixtures/selection', {
    source,
    generator:
      'node --import ./apps/api/node_modules/tsx/dist/loader.mjs e2e/generate-selection-fixtures.ts',
    policy:
      'Real 30-step battles with seeds 1/2 and exchanged positions/facing/participant slots. Separate execution roots produce different attempts for the same simulation/result; this tests replay selection, not job retry orchestration. The second first-root run verifies cache reuse. Regeneration requires review.',
    generations: generations.map((generation) => ({
      ...generation,
      rows: data.sets.find((set) => set.ref.setHash === generation.setHash)!.rows,
    })),
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
