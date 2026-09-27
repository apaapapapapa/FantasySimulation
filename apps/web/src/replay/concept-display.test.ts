import { expect, it } from 'vite-plus/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { conceptManifest } from '../../../../packages/engine/test-support/concepts.ts';
import { stopManifest } from '../../../../packages/engine/test-support/time-stop.ts';
import { recordedCheckpoints } from '../../../../packages/engine/test-support/replay.ts';
import { runBattle } from '@fantasy/engine/spatial';
import { buildSceneModel } from './scene-model.ts';
import { ReplayResources } from './ReplayResources.tsx';
import { Scene2D } from './Scene2D.tsx';
import { NO_OVERLAYS } from './overlays.ts';
import { savedReplay } from '../../test-support/saved-replay.ts';
import { ReplayPlayer } from './replay-player.ts';

it('seeks fixed stopped recordings forward backward and across a loop without advancing pending HP', async () => {
  const opened = await savedReplay('p6-concept-stop'),
    player = new ReplayPlayer(opened),
    expected = await player.frame(50);
  expect(expected.checkpoint.deferred!.length).toBeGreaterThan(0);
  expect(expected.checkpoint.state!.actors[1]!.resources.hp).toBe(40);
  expect(expected.checkpoint.state!.actors[1]!.clock!.subjectStep).toBe(6);
  for (const step of [106, 0, 50, 80, 106, 0, 50]) {
    const frame = await player.frame(step);
    if (step === 50) expect(frame.checkpoint).toEqual(expected.checkpoint);
    if (step === 106) {
      expect(frame.checkpoint.deferred).toEqual([]);
      expect(frame.checkpoint.state!.actors[1]!).toMatchObject({
        resources: { hp: 0 },
        clock: { pausedSteps: 100 },
      });
    }
    if (step === 0)
      expect(frame.checkpoint.state!.actors.every((a) => a.clock === undefined)).toBe(true);
  }
});

it('renders recorded defeat and immortal protection in both scene models and removes them on rewind', async () => {
  const input = await conceptManifest({ both: true, status: { immortality: { protections: 1 } } });
  const run = await runBattle(input);
  const { context, checkpoints } = await recordedCheckpoints(input, run);
  const frame = checkpoints.find(
    (checkpoint) =>
      checkpoint.lastRecord &&
      'events' in checkpoint.lastRecord &&
      checkpoint.lastRecord.events.some((event) => event.immortality),
  )!;
  const model = buildSceneModel(context, frame);
  expect(model.actors.every((actor) => actor.protected && actor.defeated)).toBe(true);
  const table = renderToStaticMarkup(
    createElement(ReplayResources, { context, checkpoint: frame }),
  );
  expect(table).toContain('不死: HP 1で耐える');
  expect(table).toContain('即死: 成立');
  expect(renderToStaticMarkup(createElement(Scene2D, { model, overlays: NO_OVERLAYS }))).toContain(
    '不死の保護',
  );
  expect(
    buildSceneModel(context, checkpoints[0]!).actors.every(
      (actor) => !actor.protected && !actor.defeated,
    ),
  ).toBe(true);
});

it('renders frozen poses and pending contents without applying HP before the recorded release', async () => {
  const input = await stopManifest({ duration: 12, steps: 25 }),
    run = await runBattle(input);
  const { context, checkpoints } = await recordedCheckpoints(input, run);
  const pending = checkpoints.find((checkpoint) => checkpoint.deferred?.length)!;
  const model = buildSceneModel(context, pending);
  expect(model.actors[1]).toMatchObject({
    frozen: true,
    subjectMilliseconds: pending.state!.actors[1]!.clock!.subjectStep * 20,
  });
  const table = renderToStaticMarkup(
    createElement(ReplayResources, { context, checkpoint: pending }),
  );
  expect(table).toContain('時間停止中');
  expect(table).toContain('保留中の効果:');
  expect(renderToStaticMarkup(createElement(Scene2D, { model, overlays: NO_OVERLAYS }))).toContain(
    '時間停止',
  );
  expect(pending.state!.actors[1]!.resources.hp).toBe(40);
  const end = checkpoints.at(-1)!;
  expect(buildSceneModel(context, end).actors[1]!.frozen).toBe(false);
  expect(end.state!.actors[1]!.resources.hp).toBeLessThan(40);
  expect(buildSceneModel(context, checkpoints[0]!).actors[1]!.subjectMilliseconds).toBeUndefined();
});
