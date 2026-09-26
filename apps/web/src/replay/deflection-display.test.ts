import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vite-plus/test';
import { openReplay } from './open-replay.ts';
import { ReplayPlayer } from './replay-player.ts';
import { buildSceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';
import { NO_OVERLAYS } from './overlays.ts';
import { renderCapabilityEvents } from '../../test-support/capability-render.ts';

it('renders the saved deflection turn owner velocity and polyline while seeking both ways', async () => {
  const fixture = new URL('../../test-fixtures/replays/p6-deflection-160/', import.meta.url);
  const opened = await openReplay({
    manifest: async () => JSON.parse(await readFile(new URL('manifest.json', fixture), 'utf8')),
    file: async (ref) => new Uint8Array(await readFile(new URL(ref.file, fixture))),
  });
  const player = new ReplayPlayer(opened);
  for (const step of [11, 10, 11, 12]) {
    const frame = await player.frame(step);
    const model = buildSceneModel(
      opened.context,
      frame.checkpoint,
      frame.records,
      frame.events,
      frame.eventRecords,
    );
    const returned = model.projectiles.find((p) => p.ownerId === 'right');
    expect(!!returned).toBe(step >= 11);
    if (returned) expect(returned.colour).toBe('#72e0c1');
    if (step === 11) {
      const turn = frame.events.find((e) => e.kind === 'projectile-deflect')!;
      expect(turn.projectileDeflection).toMatchObject({
        basis: 'observed-position',
        originalOwnerId: 'left',
        ownerId: 'right',
      });
      const arrow = model.arrows.find((a) => a.kind === 'deflection')!;
      expect(arrow.points[0]).toEqual(Object.values(turn.projectileDeflection!.position));
      expect(arrow.points[1][0]).toBeLessThan(arrow.points[0][0]);
      const path = model.paths.filter((p) => p.entityId === turn.entityId);
      expect(path.length).toBeGreaterThan(1);
      expect(path.at(-1)!.points[0]).toEqual(path.at(-1)!.points[1]);
      const markup = renderToStaticMarkup(
        createElement(Scene2D, { model, overlays: { ...NO_OVERLAYS, paths: true, motion: true } }),
      );
      expect(markup).toContain('#72e0c1');
      const detail = renderCapabilityEvents(frame.events, step);
      expect(detail).toContain('跳ね返し');
      expect(detail).toContain('観測した攻撃者の位置へ');
    }
  }
});
