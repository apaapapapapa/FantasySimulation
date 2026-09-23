import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export function legacyStorage(directory: string, version: string | null = 'spatial-v1.10') {
  const filename = join(directory, 'fantasy.sqlite'),
    root = join(directory, 'replays');
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec(
    'CREATE TABLE published_revisions(kind TEXT, revision_json TEXT); CREATE TABLE definition_drafts(definition_json TEXT);',
  );
  db.prepare('INSERT INTO published_revisions VALUES(?,?)').run(
    'ruleset',
    JSON.stringify({ definition: { rulesVersion: version } }),
  );
  db.prepare('INSERT INTO definition_drafts VALUES(?)').run('{"unfinished":"旧版の編集"}');
  const bundle = join(root, '11111111-1111-4111-8111-111111111111');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(root, '.store-id'), 'old-database');
  writeFileSync(
    join(bundle, 'manifest.json'),
    JSON.stringify({ input: { engineVersion: version } }),
  );
  writeFileSync(join(bundle, 'chunk-00000.ndjson.gz'), 'old immutable bytes');
  return { db, filename, root };
}

export function storageHashes(directory: string) {
  return Object.fromEntries(
    readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [
          path.slice(directory.length),
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        ];
      }),
  );
}
