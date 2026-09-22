import {
  deepFreeze,
  type Condition,
  type DeepReadonly,
  type ResourceState,
  type VectorMm,
} from '@fantasy/domain/spatial';
import { add, cosDegrees, cross, dot, length, mul, sub, unit, type Vec3 } from './math.ts';
import type { MotionState } from './movement.ts';
import type { SpatialWorld } from './physics.ts';
import { metres } from './terrain.ts';

export type ObservedActor = {
  id: string;
  position: Vec3;
  velocity: Vec3;
  facing: Vec3;
  step: number;
};
export type ObservableProjectile = { id: string; ownerId: string; position: Vec3; velocity: Vec3 };
export type Observation = DeepReadonly<{
  sampledAt: number;
  availableAt: number;
  enemy: ObservedActor | null;
  projectiles: ObservableProjectile[];
}>;
export type PerceptionMemory = DeepReadonly<{
  sampledAt: number;
  pending: Observation[];
  observation: Observation | null;
  lastSeen: ObservedActor | null;
}>;
export const emptyMemory = (): PerceptionMemory => ({
  sampledAt: -1,
  pending: [],
  observation: null,
  lastSeen: null,
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
  const perception = self.actor.character.perception;
  const eye = bodyPoint(self, self.actor.character.body.eyeOffset),
    delta = sub(point, eye);
  const distance = length(delta);
  return (
    distance <= perception.rangeMm / 1000 &&
    (distance < 1e-12 ||
      dot(unit(self.facing), unit(delta)) >=
        cosDegrees(perception.fovMilliDegrees / 2000) - 1e-12) &&
    !world.occluded(eye, point, 'vision')
  );
}

/** Only this boundary receives live enemy state. Policies receive delayed immutable snapshots. */
export function perceive(
  world: SpatialWorld,
  self: MotionState,
  enemy: MotionState,
  projectiles: readonly ObservableProjectile[],
  step: number,
  previous: PerceptionMemory,
): PerceptionMemory {
  const interval = self.actor.character.perception.reactionSteps;
  let pending = [...previous.pending],
    observation = previous.observation,
    lastSeen = previous.lastSeen;
  for (const sample of pending)
    if (sample.availableAt <= step) {
      observation = sample;
      if (sample.enemy) lastSeen = sample.enemy;
    }
  pending = pending.filter((sample) => sample.availableAt > step);
  let sampledAt = previous.sampledAt;
  if (sampledAt < 0 || step - sampledAt >= interval) {
    const point = bodyPoint(enemy, enemy.actor.character.body.aimOffset);
    const visible = canSee(world, self, point);
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
          }
        : null,
      projectiles: projectiles
        .filter(
          (p) => p.ownerId !== self.actor.participant.actorId && canSee(world, self, p.position),
        )
        .map((p) => ({
          id: p.id,
          ownerId: p.ownerId,
          position: { ...p.position },
          velocity: { ...p.velocity },
        })),
    });
    sampledAt = step;
  }
  if (
    !observation?.enemy &&
    lastSeen &&
    step - lastSeen.step > self.actor.character.perception.memorySteps
  )
    lastSeen = null;
  return deepFreeze({ sampledAt, pending, observation, lastSeen });
}
export type DecisionView = {
  self: MotionState;
  resources: ResourceState;
  statusIds: readonly string[];
  memory: PerceptionMemory;
};
export function conditionMatches(condition: DeepReadonly<Condition>, view: DecisionView): boolean {
  switch (condition.kind) {
    case 'always':
      return true;
    case 'resource': {
      const max = view.self.actor.character.stats[condition.resource];
      return max > 0 && view.resources[condition.resource] * 10000 < max * condition.belowBps;
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
    case 'all':
      return condition.children.every((c) => conditionMatches(c, view));
    case 'any':
      return condition.children.some((c) => conditionMatches(c, view));
    case 'not':
      return !conditionMatches(condition.child, view);
    default: {
      const impossible: never = condition;
      throw new Error(`Unknown condition: ${String(impossible)}`);
    }
  }
}
