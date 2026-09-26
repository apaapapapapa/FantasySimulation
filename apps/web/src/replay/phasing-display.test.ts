import { expect, it } from 'vite-plus/test';
import { runBattle } from '@fantasy/engine/spatial';
import { phasingManifest } from '../../../../packages/engine/test-support/phasing.ts';
import { recordedCheckpoints } from '../../../../packages/engine/test-support/replay.ts';
import { buildSceneModel } from './scene-model.ts';
import { renderCapabilityScene } from '../../test-support/capability-render.ts';

it('shows recorded phasing and bounded exit independently of the expired status in reverse seek', async () => {
  const input = await phasingManifest(),
    run = await runBattle(input),
    saved = await recordedCheckpoints(input, run);
  const active = saved.checkpoints.find((c) =>
      c.state?.actors.some((a) => a.phasing?.active.length),
    )!,
    final = saved.checkpoints.at(-1)!;
  for (const checkpoint of [final, active, final]) {
    const model = buildSceneModel(saved.context, checkpoint);
    expect(model.actors.every((a) => a.phasing?.materials.includes('stone'))).toBe(true);
    expect(model.actors.every((a) => a.phasing?.pending)).toBe(checkpoint === final);
    const html = renderCapabilityScene(model);
    expect(html).toContain(checkpoint === final ? '透過解除待ち 50/50' : '透過中');
    if (checkpoint === final)
      expect(checkpoint.state!.actors.every((a) => !a.statuses.length)).toBe(true);
  }
});
