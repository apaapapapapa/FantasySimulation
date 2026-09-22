import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { asc, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  BattleRecordSchema,
  CharacterSchema,
  type BattleResult,
  type Character,
  type Ruleset,
} from '@fantasy/domain';
import { repositoryRoot } from './config.ts';
import { battles, characters, rulesets } from './db/schema.ts';

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') throw new Error('Invalid JSON in database.');
  return JSON.parse(value) as unknown;
}

export function openStore(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  const db = drizzle(sqlite);
  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
    // Official Drizzle migrator consumes the same Kit-generated SQL/journal and
    // __drizzle_migrations table as db:migrate. There is no application runner.
    migrate(db, { migrationsFolder: join(repositoryRoot, 'db/drizzle') });
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return {
    close: () => sqlite.close(),
    listCharacters: () =>
      db
        .select({ definition: characters.definition })
        .from(characters)
        .orderBy(asc(characters.id))
        .all()
        .map((row) => CharacterSchema.parse(jsonValue(row.definition))),
    getCharacter(id: string): Character | undefined {
      const row = db
        .select({ definition: characters.definition })
        .from(characters)
        .where(eq(characters.id, id))
        .get();
      return row ? CharacterSchema.parse(jsonValue(row.definition)) : undefined;
    },
    saveCharacter(input: Character) {
      const character = CharacterSchema.parse(input);
      const definition = JSON.stringify(character);
      const updatedAt = new Date().toISOString();
      db.insert(characters)
        .values({ id: character.id, definition, updatedAt })
        .onConflictDoUpdate({ target: characters.id, set: { definition, updatedAt } })
        .run();
      return character;
    },
    seedCharacters(inputs: Character[]) {
      const validated = inputs.map((character) => CharacterSchema.parse(character));
      db.transaction(
        (tx) => {
          for (const character of validated) {
            tx.insert(characters)
              .values({
                id: character.id,
                definition: JSON.stringify(character),
                updatedAt: new Date().toISOString(),
              })
              .onConflictDoNothing({ target: characters.id })
              .run();
          }
        },
        { behavior: 'immediate' },
      );
    },
    registerRuleset(rules: Ruleset) {
      const definition = JSON.stringify(rules);
      db.insert(rulesets)
        .values({ version: rules.version, definition })
        .onConflictDoNothing({ target: rulesets.version })
        .run();
      const saved = db
        .select({ definition: rulesets.definition })
        .from(rulesets)
        .where(eq(rulesets.version, rules.version))
        .get();
      if (saved?.definition !== definition)
        throw new Error('Rules changed without a version bump.');
    },
    saveBattle(participants: [Character, Character], result: BattleResult) {
      const record = BattleRecordSchema.parse({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        participants,
        result,
      });
      db.insert(battles)
        .values({
          id: record.id,
          rulesVersion: result.rulesVersion,
          recordJson: JSON.stringify(record),
          createdAt: record.createdAt,
        })
        .run();
      return record;
    },
    listBattles: () =>
      db
        .select({ recordJson: battles.recordJson })
        .from(battles)
        .orderBy(desc(battles.createdAt), desc(battles.id))
        .limit(50)
        .all()
        .map((row) => BattleRecordSchema.parse(jsonValue(row.recordJson))),
  };
}

export function readSampleCharacters(): Character[] {
  const directory = join(repositoryRoot, 'data/characters');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => CharacterSchema.parse(jsonValue(readFileSync(join(directory, name), 'utf8'))));
}

export type Store = ReturnType<typeof openStore>;
