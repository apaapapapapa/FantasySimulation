import { sql } from 'drizzle-orm';
import { check, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// JSON remains text at the persistence boundary: the domain's Zod schemas
// validate it on both write and read. Never move domain contracts into this file.
export const characters = sqliteTable(
  'characters',
  {
    id: text('id').primaryKey().notNull(),
    definition: text('definition').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [check('characters_definition_json', sql`json_valid(${table.definition})`)],
);

export const rulesets = sqliteTable(
  'rulesets',
  {
    version: text('version').primaryKey().notNull(),
    definition: text('definition').notNull(),
  },
  (table) => [check('rulesets_definition_json', sql`json_valid(${table.definition})`)],
);

export const battles = sqliteTable(
  'battles',
  {
    id: text('id').primaryKey().notNull(),
    rulesVersion: text('rules_version')
      .notNull()
      .references(() => rulesets.version),
    recordJson: text('record_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    check('battles_record_json_valid', sql`json_valid(${table.recordJson})`),
    index('battles_created_at').on(sql`created_at desc`, sql`id desc`),
  ],
);
