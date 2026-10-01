import { sealDisplay } from './seal-display.ts';
import type {
  AttackGeometry,
  BattleEvent,
  ReplayCheckpoint,
  ReplayContext,
  StreamRecord,
} from '@fantasy/domain/spatial';

export type Point = [number, number, number];
/** Display colour family of a saved ability: its first damage element, else its support effect. */
export type Tint =
  | 'physical'
  | 'fire'
  | 'ice'
  | 'lightning'
  | 'arcane'
  | 'water'
  | 'earth'
  | 'heal'
  | 'shield';
type Shape = {
  id: string;
  /** Recorded geometry the pose/segment belongs to; one blade sweep shares a group. */
  group: string;
  actorId: string;
  tint: Tint | null;
  kind: AttackGeometry['kind'];
  radius: number;
  points: [Point, Point];
};
const point = (v: { x: number; y: number; z: number }): Point => [v.x, v.y, v.z];
type Ability = ReplayContext['actors'][number]['abilities'][number];
function abilityTint(ability: Ability): Tint | null {
  const effects = [
    ...ability.definition.effects,
    ...(ability.definition.stages ?? []).flatMap((stage) => stage.effects),
  ];
  for (const effect of effects) if (effect.kind === 'damage') return effect.element;
  if (effects.some((effect) => effect.kind === 'heal')) return 'heal';
  return effects.some((effect) => effect.kind === 'shield') ? 'shield' : null;
}
/** Looks in the owner's saved loadout first; a deflected projectile keeps its original ability. */
function tintOf(context: ReplayContext, abilityId: string | null, ownerId: string | null) {
  if (!abilityId) return null;
  const owners = [...context.actors].sort(
    (a, b) => Number(b.participant.actorId === ownerId) - Number(a.participant.actorId === ownerId),
  );
  const ability = owners.flatMap((owner) => owner.abilities).find((a) => a.id === abilityId);
  return ability ? abilityTint(ability) : null;
}
/** Arrows show the recorded velocity over this display interval; they never move bodies. */
export const ARROW_SECONDS = 0.1;
const ahead = (from: Point, velocity: Point): [Point, Point] => [
  from,
  from.map((n, i) => n + velocity[i]! * ARROW_SECONDS) as Point,
];
const metres = (v: { x: number; y: number; z: number }): Point =>
  point(v).map((n) => n / 1000) as Point;
const colours = {
  neutral: '#b5bfd1',
  red: '#e76669',
  blue: '#64a7e4',
  dark: '#545b78',
  bright: '#e8d89d',
  brown: '#ba895e',
  green: '#76bfa0',
};

