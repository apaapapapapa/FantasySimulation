import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { initializePhysics } from '../packages/engine/src/spatial/physics.ts';
import { probeInputs, runProbe } from '../packages/engine/src/spatial/probe.ts';

await initializePhysics();
const path = new URL('../packages/engine/fixtures/spatial/probe.json', import.meta.url);
const sha = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const fixtures = probeInputs.map((input) => ({
  name: input.name,
  inputHash: sha(input),
  digest: sha(runProbe(input)),
}));
const expected = `${JSON.stringify(fixtures, null, 2)}\n`;
if (process.argv.includes('--write')) {
  await mkdir(new URL('./', path), { recursive: true });
  await writeFile(path, expected);
} else if ((await readFile(path, 'utf8')).replaceAll('\r\n', '\n') !== expected)
  throw new Error('Spatial prototype determinism mismatch');
console.log(expected);
