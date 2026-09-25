import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { PUBLICATION_MAX_BYTES, PUBLICATION_MAX_FILES } from '@fantasy/domain/spatial';
import { localPublicationGraph } from '../publication/publication-graph.ts';
import {
  optionalPublicationFile,
  publicationDirectory,
  publicationInventory,
} from '../publication/publication-files.ts';
import { preparedLeague, cloudInput } from './league-cloud-files.ts';

/** Explicit allowlists, never a recursive upload of the worker's DB or environment. */
export async function leagueArtifactFiles(root: string, kind: 'baseline' | 'input' | 'result') {
  await publicationDirectory(root);
  const files: string[] = [];
  if (kind === 'baseline') {
    const prepared = await preparedLeague(join(root, 'prepared'));
    const graph = await localPublicationGraph(join(root, 'public'));
    if (graph.catalog.leagueWork?.hash !== prepared.work.hash)
      throw new Error('Artifact baseline reservation mismatch');
    files.push(
      ...[...graph.files.keys()].map((key) => join(root, 'public', key)),
      join(root, 'prepared/prepared.json'),
    );
    for (let i = 0; i < prepared.inputs.length; i++) {
      await cloudInput(join(root, 'prepared'), prepared, i);
      files.push(join(root, 'prepared/inputs', String(i), 'input.json'));
    }
    for (const key of ['inventory.json', 'prepared/estimate.json']) files.push(join(root, key));
    for (const phase of ['restore', 'admit'])
      files.push(join(root, 'reports', `${prepared.executionId}-${phase}.json`));
  } else {
    files.push(join(root, kind + '.json'));
    const directory = join(root, kind === 'input' ? 'retained' : 'bundles');
    try {
      await publicationDirectory(directory);
      for (const key of (await publicationInventory(directory, true)).keys()) {
        if (!key.startsWith('objects/')) throw new Error('Unexpected league artifact bundle entry');
        files.push(join(directory, key));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  let bytes = 0;
  for (const path of files) {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error('Artifact must contain regular files');
    bytes += stat.size;
  }
  if (files.length > PUBLICATION_MAX_FILES + 100 || bytes > PUBLICATION_MAX_BYTES)
    throw new Error('League Actions artifact budget');
  return { files, bytes };
}
export async function hasCloudResult(root: string) {
  return (await optionalPublicationFile(join(root, 'result.json'), 16000000)) !== null;
}
