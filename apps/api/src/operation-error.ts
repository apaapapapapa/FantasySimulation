import { ZodError } from 'zod';
import { ReplayValidationError, RevisionGraphError } from '@fantasy/domain/spatial';

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
    if (error instanceof ReplayValidationError)
      throw new OperationError('DATA_INVALID', 'Invalid replay data');
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

/** Shared saved-data classification without importing execution or persistence code. */
export function artifactOperationCode(
  error: unknown,
  schemaCode: 'INPUT_INVALID' | 'DATA_INVALID' = 'INPUT_INVALID',
): OperationCode | 'UNKNOWN' {
  if (error instanceof OperationError) return error.code;
  if (error instanceof ReplayValidationError) return 'DATA_INVALID';
  if (error instanceof ZodError) return schemaCode;
  if (error instanceof RevisionGraphError) return 'INPUT_INVALID';
  return 'UNKNOWN';
}
