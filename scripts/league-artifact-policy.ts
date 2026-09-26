import type { pagesSource } from './pages-policy.ts';

/** Recovery validates saved results only; it never admits or repeats a simulation. */
export function leagueRecoverySource(
  run: Parameters<typeof pagesSource>[0] & { id: number; run_attempt: number },
  jobs: Parameters<typeof pagesSource>[1],
  expected: { runId: number; attempt: number },
) {
  const compute = jobs.filter((job) => job.name.startsWith('compute ('));
  const phase = (name: string, conclusion: string) =>
    jobs.filter((job) => job.name === name && job.conclusion === conclusion).length === 1;
  if (
    !Number.isSafeInteger(expected.runId) ||
    expected.runId < 1 ||
    !Number.isSafeInteger(expected.attempt) ||
    expected.attempt < 1 ||
    expected.attempt > 99999 ||
    run.id !== expected.runId ||
    run.run_attempt !== expected.attempt ||
    run.path !== '.github/workflows/league.yml' ||
    !['workflow_dispatch', 'schedule'].includes(run.event) ||
    run.head_branch !== 'main' ||
    run.head_repository?.full_name !== 'apaapapapapa/FantasySimulation' ||
    run.status !== 'completed' ||
    run.conclusion !== 'failure' ||
    run.head_sha.match(/^[a-f0-9]{40}$/)?.[0] !== run.head_sha ||
    !phase('prepare', 'success') ||
    !phase('publish', 'failure') ||
    compute.length < 1 ||
    compute.length > 64 ||
    new Set(jobs.map((job) => job.name)).size !== jobs.length ||
    compute.some((job) => job.conclusion !== 'success') ||
    jobs.some((job) => job.status !== 'completed' || job.head_sha !== run.head_sha)
  )
    throw new Error('Recovery requires one completed main league attempt with successful workers');
  return run.head_sha;
}

export function artifactDigest(value: string | undefined) {
  const digest = value?.replace(/^sha256:/, '');
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Missing Actions artifact digest');
  return 'sha256:' + digest;
}
export function assertRecoveryCatalog(original: unknown, catalogHash: string) {
  if (
    typeof original !== 'object' ||
    original === null ||
    !('catalogHash' in original) ||
    original.catalogHash !== catalogHash
  )
    throw new Error('Recovered publication differs from the original validated catalog');
}
export function leagueArtifact(
  artifacts: { id: number; name: string; size: number; digest?: string }[],
  name: string,
  expected?: { id: number; digest: string },
) {
  const found = artifacts.filter((artifact) => artifact.name === name);
  if (found.length !== 1) throw new Error('Missing or duplicate current-run artifact');
  const artifact = found[0]!;
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id < 1 ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 1 ||
    artifact.size > 8100000000
  )
    throw new Error('Invalid Actions artifact bounds');
  const digest = artifactDigest(artifact.digest);
  if (expected && (expected.id !== artifact.id || artifactDigest(expected.digest) !== digest))
    throw new Error('Actions artifact identity mismatch');
  return { id: artifact.id, digest };
}
