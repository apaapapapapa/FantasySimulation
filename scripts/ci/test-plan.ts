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
 * Approximate CI seconds of the slowest files, measured on ubuntu-latest (2026-09-26). These are
 * scheduling hints only: every inventory file still runs exactly once, and a stale or missing
 * weight only unbalances the shards. Unlisted files weigh one second.
 */
export const TEST_WEIGHTS: Readonly<Record<string, number>> = {
  'apps/api/src/league/league.test.ts': 26,
  'apps/cli/src/league/league-export.test.ts': 22,
  'scripts/quality/architecture.test.ts': 21,
  'packages/engine/src/spatial/posture.test.ts': 18,
  'apps/api/src/batch/batch.test.ts': 16,
  'packages/engine/src/spatial/search.test.ts': 15,
  'apps/api/src/jobs/worker-corpus.test.ts': 14,
  'apps/api/src/jobs/battle-runtime.test.ts': 13,
  'scripts/quality/duplication.test.ts': 12,
  'apps/api/src/db/drizzle.test.ts': 11,
  'apps/api/src/jobs/ai-delivery.test.ts': 11,
  'apps/api/src/replay/replay-attestation.test.ts': 10,
  'packages/engine/src/spatial/league-terrain.test.ts': 8,
  'scripts/quality/capabilities.test.ts': 8,
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
