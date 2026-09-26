import type { Definition, Effect, Manifest } from '@fantasy/domain/spatial';
import { combatManifest } from './fixtures.ts';
import { initialStatus, withInitialStatus } from './ai.ts';
import { sealRevision, ManifestBuilder } from '../src/spatial/manifest-builder.ts';
import { reference } from '../src/spatial/prepare.ts';

// Authored fixture inventory is independent of the production interference table.
export const LEGACY_INTERFERENCE_MECHANICS = [
  'apply-status',
  'contact',
  'counter',
  'damage',
  'dispel',
  'elemental-reaction',
  'flight',
  'force',
  'heal',
  'motion',
  'parry',
  'permanent',
  'periodic',
  'projectile',
  'reaction-effects',
  'resource',
  'reveal',
  'shield',
  'silence',
  'stages',
  'status-adjustment',
  'visibility',
] as const;
export type LegacyInterferenceMechanic = (typeof LEGACY_INTERFERENCE_MECHANICS)[number];
export type RecoveryInterferenceMechanic =
  | LegacyInterferenceMechanic
  | 'attribute-absorption'
  | 'drain';
export type InterferenceMechanic = RecoveryInterferenceMechanic | 'projectile-deflection';
const pairProjectile: Definition<'ability'>['attack'] = {
  kind: 'projectile',
  speedMmPerSecond: 100000,
  radiusMm: 20,
  lifetimeSteps: 10,
  gravityScaleBps: 0,
  homingTurnMilliDegreesPerSecond: 0,
  observation: 'launch-only',
  explosionRadiusMm: 0,
  maxHitsPerTarget: 1,
};

const damage = (amount: number): Effect => ({
  kind: 'damage',
  amount,
  attackScaleBps: 0,
  element: 'fire',
  defense: 'none',
});

