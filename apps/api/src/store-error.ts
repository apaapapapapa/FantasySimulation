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
