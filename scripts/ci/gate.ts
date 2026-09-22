import { readBoundedJson } from '../harness/files.ts';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compareCorpus } from '../harness/corpus-compare.ts';
import { assessReport, record } from '../harness/report.ts';
import type { Check, Report } from '../harness/report.ts';
import { SOURCE_CHECKS } from '../harness/source.ts';
import { SECURITY_CHECKS } from '../security/evidence.ts';
import { parsePlan } from './plan.ts';
import type { Plan } from './plan.ts';
const osNames = ['ubuntu-latest', 'windows-latest'] as const;
export function assessGate(
  plan: Plan,
  results: Record<string, unknown>,
  reports: Record<string, unknown>,
  corpus?: { definition: unknown; sha256: string; artifacts: Record<string, unknown> },
) {
  plan = parsePlan(plan);
  const evidence = [{ uri: '.generated/harness/ci/plan.json', sourceSha: plan.sourceSha }];
  const checks: Check[] = [];
  const expected = {
    changes: 'success',
    security: 'success',
    'dependency-policy': 'success',
    verify: plan.full ? 'success' : 'skipped',
    docs: plan.full ? 'skipped' : 'success',
  };
  for (const [job, result] of Object.entries(expected))
    checks.push({
      id: `ci-job:${job}`,
      required: true,
      status: results[job] === result ? 'pass' : 'fail',
      reason: `Expected ${result}; observed ${typeof results[job] === 'string' ? results[job] : 'missing/invalid'}`,
      evidence,
    });
  const platforms = plan.full ? osNames : osNames.map((os) => `docs-${os}`);
  for (const key of [...platforms, 'security']) {
    let status: Check['status'] = 'unknown',
      reason = 'Missing or invalid evidence';
    try {
      const assessed = assessReport(
        reports[key],
        key === 'security'
          ? SECURITY_CHECKS
          : plan.full
            ? SOURCE_CHECKS
            : ['docs:diff', 'docs:links'],
      );
      const report = assessed.report;
      const matches =
        report.sourceSha === plan.sourceSha &&
        report.candidateSha === plan.candidateSha &&
        report.testMergeSha === plan.testMergeSha &&
        (!plan.testMergeSha || report.baselineSha === plan.baselineSha) &&
        (key !== 'security' ||
          (report.producer === 'security-evidence' && report.baselineSha === plan.baselineSha));
      status = !matches
        ? 'unknown'
        : assessed.exitCode === 0
          ? 'pass'
          : assessed.exitCode === 1
            ? 'fail'
            : 'unknown';
      reason = matches
        ? `Bound ${key} report; exit=${assessed.exitCode}`
        : 'Evidence identity does not match planned source/head/base';
      if (key === 'security' && matches) checks.push(...report.checks);
    } catch {
      /* Absent or corrupt artifact stays incomplete. */
    }
    checks.push({ id: `ci-evidence:${key}`, required: true, status, reason, evidence });
  }
  const at = new Date().toISOString();
  if (plan.full)
    checks.push(
      compareCorpus(plan, corpus?.definition, corpus?.sha256 ?? '', corpus?.artifacts ?? {}),
    );
  const report: Report = {
    schemaVersion: 1,
    producer: 'ci-gate',
    sourceSha: plan.sourceSha,
    candidateSha: plan.candidateSha,
    baselineSha: plan.baselineSha,
    testMergeSha: plan.testMergeSha,
    startedAt: at,
    finishedAt: at,
    checks,
  };
  return assessReport(report, [
    ...new Set([...checks.map((check) => check.id), ...SECURITY_CHECKS]),
  ]);
}
const json = readBoundedJson;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const plan = parsePlan(json('.generated/harness/ci/plan.json'));
    if (process.env.GITHUB_SHA !== plan.sourceSha)
      throw new Error('Plan belongs to a different run source');
    const results = record(JSON.parse(process.env.CI_RESULTS ?? '{}') as unknown),
      reports: Record<string, unknown> = {};
    for (const name of plan.full ? osNames : osNames.map((os) => `docs-${os}`)) {
      try {
        reports[name] = json(
          `.generated/harness/ci/evidence/${name}/${name.startsWith('docs-') ? 'docs' : 'source'}/report.json`,
        );
      } catch {
        reports[name] = null;
      }
    }
    try {
      reports.security = json('.generated/harness/ci/security.json');
    } catch {
      reports.security = null;
    }
    const artifacts: Record<string, unknown> = {};
    for (const [os, platform] of [
      ['ubuntu-latest', 'linux'],
      ['windows-latest', 'win32'],
    ] as const) {
      try {
        const directory = `.generated/harness/ci/evidence/${os}/corpus`;
        artifacts[platform] = {
          results: json(`${directory}/results.json`),
          report: json(`${directory}/report.json`),
        };
      } catch {
        /* Missing artifacts remain unknown, including a missing operating system. */
      }
    }
    const bytes = readFileSync('packages/engine/fixtures/spatial/corpus.json');
    const assessment = assessGate(plan, results, reports, {
      definition: JSON.parse(bytes.toString('utf8')) as unknown,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      artifacts,
    });
    writeFileSync(
      '.generated/harness/ci/gate.json',
      JSON.stringify(assessment.report, null, 2) + '\n',
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### CI plan: ${plan.full ? 'full' : 'wording only'}\n\n${plan.reason}\n\n${assessment.report.checks.map((check) => `- ${check.id}: ${check.status} — ${check.reason}`).join('\n')}\n`,
      );
    console.log(`FANTASY_CI_GATE=${JSON.stringify(assessment.report)}`);
    process.exitCode = assessment.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'CI gate incomplete');
    process.exitCode = 2;
  }
}
