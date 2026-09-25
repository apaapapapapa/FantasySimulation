import artifact from '@actions/artifact';
import { appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  preparedLeague,
  newCloudDirectory,
  leagueArtifactFiles,
  hasCloudResult,
} from '@fantasy/cli/export';
import { artifactDigest, leagueArtifact } from './league-artifact-policy.ts';

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('Missing artifact configuration: ' + key);
  return value;
};
async function main() {
  const root = resolve('.generated/league');
  const run = required('GITHUB_RUN_ID'),
    attempt = required('GITHUB_RUN_ATTEMPT');
  if (!/^\d+$/.test(run) || !/^\d+$/.test(attempt)) throw new Error('Invalid Actions run identity');
  const prefix = `league-${run}-${attempt}`;
  const output = async (key: string, value: unknown) =>
    appendFile(
      required('GITHUB_OUTPUT'),
      `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}\n`,
    );
  const upload = async (name: string, path: string, kind: 'baseline' | 'input' | 'result') => {
    const selection = await leagueArtifactFiles(path, kind);
    const result = await artifact.uploadArtifact(name, selection.files, path, {
      retentionDays: 7,
      compressionLevel: 0,
    });
    if (!result.id) throw new Error('Actions upload did not return an immutable ID');
    console.log(
      JSON.stringify({
        artifact: name,
        id: result.id,
        files: selection.files.length,
        rawBytes: selection.bytes,
        zipBytes: result.size,
      }),
    );
    return { id: result.id, digest: artifactDigest(result.digest) };
  };
  const download = async (ref: { id: number; digest: string }, path: string) => {
    await newCloudDirectory(path);
    const result = await artifact.downloadArtifact(ref.id, { path, expectedHash: ref.digest });
    if (result.digestMismatch || !result.downloadPath)
      throw new Error('Actions artifact digest mismatch');
  };
  const command = required('LEAGUE_ARTIFACT_OPERATION');
  if (command === 'prepare') {
    const prepared = await preparedLeague(join(root, 'prepared'));
    if (prepared.executionId !== prefix) throw new Error('Prepared execution identity mismatch');
    const baseline = await upload(prefix + '-baseline', root, 'baseline');
    const matrix = [];
    for (let index = 0; index < prepared.inputs.length; index++)
      matrix.push({
        index,
        ...(await upload(
          `${prefix}-input-${index}`,
          join(root, 'prepared/inputs', String(index)),
          'input',
        )),
      });
    await output('baseline-id', baseline.id);
    await output('baseline-digest', baseline.digest);
    await output('matrix', { include: matrix });
  } else if (command === 'result') {
    if (await hasCloudResult(join(root, 'output'))) {
      const index = required('LEAGUE_PARTITION');
      if (!/^(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(index))
        throw new Error('Invalid artifact partition');
      await upload(`${prefix}-result-${index}`, join(root, 'output'), 'result');
    }
  } else if (command === 'input' || command === 'aggregate') {
    const all = (await artifact.listArtifacts({ latest: false })).artifacts;
    const name =
      command === 'input'
        ? `${prefix}-input-${required('LEAGUE_PARTITION')}`
        : `${prefix}-baseline`;
    const ref = leagueArtifact(all, name, {
      id: Number(required('LEAGUE_ARTIFACT_ID')),
      digest: required('LEAGUE_ARTIFACT_DIGEST'),
    });
    await download(ref, command === 'input' ? join(root, 'input') : root);
    if (command === 'aggregate') {
      const prepared = await preparedLeague(join(root, 'prepared'));
      if (prepared.executionId !== prefix)
        throw new Error('Do not rerun only failed jobs; start a complete workflow run');
      for (let index = 0; index < prepared.inputs.length; index++) {
        const resultName = `${prefix}-result-${index}`;
        if (all.some((entry) => entry.name === resultName))
          await download(leagueArtifact(all, resultName), join(root, 'results', String(index)));
      }
    }
  } else throw new Error('Invalid league artifact operation');
}
await main();
