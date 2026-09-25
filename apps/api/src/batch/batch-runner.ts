// CLI/tooling adapter: all plan execution and persistence live in the application service.
export { executeBatch as runBatch, reconcileBatch } from './batch-service.ts';
