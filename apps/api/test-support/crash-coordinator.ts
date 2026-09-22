import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { SpecInputSchema, parseJson } from '@fantasy/domain/spatial';
import { openStore } from '../src/store.ts';
import { BattleRuntime } from '../src/battle-runtime.ts';
import { simulationAttempts } from '../src/db/schema.ts';

// A real abruptly exited coordinator, with an explicitly expired lease, for restart acceptance.
const [filename, root, input] = process.argv.slice(2);
if (!filename || !root || !input) throw new Error('Crash fixture requires database/root/spec');
const store = openStore(filename),
  runtime = await BattleRuntime.open(store, root);
const spec = parseJson(SpecInputSchema, JSON.parse(await readFile(input, 'utf8')) as unknown);
const job = await runtime.submit(spec, 'crash', 'one');
store.orm
  .update(simulationAttempts)
  .set({ leaseUntil: Date.now() - 1 })
  .where(eq(simulationAttempts.jobId, job.id))
  .run();
process.stdout.write(job.id + '\n', () => process.exit(83));
