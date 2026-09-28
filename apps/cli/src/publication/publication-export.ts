import { packPublication } from './publication-packs.ts';
import { OperationError, operationInput } from '@fantasy/api/artifacts';
import type { ReplayVerifier } from '@fantasy/api/artifacts';
import { join, resolve, sep } from 'node:path';
import {
  PublicMatchPageSchema,
  BatchIndexSchema,
  PublicMatchRowSchema,
  PublicReplaySetSchema,
  ReplayManifestSchema,
  PUBLIC_PAGE_ROWS,
  MAX_REPLAY_MANIFEST_BYTES,
  assertPublicReplayBinding,
  canonicalJson,
  compareIds,
  parseJson,
  publicHashName,
  type BatchPlan,
  type PublicMatchRow,
  type PublicReplaySet,
  type RevisionRef,
} from '@fantasy/domain/spatial';
import { checkedBatch, type BatchCheckInput } from '@fantasy/api/artifacts';
import { sha256 } from '@fantasy/api/artifacts';
import {
  publicationBytes,
  publicationDirectory,
  publicationJson,
  PUBLICATION_MAX_FILES,
  type PublicationFile,
} from './publication-files.ts';
import { commitPublication } from './publication-catalog.ts';

function namedRevision(plan: BatchPlan, kind: 'character' | 'scenario', ref: RevisionRef) {
  const revision = plan.revisions.find(
    (r) =>
      r.kind === kind &&
      r.id === ref.id &&
      r.revision === ref.revision &&
      r.contentHash === ref.contentHash,
  );
  if (!revision)
    throw new OperationError('DATA_INVALID', 'Public row references a missing revision');
  return { ...ref, name: revision.definition.name };
}
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

