// Contract/scope ideas adapted from HiFiScout@36aaf69d3f7a61195af4e85a468514dfbb1ecc80.
import { createHash } from 'node:crypto';
import { natural, repositoryName } from '../delivery.ts';
import { record, sha, text } from '../report.ts';

export const DEFAULT_BUDGET = {
  attempts: 3,
  noProgress: 2,
  durationMs: 3_600_000,
  externalCalls: 200,
  costMicros: 0,
};
export interface Contract {
  schemaVersion: 1;
  repository: string;
  baselineSha: string;
  goal: string;
  allowedPaths: string[];
  requiredChecks: string[];
  budget: typeof DEFAULT_BUDGET;
  review: 'self' | 'optional' | 'required';
  reviewWaitMs: number;
  target: 'pr';
}
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function relativePath(value: unknown): string {
  const path = text(value);
  if (!/^[\w.-][\w./-]*$/.test(path) || path.split('/').some((p) => !p || p === '.' || p === '..'))
    throw new Error('Invalid relative path');
  return path;
}
export function bounded(value: unknown, min: number, max: number): number {
  const count = natural(value);
  if (count < min || count > max) throw new Error('Out of budget range');
  return count;
}
export function strings(value: unknown, parse = text): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 200) throw new Error('Invalid list');
  const result = value.map(parse);
  if (new Set(result).size !== result.length) throw new Error('Duplicate list entry');
  return result.sort();
}
export function parseContract(value: unknown): Contract {
  const c = record(value),
    budget = record(c.budget);
  if (
    c.schemaVersion !== 1 ||
    c.target !== 'pr' ||
    !['self', 'optional', 'required'].includes(String(c.review))
  )
    throw new Error('Unsupported loop contract');
  const requiredChecks = strings(c.requiredChecks);
  if (
    requiredChecks.length !== 2 ||
    !['source-clean', 'source-verify'].every((id) => requiredChecks.includes(id))
  )
    throw new Error('Only source-clean and source-verify are supported');
  const result: Contract = {
    schemaVersion: 1,
    repository: repositoryName(text(c.repository)),
    baselineSha: sha(c.baselineSha),
    goal: text(c.goal),
    allowedPaths: strings(c.allowedPaths, relativePath),
    requiredChecks,
    budget: {
      attempts: bounded(budget.attempts, 1, 20),
      noProgress: bounded(budget.noProgress, 1, 20),
      durationMs: bounded(budget.durationMs, 1, 86_400_000),
      externalCalls: bounded(budget.externalCalls, 0, 1000),
      // The initial implementation has no paid provider or production adapter.
      costMicros: bounded(budget.costMicros, 0, 0),
    },
    review: c.review as Contract['review'],
    reviewWaitMs: bounded(c.reviewWaitMs, 0, 900_000),
    target: 'pr',
  };
  if (result.goal.length > 4000 || result.allowedPaths.some((p) => !pathAllowed(result, p)))
    throw new Error('Goal or change scope invalid');
  return result;
}
/** Same incident/baseline/goal uses the same journal even when a proposed budget changes. */
export const taskId = (c: Contract) => digest([c.repository, c.baselineSha, c.goal]).slice(0, 32);
export function pathAllowed(contract: Contract, value: unknown): boolean {
  const path = relativePath(value),
    parts = path.split('/');
  if (
    parts.some(
      (p) =>
        p.startsWith('.') ||
        /^(?:AGENTS|CLAUDE|SKILL)\.md$/i.test(p) ||
        /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|.*config\.[\w.]+|.*lock.*|node_modules)$/i.test(
          p,
        ),
    )
  )
    return false;
  if (
    /^(?:scripts|db|data|evaluations|e2e|docs)(?:\/|$)/.test(path) ||
    /(?:^|\/)(?:fixtures|test-support|migrations)(?:\/|$)/.test(path) ||
    /(?:identity|digest|budget|expected|snapshot)/i.test(path) ||
    path === 'apps/api/src/db/schema.ts'
  )
    return false;
  return contract.allowedPaths.some((p) => path === p || path.startsWith(p + '/'));
}
export const isTestPath = (path: string) =>
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|__tests__)(?:\/|$))/.test(path);
