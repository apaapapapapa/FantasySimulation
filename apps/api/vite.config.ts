import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    entry: { index: 'src/index.ts', 'battle-worker': 'src/jobs/battle-worker.ts' },
    platform: 'node',
    target: 'node24',
    format: 'esm',
    dts: false,
    sourcemap: true,
    deps: { alwaysBundle: [/^@fantasy\//] },
  },
});
