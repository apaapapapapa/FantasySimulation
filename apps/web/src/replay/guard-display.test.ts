import { expect, it } from 'vite-plus/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runBattle } from '@fantasy/engine/spatial';
import { sampleCatalog } from '@fantasy/samples';
import { battleEvents } from '../../../../packages/engine/test-support/fixtures.ts';
import { reactionManifest } from '../../../../packages/engine/test-support/reactions.ts';
import { recordedCheckpoints } from '../../../../packages/engine/test-support/replay.ts';
import { EventEntries } from './EventEntries.tsx';

it('fixture.skill.shield.ox.1.guard-viewer renders the exact saved guard provenance', async () => {
  const ability = (await sampleCatalog()).find(
    (revision) => revision.kind === 'ability' && revision.id === 'shield-set-guard-v1',
  );
  if (ability?.kind !== 'ability') throw new Error('Missing sealed shield guard ability');
  const input = await reactionManifest({
    reactions: [ability.definition],
    character: { stamina: { max: 100, recoveryPerSecond: 10 } },
    attack: {
      categories: ['physical'],
      effects: [{ kind: 'damage', amount: 101, attackScaleBps: 0, element: 'physical' }],
    },
  });
  const run = await runBattle(input);
  const saved = await recordedCheckpoints(input, run);
  const events = battleEvents(run.records).filter((event) => event.damage?.guard);
  expect(events).toHaveLength(2);
  expect(
    events.every((event) => {
      const guard = event.damage!.guard!;
      return (
        guard.after === Math.floor((guard.before * 8000) / 10_000) &&
        guard.responses[0]?.retainedDamageBps === 8000
      );
    }),
  ).toBe(true);
  expect(saved.checkpoints.at(-1)!.nextRecord).toBe(run.records.length);
  const html = renderToStaticMarkup(
    createElement(EventEntries, { events, step: events[0]!.step, onSeek() {} }),
  );
  expect(html).toContain(
    `Guard ${events[0]!.damage!.guard!.before} → ${events[0]!.damage!.guard!.after}`,
  );
  expect(html).toContain(events[0]!.damage!.guard!.responses[0]!.activationId);
});
