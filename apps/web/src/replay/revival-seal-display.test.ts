import { expect, it } from 'vite-plus/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { revivalManifest } from '../../../../packages/engine/test-support/revival.ts';
import { initialStatus, withInitialStatus } from '../../../../packages/engine/test-support/ai.ts';
import { recordedCheckpoints } from '../../../../packages/engine/test-support/replay.ts';
import { runBattle } from '@fantasy/engine/spatial';
import { buildSceneModel } from './scene-model.ts';
import { ReplayResources } from './ReplayResources.tsx';
import { Scene2D } from './Scene2D.tsx';
import { NO_OVERLAYS } from './overlays.ts';

it('shows recorded revival and sealing in the shared 3D model, 2D scene and resource table', async () => {
  for (const sealing of [false, true]) {
    const input = await revivalManifest();
    if (sealing)
      await withInitialStatus(
        input,
        0,
        initialStatus({ seals: { abilityCategories: ['special'] }, durationSteps: 20 }),
      );
    const run = await runBattle(input);
    const { context, checkpoints } = await recordedCheckpoints(input, run);
    const frame = checkpoints.find(
      (c) => c.lastRecord && 'events' in c.lastRecord && c.lastRecord.events.some((e) => e.revival),
    )!;
    const model = buildSceneModel(context, frame);
    expect(model.actors.find((a) => a.id === 'right')!.revived).toBe(true);
    expect(model.actors.find((a) => a.id === 'left')!.sealing).toBe(sealing);
    const table = renderToStaticMarkup(
      createElement(ReplayResources, { context, checkpoint: frame }),
    );
    expect(table).toContain('蘇生: HP 0 → 7');
    if (sealing) expect(table).toContain('封印中');
    const scene = renderToStaticMarkup(createElement(Scene2D, { model, overlays: NO_OVERLAYS }));
    expect(scene).toContain('蘇生');
    if (sealing) expect(scene).toContain('封印中');
    const start = buildSceneModel(context, checkpoints[0]!);
    expect(start.actors.every((a) => !a.revived && !a.sealing)).toBe(true);
  }
});
