import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RevisionSchema, revisionIndex } from '@fantasy/domain';
import { readStartupSkillCatalogs } from '@fantasy/api/catalog';
import { inspectSkillPublications } from './skill-publication.ts';
import { CORPUS_OUTPUT, vitestOutcomes, type Corpus, type TestRun } from './corpus-checks.ts';
import { assessReport, type Report } from './report.ts';
import { git } from './source.ts';

export const SKILL_PUBLICATION_CHECK = 'skill:new-publication';
/** Called by the existing corpus runner and CI aggregate with their freshly validated test run. */
export async function recordSkillPublication(
  root: string,
  corpus: Corpus,
  tests: TestRun,
  report: Report,
  unchanged: boolean,
) {
  const directory = join(root, CORPUS_OUTPUT);
  mkdirSync(directory, { recursive: true });
  const revisions = RevisionSchema.array().parse(
    JSON.parse(readFileSync(join(root, 'data/spatial/catalog.json'), 'utf8')),
  );
  const matrix = JSON.parse(
    readFileSync(join(root, 'docs/adr/0020-skill-system-fixtures.json'), 'utf8'),
  );
  const audit = await inspectSkillPublications({
    catalogs: readStartupSkillCatalogs(revisions),
    ledger: matrix.publicationLedger,
    registry: corpus.tests,
    lookup: revisionIndex(revisions),
    sourceSha: report.sourceSha,
    execution: {
      sourceSha: report.sourceSha,
      complete:
        unchanged &&
        !git(root, ['status', '--porcelain']) &&
        git(root, ['rev-parse', 'HEAD']) === report.sourceSha &&
        !tests.error &&
        tests.failedFiles === 0 &&
        (tests.shared === true || (tests.command?.exitCode === 0 && !tests.command.bounded)),
      outcomes: tests.outcomes ?? new Map(),
    },
  });
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

/** The CI aggregate has just bound corpus results to the exact current-tree/current-run receipts. */
export function boundSkillTestRun(root: string): TestRun {
  return {
    ...vitestOutcomes(
      root,
      JSON.parse(readFileSync(join(root, CORPUS_OUTPUT, 'vitest.json'), 'utf8')),
    ),
    shared: true,
    command: null,
    error: null,
  };
}
