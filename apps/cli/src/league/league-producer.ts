import { join } from 'node:path';
import { BattleBundles, OperationError, sha256, type ReplayVerifier } from '@fantasy/api/artifacts';
import {
  canonicalJson,
  LeagueCloudInputSchema,
  LeaguePartitionResultSchema,
  LeagueProducerProofSchema,
  LeagueProducerArtifactSchema,
  type LeagueCloudInput,
} from '@fantasy/domain/spatial';
import { buildPublication } from '../publication/publication-export.ts';
import { commitPublication } from '../publication/publication-catalog.ts';
import { publicationInventory, type PublicationFile } from '../publication/publication-files.ts';
import { PublicationEvidence, evidenceGraph } from '../publication/publication-evidence.ts';
import { cloudJson, writeCloudJson } from './league-cloud-files.ts';

export type PipelineIdentity = ReturnType<typeof LeagueProducerProofSchema.parse>['identity'];
export async function sealLeagueProducer(
  input: LeagueCloudInput,
  resultRoot: string,
  root: string,
  identity: PipelineIdentity,
  runner: number,
  pool?: ReplayVerifier,
) {
  const result = LeaguePartitionResultSchema.parse(
    await cloudJson(join(resultRoot, 'result.json')),
  );
  if (
    canonicalJson(input.plan.source) !== canonicalJson(identity.source) ||
    input.reservation.executionId !== `league-${identity.runId}-${identity.runAttempt}`
  )
    throw new OperationError('IDENTITY_MISMATCH', 'Producer execution mismatch');
  const publication = join(root, 'public');
  // Every recording is reopened by the independent engine-free public verifier in this pool.
  const built = await buildPublication(
    input.batch,
    [{ index: result.index, bundles: new BattleBundles(join(resultRoot, 'bundles')) }],
    publication,
    pool,
    undefined,
    true,
  );
  await commitPublication(publication, built.files, [built.setRef], { schemaVersion: 2 });
  const graph = await PublicationEvidence.producer(publication, async () => {});
  const files = [...evidenceGraph(graph).files.values()].map(({ key, bytes, checksum }) => ({
    key,
    bytes,
    checksum,
  }));
  if (files.reduce((sum, file) => sum + file.bytes, 0) > 256 * 1024 ** 2)
    throw new OperationError('BUDGET_EXCEEDED', 'Producer payload exceeds partition bound');
  await writeCloudJson(join(root, 'result.json'), result);
  const proof = LeagueProducerProofSchema.parse({
    schemaVersion: 1,
    identity,
    runner,
    partition: input.partition.index,
    partitionId: input.partition.id,
    planId: input.plan.id,
    inputHash: sha256(canonicalJson(input)),
    resultHash: sha256(canonicalJson(result)),
    setHash: built.setHash,
    files,
  });
  await writeCloudJson(join(root, 'proof.json'), proof);
  return proof;
}

export async function authenticateLeagueProducer(
  root: string,
  inputValue: unknown,
  identity: PipelineIdentity,
  runner: number,
  authenticate: () => Promise<readonly ReturnType<typeof LeagueProducerArtifactSchema.parse>[]>,
) {
  // Authenticate the actual downloaded ZIPs and trusted Actions producer before using its claims.
  const artifacts = (await authenticate()).map((ref) => LeagueProducerArtifactSchema.parse(ref));
  const input = LeagueCloudInputSchema.parse(inputValue);
  const proof = LeagueProducerProofSchema.parse(await cloudJson(join(root, 'proof.json')));
  const result = LeaguePartitionResultSchema.parse(await cloudJson(join(root, 'result.json')));
  const names = artifacts.map((ref) => ref.name).sort();
  if (
    artifacts.length < 1 ||
    artifacts.length > 3 ||
    new Set(artifacts.map((ref) => ref.id)).size !== artifacts.length ||
    names.some(
      (name, index) =>
        name !==
        `league-${identity.runId}-${identity.runAttempt}-runner-${runner}-partition-${input.partition.index}-part-${index}-of-${artifacts.length}`,
    )
  )
    throw new OperationError('IDENTITY_MISMATCH', 'Producer artifact identity/coverage mismatch');
  if (
    canonicalJson(proof.identity) !== canonicalJson(identity) ||
    proof.runner !== runner ||
    proof.partition !== input.partition.index ||
    proof.partitionId !== input.partition.id ||
    proof.planId !== input.plan.id ||
    proof.inputHash !== sha256(canonicalJson(input)) ||
    proof.resultHash !== sha256(canonicalJson(result)) ||
    result.reservationId !== input.reservation.id ||
    canonicalJson(input.plan.source) !== canonicalJson(identity.source) ||
    input.reservation.executionId !== `league-${identity.runId}-${identity.runAttempt}`
  )
    throw new OperationError('IDENTITY_MISMATCH', 'Producer proof identity mismatch');
  const evidence = await PublicationEvidence.producer(join(root, 'public'), async () => {});
  const graph = evidenceGraph(evidence);
  const actual = [...graph.files.values()].map(({ key, bytes, checksum }) => ({
    key,
    bytes,
    checksum,
  }));
  if (
    canonicalJson(actual) !== canonicalJson(proof.files) ||
    graph.catalog.sets.length !== 1 ||
    graph.catalog.sets[0]!.setHash !== proof.setHash ||
    graph.catalog.previousCatalogHash !== null ||
    graph.catalog.leagueWork ||
    graph.catalog.leagues?.length
  )
    throw new OperationError('DATA_INVALID', 'Producer publication coverage mismatch');
  const inventory = await publicationInventory(join(root, 'public'));
  if (
    inventory.size !== graph.files.size ||
    [...inventory].some(([key, bytes]) => graph.files.get(key)?.bytes !== bytes)
  )
    throw new OperationError('DATA_INVALID', 'Unexpected producer payload');
  return { proof, result, evidence, artifacts };
}
export type LeagueProducer = Awaited<ReturnType<typeof authenticateLeagueProducer>>;

/** Fixed bounded archive groups, with immutable proof/result repeated to bind multipart transfers. */
export function producerArtifactGroups(files: readonly PublicationFile[], controlBytes: number) {
  const groups: PublicationFile[][] = [];
  let group: PublicationFile[] = [],
    bytes = controlBytes;
  if (!Number.isSafeInteger(controlBytes) || controlBytes < 1 || controlBytes > 16 * 1024 ** 2)
    throw new OperationError('BUDGET_EXCEEDED', 'Producer control bound');
  for (const file of [...files].sort((a, b) => a.key.localeCompare(b.key))) {
    if (file.bytes + controlBytes > 48 * 1024 ** 2)
      throw new OperationError('BUDGET_EXCEEDED', 'Producer archive entry bound');
    if (bytes + file.bytes > 48 * 1024 ** 2) {
      groups.push(group);
      group = [];
      bytes = controlBytes;
    }
    group.push(file);
    bytes += file.bytes;
  }
  if (group.length) groups.push(group);
  return groups;
}
