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
    include: ['packages/**/*.test.ts', 'apps/api/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
