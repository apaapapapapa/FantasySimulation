import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readBoundedJson } from '../harness/files.ts';
import { assessReport, identity, record, timestamp } from '../harness/report.ts';
import type { Check, Identity, Report } from '../harness/report.ts';
import { isMain } from './common.ts';
import { parsePlan, type Plan } from '../ci/plan.ts';

const definitions = [
  ['secret-canary', 'secrets', 'secret-canary'],
  ['secret-scan', 'secrets', 'secret-scan'],
  ['codeql-severity', 'codeql', 'codeql-severity'],
  ['dependency-audit', 'audit', 'dependency-audit'],
  ['renovate-configuration', 'renovate', 'renovate-configuration'],
  ['toolchain-ubuntu-latest', 'toolchain-ubuntu-latest', 'toolchain-policy'],
] as const;
export const SECURITY_CHECKS = definitions.map(([key]) => `security:${key}`);
export interface SecurityRun {
  runId: string;
  runAttempt: string;
}
export function securityInputs(run: SecurityRun) {
  if (!/^[1-9]\d*$/.test(run.runId) || !/^[1-9]\d*$/.test(run.runAttempt))
    throw new Error('Missing or invalid security run identity');
  return definitions.map(([key, artifact, checkId]) => ({
    key,
    checkId,
    uri: `.generated/harness/ci/security-evidence/security-${artifact}-${run.runId}-${run.runAttempt}/${checkId}.json`,
  }));
}
function passingCounts(checkId: string, counts: Record<string, unknown>): boolean {
  switch (checkId) {
    case 'secret-canary':
      return counts.scenarios === 4;
    case 'secret-scan':
      return (
        typeof counts.detected === 'number' &&
        typeof counts.excepted === 'number' &&
        counts.blocking === 0 &&
        counts.detected === counts.excepted
      );
    case 'codeql-severity':
      return (
        typeof counts.runs === 'number' &&
        counts.runs > 0 &&
        typeof counts.rules === 'number' &&
        counts.rules > 0 &&
        typeof counts.findings === 'number' &&
        counts.blocking === 0
      );
    case 'dependency-audit':
      return (
        ['info', 'low', 'moderate', 'high', 'critical'].every((key) => key in counts) &&
        counts.high === 0 &&
        counts.critical === 0
      );
    case 'renovate-configuration':
      return counts.validators === 1;
    case 'toolchain-policy':
      return counts.checks === 6;
    default:
      return false;
  }
}
export function assessSecurityEvidence(
  info: Identity,
  run: SecurityRun,
  receipts: Record<string, unknown>,
  now = new Date().toISOString(),
  plan?: Plan,
) {
  info = identity(info);
  if (
    plan &&
    Object.entries(identity(parsePlan(plan))).some(
      ([key, value]) => info[key as keyof Identity] !== value,
    )
  )
    throw new Error('Security scope belongs to another revision');
  const at = timestamp(now);
  const checks: Check[] = securityInputs(run).map(({ key, checkId, uri }) => {
    let status: Check['status'] = 'unknown';
    let reason = 'Missing, malformed, stale or inconsistent security receipt';
    try {
      const receipt = record(receipts[key]);
      const counts = record(receipt.counts);
      const matches =
        receipt.schemaVersion === 1 &&
        receipt.producer === 'fantasy-security-h4' &&
        receipt.checkId === checkId &&
        receipt.sourceSha === info.sourceSha &&
        receipt.prHeadSha === (info.testMergeSha ? info.candidateSha : null) &&
        receipt.baselineSha === info.baselineSha &&
        receipt.runId === run.runId &&
        receipt.runAttempt === run.runAttempt &&
        timestamp(receipt.completedAt) <= at &&
        typeof receipt.reason === 'string' &&
        /^[A-Z][A-Z0-9_]{0,119}$/.test(receipt.reason) &&
        Object.keys(counts).length <= 32 &&
        Object.values(counts).every(
          (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
        );
      if (matches) {
        if (receipt.status === 'fail') status = 'fail';
        else if (receipt.status === 'pass') {
          const scoped =
            checkId === 'codeql-severity' && plan !== undefined && !parsePlan(plan).codeql;
          if (
            scoped
              ? receipt.reason === 'WORDING_ONLY_NO_CODE_CHANGE' &&
                counts.plannedSkip === 1 &&
                Object.keys(counts).length === 1
              : passingCounts(checkId, counts)
          )
            status = 'pass';
        }
        reason = `Bound ${key} receipt: ${status}`;
      }
    } catch {
      // Never echo untrusted receipt content or parser errors into public evidence.
    }
    return {
      id: `security:${key}`,
      required: true,
      status,
      reason,
      evidence: [{ uri, sourceSha: info.sourceSha }],
    };
  });
  const report: Report = {
    ...info,
    schemaVersion: 1,
    producer: 'security-evidence',
    startedAt: at,
    finishedAt: at,
    checks,
  };
  return assessReport(report, SECURITY_CHECKS);
}
if (isMain(import.meta.url)) {
  try {
    const plan = parsePlan(readBoundedJson('.generated/harness/ci/plan.json'));
    const info = identity(plan);
    if (process.env.GITHUB_SHA !== info.sourceSha) throw new Error('Security plan SHA mismatch');
    const run = {
      runId: process.env.GITHUB_RUN_ID ?? '',
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '',
    };
    const receipts: Record<string, unknown> = {};
    for (const input of securityInputs(run)) {
      try {
        receipts[input.key] = readBoundedJson(input.uri, 64 * 1024);
      } catch {
        receipts[input.key] = null;
      }
    }
    const assessment = assessSecurityEvidence(info, run, receipts, new Date().toISOString(), plan);
    const output = '.generated/harness/ci/security.json';
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(assessment.report, null, 2) + '\n');
    console.log(`FANTASY_SECURITY_EVIDENCE=${JSON.stringify(assessment.report)}`);
    process.exitCode = assessment.exitCode;
  } catch {
    console.error('Security evidence collection incomplete');
    process.exitCode = 2;
  }
}
