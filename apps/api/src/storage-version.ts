import { copyFileSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { CURRENT_ENGINE_VERSION } from '@fantasy/domain/spatial';
import { defaultStoragePaths } from './storage-paths.ts';
import { GENERATED_UUID, readBoundedFile } from './replay-files.ts';

type Owner = { storeId: string; artifactRoot: string };
type DatabaseIdentity = { version: string; owner?: Owner };
const unknown = 'unknown';

export class StorageVersionError extends Error {
  constructor(path: string, version: string, reason: string) {
    super(
      `Storage version rejected: ${path}; stored=${version}; current=${CURRENT_ENGINE_VERSION}. ${reason}. ` +
        `Remove DATABASE_PATH/ARTIFACT_PATH overrides or choose unused paths, e.g. ` +
        `DATABASE_PATH=${defaultStoragePaths.databasePath} and ARTIFACT_PATH=${defaultStoragePaths.artifactPath}. ` +
        'Existing data was not migrated, converted or deleted.',
    );
    this.name = 'StorageVersionError';
  }
}
function fileState(path: string) {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile()) throw new Error('Database entry must be a regular file');
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function storedIdentity(db: Database.Database): DatabaseIdentity {
  const hasTable = (name: string) =>
    !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
  const versions = new Set<string>();
  const collect = (query: string) => {
    for (const row of db.prepare<[], { version: unknown }>(query).iterate())
      versions.add(typeof row.version === 'string' && row.version ? row.version : unknown);
  };
  if (hasTable('published_revisions'))
    collect(
      "SELECT DISTINCT json_extract(revision_json, '$.definition.rulesVersion') AS version FROM published_revisions WHERE kind='ruleset'",
    );
  if (hasTable('battle_specs'))
    collect(
      "SELECT DISTINCT json_extract(manifest_json, '$.engineVersion') AS version FROM battle_specs",
    );
  const version = [...versions].sort().join(', ') || unknown;
  const owner = hasTable('runtime_owner')
    ? db
        .prepare<[], Owner>(
          'SELECT store_id AS storeId, artifact_root AS artifactRoot FROM runtime_owner WHERE id=1',
        )
        .get()
    : undefined;
  return { version, ...(owner ? { owner } : {}) };
}
/** Inspect a private copy so even SQLite WAL/SHM housekeeping cannot write the source. */
export function inspectDatabaseVersion(filename: string): DatabaseIdentity | undefined {
  if (filename === ':memory:') return undefined;
  let temporary: string | undefined;
  try {
    if (fileState(filename) === null) return undefined;
    const paths = [filename, `${filename}-wal`, `${filename}-journal`];
    const before = paths.map(fileState);
    temporary = mkdtempSync(join(tmpdir(), 'fantasy-version-'));
    const copy = join(temporary, 'database.sqlite');
    for (let index = 0; index < paths.length; index++)
      if (before[index] !== null)
        copyFileSync(
          paths[index]!,
          index === 0 ? copy : `${copy}${index === 1 ? '-wal' : '-journal'}`,
        );
    if (paths.some((path, index) => fileState(path) !== before[index]))
      throw new Error('Database changed during inspection; stop its writer and retry');
    const db = new Database(copy, { readonly: true, fileMustExist: true });
    let identity: DatabaseIdentity;
    try {
      identity = storedIdentity(db);
    } finally {
      db.close();
    }
    if (identity.version !== CURRENT_ENGINE_VERSION)
      throw new StorageVersionError(
        filename,
        identity.version,
        'Only the current battle rules are accepted',
      );
    return identity;
  } catch (error) {
    if (error instanceof StorageVersionError) throw error;
    throw new StorageVersionError(
      filename,
      unknown,
      error instanceof Error ? error.message : 'Unreadable database',
    );
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

async function inspectArtifactVersion(inputRoot: string, owner?: Owner) {
  const root = resolve(inputRoot);
  try {
    if (!(await lstat(root)).isDirectory())
      throw new Error('Artifact root must be a real directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new StorageVersionError(
      root,
      unknown,
      error instanceof Error ? error.message : 'Unreadable artifact root',
    );
  }
  let entries = 0,
    marker: string | undefined;
  const versions = new Set<string>();
  for await (const entry of await opendir(root)) {
    if (++entries > 10000) throw new StorageVersionError(root, unknown, 'Artifact entry limit');
    if (entry.name === '.store-id') {
      marker = (await readBoundedFile(join(root, entry.name), 100)).toString('utf8');
      if (owner?.storeId === marker && resolve(owner.artifactRoot) === root) return;
    } else if (entry.isDirectory() && GENERATED_UUID.test(entry.name)) {
      try {
        const value: unknown = JSON.parse(
          (await readBoundedFile(join(root, entry.name, 'manifest.json'), 2 * 1024 ** 2)).toString(
            'utf8',
          ),
        );
        const version = (value as { input?: { engineVersion?: unknown } })?.input?.engineVersion;
        versions.add(typeof version === 'string' ? version : unknown);
      } catch {
        versions.add(unknown);
      }
    }
  }
  if (!entries) return;
  throw new StorageVersionError(
    root,
    [...versions].sort().join(', ') || unknown,
    marker
      ? 'Artifact root belongs to another database'
      : 'Refusing to adopt a nonempty unowned artifact root',
  );
}

export async function assertArtifactVersion(inputRoot: string, owner?: Owner) {
  try {
    await inspectArtifactVersion(inputRoot, owner);
  } catch (error) {
    if (error instanceof StorageVersionError) throw error;
    throw new StorageVersionError(
      inputRoot,
      unknown,
      error instanceof Error ? error.message : 'Unreadable artifact root',
    );
  }
}

/** Must run before opening/migrating/seeding a database when an artifact root is configured. */
export async function assertStoragePaths(databasePath: string, artifactPath: string) {
  const identity = inspectDatabaseVersion(databasePath);
  await assertArtifactVersion(artifactPath, identity?.owner);
}
