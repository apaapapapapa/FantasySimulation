import { ZodError } from 'zod';
import { RevisionGraphError } from '@fantasy/domain/spatial';
import { EngineInputError } from '@fantasy/engine/spatial';
import { StoreError } from './db/store-error.ts';

export type OperationCode =
  | 'INPUT_INVALID'
  | 'IDENTITY_MISMATCH'
  | 'BUDGET_EXCEEDED'
  | 'DATA_INVALID'
  | 'PUBLICATION_CONFLICT'
  | 'REMOTE_AUTH'
  | 'REMOTE_UNAVAILABLE'
  | 'USAGE_CONSUMED'
  | 'USAGE_UNVERIFIED';

/** Runtime failure classification. Messages/causes are private, never a reporting contract. */
export class OperationError extends Error {
  constructor(
    readonly code: OperationCode,
    message: string,
    readonly targetHash?: string,
  ) {
    super(message);
  }
}

/** Use at parsing boundaries, where the owner knows whether input or saved data is being read. */
export function operationInput<T>(parse: () => T, code: 'INPUT_INVALID' | 'DATA_INVALID'): T {
  try {
    return parse();
  } catch (error) {
    if (
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      (error instanceof TypeError &&
        'code' in error &&
        error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA')
    )
      throw new OperationError(code, 'Invalid JSON document or schema');
    throw error;
  }
}

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
