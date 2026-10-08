export type StoreErrorCode =
  | 'not-found'
  | 'conflict'
  | 'invalid-input'
  | 'queue-capacity'
  | 'storage-capacity'
  | 'unavailable';

/** Persistence/application failures carry domain meaning, independent of transport. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Rethrow a validation failure as bounded invalid-input text; non-Error values use the fallback. */
export function invalidInput(error: unknown, fallback: string): never {
  throw new StoreError(
    'invalid-input',
    (error instanceof Error ? error.message : fallback).slice(0, 1000),
  );
}
