import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { experimentalRules } from '@fantasy/samples/testing';
import { withMilestonePublication } from '../apps/cli/test-support/league-milestones.ts';
import { publicationLeagueSource } from '../apps/cli/test-support/leagues.ts';
import { prepareCloudLeague, finishCloudLeague } from '../apps/cli/src/league/league-cloud.ts';
import { localPublicationGraph } from '../apps/cli/src/publication/publication-graph.ts';

/** Generate a new incomplete experimental publication; never rewrite historical UI oracles. */
export async function experimentalLeagueFiles() {
  const files = new Map<string, Buffer>();
  await withMilestonePublication(async (f) => {
    const definition = await experimentalRules(f.definition);
    definition.id = 'experimental-league';
    definition.name = '実験基盤リーグ';
    const prepared = join(f.root, 'experimental-ui');
    await prepareCloudLeague(definition, publicationLeagueSource, 'ui', f.publicRoot, prepared, {
      files: 0,
      bytes: 0,
      receipts: 0,
      usedReadRequests: 0,
      usedWriteRequests: 0,
    });
    await finishCloudLeague(
      prepared,
      join(f.root, 'no-results'),
      f.publicRoot,
      publicationLeagueSource,
      'ui',
    );
    for (const [key] of (await localPublicationGraph(f.publicRoot)).files)
      files.set(key, await readFile(join(f.publicRoot, key)));
  });
  return files;
}
