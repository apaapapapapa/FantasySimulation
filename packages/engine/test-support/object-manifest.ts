import type { Definition, SpatialShape, Stage } from '@fantasy/domain/spatial';
import { combatManifest } from './fixtures.ts';

export function objectAbility(
  kind: 'barrier' | 'area' | 'beam',
  shape: SpatialShape = { kind: 'sphere', radiusMm: 500 },
): Partial<Definition<'ability'>> {
  const placement = {
    anchor: 'self' as const,
    direction: 'front' as const,
    distanceMm: 1000,
    maxDistanceMm: 8000,
  };
  const attack: Definition<'ability'>['attack'] =
    kind === 'barrier'
      ? { kind: 'direct' }
      : kind === 'area'
        ? {
            kind,
            placement: { ...placement, distanceMm: 4000 },
            shape,
            durationSteps: 10,
            armDelaySteps: 2,
            periodSteps: 3,
          }
        : { kind, radiusMm: 30 };
  const effects: Definition<'ability'>['effects'] =
    kind === 'barrier'
      ? []
      : [{ kind: 'damage', amount: 6, attackScaleBps: 0, element: 'physical' }];
  const barrier =
    kind === 'barrier'
      ? {
          placement,
          shape,
          durationSteps: 3,
          attachment: 'fixed' as const,
          durability: 10,
          blocks: { movement: 'both' as const, vision: 'both' as const, attack: 'both' as const },
        }
      : undefined;
  const stage: Stage = {
    id: 'emit',
    offsetSteps: 0,
    durationSteps: kind === 'beam' ? 4 : 1,
    attack,
    effects,
    hit: { group: 'field', maxHits: 2, minIntervalSteps: 1, requireSeparation: false },
    ...(barrier ? { barrier } : {}),
  };
  return {
    name: `object ${kind}`,
    originalText: '',
    trigger: 'action',
    target: kind === 'barrier' ? 'self' : 'enemy',
    condition: { kind: 'always' },
    attack,
    effects,
    ...(barrier ? { barrier } : {}),
    stages: [stage],
    costs: { hp: 0, mp: 3, uses: 1 },
    castSteps: 0,
    recoverySteps: 3,
    cooldownSteps: 30,
    movementWhileCasting: 'stop',
    rangeMm: 8000,
    aimErrorMilliDegrees: 0,
  };
}
export async function objectManifest(
  kind: 'barrier' | 'area' | 'beam',
  edit: Partial<Definition<'ability'>> = {},
  steps = 15,
) {
  const input = await combatManifest(steps, {
    ids: {
      ability: `spatial-${kind}-test`,
      policy: 'object-hold-test',
      character: `object-${kind}-test`,
    },
    ability: { ...objectAbility(kind), ...edit },
    policy: { movement: 'hold', preferredDistanceMm: 4000, jumpWhenBlocked: false },
  });
  input.participants[0].position.x = -2000;
  input.participants[1].position.x = 2000;
  return input;
}
