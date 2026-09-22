import { join } from 'node:path';
import { catalogManifest } from '@fantasy/engine/spatial';
import { SpecInputSchema } from '@fantasy/domain/spatial';
import { BattleRuntime, type RuntimeOptions } from '../src/battle-runtime.ts';
import { openStore } from '../src/store.ts';
import { withReplayDirectory } from './replays.ts';

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
  const spec = SpecInputSchema.parse({
    seed: manifest.seed,
    participants: manifest.participants,
    ruleset: manifest.ruleset,
    scenario: manifest.scenario,
  });
  const runtime = await BattleRuntime.open(store, root, options);
  return { directory, filename, root, store, manifest, spec, runtime };
}
