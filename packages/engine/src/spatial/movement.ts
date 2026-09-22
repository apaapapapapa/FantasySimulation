import type { DeepReadonly, Definition } from '@fantasy/domain/spatial';
import {
  add,
  cosDegrees,
  dot,
  length,
  mul,
  sub,
  turnToward,
  unit,
  ZERO,
  type Vec3,
} from './math.ts';
import {
  at,
  capsuleShape,
  COLLISION_SKIN,
  CONTACT_TOLERANCE,
  firstContact,
  SpatialWorld,
  SpatialBudgetError,
  stopAt,
  straight,
  type Trace,
} from './physics.ts';
import type { ResolvedActor } from './prepare.ts';
import { bodyCapsule, metres } from './terrain.ts';

export type MotionState = {
  actor: ResolvedActor;
  position: Vec3;
  velocity: Vec3;
  facing: Vec3;
  grounded: boolean;
};
export type MotionIntent = {
  direction: Vec3;
  facing: Vec3;
  jump: boolean;
  flight: boolean;
  canMove: boolean;
  speedBps: number;
};
export type MovedActor = {
  state: MotionState;
  trace: Trace;
  landed: boolean;
  fallDamage: number;
  contactTime: number | undefined;
};
const STEP_SECONDS = 0.02;
const horizontal = (v: Vec3): Vec3 => ({ x: v.x, y: 0, z: v.z });
const minGround = (state: MotionState) =>
  cosDegrees(state.actor.character.movement.maxSlopeMilliDegrees / 1000);
function support(world: SpatialWorld, state: MotionState, position: Vec3, distance = 0.01) {
  const hit = world.sweep(
    position,
    { x: 0, y: -1, z: 0 },
    capsuleShape(bodyCapsule(state.actor.character.body)),
    'movement',
    distance,
    COLLISION_SKIN,
  );
  return hit && hit.normal1.y >= minGround(state) ? hit : undefined;
}
export function initialMotion(world: SpatialWorld, actor: ResolvedActor): MotionState {
  const state: MotionState = {
    actor,
    position: metres(actor.participant.position),
    velocity: { ...ZERO },
    facing: unit(actor.participant.facing),
    grounded: false,
  };
  const ground = support(world, state, state.position);
  state.grounded = !!ground && ground.time_of_impact <= CONTACT_TOLERANCE;
  return state;
}
function approachVelocity(current: Vec3, desired: Vec3, change: number): Vec3 {
  const delta = sub(desired, current),
    size = length(delta);
  return size <= change ? desired : add(current, mul(delta, change / size));
}
const retime = (trace: Trace, from: number, to: number): Trace =>
  trace.map((s) => ({ ...s, from: from + s.from * (to - from), to: from + s.to * (to - from) }));

/** Kinematic step correction with explicit lift (20%), traverse and optional short drop. */
function stepTrace(
  world: SpatialWorld,
  state: MotionState,
  delta: Vec3,
  normalPath: Trace,
  maxSegments: number,
): Trace {
  const body = bodyCapsule(state.actor.character.body),
    shape = capsuleShape(body),
    movement = state.actor.character.movement;
  const travel = horizontal(delta),
    direction = unit(travel),
    distance = length(travel);
  if (distance < 1e-9 || movement.stepHeightMm === 0) return normalPath;
  const normalProgress = dot(sub(at(normalPath, 1), state.position), direction);
  if (normalProgress >= distance - 1e-6) return normalPath;
  const obstruction = world.sweep(state.position, travel, shape, 'movement', 1, COLLISION_SKIN);
  if (!obstruction || obstruction.normal1.y >= minGround(state)) return normalPath; // Walkable ramps use the continuous slid path.
  const probe = add(add(state.position, travel), mul(direction, body.radius + COLLISION_SKIN));
  const foot = state.position.y - body.halfHeight - body.radius;
  const surface = world.raycast(
    { ...probe, y: foot + movement.stepHeightMm / 1000 + 0.01 },
    { ...probe, y: foot - 0.02 },
    'movement',
  );
  if (!surface || surface.normal.y < minGround(state)) return normalPath;
  const lift = surface.point.y + body.halfHeight + body.radius + COLLISION_SKIN - state.position.y;
  if (lift <= 1e-6 || lift > movement.stepHeightMm / 1000 + 1e-6) return normalPath;
  const up = { x: 0, y: lift, z: 0 };
  if (world.sweep(state.position, up, shape, 'movement', 1, COLLISION_SKIN)) return normalPath;
  const raised = add(state.position, up);
  const across = world.trace(raised, travel, body, maxSegments, minGround(state));
  if (dot(sub(at(across, 1), state.position), direction) <= normalProgress + 1e-6)
    return normalPath;
  const landing = support(world, state, at(across, 1), lift + 0.02);
  if (!landing || landing.time_of_impact > 0.01)
    return [...retime(straight(state.position, raised), 0, 0.2), ...retime(across, 0.2, 1)]; // A legal ledge can require several intervals before the centre is over its top.
  const end = add(at(across, 1), { x: 0, y: -landing.time_of_impact, z: 0 });
  if (world.overlaps(end, shape)) return normalPath;
  return [
    ...retime(straight(state.position, raised), 0, 0.2),
    ...retime(across, 0.2, 0.8),
    ...retime(straight(at(across, 1), end), 0.8, 1),
  ];
}

