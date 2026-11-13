import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { initializePhysics } from '@fantasy/engine/spatial';
import { probeInputs, runProbe } from '@fantasy/engine/tooling';

await initializePhysics();
const path = new URL('../packages/engine/fixtures/spatial/probe.json', import.meta.url);
const sha = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const fixtures = probeInputs.map((input) => {
  const run = runProbe(input);
  return {
    name: input.name,
    inputHash: sha(input),
    // Geometry outcomes alone; `digest` also covers Rapier's world snapshot encoding.
    geometry: sha({ checkpoints: run.checkpoints, casts: run.casts }),
    digest: sha(run),
  };
});
const expected = `${JSON.stringify(fixtures, null, 2)}\n`;
if (process.argv.includes('--write')) {
  await mkdir(new URL('./', path), { recursive: true });
  await writeFile(path, expected);
} else if ((await readFile(path, 'utf8')).replaceAll('\r\n', '\n') !== expected)
  throw new Error('Spatial prototype determinism mismatch');
console.log(expected);
