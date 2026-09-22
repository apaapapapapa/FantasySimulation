import { defineConfig } from 'vite-plus';

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
    // Integration suites start their own bounded pools; cap concurrent test processes.
    maxWorkers: 4,
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts', 'scripts/**/*.test.ts'],
    // These use node:test and are required by security:test in the same verify command.
    exclude: ['**/node_modules/**', '**/.git/**', 'scripts/security/**/*.test.ts'],
  },
});
