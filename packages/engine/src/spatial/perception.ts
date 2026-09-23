import {
  deepFreeze,
  compareIds,
  AI_RULES,
  type Definition,
  type Effect,
  type Experience,
  type ObservedSurface,
  type RevisionRef,
  type Condition,
  type DeepReadonly,
  type ResourceState,
  type VectorMm,
  type ObservedStatus,
} from '@fantasy/domain/spatial';
import { add, cosDegrees, cross, dot, length, mul, sub, unit, type Vec3 } from './math.ts';
import type { MotionState } from './movement.ts';
import type { SpatialWorld } from './physics.ts';
import { metres } from './terrain.ts';
import { publicStatuses } from './status-observation.ts';
import type { StatusCohort } from './status.ts';
import { observedCondition } from './observed-conditions.ts';

export type ObservedActor = {
  id: string;
  position: Vec3;
  velocity: Vec3;
  facing: Vec3;
  step: number;
  appearance?: Definition<'character'>['appearance'];
  wounds?: 'unknown' | 'unhurt' | 'hurt' | 'severe' | 'critical';
  action?: 'idle' | 'cast' | 'active' | 'recovery';
  size?: { radiusMm: number; heightMm: number };
  statuses?: ObservedStatus[];
};
export type ObservableProjectile = {
  id: string;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  radiusMm?: number;
};
export type Observation = DeepReadonly<{
  sampledAt: number;
  availableAt: number;
  enemy: ObservedActor | null;
  projectiles: ObservableProjectile[];
  terrain?: ObservedSurface[];
}>;
export type PerceptionMemory = DeepReadonly<{
  sampledAt: number;
  pending: Observation[];
  observation: Observation | null;
  lastSeen: ObservedActor | null;
  pendingExperience: Experience[];
  knowledge: Experience[];
  learned: Experience[];
  expired: string[];
  terrain: ObservedSurface[];
  statusChangedAt?: number;
}>;
export const emptyMemory = (): PerceptionMemory => ({
  sampledAt: -1,
  pending: [],
  observation: null,
  lastSeen: null,
  pendingExperience: [],
  knowledge: [],
  learned: [],
  expired: [],
  terrain: [],
});

/** Upright body offsets: local +X is forward, +Z is right, +Y remains world up. */
export function bodyPoint(state: Pick<MotionState, 'position' | 'facing'>, offset: VectorMm): Vec3 {
  const horizontal = { x: state.facing.x, y: 0, z: state.facing.z };
  const forward = length(horizontal) > 1e-12 ? unit(horizontal) : { x: 1, y: 0, z: 0 };
  const right = cross(forward, { x: 0, y: 1, z: 0 });
  const local = metres(offset);
  return add(
    state.position,
    add(mul(forward, local.x), add({ x: 0, y: local.y, z: 0 }, mul(right, local.z))),
  );
}
export function canSee(world: SpatialWorld, self: MotionState, point: Vec3): boolean {
  const perception = self.vision ?? self.actor.character.perception;
  const eye = bodyPoint(self, self.actor.character.body.eyeOffset),
    delta = sub(point, eye);
  const distance = length(delta);
  return (
    self.vision?.enabled !== false &&
    distance <= perception.rangeMm / 1000 &&
    (distance < 1e-12 ||
      dot(unit(self.facing), unit(delta)) >=
        cosDegrees(perception.fovMilliDegrees / 2000) - 1e-12) &&
    !world.occluded(eye, point, 'vision')
  );
}

