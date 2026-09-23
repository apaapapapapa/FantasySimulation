import type { Definition, Stage } from '@fantasy/domain/spatial';
import { combatManifest } from './fixtures.ts';
import { reference, sealRevision } from '../src/spatial/prepare.ts';

/** Fresh declarative data; numerical expectations belong to each consuming test. */
export function comboStages(): Stage[] {
  const attack: Definition<'ability'>['attack'] = {
    kind: 'melee',
    reachMm: 1800,
    radiusMm: 200,
    activeSteps: 2,
    maxHitsPerTarget: 16,
  };
  const damage = (amount: number): Definition<'ability'>['effects'] => [
    { kind: 'damage', amount, attackScaleBps: 0, element: 'physical', defense: 'none' },
  ];
  return [
    { id: 'cut', offsetSteps: 0, durationSteps: 2, attack: { ...attack }, effects: damage(10) },
    {
      id: 'return',
      offsetSteps: 3,
      durationSteps: 2,
      attack: { ...attack },
      effects: damage(15),
      cost: { stamina: 4 },
    },
  ];
}
export async function stagedManifest(
  options: {
    stages?: Stage[];
    stamina?: number;
    ability?: Partial<Definition<'ability'>>;
    steps?: number;
    status?: Definition<'status'>;
  } = {},
) {
  const stages = structuredClone(options.stages ?? comboStages());
  const status = options.status
    ? await sealRevision('status', 'combo-late-status', 1, options.status)
    : null;
  if (status) stages[1]!.effects.push({ kind: 'apply-status', status: reference(status) });
  const manifest = await combatManifest(options.steps ?? 25, {
    ids: {
      ability: 'combo-fixture',
      policy: 'combo-fixture-policy',
      character: 'combo-fixture-fighter',
    },
    ability: {
      castSteps: 2,
      recoverySteps: 4,
      cooldownSteps: 30,
      rangeMm: 2500,
      movementWhileCasting: 'allow',
      costs: { hp: 0, mp: 0, stamina: 6, uses: 1 },
      attack: stages[0]!.attack!,
      effects: stages[0]!.effects,
      stages,
      ...options.ability,
    },
    character: { stamina: { max: options.stamina ?? 20, recoveryPerSecond: 0 } },
    policy: { movement: 'hold', jumpWhenBlocked: false },
  });
  if (status) manifest.revisions.push(status);
  manifest.participants[0].position.x = -750;
  manifest.participants[1].position.x = 750;
  return manifest;
}
