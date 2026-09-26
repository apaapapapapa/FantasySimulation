import { collectPlan, type Plan } from '../ci/plan.ts';
import { isMain, main } from './common.ts';

/** The only planned CodeQL exclusions: wording-only PRs and the PR fast lane (main still analyzes). */
export function codeqlScopeReason(plan: Plan): string {
  if (plan.codeql) throw new Error('CodeQL analysis is required');
  return plan.full ? 'PR_FAST_LANE_CODEQL_ON_MAIN' : 'WORDING_ONLY_NO_CODE_CHANGE';
}

// Recompute from the checked-out merge and event; a workflow boolean is not proof of safe scope.
if (isMain(import.meta.url))
  main('codeql-severity', () => ({
    status: 'pass',
    reason: codeqlScopeReason(collectPlan(process.cwd(), process.env)),
    counts: { plannedSkip: 1 },
  }));
