import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    platform: 'browser',
    target: 'es2023',
    format: 'esm',
    dts: false,
    sourcemap: false,
    deps: { alwaysBundle: [/^@fantasy\//, /^zod/] },
  },
});
