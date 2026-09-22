import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const kinds = [
  'character',
  'ability',
  'equipment',
  'policy',
  'status',
  'ruleset',
  'scenario',
] as const;

export const publishedRevisions = sqliteTable(
  'published_revisions',
  {
    kind: text('kind', { enum: kinds }).notNull(),
    definitionId: text('definition_id').notNull(),
    revision: integer('revision').notNull(),
    contentHash: text('content_hash').notNull(),
    revisionJson: text('revision_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.definitionId, table.revision] }),
    check(
      'published_revisions_kind',
      sql`${table.kind} IN ('character','ability','equipment','policy','status','ruleset','scenario')`,
    ),
    check('published_revisions_positive_revision', sql`${table.revision} > 0`),
    check('published_revisions_valid_json', sql`json_valid(${table.revisionJson})`),
  ],
);

export const definitionDrafts = sqliteTable(
  'definition_drafts',
  {
    id: text('id').primaryKey().notNull(),
    kind: text('kind', { enum: kinds }).notNull(),
    definitionId: text('definition_id').notNull(),
    version: integer('version').notNull(),
    definitionJson: text('definition_json').notNull(),
    publishedJson: text('published_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    baseRevisionJson: text('base_revision_json'),
  },
  (table) => [
    check(
      'definition_drafts_kind',
      sql`${table.kind} IN ('character','ability','equipment','policy','status','ruleset','scenario')`,
    ),
    check('definition_drafts_positive_version', sql`${table.version} > 0`),
    check('definition_drafts_valid_json', sql`json_valid(${table.definitionJson})`),
    check(
      'definition_drafts_valid_published',
      sql`${table.publishedJson} IS NULL OR json_valid(${table.publishedJson})`,
    ),
    check(
      'definition_drafts_valid_base',
      sql`${table.baseRevisionJson} IS NULL OR json_valid(${table.baseRevisionJson})`,
    ),
  ],
);

export const battleSpecs = sqliteTable(
  'battle_specs',
  {
    simulationHash: text('simulation_hash').primaryKey().notNull(),
    manifestJson: text('manifest_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [check('battle_specs_valid_json', sql`json_valid(${table.manifestJson})`)],
);
