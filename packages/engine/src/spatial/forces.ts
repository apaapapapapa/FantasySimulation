import {
  compareIds,
  type Budget,
  type DeepReadonly,
  type Effect,
  type ForceContribution,
} from '@fantasy/domain/spatial';
import type { ActorState } from './combat-state.ts';
import type { MovedActor } from './movement.ts';
import { length, sub, unit, type Vec3 } from './math.ts';
import { SpatialBudgetError } from './physics.ts';

type Force = DeepReadonly<Extract<Effect, { kind: 'force' }>>;
const axes = ['x', 'y', 'z'] as const;
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
  identity: Pick<ForceContribution, 'id' | 'actorId' | 'abilityId' | 'stage'>,
  contactStep: number,
  budget: Budget,
): ForceContribution {
  const startAt = contactStep + 1;
  const active = (target.forces ?? []).filter((f) => f.endAt > startAt);
  const maximum = budget.maxForces ?? 64;
  if (active.length + 1 > maximum)
    throw new SpatialBudgetError('forces', `${active.length + 1}/${maximum};cause=${identity.id}`);
  const contribution = {
    ...identity,
    startAt,
    endAt: startAt + effect.durationSteps,
    velocityMmPerSecond: freezeForce(effect, origin, position),
  };
  target.forces = [...active, contribution].sort((a, b) => compareIds(a.id, b.id));
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
  const totals = { x: 0n, y: 0n, z: 0n };
  for (const force of contributors)
    for (const axis of axes) totals[axis] += BigInt(force.velocityMmPerSecond[axis]);
  const square = axes.reduce((n, axis) => n + totals[axis] ** 2n, 0n);
  const capped = square > BigInt(capMmPerSecond) ** 2n;
  const scale = capped ? capMmPerSecond / Math.sqrt(Number(square)) / 1000 : 0.001;
  return {
    contributors,
    capMmPerSecond,
    capped,
    force: {
      x: Number(totals.x) * scale,
      y: Number(totals.y) * scale,
      z: Number(totals.z) * scale,
    },
  };
}

/** Mode transitions happen before observation/selection on the provisional interval state. */
export function beginForcedInterval(actor: ActorState, step: number, capMmPerSecond: number) {
  if (!actor.forces && !actor.forceGravity) return null;
  const forces = (actor.forces ?? []).filter((f) => f.endAt > step);
  if (forces.length) actor.forces = forces;
  else delete actor.forces;
  const plan = forceSum(forces, step, capMmPerSecond),
    active = length(plan.force) > 0;
  const previousGravity = actor.forceGravity ? { ...actor.forceGravity } : null;
  if (active) actor.forceGravity ??= { x: 0, y: actor.motion.velocity.y, z: 0 };
  else if (actor.forceGravity) {
    actor.motion.velocity = { ...actor.forceGravity };
    delete actor.forceGravity;
  }
  return {
    ...plan,
    active,
    gravity: actor.forceGravity ? { ...actor.forceGravity } : previousGravity,
  };
}

export function settleForcedInterval(
  actor: ActorState,
  plan: ReturnType<typeof beginForcedInterval>,
  moved: MovedActor,
  step: number,
) {
  if (!plan || !plan.contributors.length) {
    if (actor.forceDisplay !== undefined) actor.forceDisplay = null;
    return;
  }
  if (plan.active && !moved.forced) throw Error('Missing forced movement settlement');
  if (moved.forced) actor.forceGravity = { ...moved.forced.gravity };
  actor.forceDisplay = {
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

export function hasForcedMotion(actor: Pick<ActorState, 'forces'>, step: number, cap = 100000) {
  return !!actor.forces?.length && length(forceSum(actor.forces, step, cap).force) > 0;
}
