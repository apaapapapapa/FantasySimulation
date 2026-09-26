import { bodyPoint, canSee } from '../world/visibility.ts';
import type {
  MotionState,
  StatusCohort,
  ObservedActor,
  ObservableProjectile,
  PerceptionMemory,
} from '../state.ts';
export type {
  ObservedActor,
  ObservableProjectile,
  Observation,
  PerceptionMemory,
  ThreatExperience,
  DecisionView,
} from '../state.ts';
import {
  deepFreeze,
  compareIds,
  AI_RULES,
  type Definition,
  type Effect,
  type Experience,
  type ObservedSurface,
  type RevisionRef,
  type DeepReadonly,
  type ResourceState,
  type ObservedStage,
  type ObservedReaction,
} from '@fantasy/domain/spatial/execution';
import { add, cross, dot, length, mul, sub, unit, type Vec3 } from '../math.ts';
import type { SpatialWorld } from '../world/physics.ts';
import { publicStatuses } from '../rules/status-observation.ts';
import { surveySearch } from './search.ts';

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
    range:
      uncertain || shield || rules.relativeImpactBps
        ? null
        : { low, high: low + rules.damageQuantum },
    ...(!uncertain && !shield && rules.relativeImpactBps
      ? {
          impactBand: (['minimal', 'weak', 'normal', 'strong'] as const)[
            detail.basePower <= 0
              ? 0
              : rules.relativeImpactBps.filter(
                  (bound) => detail.impact * 10000 >= detail.basePower * bound,
                ).length
          ]!,
        }
      : {}),
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
    stage?: ObservedStage | undefined;
    reaction?: ObservedReaction | undefined;
  },
  terrainMode: 'surveyed' | 'observed' = 'surveyed',
  rules: DeepReadonly<NonNullable<Definition<'ruleset'>['ai']>> = AI_RULES,
  bounds?: DeepReadonly<Definition<'scenario'>['bounds']>,
): PerceptionMemory {
  const interval = self.actor.character.perception.reactionSteps;
  let pending = [...previous.pending],
    observation = previous.observation,
    lastSeen = previous.lastSeen,
    terrain = [...previous.terrain];
  let statusChangedAt = previous.statusChangedAt;
  let deflections = previous.deflections
    ? [...previous.deflections.filter((d) => d.expiresAt > step)]
    : undefined;
  let threatHistory = previous.threatHistory ? [...previous.threatHistory] : undefined;
  for (const sample of pending)
    if (sample.availableAt <= step) {
      if (
        sample.enemy?.statuses !== undefined &&
        JSON.stringify(sample.enemy.statuses) !== JSON.stringify(lastSeen?.statuses)
      )
        statusChangedAt = sample.sampledAt;
      const previouslyVisible = observation?.projectiles ?? [];
      observation = sample;
      if (sample.enemy) lastSeen = sample.enemy;
      if (sample.enemy?.reaction?.response === 'deflect') {
        deflections = [
          ...(deflections ?? []).filter((d) => d.targetId !== sample.enemy!.id),
          {
            targetId: sample.enemy.id,
            sampledAt: sample.sampledAt,
            availableAt: sample.availableAt,
            expiresAt: sample.sampledAt + rules.knowledgeTtlSteps,
          },
        ].slice(-2);
      }
      terrain.push(...(sample.terrain ?? []));
      if (rules.reapplication)
        for (const p of sample.projectiles) {
          const cueId = `${p.attackCueId ?? `projectile.${p.id}`}.${p.element}`;
          if (
            !p.element ||
            previouslyVisible.some((old) => old.id === p.id) ||
            threatHistory?.some((e) => e.eventId === cueId)
          )
            continue;
          threatHistory = [
            ...(threatHistory ?? []),
            {
              eventId: cueId,
              sourceId: p.ownerId,
              element: p.element,
              sampledAt: sample.sampledAt,
              availableAt: sample.availableAt,
              expiresAt: sample.sampledAt + rules.knowledgeTtlSteps,
            },
          ].slice(-32);
        }
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
            ...(enemy.posture ? { posture: enemy.posture.current } : {}),
            ...(visibleState?.stage
              ? {
                  stage: {
                    shape: visibleState.stage.shape,
                    state: visibleState.stage.state,
                    ...(visibleState.stage.motion ? { motion: visibleState.stage.motion } : {}),
                  },
                }
              : {}),
            ...(statusKnown && { statuses: observedStatuses }),
            ...(visibleState?.reaction
              ? {
                  reaction: {
                    point: visibleState.reaction.point,
                    response: visibleState.reaction.response,
                  },
                }
              : {}),
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
          ...(p.element ? { element: p.element } : {}),
          ...(p.attackCueId ? { attackCueId: p.attackCueId } : {}),
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
    ...(rules.search && bounds
      ? {
          search: surveySearch(
            self,
            bounds,
            rules.search,
            step,
            previous.search,
            observation,
            (point) => {
              // A sensor may test true geometry, but delivers only a delayed checked-cell bit.
              // Bounds include the floor volume; its lower bound is not the walking surface.
              const feet = self.position.y - self.actor.character.body.heightMm / 2000;
              const ground = world.raycast(
                { ...point, y: feet + 0.75 },
                { ...point, y: bounds.min.y / 1000 },
                'movement',
              );
              return (
                !!ground &&
                ground.normal.y > 0.5 &&
                canSee(world, self, {
                  ...ground.point,
                  y: ground.point.y + rules.search!.lowSightMm / 1000,
                })
              );
            },
          ),
        }
      : {}),
    ...(deflections ? { deflections } : {}),
    ...(statusChangedAt !== undefined && { statusChangedAt }),
    ...(threatHistory ? { threatHistory: threatHistory.filter((e) => e.expiresAt > step) } : {}),
    pendingExperience: previous.pendingExperience.filter(
      (e) => e.availableAt > step && e.expiresAt > step,
    ),
  });
}
