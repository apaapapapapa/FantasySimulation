import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { it } from 'vite-plus/test';
import { DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { runBattle } from '@fantasy/engine/spatial';
import { BattlePool } from './worker-pool.ts';
import { buildRecipe, parseCorpus } from '../../../../scripts/harness/corpus.ts';
import { sourceIdentity } from '../../../../scripts/harness/source.ts';

it(
  'runs the fixed corpus through one and multiple real Workers in reversed submission order',
  { timeout: 60000 },
  async () => {
    const corpus = parseCorpus(
      JSON.parse(readFileSync('packages/engine/fixtures/spatial/corpus.json', 'utf8')),
    );
    const inputs = await Promise.all(
      corpus.entries.map(async (entry) => ({
        id: entry.id,
        manifest: await buildRecipe(entry.recipe),
      })),
    );
    const expected = new Map(
      await Promise.all(
        inputs.map(async (input) => [input.id, (await runBattle(input.manifest)).result] as const),
      ),
    );
    const observations: unknown[] = [];
    const count = Math.min(4, Math.max(1, availableParallelism() - 1));
    assert.ok(
      count >= 2,
      'Multiple Worker coverage unavailable; do not report a one-Worker run as multiple',
    );
    for (const workers of [1, count]) {
      const pool = new BattlePool(workers);
      try {
        const ordered = workers === 1 ? inputs : [...inputs].reverse();
        for (let offset = 0; offset < ordered.length; offset += workers)
          await Promise.all(
            ordered.slice(offset, offset + workers).map(async (input) => {
              const actual = await pool.run(
                input.manifest,
                DEFAULT_BUDGET,
                async () => {},
                AbortSignal.timeout(30000),
              );
              observations.push({
                id: input.id,
                workers,
                result: actual.result,
                metrics: actual.metrics,
              });
              assert.deepEqual(actual.result, expected.get(input.id));
            }),
          );
      } finally {
        await pool.close();
      }
    }
    mkdirSync('.generated/harness/worker-corpus', { recursive: true });
    writeFileSync(
      '.generated/harness/worker-corpus/results.json',
      JSON.stringify(
        {
          ...sourceIdentity(process.cwd()),
          inputIds: inputs.map((input) => input.id),
          observations,
        },
        null,
        2,
      ) + '\n',
    );
  },
);
