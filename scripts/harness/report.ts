/** Adapted from HiFiScout@36aaf69/scripts/harness/report.ts. See .github/harness/README.md. */
export type CheckStatus = 'pass' | 'fail' | 'unknown' | 'skipped';
export type CheckScope = 'source' | 'merge' | 'release';
export interface Evidence {
  uri: string;
  sourceSha: string;
}
export interface HarnessCheck {
  id: string;
  scope: CheckScope;
  required: boolean;
  status: CheckStatus;
  reason: string;
  evidence: Evidence[];
}
export interface HarnessReport {
  schemaVersion: 1;
  producer: string;
  runId: string;
  sourceSha: string;
  candidateSha: string;
  baselineSha: string | null;
  startedAt: string;
  finishedAt: string;
  checks: HarnessCheck[];
}
export interface Requirement {
  id: string;
  scope: CheckScope;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object');
  }
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new Error('Expected bounded nonempty text');
  }
  return value;
}
export function sha(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{40}$/.test(result) || /^0+$/.test(result)) {
    throw new Error('Expected a full nonzero commit SHA');
  }
  return result;
}
export function timestamp(value: unknown): string {
  const result = text(value);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(result);
  if (!match || !Number.isFinite(Date.parse(result))) throw new Error('Invalid timestamp');
  const wall = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  if (new Date(wall).toISOString() !== wall) throw new Error('Impossible calendar timestamp');
  return new Date(result).toISOString();
}
export function evidenceUri(value: unknown): string {
  const uri = text(value);
  if (uri.startsWith('https://')) {
    const url = new URL(uri);
    if (!url.hostname || url.username || url.password || url.search) {
      throw new Error('Credential-bearing evidence URL is forbidden');
    }
  } else if (
    !/^[\w.-][\w./-]*$/.test(uri) ||
    uri.split('/').some((part) => part === '..' || part === '.' || part === '')
  ) {
    throw new Error('Evidence must be HTTPS or repository-relative without traversal');
  }
  return uri;
}
function parseCheck(value: unknown): HarnessCheck {
  const item = record(value);
  if (
    !['source', 'merge', 'release'].includes(String(item.scope)) ||
    !['pass', 'fail', 'unknown', 'skipped'].includes(String(item.status)) ||
    typeof item.required !== 'boolean' ||
    !Array.isArray(item.evidence) ||
    item.evidence.length > 100
  ) {
    throw new Error('Invalid check');
  }
  return {
    id: text(item.id),
    scope: item.scope as CheckScope,
    required: item.required,
    status: item.status as CheckStatus,
    reason: text(item.reason),
    evidence: item.evidence.map((value): Evidence => {
      const reference = record(value);
      return { uri: evidenceUri(reference.uri), sourceSha: sha(reference.sourceSha) };
    }),
  };
}
export function parseReport(value: unknown): HarnessReport {
  const input = record(value);
  if (input.schemaVersion !== 1 || !Array.isArray(input.checks) || input.checks.length > 1000) {
    throw new Error('Invalid report schema');
  }
  const checks = input.checks.map(parseCheck);
  if (!checks.length || new Set(checks.map((check) => check.id)).size !== checks.length) {
    throw new Error('Empty or duplicate check IDs');
  }
  const startedAt = timestamp(input.startedAt);
  const finishedAt = timestamp(input.finishedAt);
  if (finishedAt < startedAt) throw new Error('Reversed report interval');
  return {
    schemaVersion: 1,
    producer: text(input.producer),
    runId: text(input.runId),
    sourceSha: sha(input.sourceSha),
    candidateSha: sha(input.candidateSha),
    baselineSha: input.baselineSha === null ? null : sha(input.baselineSha),
    startedAt,
    finishedAt,
    checks,
  };
}
/** Requirements belong to the caller's policy, never to the observed report. */
export function assessReport(value: unknown, requirements: readonly Requirement[]) {
  const report = parseReport(value);
  if (!requirements.length || new Set(requirements.map((item) => item.id)).size !== requirements.length) {
    throw new Error('Empty or duplicate requirements');
  }
  const expected = new Map(requirements.map((item) => [item.id, item.scope]));
  const checks: HarnessCheck[] = report.checks.map((check) => {
    let reason: string | null = null;
    if (expected.has(check.id) && expected.get(check.id) !== check.scope) reason = 'scope mismatch';
    if (check.status === 'pass') {
      if (!check.evidence.length) reason = 'missing evidence';
      else if (check.evidence.some((reference) => reference.sourceSha !== report.sourceSha)) {
        reason = 'stale evidence SHA';
      }
    }
    return {
      ...check,
      required: expected.has(check.id) || check.required,
      ...(reason ? { status: 'unknown' as const, reason } : {}),
    };
  });
  for (const requirement of requirements) {
    if (!checks.some((check) => check.id === requirement.id)) {
      checks.push({ ...requirement, required: true, status: 'unknown', reason: 'missing check', evidence: [] });
    }
  }
  const required = checks.filter((check) => check.required);
  const status: CheckStatus = required.some((check) => check.status === 'fail')
    ? 'fail'
    : required.some((check) => check.status !== 'pass')
      ? 'unknown'
      : 'pass';
  return { ...report, checks, status };
}
export function exitCode(status: CheckStatus): number {
  return status === 'pass' ? 0 : status === 'fail' ? 1 : 2;
}
