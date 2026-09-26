import { closureMechanics } from '@fantasy/domain/spatial';
import { interferencePairManifest, type SpatialInterferenceMechanic } from './interference.ts';
import { runBattle } from '../src/spatial/run.ts';

/** Fresh executable input and independently inspectable admission/result, without fixture expectations. */
export async function runInterferencePair(fixture: { left: string; right: string }) {
  const input = await interferencePairManifest(
    fixture.left as SpatialInterferenceMechanic,
    fixture.right as SpatialInterferenceMechanic,
  );
  const mechanics = closureMechanics(input.revisions).map((m) => m.mechanic);
  return { input, run: await runBattle(input), mechanics };
}
