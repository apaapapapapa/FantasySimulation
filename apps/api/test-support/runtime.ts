import { JobStore } from '../src/job-store.ts';
import { join } from 'node:path';
import { catalogManifest } from '@fantasy/samples';
import { SpecInputSchema, type Manifest } from '@fantasy/domain/spatial';
import { BattleService, type RuntimeOptions } from '../src/battle-service.ts';
import { openStore } from '../src/store.ts';
import { withReplayDirectory } from './replays.ts';

export function specInput({ seed, participants, ruleset, scenario }: Manifest) {
  return SpecInputSchema.parse({ seed, participants, ruleset, scenario });
}

export async function withRuntime(
  work: (fixture: Awaited<ReturnType<typeof runtimeFixture>>) => Promise<void>,
  options: RuntimeOptions = {},
  maxSteps = 50,
) {
  await withReplayDirectory(async (directory) => {
    const fixture = await runtimeFixture(directory, options, maxSteps);
    try {
      await work(fixture);
    } finally {
      await fixture.runtime.close();
      if (fixture.store.db.open) fixture.store.close();
    }
  });
}
async function runtimeFixture(directory: string, options: RuntimeOptions, maxSteps: number) {
  const filename = join(directory, 'database.sqlite'),
    root = join(directory, 'replays');
  const store = openStore(filename);
  const manifest = await catalogManifest('archer', 'guardian', 'flat', maxSteps);
  await store.seedRevisions(manifest.revisions);
  const spec = specInput(manifest);
  const runtime = await BattleService.open(store, root, options);
  return { directory, filename, root, store, manifest, spec, runtime, jobs: new JobStore(store) };
}
