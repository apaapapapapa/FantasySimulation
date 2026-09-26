import { expect, it } from 'vite-plus/test';
import { closureMechanics } from '@fantasy/domain/spatial';
import pairs from '../../fixtures/spatial/phasing-pairs.json' with { type: 'json' };
import {
  interferencePairManifest,
  type SpatialInterferenceMechanic,
} from '../../test-support/interference.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { runBattle } from './run.ts';

it('executes all 57 phasing ordered pairs with independent masks and saved provenance', async () => {
  expect(pairs.cases).toHaveLength(57);
  for (const fixture of pairs.cases) {
    const input = await interferencePairManifest(
      fixture.left as SpatialInterferenceMechanic,
      fixture.right as SpatialInterferenceMechanic,
    );
    const mechanics = new Set(closureMechanics(input.revisions).map((m) => m.mechanic));
    expect(
      mechanics.has(fixture.left as SpatialInterferenceMechanic) &&
        mechanics.has(fixture.right as SpatialInterferenceMechanic),
      fixture.id,
    ).toBe(true);
    const run = await runBattle(input);
    expect(run.result.outcome, fixture.id).toEqual({ kind: 'draw', reason: 'time-limit' });
    const initial = run.records.find((r) => r.kind === 'boundary' && r.step === 0);
    expect(
      initial?.kind === 'boundary' &&
        initial.changes.filter((a) => a.phasing?.active.length).length,
      fixture.id,
    ).toBe(fixture.phasingCount);
    const saved = await recordedCheckpoints(input, run);
    expect(
      saved.checkpoints.at(-1)!.state!.actors.filter((a) => a.phasing?.active.length).length,
      fixture.id,
    ).toBe(fixture.activeAtEnd);
  }
}, 90000);