const roundedVector = (p: Vec3, scale: number) => ({
  x: Math.round(p.x * scale),
  y: Math.round(p.y * scale),
  z: Math.round(p.z * scale),
});
/** Fixed local rays return only measured surface points/normals, never the hidden collider definition. */
function observeTerrain(world: SpatialWorld, self: MotionState, step: number): ObservedSurface[] {
  const eye = bodyPoint(self, self.actor.character.body.eyeOffset),
    forward = unit({ ...self.facing, y: 0 }),
    right = cross(forward, { x: 0, y: 1, z: 0 });
  const directions = [
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 1, z: 0 },
    ...[-1, 0, 1].flatMap((vertical) =>
      [-1, 0, 1].map((side) =>
        unit(add(forward, add(mul(right, side), { x: 0, y: vertical, z: 0 }))),
      ),
    ),
  ];
  const surfaces: ObservedSurface[] = [];
  for (const direction of directions) {
    const end = add(
        eye,
        mul(
          direction,
          Math.min(6, (self.vision?.rangeMm ?? self.actor.character.perception.rangeMm) / 1000),
        ),
      ),
      hit = world.raycast(eye, end, 'movement');
    if (hit && canSee(world, self, sub(hit.point, mul(direction, 0.005))))
      surfaces.push({
        pointMm: roundedVector(hit.point, 1000),
        normalBps: roundedVector(unit(hit.normal), 10000),
        sampledAt: step,
        availableAt: step + self.actor.character.perception.reactionSteps,
      });
  }
  return surfaces;
}
const wounds = (hp: number, maxHp: number): NonNullable<ObservedActor['wounds']> =>
  hp >= maxHp ? 'unhurt' : hp * 4 <= maxHp ? 'critical' : hp * 2 <= maxHp ? 'severe' : 'hurt';
export function rememberExperience(
  memory: PerceptionMemory,
  experience: Experience,
): PerceptionMemory {
  return deepFreeze({
    ...memory,
    pendingExperience: [...memory.pendingExperience, experience].slice(-32),
  });
}
/** Ordinary damage observations deliberately expose a coarse reaction range, not HP deltas or resistance. */
export function observeImpact(
  world: SpatialWorld,
  self: MotionState,
  target: MotionState,
  detail: {
    ability: RevisionRef;
    eventId: string;
    element: Experience['element'];
    basePower: number;
    defense?: Experience['defense'];
    impact: number;
    shield: boolean;
    partial: boolean;
    statuses?: readonly StatusCohort[];
    statusStep?: number;
  },
  step: number,
  rules: DeepReadonly<NonNullable<Definition<'ruleset'>['ai']>> = AI_RULES,
): Experience | null {
  if (
    target.vision?.visible === false ||
    !canSee(world, self, bodyPoint(target, target.actor.character.body.aimOffset))
  )
    return null;
  const uncertain = detail.partial,
    shield = detail.shield,
    low = Math.floor(detail.impact / rules.damageQuantum) * rules.damageQuantum;
  const observedStatuses = publicStatuses(detail.statuses ?? [], detail.statusStep ?? step);
  return {
    eventId: detail.eventId,
    ability: {
      id: detail.ability.id,
      revision: detail.ability.revision,
      contentHash: detail.ability.contentHash,
    },
    targetId: target.actor.participant.actorId,
    element: detail.element,
    kind: uncertain ? 'uncertain' : shield ? 'shield' : 'impact',
    sampledAt: step,
    availableAt: step + self.actor.character.perception.reactionSteps,
    expiresAt: step + rules.knowledgeTtlSteps,
    basePower: detail.basePower,
    ...(detail.defense !== undefined && { defense: detail.defense }),
    distanceBand: Math.min(200, Math.floor(length(sub(self.position, target.position)) / 2)),
    range: uncertain || shield ? null : { low, high: low + rules.damageQuantum },
    confidenceBps: uncertain || shield ? 0 : 2500,
    ...(observedStatuses.length && { observedStatuses }),
  };
}
/** This is the sole information-ability exception: one named field, after an actual successful activation. */
export function observeReveal(
  world: SpatialWorld,
  self: MotionState,
  target: MotionState,
  effect: DeepReadonly<Extract<Effect, { kind: 'reveal' }>>,
  ability: RevisionRef,
  eventId: string,
  step: number,
): Experience | null {
  if (
    target.vision?.visible === false ||
    effect.powerBps <= (target.actor.character.perception.revealWardBps ?? 0) ||
    !canSee(world, self, bodyPoint(target, target.actor.character.body.aimOffset))
  )
    return null;
  const value = target.actor.character.stats.resistances[effect.element] ?? 0;
  const low = Math.floor(value / effect.precisionBps) * effect.precisionBps;
  return {
    eventId,
    targetId: target.actor.participant.actorId,
    ability: { id: ability.id, revision: ability.revision, contentHash: ability.contentHash },
    element: effect.element,
    kind: 'reveal',
    sampledAt: step,
    availableAt: step + effect.delaySteps + self.actor.character.perception.reactionSteps,
    expiresAt: step + effect.durationSteps,
    basePower: 0,
    distanceBand: 0,
    range: { low, high: Math.min(10000, low + effect.precisionBps) },
    confidenceBps: 10000,
  };
}

