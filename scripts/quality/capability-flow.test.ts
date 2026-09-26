import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, expect, it } from 'vite-plus/test';
import { prepareBattle, runPreparedBattle } from '@fantasy/engine/spatial';
import { initializePhysics } from '../../packages/engine/src/spatial/world/physics.ts';
import { reactionManifest } from '../../packages/engine/test-support/reactions.ts';
import { battleEvents } from '../../packages/engine/test-support/fixtures.ts';
import { withReplayDirectory } from '../../apps/api/test-support/replays.ts';
import { ReplayWriter } from '../../apps/api/src/replay/replay-writer.ts';
import { readReplayManifest, seekReplay, verifyReplay } from '../../apps/api/src/replay/replay-reader.ts';
import { EventEntries } from '../../apps/web/src/replay/EventEntries.tsx';

beforeAll(initializePhysics);

it('connects an authored effect through simulation, durable storage, replay and visible diagnostics', async () => {
  const input = await reactionManifest({
    reactions: [{ reaction: { response: { kind: 'parry', scope: 'damage' } } }],
    attack: {
      effects: [
        { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'fire' },
        {
          kind: 'force',
          profile: 'linear-v1',
          direction: 'away',
          speedMmPerSecond: 500,
          durationSteps: 2,
        },
      ],
    },
  });
  const battle = await prepareBattle(input);
  const output = await runPreparedBattle(battle);
  const force = battleEvents(output.records).filter((event) => event.kind === 'force');
  expect(force).toHaveLength(2);
  await withReplayDirectory(async (root) => {
    const writer = await ReplayWriter.create(root, {
      id: 'capability-flow',
      attemptId: 'capability-attempt',
      simulationHash: battle.simulationHash,
      input: battle.manifest,
    });
    for (const record of output.records) await writer.append(record);
    await writer.finish({ kind: 'result', result: output.result }, 'capability-result');
    const saved = await readReplayManifest(root, 'capability-flow');
    expect(saved.end).toEqual({ kind: 'result', result: output.result });
    const verified = await verifyReplay(root, saved.id);
    expect(await seekReplay(root, saved.id, output.records.length)).toEqual(verified.checkpoint);
    const index = output.records.findIndex(
      (record) => 'events' in record && record.events.some((event) => event.kind === 'force'),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    const restored = await seekReplay(root, saved.id, index + 1);
    const record = restored.lastRecord;
    if (!record || !('events' in record)) throw new Error('Missing saved effect events');
    const restoredForce = record.events.filter((event) => event.kind === 'force');
    expect(restoredForce).toEqual(force.filter((event) => record.events.some((r) => r.id === event.id)));
    const markup = renderToStaticMarkup(
      createElement(EventEntries, { events: restoredForce, step: force[0]!.step, onSeek: () => {} }),
    );
    for (const event of restoredForce) {
      expect(markup).toContain(event.id);
      expect(markup).toContain(event.ruleId);
    }
    expect(markup).toContain('force');
  });
});
