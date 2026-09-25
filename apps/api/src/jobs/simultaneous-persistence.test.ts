import { join } from 'node:path';
import { StreamRecordSchema } from '@fantasy/domain/spatial';
import { describe, expect, it } from 'vite-plus/test';
import { runBattle } from '@fantasy/engine/spatial';
import { simultaneousManifest } from '../../../../packages/engine/test-support/simultaneous.ts';
import {
  stagedManifest,
  movingSweepStages,
} from '../../../../packages/engine/test-support/stages.ts';
import { reactionManifest } from '../../../../packages/engine/test-support/reactions.ts';
import { initialStatus } from '../../../../packages/engine/test-support/ai.ts';
import { battleEvents } from '../../../../packages/engine/test-support/fixtures.ts';
import { specInput, withRuntime } from '../../test-support/runtime.ts';
import {
  readReplayChunk,
  readReplayManifest,
  seekReplay,
  verifyReplay,
} from '../replay/replay-reader.ts';

describe('simultaneous slots through persisted Workers', () => {
  it.each(['joint', 'staged', 'motion', 'reaction'] as const)(
    'preserves %s decisions, costs and replacement displays across forward and backward seeks',
    async (mode) => {
      await withRuntime(
        async ({ runtime, jobs, store, root }) => {
          const input = await (mode === 'joint'
            ? simultaneousManifest()
            : mode === 'staged'
              ? stagedManifest({ status: initialStatus() })
              : mode === 'motion'
                ? stagedManifest({
                    stages: movingSweepStages(),
                    steps: 20,
                    ability: { castSteps: 0 },
                  })
                : reactionManifest({
                    steps: 20,
                    reactions: [
                      {
                        reaction: {
                          response: { kind: 'parry', scope: 'damage' },
                          elements: ['fire'],
                        },
                        costs: { hp: 0, mp: 1, uses: 1 },
                      },
                      {
                        trigger: 'after-damage',
                        target: 'enemy',
                        rangeMm: 20000,
                        attack: { kind: 'hitscan', radiusMm: 0 },
                        reaction: { response: { kind: 'counter' } },
                        costs: { hp: 0, mp: 2, uses: 1 },
                        effects: [
                          { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'physical' },
                        ],
                      },
                    ],
                    attack: {
                      effects: [
                        { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'fire' },
                        { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'water' },
                      ],
                    },
                  }));
          await store.seedRevisions(input.revisions);
          const direct = await runBattle(input);
          const submitted = await runtime.submit(specInput(input), 'simultaneous', 'persist');
          const done = await runtime.wait(submitted.id);
          expect(done.state).toBe('completed');
          const result = jobs.result(done.resultId!)!;
          expect(JSON.parse(result.resultJson)).toEqual(direct.result);
          const manifest = await readReplayManifest(root, result.replayId);
          const verified = await verifyReplay(root, result.replayId);
          const records = (
            await Promise.all(
              manifest.chunks.map((chunk) =>
                readReplayChunk(join(root, manifest.id), manifest, chunk.index),
              ),
            )
          ).flat();
          const parsed = records.map((r) => StreamRecordSchema.parse(r));
          const events = battleEvents(parsed);
          if (mode === 'joint')
            expect(
              events.filter(
                (e) =>
                  e.cognition?.kind === 'decision' &&
                  e.cognition.movementSlot?.selection === 'dodge',
              ),
            ).not.toHaveLength(0);
          else if (mode === 'staged') {
            expect(events.filter((e) => e.kind === 'hit').map((e) => e.stage?.stageId)).toEqual([
              'cut',
              'cut',
              'return',
              'return',
            ]);
            expect(events.filter((e) => e.kind === 'stage-start')).toHaveLength(4);
            expect(store.getSpec(done.simulationHash)?.manifest).toEqual(manifest.input);
            expect(
              events.filter((e) => e.reason === 'apply-status').map((e) => e.stage?.stageId),
            ).toEqual(['return', 'return']);
          } else if (mode === 'motion') {
            expect(events.filter((e) => e.kind === 'force')).toHaveLength(2);
            expect(
              parsed.some(
                (r) =>
                  r.kind === 'interval' &&
                  r.changes.some((a) => a.action?.stage?.geometry?.kind === 'blade'),
              ),
            ).toBe(true);
            expect(store.getSpec(done.simulationHash)?.manifest).toEqual(manifest.input);
          } else {
            expect(events.filter((e) => e.ruleId === 'reaction.activated')).toHaveLength(4);
            expect(events.filter((e) => e.ruleId === 'reaction.release')).toHaveLength(2);
            expect(parsed).toEqual(direct.records);
            expect(store.getSpec(done.simulationHash)?.manifest).toEqual(manifest.input);
            expect(
              events.some(
                (e) => e.cognition?.kind === 'decision' && e.cognition.reactions?.length === 2,
              ),
            ).toBe(true);
          }
          for (const cursor of [manifest.records, 1, manifest.records]) {
            const state = await seekReplay(root, manifest.id, cursor);
            expect(state.nextRecord).toBe(cursor);
            if (cursor === manifest.records) expect(state).toEqual(verified.checkpoint);
          }
        },
        {},
        mode === 'joint' ? 50 : mode === 'staged' ? 25 : 20,
      );
    },
  );
});
