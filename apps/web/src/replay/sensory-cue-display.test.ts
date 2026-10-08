import { expect, it } from 'vite-plus/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { savedReplay } from '../../test-support/saved-replay.ts';
import { ReplayPlayer } from './replay-player.ts';
import { buildSceneModel } from './scene-model.ts';
import { Scene2D } from './Scene2D.tsx';
import { NO_OVERLAYS } from './overlays.ts';
import { SensoryCues3D } from './SceneEffects.tsx';

it('shows recorded cues in truth view and substitutes position without truth leakage in actor view', async () => {
  const opened = await savedReplay('p6-concept-stop');
  const checkpoint = structuredClone((await new ReplayPlayer(opened).frame(0)).checkpoint);
  const [creator, observer] = checkpoint.state!.actors;
  creator!.position = { x: 1, y: 0, z: 0 };
  observer!.sensoryCues = [
    {
      id: 'cue.1.2.3',
      creatorId: creator!.id,
      observerId: observer!.id,
      modality: 'visual',
      perceivedOrigin: { x: 9, y: 0, z: 4 },
      emittedAt: 0,
      deliveredAt: 0,
      discoveredAt: 8,
      expiresAt: 10,
      confidenceBps: 8000,
    },
  ];
  const truth = buildSceneModel(opened.context, checkpoint);
  expect(truth.actors.find((actor) => actor.id === creator!.id)!.position).toEqual([1, 0, 0]);
  expect(truth.illusions).toMatchObject([
    { id: 'cue.1.2.3', observerId: observer!.id, position: [9, 0, 4] },
  ]);
  expect(
    renderToStaticMarkup(createElement(Scene2D, { model: truth, overlays: NO_OVERLAYS })),
  ).toContain('data-sensory-cue="cue.1.2.3"');
  expect(renderToStaticMarkup(createElement(SensoryCues3D, { model: truth }))).toContain(
    'data-sensory-cue="cue.1.2.3"',
  );

  const subjective = buildSceneModel(opened.context, checkpoint, undefined, undefined, undefined, {
    actorId: observer!.id,
  });
  expect(subjective.illusions).toEqual([]);
  expect(renderToStaticMarkup(createElement(SensoryCues3D, { model: subjective }))).not.toContain(
    'data-sensory-cue',
  );
  expect(subjective.actors.find((actor) => actor.id === creator!.id)!.position).toEqual([9, 0, 4]);
  expect(subjective.actors).not.toContainEqual(
    expect.objectContaining({ id: creator!.id, position: [1, 0, 0] }),
  );
});
