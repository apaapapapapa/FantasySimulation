import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: ['src/index.ts', 'src/battle-worker.ts'],
    platform: 'node',
    target: 'node24',
    format: 'esm',
    dts: false,
    sourcemap: true,
    deps: { alwaysBundle: [/^@fantasy\//] },
  },
});
