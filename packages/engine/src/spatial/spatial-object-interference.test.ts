import { expect, it } from 'vite-plus/test';
import { closureMechanics } from '@fantasy/domain/spatial';
import pairs from '../../fixtures/spatial/spatial-object-pairs.json' with { type: 'json' };
import {
  interferencePairManifest,
  type SpatialInterferenceMechanic,
} from '../../test-support/interference.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { runBattle } from './run.ts';

it('executes all 159 object ordered pairs with recorded activation windows and contacts', async () => {
  expect(pairs.cases).toHaveLength(159);
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
    const spawned = run.records.flatMap((r) =>
      r.kind === 'boundary' || r.kind === 'interval' ? (r.objects?.spawn ?? []) : [],
    );
    expect(spawned.map((o) => o.kind).sort(), fixture.id).toEqual([...fixture.objects].sort());
    for (const object of spawned) {
      expect(object.activeFrom, fixture.id).toBe(
        object.launchStep + (object.kind === 'beam' ? 0 : 1),
      );
      expect(object.endStep, fixture.id).toBeGreaterThan(object.activeFrom);
    }
    await recordedCheckpoints(input, run);
  }
}, 120000);
