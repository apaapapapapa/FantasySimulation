import { AI_RULES, type Definition, type Experience } from '@fantasy/domain/spatial';
import { sampleManifest } from '@fantasy/samples';
import {
  prepareBattle,
  reference,
  decisionAbilityOrder,
  type ResolvedActor,
} from '../src/spatial/prepare.ts';
import { sealRevision } from '../src/spatial/manifest-builder.ts';
import { initialMotion } from '../src/spatial/movement.ts';
import { SpatialWorld } from '../src/spatial/physics.ts';
import { emptyMemory, type DecisionView } from '../src/spatial/perception.ts';

/** Keep manually edited test actors consistent with prepared canonical decision order. */
export const withAbilities = (
  actor: ResolvedActor,
  abilities: ResolvedActor['abilities'],
): ResolvedActor => ({ ...actor, abilities, decisionAbilities: decisionAbilityOrder(abilities) });

/** Explicit defaults for partial synthetic observations; undefined status knowledge remains unknown. */
export function decisionView(
  input: Pick<DecisionView, 'self' | 'resources' | 'memory' | 'statusIds'> & Partial<DecisionView>,
): DecisionView {
  const stats = input.self.actor.character.stats;
  return {
    step: 0,
    gravityMmPerSecond2: -9807,
    staminaExhausted: false,
    used: {},
    reactionReadyAt: {},
    canAct: true,
    canMove: true,
    activeAbility: undefined,
    stageOwnsMotion: false,
    speedBps: 10000,
    flightStaminaPerSecond: 0,
    silenced: false,
    incapacitated: false,
    ownStatuses: undefined,
    burnDamage: undefined,
    waterExtinguishable: false,
    attack: stats.attack,
    magicPower: stats.magicPower ?? input.attack ?? stats.attack,
    rules: AI_RULES,
    ...input,
  };
}

export function withEvaluation(
  view: DecisionView,
  edit: Partial<NonNullable<Definition<'policy'>['evaluation']>>,
): DecisionView {
  return {
    ...view,
    self: {
      ...view.self,
      actor: {
        ...view.self.actor,
        policy: {
          ...view.self.actor.policy,
          evaluation: {
            attackBps: 10000,
            survivalBps: 10000,
            explorationBps: 10000,
            ...view.self.actor.policy.evaluation,
            ...edit,
          },
        },
      },
    },
  };
}

/** Seals common AI inputs; assertions and numeric expectations belong to each test. */
export async function aiFixture(
  edits: {
    abilities?: Partial<Definition<'ability'>>[];
    character?: Partial<Definition<'character'>>;
    policy?: Partial<Definition<'policy'>>;
    steps?: number;
  } = {},
) {
  const manifest = await sampleManifest(edits.steps ?? 50);
  const oldAbility = manifest.revisions.find((r) => r.kind === 'ability')!;
  const definitions = edits.abilities ?? [
    {
      name: 'observed fire',
      effects: [{ kind: 'damage', amount: 25, attackScaleBps: 0, element: 'fire' }],
    },
    {
      name: 'self water',
      target: 'self',
      condition: { kind: 'visible', value: true },
      attack: { kind: 'direct' },
      rangeMm: 0,
      costs: { hp: 0, mp: 4, uses: 0 },
      effects: [{ kind: 'water', extinguish: true }],
    },
  ];
  const abilities = await Promise.all(
    definitions.map((edit, i) =>
      sealRevision('ability', `choice-${i}`, 1, {
        ...oldAbility.definition,
        attack: { kind: 'hitscan', radiusMm: 0 },
        rangeMm: 20000,
        castSteps: 3,
        recoverySteps: 12,
        ...edit,
      }),
    ),
  );
  const oldPolicy = manifest.revisions.find((r) => r.kind === 'policy')!;
  const policy = await sealRevision('policy', 'observed-test', 1, {
    ...oldPolicy.definition,
    movement: 'hold',
    ...edits.policy,
    priorities: abilities
      .filter((a) => a.definition.trigger === 'action')
      .map((a) => ({ abilityId: a.id, when: { kind: 'always' } })),
  });
  const oldCharacter = manifest.revisions.find((r) => r.kind === 'character')!;
  const character = await sealRevision('character', 'observer-test', 1, {
    ...oldCharacter.definition,
    body: { ...oldCharacter.definition.body, muzzleOffset: { x: 0, y: 200, z: 0 } },
    ...edits.character,
    abilities: abilities.map(reference),
    policy: reference(policy),
  });
  manifest.revisions = manifest.revisions.filter(
    (r) => !['character', 'ability', 'policy'].includes(r.kind),
  );
  manifest.revisions.push(...abilities, policy, character);
  for (const p of manifest.participants) p.character = reference(character);
  const battle = await prepareBattle(manifest),
    world = new SpatialWorld([]);
  const self = initialMotion(world, battle.actors[0]),
    enemy = initialMotion(world, battle.actors[1]);
  const view: DecisionView = decisionView({
    self,
    resources: { hp: 100, mp: 100, shield: 0 },
    statusIds: [],
    memory: {
      ...emptyMemory(),
      observation: {
        sampledAt: 0,
        availableAt: 5,
        enemy: {
          id: 'right',
          position: { ...enemy.position },
          velocity: { ...enemy.velocity },
          facing: { ...enemy.facing },
          step: 0,
          wounds: 'unhurt',
          appearance: { silhouette: 'humanoid', surface: 'neutral', equipment: [] },
        },
        projectiles: [],
      },
    },
    step: 5,
    used: {},
    canAct: true,
    canMove: true,
    silenced: false,
    burnDamage: 20,
    waterExtinguishable: true,
    attack: 20,
    rules: AI_RULES,
  });
  return { manifest, battle, world, self, enemy, view, abilities };
}
export function impactEvidence(
  ability: Experience['ability'],
  edit: Partial<Experience> = {},
): Experience {
  return {
    eventId: 'observed.1',
    targetId: 'right',
    ability: { id: ability.id, revision: ability.revision, contentHash: ability.contentHash },
    element: 'fire',
    kind: 'impact',
    sampledAt: 0,
    availableAt: 5,
    expiresAt: 500,
    basePower: 25,
    distanceBand: 4,
    range: { low: 20, high: 30 },
    confidenceBps: 2500,
    ...edit,
  };
}

