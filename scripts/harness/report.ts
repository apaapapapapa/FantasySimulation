import { z } from 'zod';

// Adapted from HiFiScout@36aaf69/scripts/harness/report.ts. See .github/harness/README.md.
export const ShaSchema = z.string().regex(/^[a-f0-9]{40}$/).refine((s) => !/^0+$/.test(s));
export const StatusSchema = z.enum(['pass', 'fail', 'unknown', 'skipped']);
export const ScopeSchema = z.enum(['source', 'deployment', 'observation']);
const text = z.string().trim().min(1).max(4096);
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/);
export function validTimestamp(value: string): boolean {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const local = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
  const parsed = new Date(local);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === local;
}
export const TimestampSchema = z.string().refine(validTimestamp, 'Invalid ISO timestamp');
export function validEvidenceUri(value: string): boolean {
  if (value.startsWith('https://')) {
    try {
      const url = new URL(value);
      return !!url.hostname && !url.username && !url.password && !/[\s\\]/u.test(value);
    } catch { return false; }
  }
  return /^[\w.-][\w./-]*$/u.test(value) && value.split('/').every((part) => part !== '.' && part !== '..' && part !== '');
}
export const EvidenceSchema = z.object({
  uri: text.refine(validEvidenceUri, 'Expected HTTPS or a repository-relative artifact'),
  sourceSha: ShaSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const CheckSchema = z.object({
  id, required: z.boolean(), scope: ScopeSchema, status: StatusSchema,
  reason: text, evidence: z.array(EvidenceSchema).max(100),
}).strict();
export const ReportSchema = z.object({
  schemaVersion: z.literal(1), producer: id, runId: id, sourceSha: ShaSchema,
  baselineSha: ShaSchema.nullable(), pullHeadSha: ShaSchema.nullable(),
  testMergeSha: ShaSchema.nullable(), deploymentSha: ShaSchema.nullable(),
  startedAt: TimestampSchema, finishedAt: TimestampSchema,
  checks: z.array(CheckSchema).min(1).max(1000),
}).strict().superRefine((report, context) => {
  if (Date.parse(report.finishedAt) < Date.parse(report.startedAt)) context.addIssue({code:'custom', message:'Inverted report interval'});
  if (new Set(report.checks.map((check) => check.id)).size !== report.checks.length) context.addIssue({code:'custom',message:'Duplicate check ID'});
});
export type HarnessReport = z.infer<typeof ReportSchema>;
export type HarnessCheck = z.infer<typeof CheckSchema>;
export type CheckStatus = HarnessCheck['status'];
export type Requirement = Pick<HarnessCheck, 'id' | 'scope'>;
export type EvidenceReference = z.infer<typeof EvidenceSchema>;
export function bindRequiredChecks(requirements: readonly Requirement[], observed: HarnessCheck[]): HarnessCheck[] {
  if (new Set(requirements.map((entry) => entry.id)).size !== requirements.length) throw new Error('Duplicate required check ID');
  const required = requirements.map((entry): HarnessCheck => {
    const check = observed.find((item) => item.id === entry.id && item.scope === entry.scope);
    return check ? {...check, required:true} : {...entry,required:true,status:'unknown',reason:'Required evidence missing or scope changed',evidence:[]};
  });
  const names = new Set(requirements.map((entry) => entry.id));
  return [...required,...observed.filter((check) => !names.has(check.id))];
}
export function reportExitCode(status: CheckStatus): 0 | 1 | 2 {
  return status === 'pass' ? 0 : status === 'fail' ? 1 : 2;
}
/** Checks structure and identity, not the truth of caller-authored assertions. */
export function assessReport(input: unknown, requirements: readonly Requirement[] = []) {
  const parsed = ReportSchema.parse(input);
  const checks = bindRequiredChecks(requirements, parsed.checks).map((check): HarnessCheck => {
    if (check.status !== 'pass') return check;
    const reason = !check.evidence.length ? 'Passing check has no evidence'
      : check.evidence.some((item) => item.sourceSha !== parsed.sourceSha) ? 'Stale evidence SHA'
      : check.scope !== 'source' && parsed.deploymentSha !== parsed.sourceSha ? 'Deployment identity unconfirmed' : null;
    return reason ? {...check,status:'unknown',reason} : check;
  });
  const required = checks.filter((check) => check.required);
  const status: CheckStatus = required.some((check) => check.status === 'fail') ? 'fail'
    : !required.length || required.some((check) => check.status !== 'pass') ? 'unknown' : 'pass';
  return {report:{...parsed,checks},status,exitCode:reportExitCode(status)};
}
