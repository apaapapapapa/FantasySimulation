import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { leagueFixture } from '@fantasy/samples/testing';
import {
  contentHash,
  LeagueRevisionSchema,
  PublicLeagueSnapshotSchema,
  type LeagueRevision,
} from '@fantasy/domain/spatial';
import { prepareCloudLeague, finishCloudLeague } from '../src/league/league-cloud.ts';
import { localPublicationGraph } from '../src/publication/publication-graph.ts';
import { PublicReadFailure } from '../src/publication/publication-http.ts';
import { leagueFile } from '../src/league/league-export.ts';
import { publicationLeagueSource as source } from './leagues.ts';

export async function withMilestonePublication(
  run: (fixture: Awaited<ReturnType<typeof metadata>>) => Promise<void>,
) {
  await withReplayDirectory(async (root) => run(await metadata(root)));
}
async function metadata(root: string) {
  const definition = await leagueFixture(2, 1),
    publicRoot = join(root, 'public');
  const preparedRoot = join(root, 'prepared');
  await prepareCloudLeague(definition, source, 'milestone', publicRoot, preparedRoot, {
    files: 0,
    bytes: 0,
    receipts: 0,
    usedReadRequests: 0,
    usedWriteRequests: 0,
  });
  await finishCloudLeague(preparedRoot, join(root, 'missing'), publicRoot, source, 'milestone');
  const graph = await localPublicationGraph(publicRoot);
  const files = new Map<string, Buffer>(
    await Promise.all(
      [...graph.files].map(async ([key]) => [key, await readFile(join(publicRoot, key))] as const),
    ),
  );
  const read = async (key: string) => {
    const bytes = files.get(key);
    if (!bytes) throw new PublicReadFailure(404);
    return bytes;
  };
  const ref = graph.catalog.leagues![0]!;
  const snapshot = PublicLeagueSnapshotSchema.parse(
    JSON.parse((await read(`leagues/${ref.hash.slice(7)}.json`)).toString()),
  );
  const revision = LeagueRevisionSchema.parse(
    JSON.parse((await read(`leagues/${snapshot.definition.hash.slice(7)}.json`)).toString()),
  );
  const put = (value: unknown, namespace = 'leagues') => {
    const file = leagueFile(value);
    files.set(`${namespace}/${file.ref.hash.slice(7)}.json`, file.file.data!);
    return file.ref;
  };
  const update = async (candidate: LeagueRevision, edit?: (value: typeof snapshot) => void) => {
    const { leagueHash: _, ...body } = candidate;
    body.inputHash = await contentHash({
      definition: body.definition,
      engineVersion: body.engineVersion,
      implementationDigest: body.implementationDigest,
    });
    const saved = { ...body, leagueHash: await contentHash(body) };
    const next = {
      ...snapshot,
      leagueHash: saved.leagueHash,
      inputHash: saved.inputHash,
      sourceSha: saved.sourceSha,
      engineVersion: saved.engineVersion,
      implementationDigest: saved.implementationDigest,
      definition: put(saved),
    };
    edit?.(next);
    const catalog = {
      ...graph.catalog,
      leagues: [
        { ...put(next), id: next.id, leagueHash: next.leagueHash, inputHash: next.inputHash },
      ],
    };
    const file = put(catalog, 'catalog');
    files.set(
      'catalog/current.json',
      Buffer.from(JSON.stringify({ schemaVersion: 1, catalogHash: file.hash, bytes: file.bytes })),
    );
  };
  return { root, publicRoot, definition, revision, snapshot, files, read, update };
}
