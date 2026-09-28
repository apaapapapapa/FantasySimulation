import { join } from 'node:path';
import { BattleBundles, OperationError, publishImmutableFile } from '@fantasy/api/artifacts';
import { checkStoredLeague } from '@fantasy/api/tooling';
import { canonicalJson, LeagueProducerTerminalSchema } from '@fantasy/domain/spatial';
import { preparedLeague, cloudInput } from './league-cloud-files.ts';
import { assignLeagueRunners } from './league-assignment.ts';
import { preparedLeagueCosts } from './league-cost-profile.ts';
import { composeLeaguePublication } from './league-export.ts';
import { finishCheckedLeagueWork } from './league-work.ts';
import {
  PublicationEvidence,
  evidenceGraph,
  evidenceMetadata,
} from '../publication/publication-evidence.ts';
import { publicationDirectory } from '../publication/publication-files.ts';
import { dirname } from 'node:path';
import type { LeagueProducer, PipelineIdentity } from './league-producer.ts';

export async function copyEvidenceMetadata(
  evidence: PublicationEvidence,
  root: string,
  pointer = true,
) {
  for (const file of await evidenceMetadata(evidence)) {
    if (file.key.startsWith('pack-indexes/') || (!pointer && file.key.startsWith('catalog/')))
      continue;
    const path = join(root, file.key);
    await publicationDirectory(dirname(path), true);
    await publishImmutableFile(path, file.data);
  }
}

export async function finalizeLeaguePipeline(
  preparedRoot: string,
  root: string,
  producers: readonly LeagueProducer[],
  terminals: readonly unknown[],
  identity: PipelineIdentity,
  runners: number,
  successfulJobs: () => Promise<void>,
  baseline?: PublicationEvidence,
) {
  const prepared = await preparedLeague(preparedRoot);
  if (
    canonicalJson(prepared.plan.source) !== canonicalJson(identity.source) ||
    prepared.executionId !== `league-${identity.runId}-${identity.runAttempt}`
  )
    throw new OperationError('IDENTITY_MISMATCH', 'Finalizer execution mismatch');
  const assignments = assignLeagueRunners(
    prepared.plan,
    runners,
    await preparedLeagueCosts(preparedRoot, prepared),
  );
  const receipts = terminals.map((value) => LeagueProducerTerminalSchema.parse(value));
  if (
    receipts.length !== assignments.length ||
    new Set(receipts.map((r) => r.runner)).size !== receipts.length
  )
    throw new OperationError('DATA_INVALID', 'Missing or duplicate terminal receipt');
  const archiveIds = producers.flatMap((producer) => producer.artifacts.map((ref) => ref.id));
  if (new Set(archiveIds).size !== archiveIds.length)
    throw new OperationError('DATA_INVALID', 'Duplicate producer artifact');
  for (const receipt of receipts) {
    const assignment = assignments[receipt.runner];
    if (
      !assignment ||
      canonicalJson(receipt.identity) !== canonicalJson(identity) ||
      canonicalJson(receipt.partitions) !== canonicalJson(assignment.partitions)
    )
      throw new OperationError('DATA_INVALID', 'Terminal assignment mismatch');
    const expected = producers
      .filter((producer) => producer.proof.runner === receipt.runner)
      .flatMap((producer) => producer.artifacts);
    const ordered = (refs: typeof expected) => [...refs].sort((a, b) => a.id - b.id);
    if (canonicalJson(ordered(expected)) !== canonicalJson(ordered(receipt.artifacts)))
      throw new OperationError('DATA_INVALID', 'Terminal immutable artifact coverage mismatch');
  }
  await successfulJobs();
  const byIndex = new Map(producers.map((producer) => [producer.proof.partition, producer]));
  if (byIndex.size !== producers.length || producers.length !== prepared.inputs.length)
    throw new OperationError('DATA_INVALID', 'Missing or duplicate producer partition');
  const inputs = [],
    completed = [];
  for (let index = 0; index < prepared.inputs.length; index++) {
    const input = await cloudInput(preparedRoot, prepared, index),
      producer = byIndex.get(index);
    const runner = assignments.find((a) => a.partitions.includes(index))?.runner;
    if (
      !producer ||
      producer.proof.runner !== runner ||
      producer.proof.partitionId !== input.partition.id ||
      canonicalJson(producer.proof.identity) !== canonicalJson(identity)
    )
      throw new OperationError('DATA_INVALID', 'Producer assignment mismatch');
    inputs.push(input);
    completed.push({ ...input, result: producer.result, bundles: producer.evidence.bundles() });
  }
  const checked = await checkStoredLeague(prepared.plan, inputs, completed);
  const reserved = baseline ? evidenceGraph(baseline).latestWork : null;
  if (
    !reserved ||
    (baseline && evidenceGraph(baseline).catalog.leagueWork?.hash !== prepared.work.hash)
  )
    throw new OperationError('IDENTITY_MISMATCH', 'Finalizer reservation journal mismatch');
  const journal = await finishCheckedLeagueWork(
    checked,
    inputs.map((input) => input.reservation),
    { ...reserved, records: [...reserved.records.values()], ref: prepared.work },
    baseline?.bundles() ?? new BattleBundles(root),
  );
  await copyEvidenceMetadata(baseline!, root);
  for (const producer of producers) await copyEvidenceMetadata(producer.evidence, root, false);
  const exported = await composeLeaguePublication(
    checked,
    root,
    journal,
    async (batch) => {
      const producer = producers.find((p) => p.result.index.planId === batch.id)!;
      const graph = evidenceGraph(producer.evidence),
        setHash = producer.proof.setHash;
      const set = graph.sets.get(setHash)!;
      const rows = set.pages.flatMap(
        (page) => graph.pages.get(`${setHash}/${page.pageHash}`)!.rows,
      );
      const files = (await evidenceMetadata(producer.evidence)).filter((file) =>
        file.key.startsWith('sets/'),
      );
      return {
        files,
        set,
        rows,
        setHash,
        complete: producer.result.index.complete,
        setRef: graph.catalog.sets[0]!,
      };
    },
    true,
  );
  const evidence = await PublicationEvidence.derive(root, [
    baseline!,
    ...producers.map((p) => p.evidence),
  ]);
  return { ...exported, evidence };
}
