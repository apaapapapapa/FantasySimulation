import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  array,
  command,
  digest,
  isMain,
  main,
  object,
  requireCondition,
  successful,
  text,
} from './common.ts';
import type { Outcome } from './common.ts';

type Finding = { id: string; rule: string; locationId: string; line: number };

export function exceptions(value: unknown, now = Date.now()): Set<string> {
  const ids = new Set<string>();
  for (const item of array(value)) {
    const entry = object(item);
    const id = text(entry.fingerprintSha256);
    requireCondition(/^[a-f0-9]{64}$/.test(id) && !ids.has(id), 'INVALID_EXCEPTION_ID');
    requireCondition(text(entry.reason).trim().length >= 20, 'EXCEPTION_REASON_REQUIRED');
    requireCondition(
      /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(text(entry.reviewer)),
      'EXCEPTION_REVIEWER_REQUIRED',
    );
    const reviewed = Date.parse(text(entry.reviewedAt));
    const expires = Date.parse(text(entry.expiresAt));
    requireCondition(Number.isFinite(reviewed) && Number.isFinite(expires), 'INVALID_EXCEPTION_DATE');
    requireCondition(
      reviewed <= now && expires > now && expires > reviewed && expires - reviewed <= 30 * 86_400_000,
      'EXCEPTION_EXPIRED_OR_TOO_LONG',
    );
    ids.add(id);
  }
  return ids;
}

export function parseFindings(value: unknown): Finding[] {
  return array(value).map((item) => {
    const entry = object(item);
    const line = entry.StartLine;
    requireCondition(
      typeof line === 'number' && Number.isSafeInteger(line) && line > 0,
      'INVALID_FINDING_LOCATION',
    );
    const rule = text(entry.RuleID);
    requireCondition(/^[a-z0-9-]+$/.test(rule), 'INVALID_FINDING_RULE');
    // Never forward Line, Match, Secret, author, email, or filename.
    return {
      id: digest(text(entry.Fingerprint)),
      rule,
      locationId: digest(text(entry.File)),
      line,
    };
  });
}

function scan(mode: 'git' | 'dir', target: string): Finding[] {
  const temporary = mkdtempSync(join(tmpdir(), 'fantasy-gitleaks-'));
  try {
    const report = join(temporary, 'private.json');
    const ignore = join(temporary, '.gitleaksignore');
    writeFileSync(ignore, '', { mode: 0o600 });
    const args = [
      mode,
      target,
      '--config',
      resolve('.github/security/gitleaks.toml'),
      '--gitleaks-ignore-path',
      ignore,
      '--ignore-gitleaks-allow',
      '--redact=100',
      '--no-banner',
      '--no-color',
      '--log-level=error',
      '--exit-code=1',
      '--timeout=120',
      '--report-format=json',
      '--report-path',
      report,
    ];
    if (mode === 'git') args.push('--log-opts=--all --full-history');
    const result = command('gitleaks', args);
    requireCondition(
      !result.error && !result.signal && (result.status === 0 || result.status === 1),
      'GITLEAKS_EXECUTION_FAILED',
    );
    requireCondition(result.stderr.trim() === '', 'GITLEAKS_REPORTED_ERROR');
    const findings = parseFindings(JSON.parse(readFileSync(report, 'utf8')) as unknown);
    requireCondition((result.status === 0) === (findings.length === 0), 'GITLEAKS_RESULT_MISMATCH');
    return findings;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function selfTest(): Outcome {
  const root = mkdtempSync(join(tmpdir(), 'fantasy-canary-'));
  try {
    const canary = ['FANTASY', 'SECURITY', 'CANARY', 'A'.repeat(32)].join('_');
    const providerCanary = ['ghp', '0123456789abcdefghijklmnopqrstuvwxyz'].join('_');
    writeFileSync(join(root, 'README.md'), `${canary} # gitleaks:allow\n${providerCanary}\n`);
    const findings = scan('dir', root);
    requireCondition(
      findings.some((finding) => finding.rule === 'fantasy-canary'),
      'MARKDOWN_CANARY_NOT_DETECTED',
    );
    requireCondition(
      findings.some((finding) => finding.rule !== 'fantasy-canary'),
      'DEFAULT_RULES_NOT_ACTIVE',
    );
    successful('git', ['init', '-q'], root);
    successful('git', ['add', 'README.md'], root);
    const identity = ['-c', 'user.name=Security Fixture', '-c', 'user.email=fixture@invalid.test'];
    successful('git', [...identity, 'commit', '-qm', 'Add synthetic fixture'], root);
    successful('git', ['rm', '-q', 'README.md'], root);
    successful('git', [...identity, 'commit', '-qm', 'Delete synthetic fixture'], root);
    requireCondition(scan('dir', root).length === 0, 'CLEAN_FIXTURE_FAILED');
    requireCondition(
      scan('git', root).some((finding) => finding.rule === 'fantasy-canary'),
      'DELETED_MARKDOWN_NOT_DETECTED',
    );
    return {
      status: 'pass',
      reason: 'MARKDOWN_DEFAULT_RULE_AND_HISTORY_CANARIES_DETECTED',
      counts: { scenarios: 4 },
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function evaluate(): Outcome {
  requireCondition(
    successful('git', ['rev-parse', '--is-shallow-repository']) === 'false',
    'SHALLOW_HISTORY',
  );
  const allowed = exceptions(
    JSON.parse(readFileSync('.github/security/secret-exceptions.json', 'utf8')) as unknown,
  );
  const findings = [...scan('git', '.'), ...scan('dir', '.')];
  const unique = [...new Map(findings.map((finding) => [finding.id, finding])).values()];
  const blocking = unique.filter((finding) => !allowed.has(finding.id));
  // Recover actual locations privately, never in public CI output.
  if (blocking.length > 0) console.log(JSON.stringify(blocking));
  return {
    status: blocking.length > 0 ? 'fail' : 'pass',
    reason: blocking.length > 0 ? 'SECRET_DETECTED_REVOKE_AND_REMOVE' : 'NO_UNEXCEPTED_FINDINGS',
    counts: {
      detected: unique.length,
      excepted: unique.length - blocking.length,
      blocking: blocking.length,
    },
  };
}

if (isMain(import.meta.url)) {
  const fixture = process.argv[2] === '--self-test';
  main(fixture ? 'secret-canary' : 'secret-scan', fixture ? selfTest : evaluate);
}
