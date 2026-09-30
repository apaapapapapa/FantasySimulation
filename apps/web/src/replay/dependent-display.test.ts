import { expect, it } from 'vite-plus/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runBattle } from '@fantasy/engine/spatial';
import { summoningManifest } from '../../../../packages/engine/test-support/summoning.ts';
import { recordedCheckpoints } from '../../../../packages/engine/test-support/replay.ts';
import { buildSceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';
import { Dependents3D } from './SceneEffects.tsx';
import { NO_OVERLAYS } from './overlays.ts';

it('renders saved dependents in both viewers across forward and reverse checkpoints', async () => {
  const input = await summoningManifest();
  const output = await runBattle(input);
  const saved = await recordedCheckpoints(input, output);
  const active = saved.checkpoints.findIndex((checkpoint) => checkpoint.state?.dependents?.length);
  expect(active).toBeGreaterThan(0);
  for (const index of [active, active - 1, active, saved.checkpoints.length - 1]) {
    const model = buildSceneModel(saved.context, saved.checkpoints[index]!);
    const expected = index === active ? 2 : 0;
    expect(model.dependents).toHaveLength(expected);
    const two = renderToStaticMarkup(createElement(Scene2D, { model, overlays: NO_OVERLAYS }));
    const three = renderToStaticMarkup(createElement(Dependents3D, { model }));
    expect((two.match(/data-dependent=/g) ?? []).length).toBe(expected);
    expect((three.match(/data-dependent=/g) ?? []).length).toBe(expected);
  }
});
