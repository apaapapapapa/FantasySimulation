import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    define: {
      __READER_SOURCE_SHA__: JSON.stringify(
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      ),
    },
    platform: 'browser',
    target: 'es2023',
    format: 'esm',
    dts: false,
    sourcemap: false,
    deps: { alwaysBundle: [/^@fantasy\//, /^zod/] },
  },
});
