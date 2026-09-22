import { existsSync, readFileSync } from 'node:fs';
import {
  command,
  count,
  isMain,
  main,
  object,
  requireCondition,
  successful,
  text,
} from './common.ts';
import type { Outcome } from './common.ts';

export function auditOutcome(value: unknown, status: number | null): Outcome {
  requireCondition(status === 0 || status === 1, 'AUDIT_EXECUTION_FAILED');
  const report = object(value);
  requireCondition(!('error' in report), 'AUDIT_SERVICE_ERROR');
  const metadata = object(report.metadata);
  const vulnerabilities = object(metadata.vulnerabilities);
  const counts = {
    info: count(vulnerabilities.info),
    low: count(vulnerabilities.low),
    moderate: count(vulnerabilities.moderate),
    high: count(vulnerabilities.high),
    critical: count(vulnerabilities.critical),
  };
  // A metadata-only or truncated response is not an inventory.
  object(report.advisories ?? report.vulnerabilities);
  const blocking = counts.high + counts.critical;
  requireCondition((status === 0) === (blocking === 0), 'AUDIT_EXIT_RESULT_MISMATCH');
  return {
    status: blocking > 0 ? 'fail' : 'pass',
    reason: blocking > 0 ? 'HIGH_OR_CRITICAL_DEPENDENCIES' : 'NO_HIGH_OR_CRITICAL_DEPENDENCIES',
    counts,
  };
}

function evaluate(): Outcome {
  const manifest = object(JSON.parse(readFileSync('package.json', 'utf8')) as unknown);
  const manager = text(manifest.packageManager);
  requireCondition(/^pnpm@\d+\.\d+\.\d+$/.test(manager), 'PNPM_MUST_BE_EXACT');
  requireCondition(successful('pnpm', ['--version']) === manager.slice(5), 'PNPM_VERSION_MISMATCH');
  requireCondition(
    process.versions.node === readFileSync('.node-version', 'utf8').trim(),
    'NODE_VERSION_MISMATCH',
  );
  requireCondition(existsSync('pnpm-lock.yaml'), 'LOCKFILE_MISSING');
  requireCondition(!existsSync('package-lock.json'), 'UNEXPECTED_NPM_LOCKFILE');
  const workspace = readFileSync('pnpm-workspace.yaml', 'utf8');
  const pnpmConfig = manifest.pnpm === undefined ? {} : object(manifest.pnpm);
  requireCondition(
    !/^\s*audit(?:Config)?:/m.test(workspace) &&
      !('audit' in pnpmConfig) &&
      !('auditConfig' in pnpmConfig),
    'AUDIT_EXCEPTION_SETTINGS_REQUIRE_REVIEW',
  );
  if (existsSync('.npmrc')) {
    requireCondition(
      !/audit|ignore.*(?:ghsa|advisor)/i.test(readFileSync('.npmrc', 'utf8')),
      'AUDIT_NPMRC_OVERRIDE',
    );
  }
  const result = command('pnpm', [
    'audit',
    '--json',
    '--audit-level=high',
    '--ignore-registry-errors=false',
    '--ignore-unfixable=false',
    '--registry=https://registry.npmjs.org',
  ]);
  requireCondition(!result.error && !result.signal, 'AUDIT_PROCESS_FAILED');
  requireCondition(result.stderr.trim() === '', 'AUDIT_REPORTED_ERROR');
  const outcome = auditOutcome(JSON.parse(result.stdout) as unknown, result.status);
  requireCondition(
    successful('git', [
      'diff',
      '--exit-code',
      '--',
      'package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
    ]) === '',
    'AUDIT_MODIFIED_DEPENDENCIES',
  );
  return outcome;
}

if (isMain(import.meta.url)) main('dependency-audit', evaluate);
