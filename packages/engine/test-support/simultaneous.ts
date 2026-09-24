import { AI_RULES } from '@fantasy/domain/spatial';
import { combatManifest } from './fixtures.ts';
import { locomotion } from './locomotion.ts';
import { STANDARD_MOVEMENT } from '@fantasy/samples';
import { reference, sealRevision } from '../src/spatial/prepare.ts';

export async function simultaneousManifest(maxSteps = 70, withStamina = true) {
  const manifest = await combatManifest(maxSteps, {
    ids: {
      ability: 'simultaneous-shot',
      policy: 'simultaneous-policy',
      character: 'simultaneous-fighter',
    },
    ability: {
      castSteps: 0,
      recoverySteps: 5,
      rangeMm: 30000,
      movementWhileCasting: 'allow',
      attack: {
        kind: 'projectile',
        radiusMm: 80,
        speedMmPerSecond: 5000,
        gravityScaleBps: 0,
        lifetimeSteps: 150,
        homingTurnMilliDegreesPerSecond: 0,
        observation: 'launch-only',
        explosionRadiusMm: 0,
        maxHitsPerTarget: 1,
      },
      costs: { hp: 0, mp: 0, stamina: withStamina ? 6 : 0, uses: 0 },
      effects: [{ kind: 'damage', amount: 10, attackScaleBps: 0, element: 'physical' }],
    },
    character: {
      ...(withStamina ? { stamina: { max: 1000, recoveryPerSecond: 0 } } : {}),
      movement: {
        ...STANDARD_MOVEMENT,
        accelerationMmPerSecond2: 100000,
        ...(withStamina ? { locomotion: locomotion() } : {}),
      },
    },
    policy: { movement: 'hold', jumpWhenBlocked: false },
  });
  const old = manifest.revisions.find((r) => r.kind === 'ruleset')!;
  const rules = await sealRevision('ruleset', 'simultaneous-fixture', 1, {
    ...old.definition,
    ai: { ...AI_RULES, slots: 'simultaneous-v1' },
  });
  manifest.revisions = manifest.revisions.map((r) => (r === old ? rules : r));
  manifest.ruleset = reference(rules);
  return manifest;
}