/** Read-only batch export. No SQLite, engine execution, source checkout or network is required. */
export async function buildPublication(
  input: unknown,
  indexes: BatchCheckInput[],
  directory: string,
  pool?: ReplayVerifier,
  signal?: AbortSignal,
  packs = false,
  scoped = false,
) {
  const root = resolve(directory);
  for (const value of indexes) {
    if (overlaps(root, resolve(value.bundles.root)))
      throw new OperationError('INPUT_INVALID', 'Publication and bundle roots must be separate');
    // Empty artifact directories are absent after Actions transfers; no recording is read.
    if (!parseJson(BatchIndexSchema, value.index).slots.some((slot) => slot.receipt)) continue;
    await publicationDirectory(value.bundles.root);
    for (const collection of ['objects', 'packs', 'pack-indexes']) {
      await publicationDirectory(join(value.bundles.root, collection)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
  // New scope: never trust aggregation's earlier pass across the journal callback. Only a
  // producer passing its own open public scope (`scoped`) reuses that scope's re-hashed pass.
  const checked = await checkedBatch(
      input,
      indexes,
      scoped
        ? undefined
        : { publicData: true, ...(signal ? { signal } : {}), ...(pool ? { pool } : {}) },
    ),
    { plan } = checked;
  const files: PublicationFile[] = [],
    objects = new Set<string>(),
    rows: PublicMatchRow[] = [];
  for (const slot of [...plan.slots].sort((a, b) => compareIds(a.id, b.id))) {
    const found = checked.found.get(slot.id),
      receipt = found?.receipt ?? null;
    const row: PublicMatchRow = {
      slotId: slot.id,
      simulationHash: slot.simulationHash,
      participants: slot.spec.participants.map((p) => ({
        ...p,
        character: namedRevision(plan, 'character', p.character),
      })) as PublicMatchRow['participants'],
      scenario: namedRevision(plan, 'scenario', slot.spec.scenario),
      ruleset: slot.spec.ruleset,
      seed: slot.spec.seed,
      state: found?.state ?? 'pending',
      reused: found?.reused ?? false,
      reason: !found
        ? 'missing-shard'
        : (
            {
              complete: 'verified-result',
              failed: 'execution-failed',
              unresolved: 'recorded-unresolved',
              truncated: 'recorded-truncated',
              pending: 'not-started',
            } as const
          )[found.state],
      result: receipt ? { outcome: receipt.result.outcome, steps: receipt.result.steps } : null,
      replay: null,
      playback: 'unavailable',
      lastVerifiedStep: null,
      records: 0,
    };
    if (receipt) {
      const prefix = `objects/${publicHashName(receipt.objectHash)}/`,
        bundles = checked.sources.get(slot.id)!;
      const receiptBytes = await bundles.read(receipt.objectHash, 'receipt.json', 65536);
      if (
        canonicalJson(
          operationInput(
            () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)),
            'DATA_INVALID',
          ),
        ) !== canonicalJson(receipt)
      )
        throw new OperationError('DATA_INVALID', 'Receipt changed after verification');
      const manifestBytes = await bundles.read(
        receipt.objectHash,
        'manifest.json',
        MAX_REPLAY_MANIFEST_BYTES,
      );
      if (sha256(manifestBytes) !== receipt.manifestChecksum)
        throw new OperationError('DATA_INVALID', 'Manifest changed after verification');
      const manifest = operationInput(
        () =>
          parseJson(
            ReplayManifestSchema,
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as unknown,
          ),
        'DATA_INVALID',
      );
      if (
        manifest.input.engineVersion !== plan.engineVersion ||
        manifest.input.implementationDigest !== plan.implementationDigest
      )
        throw new OperationError('IDENTITY_MISMATCH', 'Plan/replay source identity mismatch');
      row.replay = {
        objectHash: receipt.objectHash,
        simulationHash: receipt.simulationHash,
        resultId: receipt.resultId,
        attemptId: receipt.attemptId,
        replayId: receipt.replayId,
        manifestChecksum: receipt.manifestChecksum,
        receiptChecksum: sha256(receiptBytes),
        receiptBytes: receiptBytes.length,
      };
      row.playback = row.state === 'complete' ? 'full' : 'partial';
      row.lastVerifiedStep = manifest.lastVerifiedStep;
      row.records = manifest.records;
      assertPublicReplayBinding(row, receipt, manifest);
      if (!objects.has(receipt.objectHash)) {
        objects.add(receipt.objectHash);
        for (const [name, data] of [
          ['receipt.json', receiptBytes],
          ['manifest.json', manifestBytes],
        ] as const) {
          const size = data.length;
          const file = {
            key: prefix + name,
            bytes: size,
            checksum: sha256(data),
            load: () => bundles.read(receipt.objectHash, name, size),
          };
          await publicationBytes(file);
          files.push(file);
        }
        for (const ref of [...manifest.chunks, ...manifest.checkpoints]) {
          const file = {
            key: prefix + ref.file,
            bytes: ref.bytes,
            checksum: ref.checksum,
            load: () => bundles.read(receipt.objectHash, ref.file, ref.bytes),
            rawBytes: ref.rawBytes,
          };
          // Privacy was checked on the original parsed JSON during full validation.
          // Re-read exact bytes here and again at write time; never trust mutable paths.
          await publicationBytes(file);
          files.push(file);
        }
        if (files.length > PUBLICATION_MAX_FILES)
          throw new OperationError('BUDGET_EXCEEDED', 'Publication file count limit');
      }
    }
    rows.push(parseJson(PublicMatchRowSchema, row));
  }
  if (packs) {
    const packed = await packPublication(files, rows, signal);
    files.splice(0, files.length, ...packed);
  }
  const counts = { complete: 0, failed: 0, unresolved: 0, truncated: 0, pending: 0 };
  rows.forEach((row) => counts[row.state]++);
  const pages: PublicationFile[] = [],
    pageRefs: PublicReplaySet['pages'] = [];
  for (let offset = 0; offset < rows.length; offset += PUBLIC_PAGE_ROWS) {
    const index = pages.length,
      page = PublicMatchPageSchema.parse({
        schemaVersion: packs ? 2 : 1,
        planId: plan.id,
        index,
        rows: rows.slice(offset, offset + PUBLIC_PAGE_ROWS),
      });
    // Temporary valid key; the set hash is computed only after all page references are known.
    const file = publicationJson(`sets/${'0'.repeat(64)}/${'0'.repeat(64)}.json`, page);
    pages.push(file);
    pageRefs.push({ index, pageHash: file.checksum, bytes: file.bytes, rows: page.rows.length });
  }
  const set = PublicReplaySetSchema.parse({
    schemaVersion: packs ? 2 : 1,
    planId: plan.id,
    source: plan.source,
    engineVersion: plan.engineVersion,
    implementationDigest: plan.implementationDigest,
    budget: plan.budget,
    totalRows: rows.length,
    incompleteRows: rows.length - counts.complete,
    counts,
    pages: pageRefs,
  });
  const setFile = publicationJson(`sets/${'0'.repeat(64)}/set.json`, set),
    setHash = setFile.checksum;
  setFile.key = `sets/${publicHashName(setHash)}/set.json`;
  files.push(
    ...pages.map((file) => ({
      ...file,
      key: `sets/${publicHashName(setHash)}/${publicHashName(file.checksum)}.json`,
    })),
    setFile,
  );
  return {
    files,
    setHash,
    set,
    rows,
    complete: checked.summary.complete,
    setRef: { setHash, bytes: setFile.bytes },
  };
}

export async function exportPublication(
  input: unknown,
  indexes: BatchCheckInput[],
  directory: string,
  maxBytes?: number,
  packs = false,
) {
  const built = await buildPublication(input, indexes, directory, undefined, undefined, packs);
  const written = await commitPublication(directory, built.files, [built.setRef], {
    maxBytes,
    schemaVersion: built.set.schemaVersion,
  });
  return {
    setHash: built.setHash,
    totalRows: built.set.totalRows,
    counts: built.set.counts,
    incompleteRows: built.set.incompleteRows,
    complete: built.complete,
    ...written,
  };
}
