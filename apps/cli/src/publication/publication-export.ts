import { mkdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  PublicCatalogCurrentSchema,
  PublicCatalogSchema,
  PublicMatchPageSchema,
  PublicMatchRowSchema,
  PublicReplaySetSchema,
  ReplayManifestSchema,
  PUBLIC_PAGE_ROWS,
  MAX_PUBLIC_JSON_BYTES,
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
import { readBoundedFile, sha256 } from '@fantasy/api/artifacts';
import {
  inspectPublicArtifact,
  optionalPublicationFile,
  publicationDirectory,
  publicationJson,
  writePublication,
  PUBLICATION_MAX_BYTES,
  PUBLICATION_MAX_FILES,
  type PublicationFile,
} from './publication-files.ts';

function namedRevision(plan: BatchPlan, kind: 'character' | 'scenario', ref: RevisionRef) {
  const revision = plan.revisions.find(
    (r) =>
      r.kind === kind &&
      r.id === ref.id &&
      r.revision === ref.revision &&
      r.contentHash === ref.contentHash,
  );
  if (!revision) throw new Error('Public row references a missing revision');
  return { ...ref, name: revision.definition.name };
}
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

/** Read-only batch export. No SQLite, engine execution, source checkout or network is required. */
export async function exportPublication(
  input: unknown,
  indexes: BatchCheckInput[],
  directory: string,
  maxBytes = PUBLICATION_MAX_BYTES,
) {
  const root = resolve(directory);
  for (const value of indexes) {
    if (overlaps(root, resolve(value.bundles.root)))
      throw new Error('Publication and bundle roots must be separate');
    await publicationDirectory(value.bundles.root);
    await publicationDirectory(join(value.bundles.root, 'objects'));
  }
  const checked = await checkedBatch(input, indexes),
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
        source = join(checked.sources.get(slot.id)!.root, prefix);
      await publicationDirectory(source);
      const receiptBytes = await readBoundedFile(join(source, 'receipt.json'), 65536);
      if (canonicalJson(JSON.parse(receiptBytes.toString('utf8'))) !== canonicalJson(receipt))
        throw new Error('Receipt changed after verification');
      const manifestBytes = await readBoundedFile(
        join(source, 'manifest.json'),
        MAX_REPLAY_MANIFEST_BYTES,
      );
      if (sha256(manifestBytes) !== receipt.manifestChecksum)
        throw new Error('Manifest changed after verification');
      const manifest = parseJson(
        ReplayManifestSchema,
        JSON.parse(manifestBytes.toString('utf8')) as unknown,
      );
      if (
        manifest.input.engineVersion !== plan.engineVersion ||
        manifest.input.implementationDigest !== plan.implementationDigest
      )
        throw new Error('Plan/replay source identity mismatch');
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
          const file = {
            key: prefix + name,
            bytes: data.length,
            checksum: sha256(data),
            source: join(source, name),
          };
          await inspectPublicArtifact(file);
          files.push(file);
        }
        for (const ref of [...manifest.chunks, ...manifest.checkpoints]) {
          const file = {
            key: prefix + ref.file,
            bytes: ref.bytes,
            checksum: ref.checksum,
            source: join(source, ref.file),
          };
          await inspectPublicArtifact(file, ref.rawBytes);
          files.push(file);
        }
        if (files.length > PUBLICATION_MAX_FILES) throw new Error('Publication file count limit');
      }
    }
    rows.push(parseJson(PublicMatchRowSchema, row));
  }
  const counts = { complete: 0, failed: 0, unresolved: 0, truncated: 0, pending: 0 };
  rows.forEach((row) => counts[row.state]++);
  const pages: PublicationFile[] = [],
    pageRefs: PublicReplaySet['pages'] = [];
  for (let offset = 0; offset < rows.length; offset += PUBLIC_PAGE_ROWS) {
    const index = pages.length,
      page = PublicMatchPageSchema.parse({
        schemaVersion: 1,
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
    schemaVersion: 1,
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
  await publicationDirectory(root, true);
  const lock = join(root, '.publication-lock');
  await mkdir(lock); // One local publisher; an interrupted lock requires explicit operator recovery.
  try {
    const previous = await optionalPublicationFile(
      join(root, 'catalog/current.json'),
      MAX_PUBLIC_JSON_BYTES,
    );
    let priorHash: string | null = null,
      sets = [{ setHash, bytes: setFile.bytes }];
    let catalogFile: PublicationFile;
    if (previous) {
      const pointer = PublicCatalogCurrentSchema.parse(JSON.parse(previous.toString('utf8')));
      const key = `catalog/${publicHashName(pointer.catalogHash)}.json`;
      const data = await readBoundedFile(join(root, key), pointer.bytes);
      if (data.length !== pointer.bytes || sha256(data) !== pointer.catalogHash)
        throw new Error('Existing catalog checksum mismatch');
      const prior = PublicCatalogSchema.parse(JSON.parse(data.toString('utf8')));
      priorHash = pointer.catalogHash;
      sets = prior.sets;
      const existing = sets.find((s) => s.setHash === setHash);
      if (existing && existing.bytes !== setFile.bytes)
        throw new Error('Existing set size mismatch');
      if (!existing) sets = [...sets, { setHash, bytes: setFile.bytes }];
      catalogFile = existing
        ? { key, bytes: data.length, checksum: pointer.catalogHash, data }
        : makeCatalog();
    } else catalogFile = makeCatalog();
    function makeCatalog() {
      const value = PublicCatalogSchema.parse({
        schemaVersion: 1,
        previousCatalogHash: priorHash,
        sets: sets.sort((a, b) => compareIds(a.setHash, b.setHash)),
      });
      const file = publicationJson(`catalog/${'0'.repeat(64)}.json`, value);
      file.key = `catalog/${publicHashName(file.checksum)}.json`;
      return file;
    }
    files.push(catalogFile);
    const current = publicationJson(
      'catalog/current.json',
      PublicCatalogCurrentSchema.parse({
        schemaVersion: 1,
        catalogHash: catalogFile.checksum,
        bytes: catalogFile.bytes,
      }),
    );
    const written = await writePublication(root, files, current, previous, maxBytes);
    return {
      setHash,
      catalogHash: catalogFile.checksum,
      totalRows: set.totalRows,
      counts,
      incompleteRows: set.incompleteRows,
      complete: checked.summary.complete,
      ...written,
    };
  } finally {
    await rm(lock, { recursive: true });
  }
}
