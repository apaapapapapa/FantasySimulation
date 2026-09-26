import { expect, it } from 'vite-plus/test';
import { closureMechanics, ReplayState, replayContext } from '@fantasy/domain/spatial';
import fixtures from '../../fixtures/spatial/recovery-pairs.json' with { type: 'json' };
import {
  interferencePairManifest,
  type RecoveryInterferenceMechanic,
} from '../../test-support/interference.ts';
import { runBattle } from './run.ts';
import { prepareBattle } from './prepare.ts';

it('executes all 92 absorption and drain ordered pairs against authored numeric expectations', async () => {
  expect(fixtures.cases).toHaveLength(92);
  for (const fixture of fixtures.cases) {
    const input = await interferencePairManifest(
      fixture.left as RecoveryInterferenceMechanic,
      fixture.right as RecoveryInterferenceMechanic,
    );
    const used = new Set(closureMechanics(input.revisions).map((u) => u.mechanic));
    expect(
      used.has(fixture.left as RecoveryInterferenceMechanic) &&
        used.has(fixture.right as RecoveryInterferenceMechanic),
      fixture.id,
    ).toBe(true);
    const battle = await prepareBattle(input);
    const run = await runBattle(input);
    expect(run.result.outcome, fixture.id).toEqual({ kind: 'draw', reason: 'time-limit' });
    const replay = new ReplayState(await replayContext(battle.manifest, run.result.simulationHash));
    for (const record of run.records) replay.apply(record);
    for (const [id, hp] of Object.entries(fixture.hp))
      expect(
        replay.checkpoint().state!.actors.find((a) => a.id === id)!.resources.hp,
        fixture.id + '/' + id,
      ).toBe(hp);
  }
}, 90000);
