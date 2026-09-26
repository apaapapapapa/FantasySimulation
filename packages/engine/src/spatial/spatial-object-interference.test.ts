import { expect, it } from 'vite-plus/test';
import pairs from '../../fixtures/spatial/spatial-object-pairs.json' with { type: 'json' };
import { runInterferencePair } from '../../test-support/interference-run.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';

it('executes all 159 object ordered pairs with recorded activation windows and contacts', async () => {
  expect(pairs.cases).toHaveLength(159);
  for (const fixture of pairs.cases) {
    const { input, run, mechanics } = await runInterferencePair(fixture);
    expect(mechanics, fixture.id).toEqual(expect.arrayContaining([fixture.left, fixture.right]));
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
