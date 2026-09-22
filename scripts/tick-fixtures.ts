import { writeFile } from 'node:fs/promises';
import { goldenCases } from '../packages/engine/fixtures/tick-v1/cases.ts';
import { simulateTickBattle } from '../packages/engine/src/tick-v1/index.ts';

if (!process.argv.includes('--write'))
  throw new Error('Use --write only after reviewing the rule and engine changes.');
const fixtures = [];
for (const { name, manifest } of await goldenCases()) {
  const report = await simulateTickBattle(manifest);
  fixtures.push({
    name,
    manifest,
    expected: {
      simulationHash: report.simulationHash,
      eventsHash: report.eventsHash,
      resultHash: report.resultHash,
      outcome: report.outcome,
      tick: report.tick,
      processedTicks: report.processedTicks,
      finalState: report.finalState,
    },
  });
}
await writeFile(
  new URL('../packages/engine/fixtures/tick-v1/golden.json', import.meta.url),
  `${JSON.stringify(fixtures, null, 2)}\n`,
);
console.log(
  `Wrote ${fixtures.length} golden fixtures. Review their changes; verification never updates expectations.`,
);
