import { defineConfig } from 'vite-plus';
import { TEST_INCLUDE, TEST_EXCLUDE } from './scripts/ci/test-plan.ts';
import { WeightedSequencer } from './scripts/ci/test-sequencer.ts';

export default defineConfig({
  lint: {
    options: { typeAware: true, typeCheck: true },
    plugins: ['typescript', 'react', 'vitest'],
    rules: {
      'typescript/no-explicit-any': 'error',
      'typescript/no-floating-promises': 'error',
    },
    ignorePatterns: ['**/dist/**', '**/node_modules/**', '**/.generated/**'],
  },
  fmt: { singleQuote: true, semi: true },
  test: {
    environment: 'node',
    // Integration suites can start four Workers each; bound concurrent test files too.
    maxWorkers: process.platform === 'win32' ? 1 : 2,
    include: TEST_INCLUDE,
    // These use node:test and are required by security:test in the same verify command.
    exclude: TEST_EXCLUDE,
    // Start the known slowest files first instead of the largest (see heaviestFirst).
    sequence: { sequencer: WeightedSequencer },
  },
});
