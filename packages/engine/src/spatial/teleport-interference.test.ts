import { expect, it } from 'vite-plus/test';
import fixtures from '../../fixtures/spatial/teleport-pairs.json' with { type: 'json' };
import { battleEvents } from '../../test-support/fixtures.ts';
import { runInterferencePair } from '../../test-support/interference-run.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';

it('executes all 49 teleport ordered pairs with a one metre boundary displacement', async () => {
  expect(fixtures.cases).toHaveLength(49);
  for (const fixture of fixtures.cases) {
    const { input, run, mechanics } = await runInterferencePair(fixture);
    expect(mechanics, fixture.id).toEqual(expect.arrayContaining([fixture.left, fixture.right]));
    expect(run.result.outcome, fixture.id).toEqual({ kind: 'draw', reason: 'time-limit' });
    const events = battleEvents(run.records);
    const jumps = events.filter((e) => e.teleport);
    expect(jumps, fixture.id).toHaveLength(fixture.teleportCount);
    for (const e of jumps) {
      const { from, to } = e.teleport!;
      expect(Math.hypot(to.x - from.x, to.z - from.z), fixture.id).toBeCloseTo(
        fixture.distanceMm / 1000,
        3,
      );
      expect(e.phase).toBe('boundary');
      expect(events.find((parent) => parent.id === e.parentEventId)?.step).toBe(e.step - 1);
      expect(
        events.some((contact) => contact.kind === 'hit' && contact.parentEventId === e.id),
      ).toBe(false);
    }
    await recordedCheckpoints(input, run);
  }
}, 90000);