/** Renderer-independent geometry in metres, derived only from saved display data. */
export function buildSceneModel(
  context: ReplayContext,
  checkpoint: ReplayCheckpoint,
  records: readonly StreamRecord[] = checkpoint.lastRecord ? [checkpoint.lastRecord] : [],
  events: readonly BattleEvent[] = records.flatMap((r) => ('events' in r ? r.events : [])),
  eventRecords: readonly StreamRecord[] = records,
  perspective: 'omniscient' | { actorId: string } = 'omniscient',
) {
  const scenario = context.manifest.revisions.find(
    (r) =>
      r.kind === 'scenario' &&
      r.id === context.manifest.scenario.id &&
      r.revision === context.manifest.scenario.revision,
  );
  if (!scenario || scenario.kind !== 'scenario') throw new Error('Missing recorded arena');
  const min = metres(scenario.definition.bounds.min),
    max = metres(scenario.definition.bounds.max);
  const centre: Point = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let actors = (checkpoint.state?.actors ?? []).map((actor, index) => {
    const loadout = context.actors.find((a) => a.participant.actorId === actor.id);
    const definition = loadout?.character;
    if (!definition) throw new Error('Missing recorded character');
    const body = actor.posture?.body ?? definition.body;
    const hp = actor.resources.hp;
    const radius = body.radiusMm / 1000;
    const horizontal = Math.hypot(actor.facing.x, actor.facing.z);
    const fx = horizontal ? actor.facing.x / horizontal : 1;
    const fz = horizontal ? actor.facing.z / horizontal : 0;
    const eye: Point = [
      actor.position.x + (fx * body.eyeOffset.x - fz * body.eyeOffset.z) / 1000,
      actor.position.y + body.eyeOffset.y / 1000,
      actor.position.z + (fz * body.eyeOffset.x + fx * body.eyeOffset.z) / 1000,
    ];
    const unknownVision = actor.statuses.some((status) => {
      const revision = context.manifest.revisions.find(
        (r) =>
          r.kind === 'status' &&
          r.id === status.revision.id &&
          r.revision === status.revision.revision,
      );
      return (
        revision?.kind === 'status' &&
        revision.definition.adjustments?.some((a) =>
          ['vision', 'perceptionRange', 'perceptionFov'].includes(a.target),
        )
      );
    });
    return {
      id: actor.id,
      position: point(actor.position),
      facing: point(actor.facing),
      radius,
      length: Math.max(0, body.heightMm / 1000 - 2 * radius),
      name: definition.name,
      appearance: definition.appearance,
      sealing: sealDisplay(context, actor, checkpoint.step).some((s) => s.sealing),
      revived: events.some((e) => e.revival && e.actorId === actor.id),
      frozen: !!actor.clock?.frozen,
      subjectMilliseconds: actor.clock ? actor.clock.subjectStep * 20 : undefined,
      evaded: events.some((event) => event.evasion && event.actorId === actor.id),
      protected: events.some((event) => event.immortality && event.actorId === actor.id),
      defeated: events.some((event) => event.defeat?.applied && event.targetId === actor.id),
      casting: actor.action?.phase === 'cast',
      vision: unknownVision
        ? null
        : {
            position: eye,
            range: definition.perception.rangeMm / 1000,
            angle: (definition.perception.fovMilliDegrees * Math.PI) / 180000,
          },
      colour: definition.appearance
        ? colours[definition.appearance.surface]
        : index === 0
          ? '#d4b780'
          : '#68b7db',
      phasing: actor.phasing
        ? {
            materials: [
              ...new Set(
                [...actor.phasing.active, ...actor.phasing.retained].flatMap((c) => c.materials),
              ),
            ],
            pending: actor.phasing.exitPending,
            intervals: actor.phasing.extendedIntervals,
          }
        : null,
      locomotion: actor.locomotion ?? null,
      stamina:
        actor.resources.stamina === undefined
          ? null
          : { value: actor.resources.stamina, max: definition.stamina?.max ?? null },
      stage: actor.action?.stage
        ? {
            abilityId: actor.action.abilityId,
            index: actor.action.stage.contact.stageIndex,
            count: stageCount(loadout, actor.action.abilityId),
            state: actor.action.stage.state,
            shape: actor.action.stage.shape,
            motion: actor.action.stage.motion
              ? {
                  kind: actor.action.stage.motion.kind,
                  applied: actor.action.stage.motion.applied,
                  metresPerSecond: actor.action.stage.motion.speedMmPerSecond / 1000,
                }
              : null,
          }
        : null,
      force: actor.force?.active
        ? { applied: point(actor.force.applied), capped: actor.force.capped }
        : null,
      /** Bottom of the recorded capsule and the saved standing height that scales the figure. */
      feet: actor.position.y - body.heightMm / 2000,
      standingHeight: definition.body.heightMm / 1000,
      hp: hp === undefined ? null : { value: hp, max: definition.stats.hp },
      look: {
        silhouette: definition.appearance?.silhouette ?? 'humanoid',
        equipment: definition.appearance?.equipment ?? [],
      },
      pose: {
        defeated: hp !== undefined && hp <= 0,
        posture: actor.posture?.current ?? 'standing',
        grounded: actor.grounded,
        locomotion: actor.locomotion ?? null,
        phase: actor.action?.phase ?? null,
      },
      struck: events.some(
        (e) => (e.kind === 'hit' || e.kind === 'damage') && e.targetId === actor.id,
      ),
      tint: tintOf(context, actor.action?.abilityId ?? null, actor.id),
      /** First tinted ability in the saved loadout, for idle glowing parts such as a staff. */
      signature: loadout.abilities.map(abilityTint).find((tint) => tint !== null) ?? null,
    };
  });
  const visualCues = (checkpoint.state?.actors ?? []).flatMap((actor) =>
    (actor.sensoryCues ?? []).filter(
      (cue) =>
        cue.deliveredAt <= checkpoint.step &&
        checkpoint.step < cue.discoveredAt &&
        checkpoint.step < cue.expiresAt,
    ),
  );
  if (perspective !== 'omniscient') {
    const subjective = visualCues.filter((cue) => cue.observerId === perspective.actorId);
    actors = actors.map((actor) => {
      const cue = subjective.find((candidate) => candidate.creatorId === actor.id);
      if (!cue) return actor;
      const position = point(cue.perceivedOrigin);
      const delta = position.map((value, index) => value - actor.position[index]!) as Point;
      return {
        ...actor,
        position,
        feet: actor.feet + delta[1],
        vision: actor.vision
          ? {
              ...actor.vision,
              position: actor.vision.position.map((value, index) => value + delta[index]!) as Point,
            }
          : null,
      };
    });
  }
  // Recorded forced velocity (m/s) and the requested stage-motion velocity; no path is inferred.
  const arrows = (checkpoint.state?.actors ?? []).flatMap((actor) => {
    const from = point(actor.position),
      motion = actor.action?.stage?.motion;
    return [
      ...(actor.force?.active
        ? [
            {
              id: `${actor.id}:force`,
              kind: 'force' as const,
              points: ahead(from, point(actor.force.applied)),
            },
          ]
        : []),
      ...(motion && actor.action?.stage?.state === 'active'
        ? [
            {
              id: `${actor.id}:stage-motion`,
              kind: 'stage-motion' as const,
              points: ahead(
                from,
                point(motion.direction).map((n) => (n * motion.speedMmPerSecond) / 1000) as Point,
              ),
            },
          ]
        : []),
    ];
  });
  const shown = new Map((checkpoint.state?.projectiles ?? []).map((p) => [p.id, p]));
  const paths = records.flatMap((record) => {
    if (record.kind !== 'interval') return [];
    // A projectile removed in this interval is gone from the checkpoint, but the interval's own
    // removal event still names its ability; a recorded source marks a deflected projectile.
    const removals = new Map(
      record.events.flatMap((e) =>
        e.kind === 'projectile-remove' && e.entityId ? [[e.entityId, e] as const] : [],
      ),
    );
    return record.paths.flatMap((path) => {
      const live = shown.get(path.entityId),
        removal = removals.get(path.entityId);
      const tint = live
        ? tintOf(context, live.abilityId, live.ownerId)
        : removal
          ? tintOf(context, removal.abilityId, removal.sourceActorId ?? removal.actorId)
          : null;
      const deflected = live ? !!live.deflection : !!removal?.sourceProjectileId;
      return path.segments.map((segment, i) => ({
        id: `${record.toStep}:${path.entityId}:${i}`,
        entityId: path.entityId,
        points: [point(segment.start), point(segment.end)] as [Point, Point],
        tint,
        deflected,
      }));
    });
  });
  const shapes = (checkpoint.state?.actors ?? [])
    .flatMap((actor) => [
      ...(actor.action?.stage?.geometry
        ? [
            {
              id: `${actor.id}:stage`,
              actorId: actor.id,
              abilityId: actor.action.abilityId,
              geometry: actor.action.stage.geometry,
            },
          ]
        : []),
      ...(actor.reactions ?? []).flatMap((reaction, i) =>
        reaction.geometry
          ? [
              {
                id: `${actor.id}:reaction:${i}`,
                actorId: actor.id,
                abilityId: reaction.abilityId,
                geometry: reaction.geometry,
              },
            ]
          : [],
      ),
    ])
    .flatMap<Shape>(({ id, actorId, abilityId, geometry }) => {
      const common = {
        group: id,
        actorId,
        tint: tintOf(context, abilityId, actorId),
        kind: geometry.kind,
        radius: geometry.radiusMm / 1000,
      };
      return geometry.kind === 'blade'
        ? geometry.poses.map((pose, i) => ({
            ...common,
            id: `${id}:${i}`,
            points: [point(pose.root), point(pose.tip)] as [Point, Point],
          }))
        : geometry.segments.map((segment, i) => ({
            ...common,
            id: `${id}:${i}`,
            points: [point(segment.start), point(segment.end)] as [Point, Point],
          }));
    });
  const hits = events.flatMap((e) =>
    e.kind === 'hit' && e.point ? [{ id: e.id, position: point(e.point) }] : [],
  );
  return {
    min,
    max,
    centre,
    span: Math.max(...max.map((n, i) => n - min[i]!)),
    follow: actors[0]?.position ?? centre,
    step: checkpoint.step,
    /** Recorded time of the displayed step; decorative motion is keyed to it, never to a clock. */
    milliseconds: checkpoint.step * context.manifest.physicsProfile.stepMs,
    obstacles: scenario.definition.obstacles.map((obstacle) => {
      const common = {
        id: obstacle.id,
        position: metres(obstacle.center),
        colour: obstacle.blocks.movement ? '#526174' : '#364358',
        material: obstacle.material ?? 'generic',
        solid: obstacle.blocks.movement,
      };
      if (obstacle.kind === 'pillar')
        return {
          ...common,
          kind: 'cylinder' as const,
          radius: obstacle.radiusMm / 1000,
          height: obstacle.halfHeightMm / 500,
        };
      const size = metres({
        x: obstacle.halfExtents.x * 2,
        y: obstacle.halfExtents.y * 2,
        z: obstacle.halfExtents.z * 2,
      });
      const yaw = (obstacle.yawMilliDegrees * Math.PI) / 180000,
        slope = (obstacle.slopeMilliDegrees * Math.PI) / 180000;
      return {
        ...common,
        kind: 'box' as const,
        size,
        rotation: [0, yaw, slope] as Point,
        topWidth: Math.abs(Math.cos(slope)) * size[0] + Math.abs(Math.sin(slope)) * size[1],
      };
    }),
    actors,
    dependents:
      perspective === 'omniscient'
        ? (checkpoint.state?.dependents ?? []).map((dependent) => ({
            id: dependent.id,
            ownerId: dependent.ownerId,
            hostileOwnerId: dependent.hostileOwnerId,
            position: point(dependent.position),
            radius: dependent.body.radiusMm / 1000,
            length: Math.max(
              0,
              dependent.body.heightMm / 1000 - (dependent.body.radiusMm * 2) / 1000,
            ),
            hp: { value: dependent.hp, max: dependent.maxHp },
            profile: dependent.profile,
          }))
        : [],
    illusions:
      perspective === 'omniscient'
        ? visualCues.map((cue) => ({
            id: cue.id,
            creatorId: cue.creatorId,
            observerId: cue.observerId,
            position: point(cue.perceivedOrigin),
            confidenceBps: cue.confidenceBps,
          }))
        : [],
    objects:
      perspective === 'omniscient'
        ? (checkpoint.state?.objects ?? []).map((o) => ({
            id: o.id,
            kind: o.kind,
            position: point(o.position),
            shape: o.shape ?? null,
            colour: o.kind === 'barrier' ? '#62c7ee' : o.kind === 'area' ? '#f6a96d' : '#ff87cf',
            tint: tintOf(context, o.abilityId, o.ownerId),
            durability: o.durability === undefined ? null : `${o.durability}/${o.maxDurability}`,
            beams:
              o.geometry && o.geometry.kind === 'ray'
                ? o.geometry.segments.map((s, i) => ({
                    id: `${o.id}:${i}`,
                    points: [point(s.start), point(s.end)] as [Point, Point],
                    radius: o.geometry!.radiusMm / 1000,
                  }))
                : [],
          }))
        : [],
    projectiles:
      perspective === 'omniscient'
        ? (checkpoint.state?.projectiles ?? []).map((p) => ({
            id: p.id,
            position: point(p.position),
            radius: p.radiusMm / 1000,
            ownerId: p.ownerId,
            colour: p.deflection ? '#72e0c1' : '#f0bd67',
            deflected: !!p.deflection,
            tint: tintOf(context, p.abilityId, p.ownerId),
          }))
        : [],
    paths: perspective === 'omniscient' ? paths : [],
    shapes: perspective === 'omniscient' ? shapes : [],
    arrows:
      perspective === 'omniscient'
        ? [
            ...arrows,
            ...events.flatMap((event) =>
              event.projectileDeflection
                ? [
                    {
                      id: `${event.id}:deflection`,
                      kind: 'deflection' as const,
                      points: ahead(
                        point(event.projectileDeflection.position),
                        point(event.projectileDeflection.velocity),
                      ),
                    },
                  ]
                : [],
            ),
          ]
        : [],
    events: perspective === 'omniscient' ? hits : [],
    rays:
      perspective === 'omniscient'
        ? [
            ...shapes.filter((shape) => shape.kind === 'ray'),
            ...eventRecords.flatMap((record) =>
              record.kind === 'interval'
                ? record.events.flatMap((event) =>
                    event.kind === 'hit' &&
                    event.point &&
                    events.some((visible) => visible.id === event.id)
                      ? record.paths
                          .filter((path) => path.entityId === event.entityId)
                          .flatMap((path) =>
                            path.segments
                              .filter(
                                (segment) =>
                                  event.subtimeMicros >= Math.round(segment.from * 1_000_000) &&
                                  event.subtimeMicros <= Math.round(segment.to * 1_000_000),
                              )
                              .slice(0, 1)
                              .map((segment, i) => ({
                                id: `${event.id}:${path.entityId}:${i}`,
                                points: [point(segment.start), point(event.point!)] as [
                                  Point,
                                  Point,
                                ],
                              })),
                          )
                      : [],
                  )
                : [],
            ),
          ]
        : [],
    effects:
      perspective === 'omniscient'
        ? events.flatMap((event) => {
            if (!['launch', 'hit', 'projectile-deflect'].includes(event.kind)) return [];
            const position = event.point ? point(event.point) : undefined;
            return position
              ? [
                  {
                    id: event.id,
                    kind: event.kind,
                    position,
                    tint: tintOf(context, event.abilityId, event.actorId),
                  },
                ]
              : [];
          })
        : [],
  };
}
export type SceneModel = ReturnType<typeof buildSceneModel>;

