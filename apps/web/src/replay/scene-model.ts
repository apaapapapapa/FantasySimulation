import type {
  AttackGeometry,
  BattleEvent,
  ReplayCheckpoint,
  ReplayContext,
  StreamRecord,
} from '@fantasy/domain/spatial';

export type Point = [number, number, number];
type Shape = { id: string; kind: AttackGeometry['kind']; radius: number; points: [Point, Point] };
const point = (v: { x: number; y: number; z: number }): Point => [v.x, v.y, v.z];
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
  const actors = (checkpoint.state?.actors ?? []).map((actor, index) => {
    const definition = context.actors.find((a) => a.participant.actorId === actor.id)?.character;
    if (!definition) throw new Error('Missing recorded character');
    const body = actor.posture?.body ?? definition.body;
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
    };
  });
  const paths = records.flatMap((record) =>
    record.kind === 'interval'
      ? record.paths.flatMap((path) =>
          path.segments.map((segment, i) => ({
            id: `${record.toStep}:${path.entityId}:${i}`,
            entityId: path.entityId,
            points: [point(segment.start), point(segment.end)] as [Point, Point],
          })),
        )
      : [],
  );
  const shapes = (checkpoint.state?.actors ?? [])
    .flatMap((actor) => [
      ...(actor.action?.stage?.geometry
        ? [{ id: `${actor.id}:stage`, geometry: actor.action.stage.geometry }]
        : []),
      ...(actor.reactions ?? []).flatMap((reaction, i) =>
        reaction.geometry ? [{ id: `${actor.id}:reaction:${i}`, geometry: reaction.geometry }] : [],
      ),
    ])
    .flatMap<Shape>(({ id, geometry }: { id: string; geometry: AttackGeometry }) =>
      geometry.kind === 'blade'
        ? geometry.poses.map((pose, i) => ({
            id: `${id}:${i}`,
            kind: geometry.kind,
            radius: geometry.radiusMm / 1000,
            points: [point(pose.root), point(pose.tip)] as [Point, Point],
          }))
        : geometry.segments.map((segment, i) => ({
            id: `${id}:${i}`,
            kind: geometry.kind,
            radius: geometry.radiusMm / 1000,
            points: [point(segment.start), point(segment.end)] as [Point, Point],
          })),
    );
  const hits = events.flatMap((e) =>
    e.kind === 'hit' && e.point ? [{ id: e.id, position: point(e.point) }] : [],
  );
  return {
    min,
    max,
    centre,
    span: Math.max(...max.map((n, i) => n - min[i]!)),
    follow: actors[0]?.position ?? centre,
    obstacles: scenario.definition.obstacles.map((obstacle) => {
      const common = {
        id: obstacle.id,
        position: metres(obstacle.center),
        colour: obstacle.blocks.movement ? '#526174' : '#364358',
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
    projectiles: (checkpoint.state?.projectiles ?? []).map((p) => ({
      id: p.id,
      position: point(p.position),
      radius: p.radiusMm / 1000,
    })),
    paths,
    shapes,
    events: hits,
    rays: [
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
                          points: [point(segment.start), point(event.point!)] as [Point, Point],
                        })),
                    )
                : [],
            )
          : [],
      ),
    ],
    effects: events.flatMap((event) => {
      if (!['launch', 'hit'].includes(event.kind)) return [];
      const position = event.point ? point(event.point) : undefined;
      return position ? [{ id: event.id, kind: event.kind, position }] : [];
    }),
  };
}
export type SceneModel = ReturnType<typeof buildSceneModel>;

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
