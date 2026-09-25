import { DEFAULT_BUDGET, revisionReference, type LeagueDefinition } from '@fantasy/domain/spatial';
import { sampleManifest } from './sample.ts';
import { createLeagueRevision, leagueMatches } from '@fantasy/engine/spatial';

export const leagueSource = '1'.repeat(40);
export async function leagueFixture(characters = 3, scenarios = 2): Promise<LeagueDefinition> {
  const manifest = await sampleManifest(20);
  const character = manifest.revisions.find((r) => r.kind === 'character')!;
  const scenario = manifest.revisions.find((r) => r.kind === 'scenario')!;
  const actors = Array.from({ length: characters }, (_, i) => ({
    ...structuredClone(character),
    id: `character-${i}`,
  }));
  const fields = Array.from({ length: scenarios }, (_, i) => ({
    ...structuredClone(scenario),
    id: `terrain-${i}`,
  }));
  return {
    schemaVersion: 1,
    id: 'test-league',
    name: 'League fixture',
    characters: actors.map(revisionReference),
    ruleset: manifest.ruleset,
    battlefields: fields.map((field) => ({
      scenario: revisionReference(field),
      weight: { numerator: '1', denominator: String(scenarios) },
      starts: manifest.participants.map(({ position, facing }) => ({
        position,
        facing,
      })) as LeagueDefinition['battlefields'][number]['starts'],
    })),
    placements: ['normal', 'swapped'],
    trials: 2,
    masterSeed: 42,
    seedDerivation: 'league-trial-v1',
    scoringVersion: 'league-score-v1',
    budget: { ...DEFAULT_BUDGET },
    retryBudget: { ...DEFAULT_BUDGET, maxEvents: 100_000 },
    revisions: [...manifest.revisions, ...actors, ...fields],
  };
}
export async function plannedLeague(definition: LeagueDefinition) {
  const league = await createLeagueRevision(definition, leagueSource);
  const matches = [];
  for await (const match of leagueMatches(league)) matches.push(match);
  return { league, matches };
}
