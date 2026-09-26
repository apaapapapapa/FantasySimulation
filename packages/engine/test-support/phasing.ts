import { reference } from '../src/spatial/prepare.ts';
import { ManifestBuilder, sealRevision } from '../src/spatial/manifest-builder.ts';
import { relocationManifest } from './spatial-objects.ts';
import { initialStatus, withInitialStatus } from './ai.ts';

export async function phasingManifest(steps = 65) {
  let input = await relocationManifest(
    { relocation: { anchor: 'self', direction: 'back', distanceMm: 2000, maxDistanceMm: 2100 } },
    steps,
  );
  for (const index of [0, 1] as const)
    await withInitialStatus(
      input,
      index,
      initialStatus({
        stackKey: 'phase-stone',
        durationSteps: 2,
        phasing: { materials: ['stone'], floor: false },
      }),
    );
  const old = input.revisions.find((r) => r.kind === 'scenario')!;
  const scenario = await sealRevision('scenario', 'phase-exit-arena', 1, {
    ...old.definition,
    obstacles: [
      ...old.definition.obstacles,
      ...[-4000, 4000].map((x, i) => ({
        id: `phase-wall-${i}`,
        kind: 'box' as const,
        material: 'stone' as const,
        center: { x, y: 1000, z: 0 },
        halfExtents: { x: 500, y: 1000, z: 1000 },
        yawMilliDegrees: 0,
        slopeMilliDegrees: 0,
        blocks: { movement: true, vision: true, attack: true },
      })),
    ],
  });
  input = await ManifestBuilder.relink(input, [{ from: old, to: scenario }]);
  input.scenario = reference(scenario);
  return input;
}
