import type { pagesSource } from './pages-policy.ts';

type RecoveryJob = Parameters<typeof pagesSource>[1][number] & {
  steps?: { name: string; status: string; conclusion: string | null; number: number }[];
};

/** An interrupted upload is recoverable only after the original finalizer completed. */
function recoverablePublication(runConclusion: string | null, publish: RecoveryJob | undefined) {
  if (runConclusion === 'failure' && publish?.conclusion === 'failure') return true;
  if (
    !['failure', 'cancelled', 'timed_out'].includes(runConclusion ?? '') ||
    !['cancelled', 'timed_out'].includes(publish?.conclusion ?? '') ||
    !Array.isArray(publish?.steps)
  )
    return false;
  const finalized = publish.steps.filter(
    (step) => step.name === 'Validate received partitions and preserve every missing denominator',
  );
  const interrupted = publish.steps.filter(
    (step) => step.name === 'Reserve publication budget and verify R2 and Worker readback',
  );
  const before = finalized[0],
    after = interrupted[0];
  return (
    finalized.length === 1 &&
    interrupted.length === 1 &&
    before?.status === 'completed' &&
    before.conclusion === 'success' &&
    after?.status === 'completed' &&
    ['cancelled', 'timed_out'].includes(after.conclusion ?? '') &&
    Number.isSafeInteger(before.number) &&
    before.number > 0 &&
    Number.isSafeInteger(after.number) &&
    after.number > before.number
  );
}

/** Download plus full revalidation needs more time than artifact transfer alone. */
export function leagueArtifactTimeout(operation: unknown) {
  if (operation === 'recover') return 90 * 60 * 1000;
  if (['prepare', 'input', 'result', 'aggregate'].some((value) => value === operation))
    return 60 * 60 * 1000;
  throw new Error('Unknown league artifact operation');
}

/** Recovery validates saved results only; it never admits or repeats a simulation. */
export function leagueRecoverySource(
  run: Parameters<typeof pagesSource>[0] & { id: number; run_attempt: number },
  jobs: RecoveryJob[],
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
    run.head_sha.match(/^[a-f0-9]{40}$/)?.[0] !== run.head_sha ||
    !phase('prepare', 'success') ||
    !recoverablePublication(
      run.conclusion,
      jobs.find((job) => job.name === 'publish'),
    ) ||
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
