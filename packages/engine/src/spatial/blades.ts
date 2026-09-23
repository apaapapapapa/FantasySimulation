import type { AttackGeometry, Budget, DeepReadonly, Definition } from '@fantasy/domain/spatial';
import { bladeBodyContact, bladeObstacleContact } from './geometry.ts';
import { add, cosDegrees, length, mul, sinDegrees, sub, unit, type Vec3 } from './math.ts';
import {
  at,
  CONTACT_TOLERANCE,
  firstImpact,
  SpatialBudgetError,
  type SpatialWorld,
  type Trace,
} from './physics.ts';
import type { MotionState } from './movement.ts';
import { bodyCapsule } from './terrain.ts';
import type { AttackContact } from './attacks.ts';

type Blade = DeepReadonly<Extract<Definition<'ability'>['attack'], { kind: 'arc' | 'radial' }>>;
/** Positive angle turns +X toward +Z. Vertical aim retains a deterministic horizontal plane. */
export function bladePose(root: Vec3, facing: Vec3, reach: number, angle: number) {
  const horizontal = unit({ ...facing, y: 0 });
  const forward = length(horizontal) ? horizontal : { x: 1, y: 0, z: 0 };
  const direction = unit({
    x: forward.x * cosDegrees(angle) - forward.z * sinDegrees(angle),
    y: 0,
    z: forward.z * cosDegrees(angle) + forward.x * sinDegrees(angle),
  });
  return { root, tip: add(root, mul(direction, reach)) };
}
/** Lipschitz advancement cannot step across first contact; non-convergence is explicit truncation. */
function advance(
  world: SpatialWorld,
  from: number,
  to: number,
  speed: number,
  separation: (time: number) => number,
) {
  let time = from;
  for (let iteration = 0; iteration < 256; iteration++) {
    world.countCast();
    const distance = separation(time);
    if (distance <= CONTACT_TOLERANCE) return time;
    if (time === to || speed < 1e-12 || distance > speed * (to - time) + CONTACT_TOLERANCE)
      return undefined;
    const next = Math.min(to, time + (0.9 * distance) / speed);
    if (next <= time) throw new SpatialBudgetError('blade-sweep', 'no progress');
    time = next;
  }
  throw new SpatialBudgetError('blade-sweep', '256 conservative advances');
}
/** One attached blade adapter; body/root motion follows every actual shared-physics trace bend. */
export function sweepBlade(
  world: SpatialWorld,
  owner: Trace,
  offset: Vec3,
  facing: Vec3,
  shape: Blade,
  elapsed: number,
  duration: number,
  target: MotionState,
  targetTrace: Trace,
  rules: DeepReadonly<Definition<'ruleset'>>,
  budget: Budget,
): { contact: AttackContact | null; wall: AttackContact | null; geometry: AttackGeometry } {
  const reach = shape.reachMm / 1000,
    radius = shape.bladeRadiusMm / 1000;
  const sweep = (shape.kind === 'radial' ? 360000 : shape.sweepMilliDegrees) / 1000;
  const rate = sweep / duration;
  const pose = (time: number) =>
    bladePose(
      add(at(owner, time), offset),
      facing,
      reach,
      shape.startAngleMilliDegrees / 1000 + (elapsed + time) * rate,
    );
  const obstacles = world.obstacles('attack'),
    capsule = bodyCapsule(target.actor.character.body);
  const bodyContact = (time: number) => {
    const p = pose(time);
    return bladeBodyContact(p.root, p.tip, radius, at(targetTrace, time), capsule);
  };
  const boundaries = [
    ...new Set([
      0,
      1,
      ...owner.flatMap((s) => [s.from, s.to]),
      ...targetTrace.flatMap((s) => [s.from, s.to]),
    ]),
  ].sort((a, b) => a - b);
  let wall: number | undefined, wallPoint: Vec3 | undefined, body: number | undefined;
  for (let i = 1; i < boundaries.length; i++) {
    const from = boundaries[i - 1]!,
      to = boundaries[i]!;
    if (to <= from) continue;
    const rotationSpeed = reach * Math.abs(rate) * 0.018;
    const rootSpeed = length(sub(at(owner, to), at(owner, from))) / (to - from);
    if (wall === undefined)
      for (const obstacle of obstacles) {
        const contact = (t: number) => {
          const p = pose(t);
          return bladeObstacleContact(p.root, p.tip, radius, obstacle);
        };
        const time = advance(
          world,
          from,
          to,
          rootSpeed + rotationSpeed,
          (t) => contact(t).distance,
        );
        if (time !== undefined && (wall === undefined || time < wall)) {
          wall = time;
          wallPoint = contact(time).point;
        }
      }
    if (body === undefined)
      body = advance(
        world,
        from,
        to,
        rootSpeed +
          rotationSpeed +
          length(sub(at(targetTrace, to), at(targetTrace, from))) / (to - from),
        (t) => bodyContact(t).distance,
      );
    // A body accepts a hit, but does not end the blade's remaining wall sweep.
    if (wall !== undefined) break;
  }
  let impact = firstImpact(wall, body);
  if (
    impact?.kind === 'body' &&
    world.occluded(pose(impact.time).root, bodyContact(impact.time).point, 'attack')
  ) {
    impact = { kind: 'wall', time: impact.time };
    wall = impact.time;
    wallPoint = bodyContact(impact.time).point;
  }
  const contact = impact
    ? {
        ...impact,
        point: impact.kind === 'body' ? bodyContact(impact.time).point : wallPoint!,
        center: pose(impact.time).root,
      }
    : null;
  const end = wall ?? 1;
  // Recorded poses bound the tip's chord error; also retain all owner trace breakpoints.
  const segments = Math.max(
    1,
    Math.ceil(
      Math.sqrt((reach * (Math.abs(rate) * 0.02) ** 2) / ((8 * rules.curveErrorMm) / 1000)),
    ),
  );
  const times = [
    ...new Set([
      0,
      end,
      ...owner.flatMap((s) => [s.from, s.to]).filter((t) => t < end),
      ...Array.from(
        { length: Math.min(segments, budget.maxCurveSegments + 1) },
        (_, i) => (i + 1) / segments,
      ).filter((t) => t < end),
    ]),
  ].sort((a, b) => a - b);
  if (segments > budget.maxCurveSegments || times.length - 1 > budget.maxCurveSegments)
    throw new SpatialBudgetError('curve-segments');
  return {
    contact,
    wall:
      wall === undefined
        ? null
        : { kind: 'wall', time: wall, point: wallPoint!, center: pose(wall).root },
    geometry: {
      kind: 'blade',
      radiusMm: shape.bladeRadiusMm,
      poses: times.map((fraction) => ({ fraction, ...pose(fraction) })),
    },
  };
}
