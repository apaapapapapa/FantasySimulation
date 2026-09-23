import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assessReport } from '../harness/report.ts';
import type { Report } from '../harness/report.ts';
import { parsePlan } from './plan.ts';
import { missingLocalLinks } from '../quality/markdown.ts';
import { qualityPaths } from '../quality/files.ts';
import { inspectContext } from '../harness/context.ts';
export const DOCS_CHECKS = ['docs:diff', 'docs:links', 'docs:context'] as const;
export function verifyDocs(root: string) {
  const plan = parsePlan(
    JSON.parse(readFileSync('.generated/harness/ci/plan.json', 'utf8')) as unknown,
  );
  if (plan.full || !plan.baselineSha || process.env.GITHUB_SHA !== plan.sourceSha)
    throw new Error('Docs shortcut is not authorized by this source plan');
  const at = new Date().toISOString(),
    context = inspectContext(root, qualityPaths(root)),
    failures = missingLocalLinks(root, plan.paths);
  let clean = true;
  try {
    execFileSync('git', ['diff', '--check', plan.baselineSha, plan.sourceSha, '--'], {
      cwd: root,
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch {
    clean = false;
  }
  mkdirSync('.generated/harness/docs', { recursive: true });
  const details = '.generated/harness/docs/links.json';
  writeFileSync(
    details,
    JSON.stringify(
      { sourceSha: plan.sourceSha, failures, checkedPaths: plan.paths, context },
      null,
      2,
    ) + '\n',
  );
  const evidence = [{ uri: details, sourceSha: plan.sourceSha }];
  const report: Report = {
    ...plan,
    schemaVersion: 1,
    producer: 'docs-check',
    startedAt: at,
    finishedAt: new Date().toISOString(),
    checks: [
      {
        id: 'docs:context',
        required: true,
        status: context.findings.length ? 'fail' : 'pass',
        reason: `${context.findings.length} context violations; ${context.totalBytes} documentation bytes`,
        evidence,
      },
      {
        id: 'docs:diff',
        required: true,
        status: clean ? 'pass' : 'fail',
        reason: 'git diff --check against tested base',
        evidence,
      },
      {
        id: 'docs:links',
        required: true,
        status: failures.length ? 'fail' : 'pass',
        reason: `Local inline-link failures: ${failures.length}`,
        evidence,
      },
    ],
  };
  const result = assessReport(report, DOCS_CHECKS);
  writeFileSync(
    '.generated/harness/docs/report.json',
    JSON.stringify(result.report, null, 2) + '\n',
  );
  console.log(`FANTASY_DOCS_REPORT=${JSON.stringify(result.report)}`);
  return result;
}
if (process.argv[1]?.endsWith('/ci/docs.ts') || process.argv[1]?.endsWith('\\ci\\docs.ts')) {
  try {
    process.exitCode = verifyDocs(process.cwd()).exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Docs check failed');
    process.exitCode = 2;
  }
}
