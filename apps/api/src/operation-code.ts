import { ZodError } from 'zod';
import { RevisionGraphError } from '@fantasy/domain/spatial';
import { EngineInputError } from '@fantasy/engine/spatial';
import { StoreError } from './db/store-error.ts';
import { OperationError, type OperationCode } from './operation-error.ts';

/** Execution-aware classification stays outside the saved-artifact entry point. */
export function operationCode(
  error: unknown,
  schemaCode: 'INPUT_INVALID' | 'DATA_INVALID' = 'INPUT_INVALID',
): OperationCode | 'UNKNOWN' {
  if (error instanceof OperationError) return error.code;
  if (error instanceof ZodError) return schemaCode;
  if (error instanceof RevisionGraphError) return 'INPUT_INVALID';
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