/** Declared stage count of the recorded ability revision; null for legacy single-stage data. */
export function stageCount(actor: ReplayContext['actors'][number] | undefined, abilityId: string) {
  const ability = actor?.abilities.find((candidate) => candidate.id === abilityId);
  return ability?.kind === 'ability' ? (ability.definition.stages?.length ?? 1) : null;
}

/** The same 3D cone boundary is projected by both renderers; no visibility is inferred. */
export function visionRing(actor: SceneModel['actors'][number]): Point[] {
  if (!actor.vision) return [];
  const length = Math.hypot(...actor.facing) || 1;
  const f = actor.facing.map((n) => n / length) as Point;
  const horizontal = Math.hypot(f[0], f[2]);
  const u: Point = horizontal ? [-f[2] / horizontal, 0, f[0] / horizontal] : [1, 0, 0];
  const v: Point = [f[1] * u[2], f[2] * u[0] - f[0] * u[2], -f[1] * u[0]];
  const radius = actor.vision.range * Math.sin(actor.vision.angle / 2);
  const distance = actor.vision.range * Math.cos(actor.vision.angle / 2);
  return Array.from(
    { length: 49 },
    (_, i) =>
      f.map(
        (n, axis) =>
          n * distance +
          radius *
            (u[axis]! * Math.cos((i * Math.PI) / 24) + v[axis]! * Math.sin((i * Math.PI) / 24)),
      ) as Point,
  );
}
