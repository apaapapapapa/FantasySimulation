import { expect, it } from 'vite-plus/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { runBattle } from '@fantasy/engine/spatial';
import { objectManifest } from '../../../../packages/engine/test-support/object-manifest.ts';
import { recordedCheckpoints } from '../../../../packages/engine/test-support/replay.ts';
import { buildSceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';

it.each(['barrier', 'area', 'beam'] as const)(
  'renders recorded %s geometry through activation removal and reverse seek',
  async (kind) => {
    const input = await objectManifest(kind, {}, 20),
      output = await runBattle(input),
      saved = await recordedCheckpoints(input, output);
    const active = saved.checkpoints.findIndex((c) =>
      c.state?.objects?.some((o) => o.kind === kind),
    );
    expect(active).toBeGreaterThan(0);
    for (const index of [active, active - 1, active, saved.checkpoints.length - 1]) {
      const model = buildSceneModel(saved.context, saved.checkpoints[index]!);
      const expected = index === active ? 2 : 0;
      expect(model.objects).toHaveLength(expected);
      if (expected) {
        expect(
          kind === 'beam'
            ? model.objects.every((o) => o.beams.length > 0)
            : model.objects.every((o) => o.shape?.kind === 'sphere'),
        ).toBe(true);
        const html = renderToStaticMarkup(
          createElement(Scene2D, {
            model,
            overlays: {
              collision: false,
              paths: false,
              vision: false,
              rays: false,
              hits: false,
              motion: false,
            },
          }),
        );
        expect(html).toContain(
          kind === 'barrier' ? '結界 耐久 10/10' : kind === 'area' ? '持続範囲' : '照射',
        );
      }
    }
  },
);
