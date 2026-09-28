import { expect, it } from 'vite-plus/test';
import {
  LeagueDefinitionSchema,
  leagueSlotCount,
  revisionReference,
} from '@fantasy/domain/spatial';
import { catalogManifest, sampleCatalog } from '@fantasy/samples';
import baselineInput from '../../../../data/leagues/official-20-v2.json' with { type: 'json' };
import balancedInput from '../../../../data/leagues/official-20-balanced-v1.json' with { type: 'json' };
import { leagueCoordinates, normalizeLeagueDefinition } from '../league/index.ts';
import { ManifestBuilder } from './manifest-builder.ts';
import { runBattle, runPreparedBattle } from './run.ts';
import { battleEvents } from '../../test-support/fixtures.ts';

const replacements = [
  ['staged-duelist-v1', 'staged-duelist-trained-v1'],
  ['stage-vanguard-v1', 'stage-vanguard-trained-v1'],
  ['lancer', 'lancer-trained-v1'],
  ['swordsman', 'swordsman-trained-v1'],
  ['posture-duelist-v1', 'posture-duelist-trained-v1'],
] as const;

it('replaces only the five weakest roster entries and preserves the 7,600-slot contract', async () => {
  const baseline = await normalizeLeagueDefinition(baselineInput);
  const balanced = await normalizeLeagueDefinition(balancedInput);
  expect(leagueSlotCount(balanced)).toBe(7600);
  const { id: _oldId, name: _oldName, characters, revisions: _oldRevisions, ...oldPlan } = baseline;
  const { id: _id, name: _name, characters: next, revisions: _revisions, ...newPlan } = balanced;
  expect(newPlan).toEqual(oldPlan);
  const mapping = new Map<string, string>(replacements);
  const catalog = await sampleCatalog();
  expect(next).toEqual(
    characters.map((character) => {
      const id = mapping.get(character.id);
      return id
        ? revisionReference(catalog.find((r) => r.kind === 'character' && r.id === id)!)
        : character;
    }),
  );
  // The old league remains independently readable; none of its definitions is replaced in place.
  for (const revision of baseline.revisions) expect(catalog).toContainEqual(revision);
});

it.each(replacements)(
  '%s can close on a bow user from either starting side',
  async (before, after) => {
    const fixture = LeagueDefinitionSchema.parse(baselineInput);
    fixture.characters = fixture.characters.filter((c) => [before, 'archer'].includes(c.id));
    fixture.battlefields = fixture.battlefields.filter((f) => f.scenario.id === 'flat-surveyed-v1');
    fixture.trials = 1;
    const catalog = await sampleCatalog();
    const replacement = catalog.find((r) => r.kind === 'character' && r.id === after)!;
    const builder = ManifestBuilder.from(catalog);
    let checked = 0;
    for await (const { spec } of leagueCoordinates(fixture)) {
      const participant = spec.participants.find((p) => p.character.id === before)!;
      const oldRun = await runPreparedBattle(await builder.build(spec), fixture.budget);
      expect(oldRun.result.outcome).toEqual({
        kind: 'win',
        winner: spec.participants.find((p) => p !== participant)!.actorId,
      });
      participant.character = revisionReference(replacement);
      const newRun = await runPreparedBattle(await builder.build(spec), fixture.budget);
      expect(newRun.result.outcome).toEqual({ kind: 'win', winner: participant.actorId });
      expect(
        battleEvents(newRun.records).some(
          (e) => e.kind === 'damage' && e.actorId === participant.actorId && (e.amount ?? 0) > 0,
        ),
      ).toBe(true);
      checked++;
    }
    expect(checked).toBe(2);
  },
);

it('lands both trained combo stages against armor without bypassing its defense', async () => {
  const input = await catalogManifest(
    'staged-duelist-trained-v1',
    'guardian',
    'flat-surveyed-v1',
    6000,
    42,
    'standard-tactics-spatial-v1',
  );
  const run = await runBattle(input);
  const damage = battleEvents(run.records).filter(
    (e) => e.actorId === 'left' && e.kind === 'damage',
  );
  expect(new Set(damage.map((e) => e.stage?.stageId))).toEqual(new Set(['cut', 'return']));
  expect(damage.length).toBeGreaterThan(0);
  for (const event of damage) {
    expect(event.damage?.defenseApplied).toBe(17);
    expect(event.amount).toBeGreaterThan(0);
  }
  expect(run.result.outcome).toEqual({ kind: 'win', winner: 'right' });
});
