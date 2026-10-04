import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createTestProject } from '../quality/test-support/project.ts';

// Follow the vulnerable Drizzle loader route rather than a separate test dependency.
const kit = createRequire(import.meta.resolve('drizzle-kit'));
const loader = createRequire(kit.resolve('@esbuild-kit/esm-loader'));
const core = createRequire(loader.resolve('@esbuild-kit/core-utils'));

await test('the Drizzle loader esbuild server does not expose assets to an unrelated origin', async () => {
  const project = createTestProject({ 'entry.ts': 'export const answer: number = 42;\n' });
  const esbuild = core('esbuild') as {
    context: (options: Record<string, unknown>) => Promise<{
      serve: (options: { host: string; port: number }) => Promise<{ port: number }>;
      dispose: () => Promise<void>;
    }>;
  };
  const context = await esbuild.context({
    absWorkingDir: project.root,
    entryPoints: ['entry.ts'],
    outfile: 'entry.js',
    sourcemap: true,
    write: false,
  });
  try {
    const { port } = await context.serve({ host: '127.0.0.1', port: 0 });
    for (const path of ['/entry.js', '/entry.js.map']) {
      const url = `http://127.0.0.1:${port}${path}`;
      const local = await fetch(url, { signal: AbortSignal.timeout(5000) });
      assert.equal(local.status, 200);
      assert.ok((await local.text()).includes('42'));
      const crossOrigin = await fetch(url, {
        headers: { Origin: 'https://unrelated.example' },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(crossOrigin.headers.get('access-control-allow-origin'), null);
      await crossOrigin.arrayBuffer();
    }
  } finally {
    await context.dispose();
    project.dispose();
  }
});

await test('the actual legacy loader preserves TypeScript transforms and source maps', async () => {
  type Result = { code: string; map: { sourcesContent: string[] } };
  const utils = loader('@esbuild-kit/core-utils') as {
    transformSync: (code: string, filename: string) => Result;
    transform: (code: string, filename: string) => Promise<Result>;
  };
  const source = 'export const answer: number = 42';
  const filename = join(process.cwd(), 'example.ts');
  const cjs = utils.transformSync(source, filename);
  const module = { exports: {} as { answer?: number } };
  runInNewContext(cjs.code, { module, exports: module.exports }, { timeout: 1000 });
  assert.equal(module.exports.answer, 42);
  assert.deepEqual(cjs.map.sourcesContent, [source]);
  const esm = await utils.transform(source, filename);
  const result = await import(
    'data:text/javascript;base64,' + Buffer.from(esm.code).toString('base64')
  );
  assert.equal(result.answer, 42);
  assert.deepEqual(esm.map.sourcesContent, [source]);
});
