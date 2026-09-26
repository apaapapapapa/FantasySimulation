import { reference } from '../src/spatial/prepare.ts';
import { ManifestBuilder, sealRevision } from '../src/spatial/manifest-builder.ts';
import { combatManifest } from './fixtures.ts';
import { initialStatus, withInitialStatus } from './ai.ts';

export async function phasingManifest(steps = 65) {
  let input = await combatManifest(steps, {
    ids: {
      ability: 'phase-push-fixture',
      policy: 'phase-hold-fixture',
      character: 'phase-walker-fixture',
    },
    ability: {
      target: 'enemy',
      rangeMm: 10000,
      attack: { kind: 'hitscan', radiusMm: 0 },
      effects: [
        { kind: 'damage', amount: 1, attackScaleBps: 0, element: 'physical', defense: 'none' },
        {
          kind: 'force',
          profile: 'linear-v1',
          direction: 'away',
          speedMmPerSecond: 50000,
          durationSteps: 1,
        },
      ],
      castSteps: 0,
      recoverySteps: 3,
      cooldownSteps: 100,
      costs: { hp: 0, mp: 0, uses: 1 },
      aimErrorMilliDegrees: 0,
    },
    policy: { movement: 'hold', jumpWhenBlocked: false },
  });
  input.participants[0].position.x = -2000;
  input.participants[1].position.x = 2000;
  for (const index of [0, 1] as const)
    await withInitialStatus(
      input,
      index,
      initialStatus({
        stackKey: 'phase-stone',
        durationSteps: 8,
        phasing: { materials: ['stone'], floor: false },
      }),
    );
  const old = input.revisions.find((r) => r.kind === 'scenario')!;
  const scenario = await sealRevision('scenario', 'phase-exit-arena', 1, {
    ...old.definition,
    obstacles: [
      ...old.definition.obstacles,
      ...[-3000, 3000].map((x, i) => ({
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
