import { EngineInputError } from '@fantasy/engine/spatial';
import { StoreError } from './db/store-error.ts';
import { artifactOperationCode, type OperationCode } from './operation-error.ts';

/** Execution-aware classification stays outside the saved-artifact entry point. */
export function operationCode(
  error: unknown,
  schemaCode: 'INPUT_INVALID' | 'DATA_INVALID' = 'INPUT_INVALID',
): OperationCode | 'UNKNOWN' {
  const shared = artifactOperationCode(error, schemaCode);
  if (shared !== 'UNKNOWN') return shared;
  if (error instanceof EngineInputError)
    return error.code.startsWith('unsupported-') ? 'IDENTITY_MISMATCH' : 'INPUT_INVALID';
  if (error instanceof StoreError) {
    switch (error.code) {
      case 'queue-capacity':
      case 'storage-capacity':
        return 'BUDGET_EXCEEDED';
      case 'invalid-input':
        return 'INPUT_INVALID';
      case 'unavailable':
        return 'REMOTE_UNAVAILABLE';
      default:
        return 'DATA_INVALID';
    }
  }
  return 'UNKNOWN';
}
