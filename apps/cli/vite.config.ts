import { defineConfig } from 'vite-plus';
export default defineConfig({
  pack: {
    entry: {
      batch: 'src/batch.ts',
      publication: 'src/publication.ts',
      'battle-worker': 'src/battle-worker.ts',
    },
    platform: 'node',
    target: 'node24',
    format: 'esm',
    dts: false,
    sourcemap: true,
    deps: { alwaysBundle: [/^@fantasy\//] },
  },
});
