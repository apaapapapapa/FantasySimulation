import { expect, it } from 'vite-plus/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { runBattle } from '@fantasy/engine/spatial';
import { relocationManifest } from '../../../../packages/engine/test-support/spatial-objects.ts';
import { recordedCheckpoints } from '../../../../packages/engine/test-support/replay.ts';
import { buildSceneModel } from './scene-model.ts';
import { EventEntries } from './EventEntries.tsx';

it('renders recorded teleport endpoints without a swept bridge in both seek directions', async () => {
  const input = await relocationManifest(),
    output = await runBattle(input);
  const saved = await recordedCheckpoints(input, output);
  const old = saved.checkpoints.find((c) => c.step === 1 && c.lastRecord?.kind === 'interval')!;
  const jumped = saved.checkpoints.find((c) => c.step === 1 && c.lastRecord?.kind === 'boundary')!;
  const events = jumped.lastRecord && 'events' in jumped.lastRecord ? jumped.lastRecord.events : [];
  for (const c of [old, jumped, old, jumped]) {
    const model = buildSceneModel(saved.context, c);
    expect(model.actors.map((a) => a.position[0])).toEqual(c === old ? [-2, 2] : [-4, 4]);
  }
  const html = renderToStaticMarkup(
    createElement(EventEntries, { events, step: 1, onSeek: () => {} }),
  );
  expect(html).toContain('テレポート');
  expect(html).toContain('経路は補間しません');
});
