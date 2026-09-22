import { isMain, main } from './common.ts';
import type { Outcome } from './common.ts';

export function validatorOutcome(outcome: unknown): Outcome {
  return {
    status: outcome === 'success' ? 'pass' : outcome === 'failure' ? 'fail' : 'unknown',
    reason: 'OFFICIAL_RENOVATE_VALIDATOR',
    counts: { validators: outcome === 'success' ? 1 : 0 },
  };
}

if (isMain(import.meta.url))
  main('renovate-configuration', () => validatorOutcome(process.env.H4_VALIDATOR_OUTCOME));
