import { OperationError, operationInput } from '@fantasy/api/artifacts';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  PublicCatalogCurrentSchema,
  PublicCatalogSchema,
  MAX_PUBLIC_JSON_BYTES,
  canonicalJson,
  compareIds,
  publicHashName,
  type PublicCatalog,
} from '@fantasy/domain/spatial';
import { readBoundedFile, sha256 } from '@fantasy/api/artifacts';
import {
  optionalPublicationFile,
  publicationDirectory,
  publicationJson,
  writePublication,
  PUBLICATION_MAX_BYTES,
  type PublicationFile,
} from './publication-files.ts';

/** Commit all sets and optional league metadata as one catalog generation. */
export async function commitPublication(
  directory: string,
  files: PublicationFile[],
  addedSets: PublicCatalog['sets'],
  options: {
    maxBytes?: number | undefined;
    league?: NonNullable<PublicCatalog['leagues']>[number];
    leagueWork?: PublicCatalog['leagueWork'];
  } = {},
) {
  const root = resolve(directory);
  await publicationDirectory(root, true);
  const lock = join(root, '.publication-lock');
  await mkdir(lock);
  try {
    const previous = await optionalPublicationFile(
      join(root, 'catalog/current.json'),
      MAX_PUBLIC_JSON_BYTES,
    );
    let priorHash: string | null = null;
    let prior: PublicCatalog | undefined;
    let priorFile: PublicationFile | undefined;
    if (previous) {
      const pointer = operationInput(
        () =>
          PublicCatalogCurrentSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(previous)),
          ),
        'DATA_INVALID',
      );
      const key = `catalog/${publicHashName(pointer.catalogHash)}.json`;
      const data = await readBoundedFile(join(root, key), pointer.bytes);
      if (data.length !== pointer.bytes || sha256(data) !== pointer.catalogHash)
        throw new OperationError('DATA_INVALID', 'Existing catalog checksum mismatch');
      prior = operationInput(
        () =>
          PublicCatalogSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)),
          ),
        'DATA_INVALID',
      );
      priorHash = pointer.catalogHash;
      priorFile = { key, bytes: data.length, checksum: priorHash, data };
    }
    const sets = new Map((prior?.sets ?? []).map((ref) => [ref.setHash, ref]));
    for (const ref of addedSets) {
      const old = sets.get(ref.setHash);
      if (old && old.bytes !== ref.bytes)
        throw new OperationError('DATA_INVALID', 'Existing set size mismatch');
      sets.set(ref.setHash, ref);
    }
    const leagues = new Map((prior?.leagues ?? []).map((ref) => [ref.id, ref]));
    if (options.league) {
      const previous = leagues.get(options.league.id);
      if (
        previous &&
        (previous.leagueClass ?? 'standard') !== (options.league.leagueClass ?? 'standard')
      )
        throw new OperationError(
          'IDENTITY_MISMATCH',
          'League class change requires a separate league ID',
        );
      leagues.set(options.league.id, options.league);
    }
    const leagueWork = options.leagueWork ?? prior?.leagueWork;
    const catalog = PublicCatalogSchema.parse({
      schemaVersion: 1,
      previousCatalogHash: priorHash,
      sets: [...sets.values()].sort((a, b) => compareIds(a.setHash, b.setHash)),
      ...(leagues.size
        ? { leagues: [...leagues.values()].sort((a, b) => compareIds(a.id, b.id)) }
        : {}),
      ...(leagueWork ? { leagueWork } : {}),
    });
    const same =
      prior &&
      canonicalJson({ ...prior, previousCatalogHash: null }) ===
        canonicalJson({ ...catalog, previousCatalogHash: null });
    const catalogFile = same
      ? priorFile!
      : publicationJson(`catalog/${'0'.repeat(64)}.json`, catalog);
    catalogFile.key = `catalog/${publicHashName(catalogFile.checksum)}.json`;
    const current = publicationJson(
      'catalog/current.json',
      PublicCatalogCurrentSchema.parse({
        schemaVersion: 1,
        catalogHash: catalogFile.checksum,
        bytes: catalogFile.bytes,
      }),
    );
    const written = await writePublication(
      root,
      [...files, catalogFile],
      current,
      previous,
      options.maxBytes ?? PUBLICATION_MAX_BYTES,
    );
    return { catalogHash: catalogFile.checksum, ...written };
  } finally {
    await rm(lock, { recursive: true });
  }
}
