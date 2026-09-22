import type { DeepReadonly, Definition } from '@fantasy/domain/spatial';
import { cosDegrees, cross, dot, length, lerp, sub, unit, type Vec3 } from './math.ts';
import { capsuleShape, COLLISION_SKIN, type SpatialWorld, type Trace } from './physics.ts';
import type { ResolvedActor } from './prepare.ts';
import { bodyCapsule, metres } from './terrain.ts';

type Mode = 'walk' | 'jump' | 'fly';
export type Waypoint = { position: Vec3; mode: Mode };
export type NavigationResult =
  | { kind: 'path'; waypoints: Waypoint[]; visited: number }
  | { kind: 'unreachable' | 'budget-exceeded'; visited: number };
/** One planner per actor and immutable battle world; geometric edge checks are reusable. */
export class Navigator {
  private readonly cache = new Map<string, boolean>();
  private readonly world: SpatialWorld;
  private readonly actor: ResolvedActor;
  private readonly scenario: DeepReadonly<Definition<'scenario'>>;
  private readonly rules: DeepReadonly<Definition<'ruleset'>>;
  constructor(
    world: SpatialWorld,
    actor: ResolvedActor,
    scenario: DeepReadonly<Definition<'scenario'>>,
    rules: DeepReadonly<Definition<'ruleset'>>,
  ) {
    this.world = world;
    this.actor = actor;
    this.scenario = scenario;
    this.rules = rules;
  }
  private clear(from: Vec3, to: Vec3): boolean {
    const shape = capsuleShape(bodyCapsule(this.actor.character.body));
    return (
      !this.world.overlaps(from, shape) &&
      !this.world.overlaps(to, shape) &&
      !this.world.sweep(from, sub(to, from), shape, 'movement', 1, COLLISION_SKIN / 2)
    );
  }
  private supported(point: Vec3, distance = 0.02): boolean {
    const hit = this.world.sweep(
      point,
      { x: 0, y: -1, z: 0 },
      capsuleShape(bodyCapsule(this.actor.character.body)),
      'movement',
      distance,
      COLLISION_SKIN / 2,
    );
    return (
      !!hit &&
      hit.normal1.y >= cosDegrees(this.actor.character.movement.maxSlopeMilliDegrees / 1000)
    );
  }
  private walk(from: Vec3, to: Vec3): boolean {
    const movement = this.actor.character.movement;
    if (!this.supported(from) || !this.supported(to)) return false;
    const delta = sub(to, from),
      horizontal = length({ ...delta, y: 0 });
    const cosine = cosDegrees(movement.maxSlopeMilliDegrees / 1000);
    const slopeOK = length(delta) < 1e-9 || horizontal / length(delta) >= cosine - 1e-12;
    let pieces: Trace;
    let supportDistance = 0.02;
    if (slopeOK && this.clear(from, to)) pieces = [{ start: from, end: to, from: 0, to: 1 }];
    else {
      if (
        Math.abs(delta.y) > movement.stepHeightMm / 1000 ||
        horizontal > (2 * this.actor.character.body.radiusMm) / 1000 + 0.1
      )
        return false;
      const raisedFrom = { ...from, y: Math.max(from.y, to.y) },
        raisedTo = { ...to, y: Math.max(from.y, to.y) };
      if (
        !this.clear(from, raisedFrom) ||
        !this.clear(raisedFrom, raisedTo) ||
        !this.clear(raisedTo, to)
      )
        return false;
      supportDistance += Math.abs(delta.y);
      pieces = [{ start: raisedFrom, end: raisedTo, from: 0, to: 1 }];
    }
    for (const piece of pieces) {
      const count = Math.max(1, Math.ceil(length(sub(piece.end, piece.start)) / 0.25));
      for (let i = 0; i <= count; i++)
        if (!this.supported(lerp(piece.start, piece.end, i / count), supportDistance)) return false;
    }
    return true;
  }
  private jump(from: Vec3, to: Vec3): boolean {
    const movement = this.actor.character.movement,
      gravity = this.rules.gravityMmPerSecond2 / 1000;
    if (!movement.jumpMmPerSecond || gravity >= 0 || !this.supported(from) || !this.supported(to))
      return false;
    const velocity = movement.jumpMmPerSecond / 1000,
      delta = sub(to, from);
    // Semi-implicit Euler at 20ms: y(t)=v0*t+g*t*(t+dt)/2.
    const b = velocity + gravity * 0.01,
      discriminant = b * b + 2 * gravity * delta.y;
    if (discriminant < 0) return false;
    const time = (-b - Math.sqrt(discriminant)) / gravity;
    if (
      time <= 0 ||
      time > 120 ||
      length({ ...delta, y: 0 }) > (movement.speedMmPerSecond / 1000) * time
    )
      return false;
    const steps = Math.ceil(time / 0.02);
    let previous = from;
    for (let i = 1; i <= steps; i++) {
      const t = Math.min(time, i * 0.02);
      const point = {
        x: from.x + (delta.x * t) / time,
        y: from.y + velocity * t + (gravity * t * (t + 0.02)) / 2,
        z: from.z + (delta.z * t) / time,
      };
      if (!this.clear(previous, point)) return false;
      previous = point;
    }
    return true;
  }
  private traversable(from: Vec3, to: Vec3, mode: Mode) {
    return mode === 'fly'
      ? this.clear(from, to)
      : mode === 'jump'
        ? this.jump(from, to)
        : this.walk(from, to);
  }
  find(
    start: Vec3,
    goal: Vec3,
    flight: boolean,
    maxNodes: number,
    allowJump = true,
  ): NavigationResult {
    const mode = flight ? 'fly' : 'walk';
    if (this.traversable(start, goal, mode))
      return { kind: 'path', waypoints: [{ position: { ...goal }, mode }], visited: 0 };
    const nodes = this.scenario.navigation.nodes.filter(
      (n) => n.mode === (flight ? 'air' : 'ground'),
    );
    const points = new Map(nodes.map((n) => [n.id, metres(n.position)]));
    const edges = this.scenario.navigation.edges;
    const costs = new Map<string, number>(),
      previous = new Map<string, { id: string | null; mode: Mode }>(),
      open = new Set<string>(),
      closed = new Set<string>();
    let forward = unit({ ...sub(goal, start), y: 0 });
    if (length(forward) < 1e-12) forward = unit({ ...this.actor.participant.facing, y: 0 });
    if (length(forward) < 1e-12) forward = { x: 1, y: 0, z: 0 };
    const right = cross(forward, { x: 0, y: 1, z: 0 });
    let visited = 0;
    const ordered = [...nodes].sort((a, b) => {
      const pa = sub(points.get(a.id)!, start),
        pb = sub(points.get(b.id)!, start);
      return (
        length(sub(points.get(a.id)!, goal)) - length(sub(points.get(b.id)!, goal)) ||
        dot(right, pb) - dot(right, pa) ||
        dot(forward, pb) - dot(forward, pa) ||
        pa.y - pb.y
      );
    });
    for (const node of ordered) {
      if (++visited > maxNodes) return { kind: 'budget-exceeded', visited: visited - 1 };
      const point = points.get(node.id)!;
      if (this.traversable(start, point, mode)) {
        costs.set(node.id, length(sub(point, start)));
        previous.set(node.id, { id: null, mode });
        open.add(node.id);
      }
    }
    while (open.size) {
      if (++visited > maxNodes) return { kind: 'budget-exceeded', visited: visited - 1 };
      let chosen: string | undefined,
        score = Infinity;
      for (const node of ordered)
        if (open.has(node.id)) {
          const candidate = costs.get(node.id)! + length(sub(points.get(node.id)!, goal));
          if (candidate < score) {
            chosen = node.id;
            score = candidate;
          }
        }
      const id = chosen!,
        point = points.get(id)!;
      open.delete(id);
      closed.add(id);
      if (this.traversable(point, goal, mode)) {
        const waypoints: Waypoint[] = [{ position: { ...goal }, mode }];
        let cursor: string | null = id;
        while (cursor !== null) {
          const parent: { id: string | null; mode: Mode } = previous.get(cursor)!;
          waypoints.unshift({ position: points.get(cursor)!, mode: parent.mode });
          cursor = parent.id;
        }
        return { kind: 'path', waypoints, visited };
      }
      for (const edge of edges) {
        const next =
          edge.from === id ? edge.to : edge.bidirectional && edge.to === id ? edge.from : null;
        if (
          !next ||
          !points.has(next) ||
          closed.has(next) ||
          (flight ? edge.mode !== 'fly' : edge.mode === 'fly') ||
          (edge.mode === 'jump' && !allowJump)
        )
          continue;
        if (
          edge.widthMm < this.actor.character.body.radiusMm * 2 + 4 ||
          edge.headroomMm < this.actor.character.body.heightMm + 4
        )
          continue;
        const key = `${id}:${next}:${edge.mode}`;
        let usable = this.cache.get(key);
        if (usable === undefined) {
          usable = this.traversable(point, points.get(next)!, edge.mode);
          this.cache.set(key, usable);
        }
        if (!usable) continue;
        const cost = costs.get(id)! + length(sub(points.get(next)!, point));
        if (cost < (costs.get(next) ?? Infinity)) {
          costs.set(next, cost);
          previous.set(next, { id, mode: edge.mode });
          open.add(next);
        }
      }
    }
    return { kind: 'unreachable', visited };
  }
}
