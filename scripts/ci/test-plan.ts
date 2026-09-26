import { globSync } from 'node:fs';

export const TEST_INCLUDE = [
  'packages/**/*.test.ts',
  'apps/api/**/*.test.ts',
  'apps/cli/**/*.test.ts',
  'apps/web/**/*.test.ts',
  'apps/replay-reader/**/*.test.ts',
  'scripts/**/*.test.ts',
];
export const TEST_EXCLUDE = ['**/node_modules/**', '**/.git/**', 'scripts/security/**/*.test.ts'];
export function testFiles(root: string): string[] {
  return globSync(TEST_INCLUDE, { cwd: root, exclude: TEST_EXCLUDE })
    .map((path) => path.replaceAll('\\', '/'))
    .sort();
}

/**
 * Approximate CI seconds per file: the mean of four six-shard ubuntu-latest runs (36241620593,
 * 36241602362, 36243792959, 36246318306; files added since then from fewer runs). Durations include
 * contention from the other workers in a shard, so these are scheduling hints only: every inventory
 * file still runs exactly once, and a stale or missing weight only unbalances the shards. Files
 * under two seconds are unlisted and weigh one second, so a new heavy test file needs a weight or it
 * is treated as light. The real-Worker corpus counts its CPU instead: about 20 s with up to three
 * busy Worker threads. Sharing a shard with other heavy files slowed it to 31 s (main run
 * 36239802179), so it gets a shard of light files.
 */
export const TEST_WEIGHTS: Readonly<Record<string, number>> = {
  'apps/api/src/jobs/worker-corpus.test.ts': 60,
  'apps/cli/src/league/league-export.test.ts': 26,
  'scripts/quality/architecture.test.ts': 22,
  'apps/api/src/batch/batch.test.ts': 18,
  'packages/engine/src/spatial/posture.test.ts': 18,
  'apps/api/src/jobs/battle-runtime.test.ts': 15,
  'apps/api/src/league/league-runner.test.ts': 15,
  'apps/api/src/jobs/ai-delivery.test.ts': 14,
  'packages/engine/src/spatial/interference-matrix.test.ts': 14,
  'packages/engine/src/spatial/search.test.ts': 14,
  'scripts/quality/duplication.test.ts': 12,
  'scripts/quality/capabilities.test.ts': 11,
  'apps/api/src/league/league-plan.test.ts': 10,
  'apps/cli/src/league/league-cli.test.ts': 10,
  'apps/cli/src/league/league-graph.test.ts': 10,
  'apps/api/src/db/drizzle.test.ts': 9,
  'apps/api/src/replay/replay-attestation.test.ts': 9,
  'apps/api/src/replay/replay-storage.test.ts': 8,
  'scripts/harness/ui.test.ts': 8,
  'apps/api/src/jobs/simultaneous-persistence.test.ts': 7,
  'packages/engine/src/spatial/catalog.test.ts': 7,
  'apps/api/src/jobs/staged-jobs.test.ts': 6,
  'apps/cli/src/league/league-cloud.test.ts': 6,
  'apps/cli/src/publication/publication-export.test.ts': 6,
  'scripts/identity/identity.test.ts': 6,
  'apps/api/src/jobs/worker-pool.test.ts': 5,
  'apps/api/src/replay/replay-contract.test.ts': 5,
  'apps/cli/src/league/league-milestones.test.ts': 5,
  'apps/cli/src/league/league-stored.test.ts': 5,
  'apps/cli/src/publication/publication-remote.test.ts': 5,
  'apps/web/src/replay/open-replay.test.ts': 5,
  'packages/engine/src/spatial/league-terrain.test.ts': 5,
  'packages/engine/src/spatial/simulate.test.ts': 5,
  'scripts/harness/loop/workspace.test.ts': 5,
  'apps/api/src/league/league-stored.test.ts': 4,
  'apps/cli/src/league/league-cloud-cli.test.ts': 4,
  'apps/cli/src/league/league-transfer.test.ts': 4,
  'apps/cli/src/publication/publication-restore.test.ts': 4,
  'scripts/harness/loop/regression.test.ts': 4,
  'apps/api/src/jobs/resource-persistence.test.ts': 3,
  'apps/api/src/http/app.test.ts': 2,
  'apps/cli/src/league/league-history.test.ts': 2,
  'packages/engine/src/spatial/ai-integration.test.ts': 2,
  'scripts/harness/context.test.ts': 2,
};
const weight = (file: string, weights = TEST_WEIGHTS) => weights[file] ?? 1;
/** Deterministic heaviest-first assignment of the inventory to the least loaded shard. */
export function shardFiles(files: readonly string[], shards: number): string[][] {
  const assigned = Array.from({ length: shards }, (): string[] => []);
  const load = Array.from({ length: shards }, () => 0);
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const index = load.indexOf(Math.min(...load));
    assigned[index]!.push(file);
    load[index]! += weight(file);
  }
  return assigned;
}
/**
 * The heaviest known file first, everything else in the given order. CI never caches test results,
 * and without them Vitest starts files largest first, so a short but slow file could start last and
 * alone set its shard's wall time. Only one file moves: starting every heavy file at once made the
 * CPU-bound ones slow each other, and two 4-vCPU shards took 5-7 s longer (runs 36239695205 and
 * 36239802179 against 36238386739).
 */
export function heaviestFirst<T>(
  items: readonly T[],
  file: (item: T) => string,
  weights = TEST_WEIGHTS,
): T[] {
  let heaviest = -1;
  let most = 1;
  items.forEach((item, index) => {
    const value = weight(file(item), weights);
    if (value > most) [heaviest, most] = [index, value];
  });
  return heaviest < 0
    ? [...items]
    : [items[heaviest]!, ...items.filter((_, index) => index !== heaviest)];
}