/** Only this boundary receives live enemy state. Policies receive delayed immutable snapshots. */
export function perceive(
  world: SpatialWorld,
  self: MotionState,
  enemy: MotionState,
  projectiles: readonly ObservableProjectile[],
  step: number,
  previous: PerceptionMemory,
  visibleState?: {
    resources: ResourceState;
    action: NonNullable<ObservedActor['action']>;
    statuses?: readonly StatusCohort[];
  },
  terrainMode: 'surveyed' | 'observed' = 'surveyed',
  rules: DeepReadonly<NonNullable<Definition<'ruleset'>['ai']>> = AI_RULES,
): PerceptionMemory {
  const interval = self.actor.character.perception.reactionSteps;
  let pending = [...previous.pending],
    observation = previous.observation,
    lastSeen = previous.lastSeen,
    terrain = [...previous.terrain];
  let statusChangedAt = previous.statusChangedAt;
  for (const sample of pending)
    if (sample.availableAt <= step) {
      if (
        sample.enemy?.statuses !== undefined &&
        JSON.stringify(sample.enemy.statuses) !== JSON.stringify(lastSeen?.statuses)
      )
        statusChangedAt = sample.sampledAt;
      observation = sample;
      if (sample.enemy) lastSeen = sample.enemy;
      terrain.push(...(sample.terrain ?? []));
    }
  pending = pending.filter((sample) => sample.availableAt > step);
  let sampledAt = previous.sampledAt;
  if (sampledAt < 0 || step - sampledAt >= interval) {
    const point = bodyPoint(enemy, enemy.actor.character.body.aimOffset);
    const visible = enemy.vision?.visible !== false && canSee(world, self, point);
    const observedStatuses = publicStatuses(visibleState?.statuses ?? [], step);
    const statusKnown =
      observedStatuses.length > 0 ||
      lastSeen?.statuses !== undefined ||
      previous.pending.some((s) => s.enemy?.statuses !== undefined);
    pending.push({
      sampledAt: step,
      availableAt: step + interval,
      enemy: visible
        ? {
            id: enemy.actor.participant.actorId,
            position: { ...enemy.position },
            velocity: { ...enemy.velocity },
            facing: { ...enemy.facing },
            step,
            appearance: enemy.actor.character.appearance ?? {
              silhouette: 'humanoid',
              surface: 'neutral',
              equipment: [],
            },
            wounds: visibleState
              ? wounds(visibleState.resources.hp, enemy.actor.character.stats.hp)
              : 'unknown',
            action: visibleState?.action ?? 'idle',
            ...(statusKnown && { statuses: observedStatuses }),
            size: {
              radiusMm: enemy.actor.character.body.radiusMm,
              heightMm: enemy.actor.character.body.heightMm,
            },
          }
        : null,
      projectiles: projectiles
        .filter(
          (p) => p.ownerId !== self.actor.participant.actorId && canSee(world, self, p.position),
        )
        .sort(
          (a, b) =>
            length(sub(a.position, self.position)) - length(sub(b.position, self.position)) ||
            dot(sub(a.position, b.position), self.facing) ||
            dot(sub(a.position, b.position), cross(self.facing, { x: 0, y: 1, z: 0 })) ||
            a.position.y - b.position.y ||
            dot(sub(a.velocity, b.velocity), self.facing) ||
            dot(sub(a.velocity, b.velocity), cross(self.facing, { x: 0, y: 1, z: 0 })) ||
            a.velocity.y - b.velocity.y ||
            (a.radiusMm ?? 80) - (b.radiusMm ?? 80) ||
            compareIds(a.id, b.id),
        )
        .slice(0, 32)
        .map((p) => ({
          id: p.id,
          ownerId: p.ownerId,
          position: { ...p.position },
          velocity: { ...p.velocity },
          radiusMm: p.radiusMm ?? 80,
        })),
      terrain: terrainMode === 'observed' ? observeTerrain(world, self, step) : [],
    });
    sampledAt = step;
  }
  if (
    !observation?.enemy &&
    lastSeen &&
    step - lastSeen.step > self.actor.character.perception.memorySteps
  )
    lastSeen = null;
  const delivered = previous.pendingExperience.filter(
    (e) => e.availableAt <= step && e.expiresAt > step,
  );
  const knowledge = [...previous.knowledge.filter((e) => e.expiresAt > step), ...delivered]
    // Impacts stamped at the transition boundary used the previous interval's status snapshot.
    // Reveals measure the baseline resistance, which is independent of a temporary status.
    .filter(
      (e) => e.kind === 'reveal' || statusChangedAt === undefined || e.sampledAt > statusChangedAt,
    )
    .slice(-rules.memorySamples);
  const learned = delivered.filter((e) => knowledge.includes(e));
  const expired = previous.knowledge.filter((e) => !knowledge.includes(e)).map((e) => e.eventId);
  const surfaces = new Map<string, DeepReadonly<ObservedSurface>>();
  for (const sample of terrain.filter(
    (s) => step - s.sampledAt <= self.actor.character.perception.memorySteps,
  ))
    surfaces.set(JSON.stringify([sample.pointMm, sample.normalBps]), sample);
  terrain = [...surfaces.values()].slice(-64);
  return deepFreeze({
    sampledAt,
    pending,
    observation,
    lastSeen,
    knowledge,
    learned,
    expired,
    terrain,
    ...(statusChangedAt !== undefined && { statusChangedAt }),
    pendingExperience: previous.pendingExperience.filter(
      (e) => e.availableAt > step && e.expiresAt > step,
    ),
  });
}
export type DecisionView = {
  self: MotionState;
  resources: ResourceState;
  staminaExhausted?: boolean;
  statusIds: readonly string[];
  memory: PerceptionMemory;
  step?: number;
  used?: Readonly<Record<string, number>>;
  canAct?: boolean;
  canMove?: boolean;
  speedBps?: number;
  flightStaminaPerSecond?: number;
  silenced?: boolean;
  incapacitated?: boolean;
  ownStatuses?: readonly StatusCohort[];
  burnDamage?: number;
  waterExtinguishable?: boolean;
  attack?: number;
  magicPower?: number;
  rules?: DeepReadonly<NonNullable<Definition<'ruleset'>['ai']>>;
};
export function conditionMatches(condition: DeepReadonly<Condition>, view: DecisionView): boolean {
  return evaluateCondition(condition, view) === true;
}
function evaluateCondition(
  condition: DeepReadonly<Condition>,
  view: DecisionView,
): boolean | undefined {
  switch (condition.kind) {
    case 'always':
      return true;
    case 'resource': {
      const max =
        condition.resource === 'stamina'
          ? (view.self.actor.character.stamina?.max ?? 0)
          : view.self.actor.character.stats[condition.resource];
      return (
        max > 0 && (view.resources[condition.resource] ?? 0) * 10000 < max * condition.belowBps
      );
    }
    case 'distance': {
      const target = view.memory.observation?.enemy ?? view.memory.lastSeen;
      return (
        !!target && length(sub(target.position, view.self.position)) * 1000 <= condition.withinMm
      );
    }
    case 'visible':
      return !!view.memory.observation?.enemy === condition.value;
    case 'status':
      return view.statusIds.includes(condition.id) === condition.present;
    case 'projectile-observed':
      return (view.memory.observation?.projectiles.length ?? 0) > 0;
    case 'observed-wounds':
    case 'observed-phase':
    case 'observed-status':
    case 'relative-position':
      return observedCondition(condition, view);
    case 'all': {
      const values = condition.children.map((c) => evaluateCondition(c, view));
      return values.includes(false) ? false : values.includes(undefined) ? undefined : true;
    }
    case 'any': {
      const values = condition.children.map((c) => evaluateCondition(c, view));
      return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
    }
    case 'not': {
      const value = evaluateCondition(condition.child, view);
      return value === undefined ? undefined : !value;
    }
    default: {
      const impossible: never = condition;
      throw new Error(`Unknown condition: ${String(impossible)}`);
    }
  }
}
