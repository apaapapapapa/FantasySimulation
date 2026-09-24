import {
  nextRandom,
  type DeepReadonly,
  type Definition,
  type ResourceState,
} from '@fantasy/domain/spatial/execution';
import {
  add,
  sub,
  mul,
  unit,
  length,
  cross,
  dot,
  sinDegrees,
  cosDegrees,
  type Vec3,
} from './math.ts';
import {
  at,
  ballShape,
  capsuleShape,
  firstContact,
  firstImpact,
  straight,
  type SpatialWorld,
  type Trace,
} from './physics.ts';
import { bodyPoint, type DecisionView } from './perception.ts';
import type { MotionState } from './movement.ts';
import { bodyCapsule } from './terrain.ts';
import { ResourceBudget } from './resources.ts';

type Ability = DeepReadonly<Definition<'ability'>>;
export type ActionClock = { launchAt: number; recoveryUntil: number; cooldownUntil: number };
/** Action speed scales preparation/recovery/cooldown, not physics or an attack's active duration. */
export function actionClock(ability: Ability, speedBps: number, step: number): ActionClock | null {
  if (speedBps === 0) return null;
  const delay = (value: number) => Math.ceil((value * 10000) / speedBps);
  const launchAt = step + delay(ability.castSteps);
  const last = ability.stages?.at(-1);
  const active = last
    ? last.offsetSteps + last.durationSteps
    : ability.attack.kind === 'melee'
      ? ability.attack.activeSteps
      : 1;
  return {
    launchAt,
    recoveryUntil: launchAt + active + Math.max(1, delay(ability.recoverySteps)),
    cooldownUntil: launchAt + delay(ability.cooldownSteps),
  };
}
/** Only stage zero is prepaid. Later costs never hold future resources. */
export function declarationCost(ability: Ability) {
  const extra = ability.stages?.[0]?.cost;
  if (!extra) return ability.costs;
  return {
    ...ability.costs,
    hp: ability.costs.hp + (extra.hp ?? 0),
    mp: ability.costs.mp + (extra.mp ?? 0),
    ...(ability.costs.stamina !== undefined || extra.stamina !== undefined
      ? { stamina: (ability.costs.stamina ?? 0) + (extra.stamina ?? 0) }
      : {}),
  };
}
/** Zero uses means unlimited. HP cost equal to current HP is legal. No partial cost on failure. */
export function payCost(
  ability: Ability,
  resources: ResourceState,
  used: number,
  staminaReady = true,
) {
  const budget = new ResourceBudget(resources, { ability: used }, staminaReady);
  const result = budget.reserve('ability', [
    { ...declarationCost(ability), uses: { id: 'ability', limit: ability.costs.uses } },
  ]);
  if (!result.ok) return { ...result, resources: { ...resources } };
  budget.commit('ability');
  return { ok: true as const, reason: null, resources: budget.finish().resources };
}
/** Both declaration and release inspect only information available to the owner. Geometry decides actual contact. */
export function inObservedRange(ability: Ability, view: DecisionView): boolean {
  if (ability.target === 'self') return true;
  const target = view.memory.observation?.enemy ?? view.memory.lastSeen;
  if (!target) return false;
  const delta = sub(
    target.position,
    bodyPoint(view.self, view.self.actor.character.body.muzzleOffset),
  );
  return (
    length(delta) <= ability.rangeMm / 1000 &&
    (ability.attack.kind === 'arc' ||
      ability.attack.kind === 'radial' ||
      dot(view.self.facing, delta) >= -1e-12)
  );
}
/** Two explicit PRNG samples per released spatial attack, including zero-error shots. */
export function launchDirection(facing: Vec3, errorMilliDegrees: number, random: number) {
  const yawState = nextRandom(random),
    next = nextRandom(yawState);
  const yaw = (((yawState / 0x1_0000_0000) * 2 - 1) * errorMilliDegrees) / 1000;
  const pitch = (((next / 0x1_0000_0000) * 2 - 1) * errorMilliDegrees) / 1000;
  const forward = unit(facing);
  const reference = Math.abs(forward.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const right = unit(cross(forward, reference)),
    up = unit(cross(right, forward));
  return {
    direction: unit(
      add(
        mul(add(mul(forward, cosDegrees(yaw)), mul(right, sinDegrees(yaw))), cosDegrees(pitch)),
        mul(up, sinDegrees(pitch)),
      ),
    ),
    random: next,
  };
}
export type AttackContact = { kind: 'wall' | 'body'; time: number; point: Vec3; center: Vec3 };
/** Attack overlap counts even for a stationary or separating body; movement contact has different semantics. */
export function traceAttack(
  world: SpatialWorld,
  trace: Trace,
  radius: number,
  target: MotionState,
  targetTrace: Trace,
  blocking?: { wall: AttackContact | null },
): AttackContact | null {
  let wall: number | undefined;
  let wallPoint: Vec3 | undefined;
  const shape = ballShape(radius);
  for (const piece of trace) {
    if (world.overlaps(piece.start, shape, 'attack')) {
      wall = piece.from;
      wallPoint = piece.start;
      break;
    }
    const hit = world.sweep(piece.start, sub(piece.end, piece.start), shape, 'attack');
    if (hit) {
      wall = piece.from + (piece.to - piece.from) * hit.time_of_impact;
      wallPoint = sub(at(trace, wall), mul(hit.normal1, radius));
      break;
    }
  }
  const body = firstContact(
    trace,
    shape,
    targetTrace,
    capsuleShape(bodyCapsule(target.actor.character.body)),
    0,
    true,
  );
  const hit = firstImpact(wall, body);
  if (blocking)
    blocking.wall =
      wall === undefined
        ? null
        : { kind: 'wall', time: wall, point: wallPoint!, center: at(trace, wall) };
  if (!hit) return null;
  const center = at(trace, hit.time);
  const targetPosition = at(targetTrace, hit.time);
  const capsule = bodyCapsule(target.actor.character.body);
  const axis = {
    ...targetPosition,
    y: Math.max(
      targetPosition.y - capsule.halfHeight,
      Math.min(targetPosition.y + capsule.halfHeight, center.y),
    ),
  };
  const point =
    hit.kind === 'wall' ? wallPoint! : sub(center, mul(unit(sub(center, axis)), radius));
  return { ...hit, point, center };
}
/** Prevent an offset weapon from appearing through a wall between the body and its muzzle. */
export function muzzleBlocked(world: SpatialWorld, state: MotionState): boolean {
  return world.occluded(
    state.position,
    bodyPoint(state, state.actor.character.body.muzzleOffset),
    'attack',
  );
}
export function hitscan(
  world: SpatialWorld,
  owner: MotionState,
  target: MotionState,
  direction: Vec3,
  range: number,
  radius: number,
): AttackContact | null {
  const origin = bodyPoint(owner, owner.actor.character.body.muzzleOffset);
  if (muzzleBlocked(world, owner)) return { kind: 'wall', time: 0, point: origin, center: origin };
  return traceAttack(
    world,
    straight(origin, add(origin, mul(direction, range))),
    radius,
    target,
    straight(target.position, target.position),
  );
}
/** A melee attack is a forward thrust sphere. Its committed direction is fixed until its active window ends. */
export function meleeTrace(
  ownerTrace: Trace,
  muzzleOffset: Vec3,
  direction: Vec3,
  reach: number,
  elapsed: number,
  activeSteps: number,
): Trace {
  const position = (body: Vec3, time: number) =>
    add(add(body, muzzleOffset), mul(direction, (reach * (elapsed + time)) / activeSteps));
  return ownerTrace.map((piece) => ({
    ...piece,
    start: position(piece.start, piece.from),
    end: position(piece.end, piece.to),
  }));
}
