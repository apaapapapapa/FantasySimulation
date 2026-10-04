import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { array, CORPUS_OUTPUT, vitestOutcomes } from './corpus-checks.ts';
import { readBoundedJson } from './files.ts';
import { assessReport, identity, record, type Report } from './report.ts';
import { git, sourceIdentity } from './source.ts';
import { bindSkillProof, type SkillTestExecution } from './skill-publication-proof.ts';
import type { inspectSkillPublications } from './skill-publication.ts';

type Audit = Awaited<ReturnType<typeof inspectSkillPublications>>;
export const SKILL_PUBLICATION_CHECK = 'skill:new-publication';
export const SKILL_OBSERVATION_FILE = 'skill-publication-observation.json';
const inputPaths = [
  'docs/adr/0020-skill-system-fixtures.json',
  'packages/engine/fixtures/spatial/corpus.json',
];
export function skillObservationIdentity(root: string) {
  return {
    // The corpus subprocess intentionally receives only safeEnvironment, without PR-event metadata.
    // Its enclosing source-task receipt binds PR parents; this observation binds the physical SHA.
    info: sourceIdentity(root, {}),
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    inputs: inputPaths.map((path) =>
      createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex'),
    ),
  };
}
/** The dependency-installed observer already validated catalog, recipe and ledger schemas.
 * As with bindCorpus, consume only its unchanged source/run/attempt and exact definition bytes. */
export function bindSkillObservation(
  value: unknown,
  expected: ReturnType<typeof skillObservationIdentity>,
  execution: SkillTestExecution,
): Audit {
  const observed = record(value),
    info = identity(observed.info);
  if (
    observed.schemaVersion !== 1 ||
    observed.producer !== 'skill-publication-observer' ||
    observed.clean !== true ||
    Object.entries(expected.info).some(([key, item]) => info[key as keyof typeof info] !== item) ||
    observed.runId !== expected.runId ||
    observed.runAttempt !== expected.runAttempt ||
    JSON.stringify(observed.inputs) !== JSON.stringify(expected.inputs)
  )
    throw new Error('Stale or foreign skill publication observation');
  const audit = record(observed.audit);
  if (
    audit.sourceSha !== info.sourceSha ||
    audit.issueCompletion !== 'requires-existing-issue-completion-gate'
  )
    throw new Error('Invalid skill publication observation identity');
  const rows = array(audit.rows, 16_384, 'skill publication rows').map((value) => {
    const row = record(value) as unknown as Audit['rows'][number];
    if (
      !['historical-audit', 'new-publication'].includes(row.mode) ||
      typeof row.proof?.registered !== 'boolean'
    )
      throw new Error('Invalid skill publication row');
    array(row.proof.tests, 1024, 'skill tests');
    array(row.proof.issues, 2048, 'skill issues');
    return { ...row, proof: bindSkillProof(row.proof, info.sourceSha, execution) };
  });
  return {
    sourceSha: info.sourceSha,
    rows,
    newPublicationReady: rows
      .filter(({ mode }) => mode === 'new-publication')
      .every(({ proof }) => proof.passed),
    issueCompletion: 'requires-existing-issue-completion-gate',
  };
}
export function saveSkillPublication(root: string, audit: Audit, report: Report) {
  const directory = join(root, CORPUS_OUTPUT);
  writeFileSync(join(directory, 'skill-publication.json'), JSON.stringify(audit, null, 2) + '\n');
  const candidates = audit.rows.filter((row) => row.mode === 'new-publication');
  const historical = audit.rows.filter((row) => row.mode === 'historical-audit');
  const updated: Report = {
    ...report,
    checks: [
      ...report.checks,
      {
        id: SKILL_PUBLICATION_CHECK,
        required: true,
        status: audit.newPublicationReady ? 'pass' : 'fail',
        reason: `${candidates.filter((row) => row.proof.passed).length}/${candidates.length} new/changed nodes proven; ${historical.filter((row) => !row.proof.passed).length} historical node revisions remain unproven (audit only); Issue completion is separate`,
        evidence: [{ uri: `${CORPUS_OUTPUT}/skill-publication.json`, sourceSha: report.sourceSha }],
      },
    ],
  };
  const assessed = assessReport(
    updated,
    updated.checks.filter((check) => check.required).map((check) => check.id),
  );
  writeFileSync(join(directory, 'report.json'), JSON.stringify(assessed.report, null, 2) + '\n');
  return assessed;
}
/** Called only after bindCorpus has validated the complete current-run test receipts. No runtime imports. */
export function bindSkillPublication(root: string, report: Report) {
  const expected = skillObservationIdentity(root);
  if (git(root, ['status', '--porcelain']) || expected.info.sourceSha !== report.sourceSha)
    throw new Error('Dirty or foreign skill publication aggregate');
  const tests = vitestOutcomes(
    root,
    readBoundedJson(join(root, CORPUS_OUTPUT, 'vitest.json'), 16 * 1024 * 1024),
  );
  const audit = bindSkillObservation(
    readBoundedJson(join(root, CORPUS_OUTPUT, SKILL_OBSERVATION_FILE)),
    expected,
    {
      sourceSha: report.sourceSha,
      complete: tests.failedFiles === 0,
      outcomes: tests.outcomes ?? new Map(),
    },
  );
  return saveSkillPublication(root, audit, report);
}
