import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  BattleRecordSchema,
  CharacterSchema,
  type BattleResult,
  type Character,
  type Ruleset,
} from '@fantasy/domain';
import { repositoryRoot } from './config.ts';

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('Invalid JSON in database.');
  return JSON.parse(value) as unknown;
}

export function openStore(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    close: () => db.close(),
    listCharacters: () =>
      db
        .prepare('SELECT definition FROM characters ORDER BY id')
        .all()
        .map((row) => CharacterSchema.parse(jsonValue(row.definition))),
    getCharacter(id: string): Character | undefined {
      const row = db.prepare('SELECT definition FROM characters WHERE id = ?').get(id);
      return row ? CharacterSchema.parse(jsonValue(row.definition)) : undefined;
    },
    saveCharacter(input: Character) {
      const character = CharacterSchema.parse(input);
      db.prepare(`INSERT INTO characters (id, definition, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at`).run(
        character.id,
        JSON.stringify(character),
        new Date().toISOString(),
      );
      return character;
    },
    seedCharacters(characters: Character[]) {
      const validated = characters.map((character) => CharacterSchema.parse(character));
      const insert =
        db.prepare(`INSERT INTO characters (id, definition, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO NOTHING`);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const character of validated) {
          insert.run(character.id, JSON.stringify(character), new Date().toISOString());
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    registerRuleset(rules: Ruleset) {
      const definition = JSON.stringify(rules);
      db.prepare(
        'INSERT INTO rulesets (version, definition) VALUES (?, ?) ON CONFLICT(version) DO NOTHING',
      ).run(rules.version, definition);
      const saved = db
        .prepare('SELECT definition FROM rulesets WHERE version = ?')
        .get(rules.version);
      if (saved?.definition !== definition) {
        throw new Error('Rules changed without a version bump.');
      }
    },
    saveBattle(participants: [Character, Character], result: BattleResult) {
      const record = BattleRecordSchema.parse({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        participants,
        result,
      });
      db.prepare(
        'INSERT INTO battles (id, rules_version, record_json, created_at) VALUES (?, ?, ?, ?)',
      ).run(record.id, result.rulesVersion, JSON.stringify(record), record.createdAt);
      return record;
    },
    listBattles: () =>
      db
        .prepare('SELECT record_json FROM battles ORDER BY created_at DESC, id DESC LIMIT 50')
        .all()
        .map((row) => BattleRecordSchema.parse(jsonValue(row.record_json))),
  };
}

function migrate(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, checksum TEXT NOT NULL
  ) STRICT`);
  const directory = join(repositoryRoot, 'db/migrations');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const name of readdirSync(directory)
      .filter((file) => /^\d{3}_[a-z0-9_-]+\.sql$/.test(file))
      .sort()) {
      const sql = readFileSync(join(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = db
        .prepare('SELECT checksum FROM schema_migrations WHERE name = ?')
        .get(name);
      if (previous) {
        if (previous.checksum !== checksum)
          throw new Error(`Applied migration was modified: ${name}`);
        continue;
      }
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)').run(
        name,
        checksum,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function readSampleCharacters(): Character[] {
  const directory = join(repositoryRoot, 'data/characters');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => CharacterSchema.parse(jsonValue(readFileSync(join(directory, name), 'utf8'))));
}

export type Store = ReturnType<typeof openStore>;
