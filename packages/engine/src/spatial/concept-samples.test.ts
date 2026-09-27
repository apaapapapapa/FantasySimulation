import { expect, it } from 'vite-plus/test';
import { catalogManifest } from '@fantasy/samples';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { runBattle } from './run.ts';
import { prepareBattle } from './prepare.ts';
import league from '../../../../data/leagues/experimental-concepts-7-v1.json' with { type: 'json' };
import { rulesetClass, leagueSlotCount } from '@fantasy/domain/spatial';
import { createLeagueRevision, leagueMatches } from '../league/index.ts';

it('admits all 42 manual experimental slots with seven samples under one separate ruleset', async () => {
  const revision = await createLeagueRevision(league, '1'.repeat(40));
  expect(revision.definition.id).toBe('experimental-concepts-7-v1');
  expect(leagueSlotCount(revision.definition)).toBe(42);
  let count = 0;
  for await (const { manifest } of leagueMatches(revision)) {
    const battle = await prepareBattle(manifest);
    expect(rulesetClass(battle.rules)).toBe('experimental');
    expect(battle.manifest.ruleset.id).toBe('experimental-concepts-v1');
    count++;
  }
  expect(count).toBe(42);
});

it.each([
  ['death-mage-v1', 'immortal-warden-v1', 'concept.defeat'],
  ['immortal-warden-v1', 'death-mage-v1', 'concept.immortality'],
  ['chronomancer-v1', 'unerring-mage-v1', 'concept.time-stop.release'],
  ['unerring-mage-v1', 'evasive-mage-v1', 'concept.no-error-aim'],
  ['evasive-mage-v1', 'unerring-mage-v1', 'concept.contact-evasion'],
  ['mind-reader-v1', 'unerring-mage-v1', 'concept.bounded-read'],
  ['concept-warden-v1', 'death-mage-v1', 'concept.defeat'],
])('executes published %s through shared experimental rules', async (left, right, rule) => {
  const input = await catalogManifest(
    left,
    right,
    'flat-surveyed-v1',
    200,
    42,
    'experimental-concepts-v1',
  );
  const run = await runBattle(input);
  await recordedCheckpoints(input, run);
  expect(['win', 'draw']).toContain(run.result.outcome.kind);
  expect(battleEvents(run.records).some((event) => event.ruleId === rule)).toBe(true);
  await expect(
    prepareBattle(await catalogManifest(left, right, 'flat-surveyed-v1', 200)),
  ).rejects.toMatchObject({ code: 'unsupported-mechanic' });
});
