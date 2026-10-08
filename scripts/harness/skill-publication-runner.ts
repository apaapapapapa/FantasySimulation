import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RevisionSchema, revisionIndex } from '@fantasy/domain';
import { readStartupSkillCatalogs } from '@fantasy/api/catalog';
import {
  inspectSkillPublications,
  PRE_GATE_SKILL_CATALOG,
  type SkillTestExecution,
} from './skill-publication.ts';
import { CORPUS_OUTPUT, type Corpus, type TestRun } from './corpus-checks.ts';
import type { Report } from './report.ts';
import {
  saveSkillPublication,
  skillObservationIdentity,
  SKILL_OBSERVATION_FILE,
} from './skill-publication-evidence.ts';
import { git } from './source.ts';

export { SKILL_PUBLICATION_CHECK } from './skill-publication-evidence.ts';
function inspect(
  root: string,
  corpus: Corpus,
  sourceSha: string,
  execution: SkillTestExecution | null,
) {
  const revisions = RevisionSchema.array().parse(
    JSON.parse(readFileSync(join(root, 'data/spatial/catalog.json'), 'utf8')),
  );
  const matrix = JSON.parse(
    readFileSync(join(root, 'docs/adr/0020-skill-system-fixtures.json'), 'utf8'),
  );
  return inspectSkillPublications({
    catalogs: readStartupSkillCatalogs(revisions),
    ledger: matrix.publicationLedger,
    registry: corpus.tests,
    lookup: revisionIndex(revisions),
    sourceSha,
    execution,
    historicalCutoff: PRE_GATE_SKILL_CATALOG,
  });
}
/** Standalone corpus collection uses the same proof binder as CI, with its actual test command. */
export async function recordSkillPublication(
  root: string,
  corpus: Corpus,
  tests: TestRun,
  report: Report,
  unchanged: boolean,
) {
  mkdirSync(join(root, CORPUS_OUTPUT), { recursive: true });
  const audit = await inspect(root, corpus, report.sourceSha, {
    sourceSha: report.sourceSha,
    complete:
      unchanged &&
      !git(root, ['status', '--porcelain']) &&
      git(root, ['rev-parse', 'HEAD']) === report.sourceSha &&
      !tests.error &&
      tests.failedFiles === 0 &&
      (tests.shared === true || (tests.command?.exitCode === 0 && !tests.command.bounded)),
    outcomes: tests.outcomes ?? new Map(),
  });
  return saveSkillPublication(root, audit, report);
}
/** Recipe validation runs with dependencies in the existing corpus observation job. */
export async function observeSkillPublication(root: string, corpus: Corpus) {
  const expected = skillObservationIdentity(root);
  const cleanBefore = !git(root, ['status', '--porcelain']);
  const audit = await inspect(root, corpus, expected.info.sourceSha, null);
  writeFileSync(
    join(root, CORPUS_OUTPUT, SKILL_OBSERVATION_FILE),
    JSON.stringify({
      schemaVersion: 1,
      producer: 'skill-publication-observer',
      ...expected,
      clean:
        cleanBefore &&
        !git(root, ['status', '--porcelain']) &&
        git(root, ['rev-parse', 'HEAD']) === expected.info.sourceSha,
      audit,
    }) + '\n',
  );
}
