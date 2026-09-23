import {
  contentHash,
  CURRENT_ENGINE_VERSION,
  AI_RULES,
  AppearancePriorsSchema,
  LEGACY_APPEARANCE_PRIORS,
  actorSeed,
  PhysicsProfileSchema,
  type Definition,
  type Manifest,
} from '@fantasy/domain/spatial';
import { implementation, profile, reference, sealRevision } from './prepare.ts';

export const STANDARD_BODY: Definition<'character'>['body'] = {
  radiusMm: 300,
  heightMm: 1800,
  eyeOffset: { x: 0, y: 650, z: 0 },
  muzzleOffset: { x: 0, y: 400, z: 300 },
  aimOffset: { x: 0, y: 200, z: 0 },
};
export const STANDARD_MOVEMENT: Definition<'character'>['movement'] = {
  speedMmPerSecond: 4000,
  accelerationMmPerSecond2: 12000,
  turnMilliDegreesPerSecond: 360000,
  jumpMmPerSecond: 5000,
  stepHeightMm: 300,
  maxSlopeMilliDegrees: 45000,
  flySpeedMmPerSecond: 5000,
};
export async function sampleManifest(maxSteps = 6000): Promise<Manifest> {
  const attack = await sealRevision('ability', 'sword', 1, {
    name: '剣',
    originalText: '正面の相手を剣で攻撃する',
    trigger: 'action',
    target: 'enemy',
    condition: { kind: 'always' },
    costs: { hp: 0, mp: 0, uses: 0 },
    castSteps: 5,
    recoverySteps: 20,
    cooldownSteps: 0,
    movementWhileCasting: 'allow',
    rangeMm: 2000,
    aimErrorMilliDegrees: 0,
    attack: { kind: 'melee', reachMm: 1800, radiusMm: 200, activeSteps: 2, maxHitsPerTarget: 1 },
    effects: [{ kind: 'damage', amount: 10, attackScaleBps: 10000, element: 'physical' }],
  });
  const policy = await sealRevision('policy', 'approach', 1, {
    name: '接近戦',
    originalText: '',
    priorities: [{ when: { kind: 'always' }, abilityId: 'sword' }],
    movement: 'approach',
    preferredDistanceMm: 1200,
    flightAltitudeMm: 4000,
    jumpWhenBlocked: true,
  });
  const character = await sealRevision('character', 'fighter', 1, {
    name: '剣士',
    originalText: '',
    stats: {
      hp: 100,
      mp: 100,
      attack: 20,
      defense: 5,
      actionSpeedBps: 10000,
      shield: 0,
      resistances: { physical: 0, fire: 0, ice: 0, lightning: 0, arcane: 0 },
    },
    body: STANDARD_BODY,
    movement: STANDARD_MOVEMENT,
    perception: { rangeMm: 50000, fovMilliDegrees: 180000, reactionSteps: 5, memorySteps: 250 },
    abilities: [reference(attack)],
    equipment: [],
    policy: reference(policy),
  });
  const scenario = await sealRevision('scenario', 'flat', 1, {
    terrainKnowledge: 'surveyed',
    name: '平地',
    bounds: { min: { x: -50000, y: -1000, z: -50000 }, max: { x: 50000, y: 50000, z: 50000 } },
    obstacles: [
      {
        id: 'floor',
        kind: 'box',
        center: { x: 0, y: -500, z: 0 },
        halfExtents: { x: 50000, y: 500, z: 50000 },
        yawMilliDegrees: 0,
        slopeMilliDegrees: 0,
        blocks: { movement: true, vision: true, attack: true },
      },
    ],
    navigation: { version: 'support-graph-v1', nodes: [], edges: [] },
  });
  const ruleset = await sealRevision('ruleset', 'standard-stages-v1', 1, {
    name: '標準3D',
    rulesVersion: CURRENT_ENGINE_VERSION,
    ai: {
      ...AI_RULES,
      slots: 'simultaneous-v1',
      appearancePriors: AppearancePriorsSchema.parse(LEGACY_APPEARANCE_PRIORS),
    },
    stepMs: 20,
    maxSteps,
    gravityMmPerSecond2: -9807,
    fallSafeSpeedMmPerSecond: 8000,
    fallDamagePerMeterPerSecond: 5,
    curveErrorMm: 1,
    bodyContact: 'symmetric-stop',
    aoeOcclusion: 'five-samples-equal-linear-v1',
    simultaneousConflict: 'unresolved',
  });
  return {
    schemaVersion: 3,
    eventSchemaVersion: 1,
    replaySchemaVersion: 1,
    engineVersion: CURRENT_ENGINE_VERSION,
    aiProfile: 'observed-utility-v1',
    implementationDigest: implementation.digest,
    physicsProfileHash: await contentHash(profile),
    physicsProfile: PhysicsProfileSchema.parse(profile),
    wasmHash: implementation.wasm,
    angleTableHash: implementation.table,
    prng: 'xorshift32-v1',
    seed: 42,
    seedDerivation: 'actor-stream-v1',
    participants: [
      {
        actorId: 'left',
        character: reference(character),
        position: { x: -4000, y: 902, z: 0 },
        facing: { x: 1, y: 0, z: 0 },
        rngSeed: actorSeed(42, 0),
        rngStream: 0,
      },
      {
        actorId: 'right',
        character: reference(character),
        position: { x: 4000, y: 902, z: 0 },
        facing: { x: -1, y: 0, z: 0 },
        rngSeed: actorSeed(42, 1),
        rngStream: 1,
      },
    ],
    ruleset: reference(ruleset),
    scenario: reference(scenario),
    revisions: [character, attack, policy, scenario, ruleset],
  };
}
