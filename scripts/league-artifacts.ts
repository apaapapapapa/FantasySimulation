import artifact from '@actions/artifact';
import { appendFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  preparedLeague,
  newCloudDirectory,
  leagueArtifactFiles,
  hasCloudResult,
  finishCloudLeague,
  cloudJson,
} from '@fantasy/cli/export';
import { artifactDigest, leagueArtifact, assertRecoveryCatalog } from './league-artifact-policy.ts';

const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error('Missing artifact configuration: ' + key);
  return value;
};
async function main() {
  const root = resolve('.generated/league');
  const command = required('LEAGUE_ARTIFACT_OPERATION');
  const recovery = command === 'recover';
  const run = required(recovery ? 'LEAGUE_RECOVERY_RUN' : 'GITHUB_RUN_ID'),
    attempt = required(recovery ? 'LEAGUE_RECOVERY_ATTEMPT' : 'GITHUB_RUN_ATTEMPT');
  if (!/^\d+$/.test(run) || !/^\d+$/.test(attempt)) throw new Error('Invalid Actions run identity');
  const prefix = `league-${run}-${attempt}`;
  const find = recovery
    ? {
        findBy: {
          token: required('LEAGUE_ARTIFACT_TOKEN'),
          workflowRunId: Number(run),
          repositoryOwner: 'apaapapapapa',
          repositoryName: 'FantasySimulation',
        },
      }
    : {};
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
    const result = await artifact.downloadArtifact(ref.id, {
      path,
      expectedHash: ref.digest,
      ...find,
    });
    if (result.digestMismatch || !result.downloadPath)
      throw new Error('Actions artifact digest mismatch');
  };
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
  } else if (command === 'input' || command === 'aggregate' || recovery) {
    const all = (await artifact.listArtifacts({ latest: false, ...find })).artifacts;
    const name =
      command === 'input'
        ? `${prefix}-input-${required('LEAGUE_PARTITION')}`
        : `${prefix}-baseline`;
    const ref = leagueArtifact(
      all,
      name,
      recovery
        ? undefined
        : {
            id: Number(required('LEAGUE_ARTIFACT_ID')),
            digest: required('LEAGUE_ARTIFACT_DIGEST'),
          },
    );
    await download(ref, command === 'input' ? join(root, 'input') : root);
    if (command === 'aggregate' || recovery) {
      const prepared = await preparedLeague(join(root, 'prepared'));
      if (prepared.executionId !== prefix)
        throw new Error('Do not rerun only failed jobs; start a complete workflow run');
      if (
        recovery &&
        (prepared.plan.source.sha !== required('LEAGUE_RECOVERY_SHA') ||
          prepared.inputs.length !== Number(required('LEAGUE_RECOVERY_PARTITIONS')))
      )
        throw new Error('Recovery artifact source or partition count mismatch');
      for (let index = 0; index < prepared.inputs.length; index++) {
        const resultName = `${prefix}-result-${index}`;
        if (recovery || all.some((entry) => entry.name === resultName))
          await download(leagueArtifact(all, resultName), join(root, 'results', String(index)));
      }
      if (recovery) {
        const measurements = join(root, 'original-measurements');
        await download(leagueArtifact(all, `league-measurements-${run}-${attempt}`), measurements);
        const original = await cloudJson(join(measurements, 'prepared/completion.json'));
        const completion = await finishCloudLeague(
          join(root, 'prepared'),
          join(root, 'results'),
          join(root, 'public'),
          prepared.plan.source,
          prefix,
        );
        assertRecoveryCatalog(original, completion.catalogHash);
        console.log(
          JSON.stringify({
            recovery: { run, attempt, sourceSha: prepared.plan.source.sha },
            completion,
          }),
        );
      }
    }
  } else throw new Error('Invalid league artifact operation');
}
await main();
