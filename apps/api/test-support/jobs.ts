import { DEFAULT_BUDGET, canonicalJson, type Budget } from '@fantasy/domain/spatial';
import { prepareBattle, runPreparedBattle } from '@fantasy/engine/spatial';
import { catalogManifest } from '@fantasy/samples';
import { JobStore, type Claim } from '../src/jobs/job-store.ts';
import { openStore } from '../src/db/store.ts';
import { sha256 } from '../src/replay/replay-files.ts';

export async function withJobs(
  work: (fixture: Awaited<ReturnType<typeof jobFixture>>) => Promise<void>,
  filename = ':memory:',
) {
  const fixture = await jobFixture(filename);
  try {
    await work(fixture);
  } finally {
    fixture.store.close();
  }
}
async function jobFixture(filename: string) {
  const store = openStore(filename),
    jobs = new JobStore(store);
  const battle = await prepareBattle(await catalogManifest('archer', 'guardian', 'flat', 1));
  store.saveSpec(battle);
  const { result } = await runPreparedBattle(battle);
  const submit = (key: string, budget: Budget = DEFAULT_BUDGET) =>
    jobs.submit(
      {
        simulationHash: battle.simulationHash,
        clientId: 'local:POST/battle-jobs',
        key,
        requestHash: sha256(canonicalJson({ simulationHash: battle.simulationHash, budget })),
        budget,
      },
      100,
    );
  return { store, jobs, battle, result, submit };
}
export const artifactFor = (claim: Claim) => ({
  id: `replay-${claim.attempt.id}`,
  attemptId: claim.attempt.id,
  manifestChecksum: `sha256:${'a'.repeat(64)}`,
  bytes: 1000,
  state: 'ready' as const,
  createdAt: 100,
});
