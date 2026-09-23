import { collectPlan } from '../ci/plan.ts';
import { main } from './common.ts';

// Recompute from the checked-out merge and event; a workflow boolean is not proof of safe scope.
main('codeql-severity', () => {
  const plan = collectPlan(process.cwd(), process.env);
  if (plan.codeql) throw new Error('CodeQL analysis is required');
  return { status: 'pass', reason: 'WORDING_ONLY_NO_CODE_CHANGE', counts: { plannedSkip: 1 } };
});