/** All desired paths are computed from the same boundary state before either actor is committed. */
export function moveActors(
  world: SpatialWorld,
  states: readonly MotionState[],
  intents: ReadonlyMap<string, MotionIntent>,
  rules: DeepReadonly<Definition<'ruleset'>>,
  maxSegments = 8,
): MovedActor[] {
  if (
    states.length > 2 ||
    new Set(states.map((s) => s.actor.participant.actorId)).size !== states.length
  )
    throw new Error('Movement requires at most two distinct actors');
  const plans = states.map((state) => {
    const intent = intents.get(state.actor.participant.actorId);
    if (!intent) throw new Error('Missing simultaneous movement intent');
    const movement = state.actor.character.movement;
    const ground =
      state.grounded && !intent.flight ? support(world, state, state.position) : undefined;
    let requested = intent.flight ? intent.direction : horizontal(intent.direction);
    if (ground) requested = sub(requested, mul(ground.normal1, dot(requested, ground.normal1)));
    const speed =
      (((intent.flight ? movement.flySpeedMmPerSecond : movement.speedMmPerSecond) / 1000) *
        intent.speedBps) /
      10000;
    const desired = intent.canMove ? mul(unit(requested), speed) : { ...ZERO };
    const current = intent.flight || ground ? state.velocity : horizontal(state.velocity);
    let velocity = intent.canMove
      ? approachVelocity(
          current,
          desired,
          (movement.accelerationMmPerSecond2 / 1000) * STEP_SECONDS,
        )
      : { ...ZERO };
    if (!intent.flight) {
      const jumping = intent.canMove && intent.jump && state.grounded;
      velocity = {
        ...velocity,
        y:
          (jumping ? movement.jumpMmPerSecond / 1000 : ground ? velocity.y : state.velocity.y) +
          (rules.gravityMmPerSecond2 / 1000) * STEP_SECONDS,
      };
    }
    const delta = mul(velocity, STEP_SECONDS),
      body = bodyCapsule(state.actor.character.body);
    let trace = world.trace(state.position, delta, body, maxSegments, minGround(state));
    const normalTrace = trace;
    if (state.grounded && !intent.flight && !intent.jump && intent.canMove)
      trace = stepTrace(world, state, delta, trace, maxSegments);
    return {
      state,
      intent,
      velocity,
      trace,
      stepped: trace !== normalTrace,
      contactTime: undefined as number | undefined,
    };
  });
  if (plans.length === 2) {
    const [a, b] = plans as [(typeof plans)[number], (typeof plans)[number]];
    const time = firstContact(
      a.trace,
      capsuleShape(bodyCapsule(a.state.actor.character.body)),
      b.trace,
      capsuleShape(bodyCapsule(b.state.actor.character.body)),
    );
    if (time !== undefined) {
      a.trace = stopAt(a.trace, time);
      b.trace = stopAt(b.trace, time);
      a.contactTime = time;
      b.contactTime = time;
    }
  }
  return plans.map((plan) => {
    if (plan.trace.length > maxSegments) throw new SpatialBudgetError('movement-segments');
    const { state, intent, trace } = plan,
      position = at(trace, 1);
    const ground = !intent.flight ? support(world, state, position) : undefined;
    const grounded =
      !!ground &&
      ground.time_of_impact <= CONTACT_TOLERANCE &&
      dot(plan.velocity, ground.normal1) <= 1e-6;
    const landed = !state.grounded && grounded;
    const last = trace.at(-1)!;
    const actualVelocity =
      plan.contactTime !== undefined
        ? { ...ZERO }
        : plan.stepped
          ? { ...mul(sub(position, state.position), 1 / STEP_SECONDS), y: 0 }
          : last.to === last.from
            ? { ...ZERO }
            : mul(sub(last.end, last.start), 1 / ((last.to - last.from) * STEP_SECONDS));
    const velocity = actualVelocity;
    const excessFall = Math.max(0, -plan.velocity.y * 1000 - rules.fallSafeSpeedMmPerSecond);
    const fallDamage = landed
      ? Math.floor((excessFall * rules.fallDamagePerMeterPerSecond) / 1000)
      : 0;
    return {
      state: {
        actor: state.actor,
        position,
        velocity,
        grounded,
        facing: turnToward(
          state.facing,
          intent.facing,
          (state.actor.character.movement.turnMilliDegreesPerSecond / 1000) * STEP_SECONDS,
        ),
      },
      trace,
      landed,
      fallDamage,
      contactTime: plan.contactTime,
    };
  });
}
