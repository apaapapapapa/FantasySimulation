import type { StoreError, StoreErrorCode } from '../db/store-error.ts';

const statuses: Record<StoreErrorCode, number> = {
  'not-found': 404,
  conflict: 409,
  'invalid-input': 400,
  'queue-capacity': 429,
  'storage-capacity': 507,
  unavailable: 503,
};
export const storeErrorStatus = (error: StoreError) => statuses[error.code];
