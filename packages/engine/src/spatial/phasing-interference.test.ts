import { expect, it } from 'vite-plus/test';
import pairs from '../../fixtures/spatial/phasing-pairs.json' with { type: 'json' };
import { runInterferencePair } from '../../test-support/interference-run.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';

it('executes all 57 phasing ordered pairs with independent masks and saved provenance', async () => {
  expect(pairs.cases).toHaveLength(57);
  for (const fixture of pairs.cases) {
    const { input, run, mechanics } = await runInterferencePair(fixture);
    expect(mechanics, fixture.id).toEqual(expect.arrayContaining([fixture.left, fixture.right]));
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
