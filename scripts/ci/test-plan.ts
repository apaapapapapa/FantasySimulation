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
 * Approximate CI seconds per file: the mean of two six-shard ubuntu-latest runs (36233578962,
 * 36233600930). Durations include contention from the other workers in a shard, so these are
 * scheduling hints only: every inventory file still runs exactly once, and a stale or missing
 * weight only unbalances the shards. Files under two seconds are unlisted and weigh one second;
 * the league plan/runner split is estimated from its measured per-test durations.
 */
export const TEST_WEIGHTS: Readonly<Record<string, number>> = {
  'apps/cli/src/league/league-export.test.ts': 22,
  'apps/api/src/jobs/worker-corpus.test.ts': 20,
  'apps/api/src/batch/batch.test.ts': 19,
  'apps/api/src/jobs/battle-runtime.test.ts': 16,
  'apps/api/src/jobs/ai-delivery.test.ts': 16,
  'packages/engine/src/spatial/posture.test.ts': 15,
  'packages/engine/src/spatial/search.test.ts': 15,
  'scripts/quality/capabilities.test.ts': 14,
  'scripts/quality/architecture.test.ts': 13,
  'scripts/quality/duplication.test.ts': 11,
  'apps/api/src/league/league-runner.test.ts': 11,
  'apps/api/src/replay/replay-attestation.test.ts': 10,
  'packages/engine/src/spatial/league-terrain.test.ts': 9,
  'apps/api/src/league/league-plan.test.ts': 9,
  'apps/cli/src/league/league-graph.test.ts': 8,
  'packages/engine/src/spatial/catalog.test.ts': 8,
  'apps/cli/src/publication/publication-restore.test.ts': 7,
  'scripts/harness/loop/workspace.test.ts': 7,
  'apps/api/src/jobs/simultaneous-persistence.test.ts': 7,
  'scripts/identity/identity.test.ts': 7,
  'packages/engine/src/spatial/simulate.test.ts': 7,
  'scripts/harness/ui.test.ts': 7,
  'apps/api/src/db/drizzle.test.ts': 6,
  'apps/cli/src/league/league-cloud.test.ts': 6,
  'apps/api/src/replay/replay-storage.test.ts': 5,
  'apps/cli/src/publication/publication-export.test.ts': 5,
  'apps/cli/src/publication/publication-remote.test.ts': 5,
  'apps/api/src/jobs/staged-jobs.test.ts': 5,
  'apps/api/src/replay/replay-contract.test.ts': 5,
  'apps/web/src/replay/open-replay.test.ts': 5,
  'apps/cli/src/publication/publication-cli.test.ts': 4,
  'scripts/harness/loop/regression.test.ts': 4,
  'apps/api/src/jobs/worker-pool.test.ts': 3,
  'apps/api/src/jobs/resource-persistence.test.ts': 3,
  'apps/cli/src/league/league-cloud-cli.test.ts': 3,
  'packages/engine/src/spatial/probe.test.ts': 3,
  'apps/cli/src/league/league-history.test.ts': 3,
  'scripts/harness/corpus.test.ts': 2,
};
/** Deterministic heaviest-first assignment of the inventory to the least loaded shard. */
export function shardFiles(files: readonly string[], shards: number): string[][] {
  const weight = (file: string) => TEST_WEIGHTS[file] ?? 1;
  const assigned = Array.from({ length: shards }, (): string[] => []);
  const load = Array.from({ length: shards }, () => 0);
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const index = load.indexOf(Math.min(...load));
    assigned[index]!.push(file);
    load[index]! += weight(file);
  }
  return assigned;
}
