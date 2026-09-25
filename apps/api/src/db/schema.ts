import {
  ARTIFACT_RESERVATION_BYTES,
  MAX_JOB_ATTEMPTS,
  MAX_BATTLE_STEPS,
  DEFINITION_KINDS,
} from '@fantasy/domain/spatial';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const kinds = DEFINITION_KINDS;
// Only schema-owned enum literals enter generated DDL; runtime values remain bound parameters.
const kindCheck = sql.raw(kinds.map((kind) => `'${kind.replaceAll("'", "''")}'`).join(','));

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
    check('published_revisions_kind', sql`${table.kind} IN (${kindCheck})`),
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
    check('definition_drafts_kind', sql`${table.kind} IN (${kindCheck})`),
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

export const simulationJobs = sqliteTable(
  'simulation_jobs',
  {
    id: text('id').primaryKey().notNull(),
    simulationHash: text('simulation_hash')
      .notNull()
      .references(() => battleSpecs.simulationHash),
    clientId: text('client_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    budgetJson: text('budget_json').notNull(),
    state: text('state', {
      enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    currentAttemptId: text('current_attempt_id'),
    resultId: text('result_id'),
    error: text('error'),
    failureCode: text('failure_code', { enum: ['determinism-violation'] }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('job_idempotency').on(t.clientId, t.idempotencyKey),
    index('job_queue').on(t.state, t.createdAt, t.id),
    check('job_state', sql`${t.state} IN ('queued','running','completed','failed','cancelled')`),
    check(
      'job_attempt_limit',
      sql`${t.attempts} >= 0 AND ${t.attempts} <= ${t.maxAttempts} AND ${t.maxAttempts} BETWEEN 1 AND ${sql.raw(String(MAX_JOB_ATTEMPTS))}`,
    ),
    check('job_budget_json', sql`json_valid(${t.budgetJson})`),
  ],
);

export const simulationAttempts = sqliteTable(
  'simulation_attempts',
  {
    id: text('id').primaryKey().notNull(),
    jobId: text('job_id')
      .notNull()
      .references(() => simulationJobs.id),
    number: integer('number').notNull(),
    token: text('token').notNull(),
    state: text('state', {
      enum: ['running', 'completed', 'failed', 'cancelled', 'expired', 'conflict'],
    }).notNull(),
    budgetJson: text('budget_json').notNull(),
    leaseUntil: integer('lease_until').notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    replayId: text('replay_id'),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('attempt_number').on(t.jobId, t.number),
    uniqueIndex('attempt_token').on(t.token),
    index('attempt_lease').on(t.state, t.leaseUntil),
    check(
      'attempt_state',
      sql`${t.state} IN ('running','completed','failed','cancelled','expired','conflict')`,
    ),
    check('attempt_budget_json', sql`json_valid(${t.budgetJson})`),
  ],
);

export const battleResults = sqliteTable(
  'battle_results',
  {
    id: text('id').primaryKey().notNull(),
    simulationHash: text('simulation_hash')
      .notNull()
      .references(() => battleSpecs.simulationHash),
    canonicalHash: text('canonical_hash'),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => simulationAttempts.id),
    resultHash: text('result_hash').notNull(),
    resultJson: text('result_json').notNull(),
    replayId: text('replay_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('result_canonical').on(t.canonicalHash),
    uniqueIndex('result_attempt').on(t.attemptId),
    check('result_json', sql`json_valid(${t.resultJson})`),
  ],
);

export const replayArtifacts = sqliteTable(
  'replay_artifacts',
  {
    id: text('id').primaryKey().notNull(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => simulationAttempts.id),
    manifestChecksum: text('manifest_checksum').notNull(),
    validationProfile: text('validation_profile'),
    bytes: integer('bytes').notNull(),
    state: text('state', { enum: ['ready', 'missing', 'corrupt', 'quarantined'] }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('artifact_attempt').on(t.attemptId),
    check('artifact_state', sql`${t.state} IN ('ready','missing','corrupt','quarantined')`),
    check(
      'artifact_bytes',
      sql`${t.bytes} > 0 AND ${t.bytes} <= ${sql.raw(String(ARTIFACT_RESERVATION_BYTES))}`,
    ),
  ],
);

// One coordinator owns a database/artifact root. PID liveness is checked only on the same host.
export const runtimeOwner = sqliteTable(
  'runtime_owner',
  {
    id: integer('id').primaryKey().notNull(),
    storeId: text('store_id').notNull(),
    artifactRoot: text('artifact_root').notNull(),
    hostname: text('hostname').notNull(),
    pid: integer('pid').notNull(),
    token: text('token').notNull(),
  },
  (t) => [check('runtime_singleton', sql`${t.id} = 1`)],
);

export const attemptMetrics = sqliteTable(
  'attempt_metrics',
  {
    attemptId: text('attempt_id')
      .primaryKey()
      .notNull()
      .references(() => simulationAttempts.id),
    progressStep: integer('progress_step').notNull().default(0),
    metricsJson: text('metrics_json'),
  },
  (t) => [
    check(
      'attempt_progress',
      sql`${t.progressStep} BETWEEN 0 AND ${sql.raw(String(MAX_BATTLE_STEPS))}`,
    ),
    check('attempt_metrics_json', sql`${t.metricsJson} IS NULL OR json_valid(${t.metricsJson})`),
  ],
);
