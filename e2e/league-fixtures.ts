import { PublicLeagueSnapshotSchema, PublicMatchPageSchema } from '@fantasy/domain/spatial';
import provenance from '../apps/web/test-fixtures/league/provenance.json' with { type: 'json' };
import { publicFixtures } from './publication-fixtures.ts';

export const leagueFiles = publicFixtures(process.cwd(), 'league');
export const leagueGenerations = [provenance.partial, provenance.complete].map((ref) => ({
  ...ref,
  snapshot: PublicLeagueSnapshotSchema.parse(
    JSON.parse(leagueFiles.get(`leagues/${ref.hash.slice(7)}.json`)!.toString()),
  ),
}));
export const leagueRows = [...leagueFiles]
  .filter(([key]) => key.startsWith('sets/') && !key.endsWith('/set.json'))
  .flatMap(([, data]) => PublicMatchPageSchema.parse(JSON.parse(data.toString())).rows);