/** Real two-sided contacts plus startup cohorts; no expected values or table lookup. */
export async function interferencePairManifest(
  left: InterferenceMechanic,
  right: InterferenceMechanic,
): Promise<Manifest> {
  const input = await combatManifest(10, {
    ability: {
      castSteps: 0,
      recoverySteps: 1,
      cooldownSteps: 20,
      condition: { kind: 'always' },
      costs: { hp: 0, mp: 0, uses: 1 },
      categories: ['magic'],
      rangeMm: 20000,
      aimErrorMilliDegrees: 0,
      attack: { kind: 'hitscan', radiusMm: 0 },
      effects: [damage(4)],
    },
    policy: { movement: 'hold', jumpWhenBlocked: false },
    character: {
      stats: {
        hp: 40,
        mp: 30,
        shield: 1,
        attack: 0,
        defense: 0,
        actionSpeedBps: 10000,
        resistances: { physical: 0, fire: 0, ice: 0, lightning: 0, arcane: 0 },
      },
      stamina: { max: 20, recoveryPerSecond: 0 },
    },
  });
  input.participants[0].position.x = -750;
  input.participants[1].position.x = 750;
  const base = input.revisions.find((r) => r.kind === 'ability')!;
  for (const index of [0, 1] as const) {
    const mechanic = index === 0 ? left : right;
    const action: Definition<'ability'> = structuredClone(base.definition);
    const status = initialStatus({ categories: ['debuff'], durationSteps: 20 });
    let reaction: Partial<Definition<'ability'>> | undefined;
    switch (mechanic) {
      case 'attribute-absorption':
        status.adjustments = [
          { target: 'absorption', operation: 'add', element: 'fire', amount: 10000 },
        ];
        break;
      case 'drain':
        action.effects = [
          {
            kind: 'damage',
            amount: 4,
            attackScaleBps: 0,
            element: 'fire',
            defense: 'none',
            drainBps: 10000,
          },
        ];
        break;
      case 'damage':
        action.effects = [damage(7)];
        break;
      case 'heal':
        action.effects.push({ kind: 'heal', amount: 3 });
        break;
      case 'shield':
        action.effects.push({ kind: 'shield', amount: 2 });
        break;
      case 'apply-status': {
        const granted = await sealRevision(
          'status',
          `pair-mark-${index}`,
          1,
          initialStatus({
            stackKey: 'pair-mark',
            adjustments: [{ target: 'defense', operation: 'add', amount: 1 }],
          }),
        );
        input.revisions.push(granted);
        action.effects.push({ kind: 'apply-status', status: reference(granted) });
        break;
      }
      case 'dispel':
        action.effects.push({ kind: 'dispel', categories: ['debuff'] });
        break;
      case 'elemental-reaction':
        action.effects.push({ kind: 'water', extinguish: true });
        status.reactions = [
          { element: 'fire', response: { kind: 'strengthen', stacks: 1 }, damageTakenBps: 5000 },
          { element: 'water', response: { kind: 'remove' } },
        ];
        status.maxStacks = 2;
        break;
      case 'flight':
        status.modifiers.flight = true;
        status.flightStaminaPerSecond = 1;
        break;
      case 'force':
        action.effects.push({
          kind: 'force',
          profile: 'linear-v1',
          direction: 'away',
          speedMmPerSecond: 1000,
          durationSteps: 2,
        });
        break;
      case 'contact':
        action.attack = {
          kind: 'melee',
          reachMm: 2000,
          radiusMm: 100,
          activeSteps: 1,
          maxHitsPerTarget: 1,
        };
        break;
      case 'projectile-deflection':
      case 'projectile':
        action.attack = structuredClone(pairProjectile);
        if (mechanic === 'projectile-deflection')
          reaction = {
            trigger: 'before-hit',
            effects: [],
            reaction: { response: { kind: 'deflect' } },
          };
        break;
      case 'motion':
      case 'stages':
        action.stages = [
          {
            id: 'first',
            offsetSteps: 0,
            durationSteps: 2,
            attack: structuredClone(action.attack),
            effects: structuredClone(action.effects),
            ...(mechanic === 'motion'
              ? {
                  selfMotion: {
                    kind: 'dash',
                    speedMmPerSecond: 1000,
                    accelerationMmPerSecond2: 100000,
                  } as const,
                }
              : {}),
          },
          {
            id: 'second',
            offsetSteps: 2,
            durationSteps: 1,
            attack: { kind: 'hitscan', radiusMm: 0 },
            effects: [damage(2)],
          },
        ];
        break;
      case 'parry':
        reaction = {
          trigger: 'before-hit',
          effects: [],
          reaction: { response: { kind: 'parry', scope: 'damage' } },
        };
        break;
      case 'counter':
        reaction = {
          trigger: 'after-damage',
          target: 'enemy',
          attack: { kind: 'hitscan', radiusMm: 0 },
          effects: [damage(2)],
          reaction: { response: { kind: 'counter' } },
        };
        break;
      case 'reaction-effects':
        reaction = {
          trigger: 'before-hit',
          effects: [{ kind: 'heal', amount: 2 }],
          reaction: { response: { kind: 'effects' } },
        };
        break;
      case 'permanent':
        status.categories = ['permanent'];
        break;
      case 'periodic':
        status.periodic = [{ everySteps: 2, kind: 'damage', amount: 1, element: 'fire' }];
        break;
      case 'resource':
        status.periodic = [{ everySteps: 2, kind: 'resource', resource: 'mp', amount: -1 }];
        break;
      case 'reveal':
        action.effects.push({
          kind: 'reveal',
          field: 'resistance',
          element: 'fire',
          precisionBps: 1000,
          durationSteps: 20,
          delaySteps: 1,
          occlusion: 'vision',
          powerBps: 10000,
        });
        break;
      case 'silence':
        status.modifiers.silenced = true;
        break;
      case 'status-adjustment':
        status.adjustments = [{ target: 'damageDealt', operation: 'multiply', amount: 8000 }];
        break;
      case 'visibility':
        status.visibility = 'hidden';
        status.adjustments = [{ target: 'visibility', operation: 'multiply', amount: 5000 }];
        break;
      default: {
        const exhaustive: never = mechanic;
        throw new Error(`Unclassified fixture ${exhaustive}`);
      }
    }
    if (
      [left, right].includes('projectile-deflection') &&
      !['contact', 'reveal'].includes(mechanic) &&
      !action.stages
    )
      action.attack = structuredClone(pairProjectile);
    const primary = await sealRevision('ability', `pair-action-${index}`, 1, action);
    const abilities = [primary];
    if (reaction)
      abilities.push(
        await sealRevision('ability', `pair-response-${index}`, 1, {
          ...base.definition,
          categories: ['technique'],
          trigger: 'before-hit',
          castSteps: 0,
          target: 'self',
          attack: { kind: 'direct' },
          effects: [],
          costs: { hp: 0, mp: 0, uses: 1 },
          ...reaction,
        }),
      );
    const participant = input.participants[index];
    const old = input.revisions.find(
      (r) => r.kind === 'character' && r.id === participant.character.id,
    )!;
    if (old.kind !== 'character') throw new Error('Missing pair character');
    const oldPolicy = input.revisions.find(
      (r) => r.kind === 'policy' && r.id === old.definition.policy.id,
    )!;
    if (oldPolicy.kind !== 'policy') throw new Error('Missing pair policy');
    const policy = await sealRevision('policy', `pair-policy-${index}`, 1, {
      ...oldPolicy.definition,
      priorities: oldPolicy.definition.priorities.map((entry) => ({
        ...entry,
        abilityId: primary.id,
      })),
    });
    const character = await sealRevision('character', `pair-actor-${index}`, 1, {
      ...old.definition,
      policy: reference(policy),
      abilities: abilities.map(reference),
    });
    input.revisions.push(...abilities, policy, character);
    participant.character = reference(character);
    await withInitialStatus(input, index, status);
  }
  input.revisions = ManifestBuilder.from(input.revisions).closure([
    ...input.participants.map((p) =>
      input.revisions.find((r) => r.kind === 'character' && r.id === p.character.id)!,
    ),
    input.revisions.find((r) => r.kind === 'ruleset' && r.id === input.ruleset.id)!,
    input.revisions.find((r) => r.kind === 'scenario' && r.id === input.scenario.id)!,
  ]);
  return input;
}
