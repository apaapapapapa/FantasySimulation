import { expect, it } from 'vite-plus/test';
import { closureMechanics } from '@fantasy/domain/spatial';
import pairs from '../../fixtures/spatial/revival-seal-pairs.json' with { type: 'json' };
import {
  interferencePairManifest,
  type SpatialInterferenceMechanic,
} from '../../test-support/interference.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { runBattle } from './run.ts';

it('executes all 124 revival and seal ordered pairs with explicit restoration and suppression expectations', async () => {
  expect(pairs.pairs).toHaveLength(124);
  for (const [left, right] of pairs.pairs) {
    const key = `${left}/${right}`;
    const input = await interferencePairManifest(
      left as SpatialInterferenceMechanic,
      right as SpatialInterferenceMechanic,
    );
    const used = new Set(closureMechanics(input.revisions).map((m) => m.mechanic));
    expect(
      used.has(left as SpatialInterferenceMechanic) &&
        used.has(right as SpatialInterferenceMechanic),
      key,
    ).toBe(true);
    const run = await runBattle(input);
    const events = battleEvents(run.records);
    await recordedCheckpoints(input, run);
    expect(['draw', 'win'], key).toContain(run.result.outcome.kind);
    for (const [index, mechanic] of [left, right].entries()) {
      const id = index === 0 ? 'left' : 'right';
      if (mechanic === 'revival') {
        const revivals = events.filter((e) => e.actorId === id && e.revival);
        expect(revivals, key).toHaveLength(1);
        expect(revivals[0], key).toMatchObject({
          step: 0,
          amount: 40,
          before: { hp: 0 },
          after: { hp: 40, mp: 30 },
          revival: { use: 1 },
        });
      }
      if (mechanic === 'seal') {
        expect(
          events.filter(
            (e) =>
              e.actorId === id && e.kind === 'launch' && e.abilityId === `pair-action-${index}`,
          ),
          key,
        ).toHaveLength(0);
      }
    }
  }
}, 90000);
