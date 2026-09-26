import { expect, it } from 'vite-plus/test';
import { closureMechanics } from '@fantasy/domain/spatial';
import fixtures from '../../fixtures/spatial/teleport-pairs.json' with { type: 'json' };
import { battleEvents } from '../../test-support/fixtures.ts';
import {
  interferencePairManifest,
  type SpatialInterferenceMechanic,
} from '../../test-support/interference.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { runBattle } from './run.ts';

it('executes all 49 teleport ordered pairs with a one metre boundary displacement', async () => {
  expect(fixtures.cases).toHaveLength(49);
  for (const fixture of fixtures.cases) {
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
