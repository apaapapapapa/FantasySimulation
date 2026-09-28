import { join } from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import {
  LeagueCheckpointLocatorSchema,
  PublicCatalogCurrentSchema,
  canonicalJson,
} from '@fantasy/domain/spatial';
import { PublicationEvidence } from '../apps/cli/src/publication/publication-evidence.ts';
import {
  checkpointArchiveKey,
  checkpointLocatorKey,
  decodeLeagueCheckpoint,
} from '../apps/cli/src/league/league-checkpoint.ts';
import type { PublicationStore } from '../apps/cli/src/publication/publication-remote.ts';
import { PipelineArtifacts } from './league-pipeline-artifacts.ts';
import { archiveHash, extractLeagueArchive } from './league-archive.ts';

export async function durableLeagueCheckpoint(
  store: PublicationStore,
  root: string,
  policy: {
    token: string;
    validatorDigest: string;
    maxAgeMs: number;
    ancestor(sha: string): boolean;
  },
) {
  const pointer = await store.read('catalog/current.json', 4000000);
  if (!pointer) return null;
  const current = PublicCatalogCurrentSchema.parse(JSON.parse(pointer.data.toString('utf8')));
  const location = await store.read(checkpointLocatorKey(current.catalogHash), 65536);
  if (!location) return null; // A legacy catalog requires full audit, never synthetic trust.
  const locator = LeagueCheckpointLocatorSchema.parse(JSON.parse(location.data.toString('utf8')));
  if (
    locator.catalogHash !== current.catalogHash ||
    locator.identity.runId !== locator.writerRun ||
    locator.identity.runAttempt !== locator.writerAttempt ||
    !policy.ancestor(locator.identity.source.sha)
  )
    throw new Error('Checkpoint catalog/writer ancestry mismatch');
  const github = new PipelineArtifacts(policy.token, locator.identity, 10);
  await github.successfulWriter();
  await github.durableArtifact(locator.artifactId, {
    digest: locator.archiveHash,
    bytes: locator.archiveBytes,
  });
  const archive = await store.read(checkpointArchiveKey(locator.archiveHash), locator.archiveBytes);
  if (
    !archive ||
    archive.data.length !== locator.archiveBytes ||
    archiveHash(archive.data) !== locator.archiveHash
  )
    throw new Error('Durable checkpoint actual ZIP mismatch');
  const extracted = join(root, 'checkpoint-download');
  try {
    await extractLeagueArchive(archive.data, extracted, (key) => key === 'checkpoint.gz');
    const checkpoint = decodeLeagueCheckpoint(await readFile(join(extracted, 'checkpoint.gz')));
    const evidence = await PublicationEvidence.restore(checkpoint, {
      catalogHash: current.catalogHash,
      validatorDigest: policy.validatorDigest,
      now: Date.now(),
      maxAgeMs: policy.maxAgeMs,
      authenticate: async (value) => {
        if (canonicalJson(value.identity) !== canonicalJson(locator.identity))
          throw new Error('Checkpoint identity changed inside archive');
      },
    });
    const after = await store.read('catalog/current.json', 4000000);
    if (!after?.data.equals(pointer.data) || after.etag !== pointer.etag)
      throw new Error('Checkpoint generation changed');
    return evidence;
  } finally {
    await rm(extracted, { recursive: true, force: true });
  }
}
