// Adapted from HiFiScout scripts/harness/report.ts at 36aaf69d3f7a61195af4e85a468514dfbb1ecc80.
export type CheckStatus = 'pass' | 'fail' | 'unknown' | 'skipped';
export interface Evidence {
  uri: string;
  sourceSha: string;
}
export interface Check {
  id: string;
  required: boolean;
  status: CheckStatus;
  reason: string;
  evidence: Evidence[];
}
export interface Identity {
  sourceSha: string;
  candidateSha: string;
  baselineSha: string | null;
  testMergeSha: string | null;
}
export interface Report extends Identity {
  schemaVersion: 1;
  producer: string;
  startedAt: string;
  finishedAt: string;
  checks: Check[];
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty text');
  return value;
}
export function sha(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{40}$/.test(result) || /^0+$/.test(result))
    throw new Error('Expected a full nonzero commit SHA');
  return result;
}
export function timestamp(value: unknown): string {
  const result = text(value);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    result,
  );
  if (!match || !Number.isFinite(Date.parse(result))) throw new Error('Invalid timestamp');
  const wall = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  if (new Date(wall).toISOString() !== wall) throw new Error('Invalid calendar date');
  return new Date(result).toISOString();
}
export function evidenceUri(value: unknown): string {
  const uri = text(value);
  if (uri.startsWith('https://')) {
    const url = new URL(uri);
    if (!url.hostname || url.username || url.password) throw new Error('Unsafe evidence URL');
  } else if (
    !/^[\w.-][\w./-]*$/.test(uri) ||
    uri.split('/').some((part) => part === '.' || part === '..' || part === '')
  )
    throw new Error('Expected HTTPS or a repository-relative evidence path');
  return uri;
}
export function identity(value: unknown): Identity {
  const obj = record(value);
  const result = {
    sourceSha: sha(obj.sourceSha),
    candidateSha: sha(obj.candidateSha),
    baselineSha: obj.baselineSha === null ? null : sha(obj.baselineSha),
    testMergeSha: obj.testMergeSha === null ? null : sha(obj.testMergeSha),
  };
  if (
    result.testMergeSha !== null &&
    (result.testMergeSha !== result.sourceSha || result.baselineSha === null)
  )
    throw new Error('Test merge identity requires its tested source and baseline');
  return result;
}
export function parseReport(value: unknown): Report {
  const obj = record(value);
  if (
    obj.schemaVersion !== 1 ||
    !Array.isArray(obj.checks) ||
    !obj.checks.length ||
    obj.checks.length > 10000
  )
    throw new Error('Invalid report schema or coverage');
  const ids = new Set<string>();
  const checks: Check[] = obj.checks.map((value: unknown) => {
    const check = record(value);
    const id = text(check.id);
    if (ids.has(id) || typeof check.required !== 'boolean' || !Array.isArray(check.evidence))
      throw new Error('Duplicate check ID or invalid check');
    ids.add(id);
    const status = check.status;
    if (status !== 'pass' && status !== 'fail' && status !== 'unknown' && status !== 'skipped')
      throw new Error('Invalid check status');
    return {
      id,
      required: check.required,
      status,
      reason: text(check.reason),
      evidence: check.evidence.map((item: unknown) => {
        const ref = record(item);
        return { uri: evidenceUri(ref.uri), sourceSha: sha(ref.sourceSha) };
      }),
    };
  });
  const result: Report = {
    ...identity(obj),
    schemaVersion: 1,
    producer: text(obj.producer),
    startedAt: timestamp(obj.startedAt),
    finishedAt: timestamp(obj.finishedAt),
    checks,
  };
  if (result.finishedAt < result.startedAt) throw new Error('Reversed evidence interval');
  return result;
}
export function assessReport(value: unknown, requiredIds: readonly string[]) {
  const report = parseReport(value);
  if (!requiredIds.length || new Set(requiredIds).size !== requiredIds.length)
    throw new Error('A nonempty unique acceptance contract is required');
  const required = new Set(requiredIds);
  const checks: Check[] = report.checks.map((check) => {
    const bound = { ...check, required: check.required || required.has(check.id) };
    if (
      bound.status === 'pass' &&
      (!bound.evidence.length || bound.evidence.some((ref) => ref.sourceSha !== report.sourceSha))
    )
      return { ...bound, status: 'unknown', reason: 'Missing or stale-SHA evidence' };
    return bound;
  });
  for (const id of requiredIds) {
    if (!checks.some((check) => check.id === id))
      checks.push({
        id,
        required: true,
        status: 'unknown',
        reason: 'Required check missing',
        evidence: [],
      });
  }
  const needed = checks.filter((check) => check.required);
  const exitCode = needed.some((check) => check.status === 'fail')
    ? 1
    : needed.some((check) => check.status !== 'pass')
      ? 2
      : 0;
  return { report: { ...report, checks }, exitCode };
}