export const flyingBody = {
  radiusMm: 300,
  heightMm: 600,
  eyeOffset: { x: 0, y: 0, z: 0 },
  aimOffset: { x: 0, y: 0, z: 0 },
  muzzleOffset: { x: 0, y: 0, z: 0 },
};
export async function dodgeFixture() {
  const f = await aiFixture({ character: { body: flyingBody } });
  const view: DecisionView = decisionView({
    ...f.view,
    canAct: false,
    step: 5,
    memory: {
      ...f.view.memory,
      observation: {
        sampledAt: 0,
        availableAt: 5,
        enemy: null,
        projectiles: [incomingArrow(f.self.position)],
      },
    },
  });
  return { ...f, view };
}

/** Adds a real startup ability and reseals only one participant's character. */
export async function withInitialStatus(
  manifest: import('@fantasy/domain/spatial').Manifest,
  index: 0 | 1,
  definition: Definition<'status'>,
) {
  const status = await sealRevision('status', `initial-status-${index}`, 1, definition);
  const base = manifest.revisions.find((r) => r.kind === 'ability')!;
  const startup: Definition<'ability'> = {
    ...base.definition,
    trigger: 'battle-start',
    condition: { kind: 'always' },
    target: 'self',
    attack: { kind: 'direct' },
    castSteps: 0,
    costs: { hp: 0, mp: 0, uses: 1 },
    effects: [{ kind: 'apply-status', status: reference(status) }],
  };
  delete startup.stages;
  const ability = await sealRevision('ability', `initial-grant-${index}`, 1, startup);
  const participant = manifest.participants[index];
  const old = manifest.revisions.find(
    (r) => r.kind === 'character' && r.id === participant.character.id,
  )!;
  if (old.kind !== 'character') throw Error('Missing character');
  const character = await sealRevision('character', `status-actor-${index}`, 1, {
    ...old.definition,
    abilities: [...old.definition.abilities, reference(ability)],
  });
  manifest.revisions.push(status, ability, character);
  participant.character = reference(character);
  return status;
}
export const initialStatus = (edit: Partial<Definition<'status'>> = {}): Definition<'status'> => ({
  name: 'initial effect',
  originalText: 'fixture through the common status pipeline',
  stackKey: 'initial-effect',
  stacking: 'refresh',
  durationSteps: 200,
  maxStacks: 1,
  modifiers: { attack: 0, defense: 0, speedBps: 10000, flight: false, rooted: false },
  periodic: [],
  ...edit,
});

export const incomingArrow = (position: { x: number; y: number; z: number }) => ({
  id: 'arrow',
  ownerId: 'right',
  position: { ...position, x: position.x + 8 },
  velocity: { x: -10, y: 0, z: 0 },
  radiusMm: 80,
});
