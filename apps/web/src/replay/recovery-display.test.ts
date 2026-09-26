import { expect, it } from 'vite-plus/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EventSchema } from '@fantasy/domain/spatial';
import { recoveryDisplay } from './recovery-display.ts';
import { EventEntries } from './EventEntries.tsx';

it('renders conversion and causal drain for their recorded recipients without inferring HP loss', () => {
  const event = EventSchema.parse({
    schemaVersion: 1,
    id: 'e.4',
    sequence: 4,
    step: 1,
    phase: 'resolution',
    subtimeMicros: 0,
    kind: 'damage',
    actorId: 'left',
    targetId: 'right',
    entityId: null,
    parentEventId: 'e.3',
    causes: [],
    abilityId: 'drain',
    ruleId: 'damage.defense-resistance-shield',
    point: null,
    before: { hp: 40, mp: 0, shield: 0 },
    after: { hp: 40, mp: 0, shield: 0 },
    amount: 20,
    damage: {
      defenseApplied: 0,
      afterDefense: 20,
      afterResistance: 20,
      absorption: { element: 'fire', converted: 10, healing: 10 },
      drain: { basis: { numerator: '10', denominator: '1' }, healing: 5 },
      absorbed: { numerator: '0', denominator: '1' },
      toHp: { numerator: '10', denominator: '1' },
    },
    reason: '',
  });
  expect(recoveryDisplay([event]).map((i) => i.actorId)).toEqual(['right', 'left']);
  const markup = renderToStaticMarkup(
    createElement(EventEntries, { events: [event], step: 1, onSeek: () => {} }),
  );
  expect(markup).toContain('属性吸収（fire）: 10を変換 / 回復 10');
  expect(markup).toContain('ドレイン: leftが回復 5 / 実HP損失の配分 10/1');
  const legacy = { ...event, damage: { ...event.damage! } };
  delete legacy.damage.absorption;
  delete legacy.damage.drain;
  expect(recoveryDisplay([legacy])).toEqual([]);
});
