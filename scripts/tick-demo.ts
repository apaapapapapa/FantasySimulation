import { readFile } from 'node:fs/promises';
import { simulateTickBattle } from '../packages/engine/src/tick-v1/index.ts';

const input: unknown = JSON.parse(
  await readFile(
    new URL('../packages/engine/fixtures/tick-v1/golden.json', import.meta.url),
    'utf8',
  ),
);
if (!Array.isArray(input) || !input[2] || !('manifest' in input[2]))
  throw new Error('Missing demo fixture');
const report = await simulateTickBattle(input[2].manifest);
console.log(JSON.stringify(report, null, 2));
