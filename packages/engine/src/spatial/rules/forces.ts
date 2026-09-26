import type { ActorBodyState, ActorState } from '../state.ts';
import {
  compareIds,
  composeForce,
  DEFAULT_FORCED_SPEED_CAP_MM_PER_SECOND,
  type Budget,
  type DeepReadonly,
  type Effect,
  type ForceContribution,
} from '@fantasy/domain/spatial/execution';
import type { MovedActor } from '../world/movement.ts';
import { length, sub, unit, type Vec3 } from '../math.ts';
import { SpatialBudgetError } from '../world/physics.ts';

type Force = DeepReadonly<Extract<Effect, { kind: 'force' }>>;
/** Contact-frozen integer mm/s; Math.round alone would round negative ties toward zero. */
export function freezeForce(effect: Force, source: Vec3, target: Vec3): Vec3 {
  const direction = unit(sub(target, source));
  const scalar = effect.speedMmPerSecond * (effect.direction === 'toward' ? -1 : 1);
  const round = (n: number) => {
    const magnitude = Math.floor(Math.abs(n) + 0.5);
    return magnitude === 0 ? 0 : Math.sign(n) * magnitude;
  };
  return {
    x: round(direction.x * scalar),
    y: round(direction.y * scalar),
    z: round(direction.z * scalar),
  };
}

export function queueForce(
  target: ActorState,
  effect: Force,
  origin: Vec3,
  position: Vec3,
  identity: Pick<ForceContribution, 'id' | 'actorId' | 'abilityId' | 'stage' | 'sourceActorId'>,
  contactStep: number,
  budget: Budget,
): ForceContribution {
  const startAt = contactStep + 1;
  const active = (target.body.forces ?? []).filter((f) => f.endAt > startAt);
  const maximum = budget.maxForces ?? 64;
  if (active.length + 1 > maximum)
    throw new SpatialBudgetError('forces', `${active.length + 1}/${maximum};cause=${identity.id}`);
  const contribution = {
    ...identity,
    startAt,
    endAt: startAt + effect.durationSteps,
    velocityMmPerSecond: freezeForce(effect, origin, position),
  };
  target.body.forces = [...active, contribution].sort((a, b) => compareIds(a.id, b.id));
  return contribution;
}

/** Sum before capping: opposite contributions cancel without order-dependent saturation. */
export function forceSum(
  forces: readonly ForceContribution[],
  step: number,
  capMmPerSecond: number,
) {
  const contributors = forces
    .filter((f) => f.startAt <= step && step < f.endAt)
    .sort((a, b) => compareIds(a.id, b.id));
  const { capped, force } = composeForce(contributors, capMmPerSecond);
  return { contributors, capMmPerSecond, capped, force };
}

/** Mode transitions happen before observation/selection on the provisional interval state. */
export function beginForcedInterval(actor: ActorState, step: number, capMmPerSecond: number) {
  if (!actor.body.forces && !actor.body.forceGravity) return null;
  const forces = (actor.body.forces ?? []).filter((f) => f.endAt > step);
  if (forces.length) actor.body.forces = forces;
  else delete actor.body.forces;
  const plan = forceSum(forces, step, capMmPerSecond),
    active = length(plan.force) > 0;
  const previousGravity = actor.body.forceGravity ? { ...actor.body.forceGravity } : null;
  if (active) actor.body.forceGravity ??= { x: 0, y: actor.body.motion.velocity.y, z: 0 };
  else if (actor.body.forceGravity) {
    actor.body.motion.velocity = { ...actor.body.forceGravity };
    delete actor.body.forceGravity;
  }
  return {
    ...plan,
    active,
    gravity: actor.body.forceGravity ? { ...actor.body.forceGravity } : previousGravity,
  };
}

export function settleForcedInterval(
  actor: ActorState,
  plan: ReturnType<typeof beginForcedInterval>,
  moved: MovedActor,
  step: number,
) {
  if (!plan || !plan.contributors.length) {
    if (actor.body.forceDisplay !== undefined) actor.body.forceDisplay = null;
    return;
  }
  if (plan.active && !moved.forced) throw Error('Missing forced movement settlement');
  if (moved.forced) actor.body.forceGravity = { ...moved.forced.gravity };
  actor.body.forceDisplay = {
    fromStep: step,
    active: plan.active,
    contributors: structuredClone(plan.contributors),
    capMmPerSecond: plan.capMmPerSecond,
    capped: plan.capped,
    applied: { ...plan.force },
    gravityBefore: plan.gravity,
    gravityAfter: moved.forced ? { ...moved.forced.gravity } : null,
    incident: moved.forced ? { ...moved.forced.incident } : null,
    projectedForce: moved.forced ? { ...moved.forced.force } : null,
    projections: moved.forced ? structuredClone(moved.forced.projections) : [],
  };
}

export function hasForcedMotion(
  actor: Pick<ActorBodyState, 'forces'>,
  step: number,
  cap = DEFAULT_FORCED_SPEED_CAP_MM_PER_SECOND,
) {
  return !!actor.forces?.length && length(forceSum(actor.forces, step, cap).force) > 0;
}
