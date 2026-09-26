import { expect, it } from 'vite-plus/test';
import { savedReplay } from '../../test-support/saved-replay.ts';
import { ReplayPlayer } from './replay-player.ts';
import { buildSceneModel } from './scene-model.ts';
import { renderCapabilityScene } from '../../test-support/capability-render.ts';

it.each([
  ['teleport', 1, 20],
  ['barrier', 1, 20],
  ['area', 6, 20],
  ['beam', 6, 20],
  ['phasing', 8, 58],
] as const)(
  'restores saved %s through forward reverse and loop playback',
  async (kind, active, end) => {
    const opened = await savedReplay(`p6-spatial-${kind}`),
      player = new ReplayPlayer(opened),
      expected = await player.frame(active);
    for (const step of [end, 0, active, active + 1, 0, active]) {
      const frame = await player.frame(step);
      const model = buildSceneModel(
        opened.context,
        frame.checkpoint,
        frame.records,
        frame.events,
        frame.eventRecords,
      );
      if (step !== active) continue;
      expect(frame.checkpoint).toEqual(expected.checkpoint);
      if (kind === 'teleport') {
        expect(frame.checkpoint.state!.actors.map((a) => a.position.x)).toEqual([-4, 4]);
        expect(model.paths.every((p) => Math.abs(p.points[1][0] - p.points[0][0]) < 0.1)).toBe(
          true,
        );
      } else if (kind === 'phasing') {
        expect(frame.checkpoint.state!.actors.every((a) => a.phasing?.exitPending)).toBe(true);
        expect(renderCapabilityScene(model)).toContain('透過解除待ち 0/50');
      } else {
        expect(model.objects).toHaveLength(2);
        expect(renderCapabilityScene(model)).toContain(
          kind === 'barrier' ? '結界' : kind === 'area' ? '持続範囲' : '照射',
        );
      }
    }
  },
);
