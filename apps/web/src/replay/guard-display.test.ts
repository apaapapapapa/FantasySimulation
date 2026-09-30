import { expect, it } from 'vite-plus/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runBattle } from '@fantasy/engine/spatial';
import { battleEvents } from '../../../../packages/engine/test-support/fixtures.ts';
import { reactionManifest } from '../../../../packages/engine/test-support/reactions.ts';
import { recordedCheckpoints } from '../../../../packages/engine/test-support/replay.ts';
import { EventEntries } from './EventEntries.tsx';

it('renders the recorded martial guard boundary from a saved replay', async () => {
  const input = await reactionManifest({
    reactions: [{ reaction: { response: { kind: 'guard', retainedDamageBps: 6000 } } }],
    attack: {
      effects: [{ kind: 'damage', amount: 20, attackScaleBps: 0, element: 'physical' }],
    },
  });
  const run = await runBattle(input);
  const saved = await recordedCheckpoints(input, run);
  const events = battleEvents(run.records).filter((event) => event.damage?.guard);
  expect(events).toHaveLength(2);
  expect(saved.checkpoints.at(-1)!.nextRecord).toBe(run.records.length);
  const html = renderToStaticMarkup(
    createElement(EventEntries, { events, step: events[0]!.step, onSeek() {} }),
  );
  expect(html).toContain(
    `Guard ${events[0]!.damage!.guard!.before} → ${events[0]!.damage!.guard!.after}`,
  );
  expect(html).toContain(events[0]!.damage!.guard!.responses[0]!.activationId);
});
