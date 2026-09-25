import type { ReplayCheckpoint, ReplayContext } from '@fantasy/domain/spatial';

export type Point = [number, number, number];
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
export function buildSceneModel(context: ReplayContext, checkpoint: ReplayCheckpoint) {
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
    const radius = definition.body.radiusMm / 1000;
    return {
      id: actor.id,
      position: point(actor.position),
      facing: point(actor.facing),
      radius,
      length: Math.max(0, definition.body.heightMm / 1000 - 2 * radius),
      colour: definition.appearance
        ? colours[definition.appearance.surface]
        : index === 0
          ? '#d4b780'
          : '#68b7db',
    };
  });
  const record = checkpoint.lastRecord;
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
    paths:
      record?.kind === 'interval'
        ? record.paths.flatMap((path) =>
            path.segments.map((segment, i) => ({
              id: `${path.entityId}:${i}`,
              points: [point(segment.start), point(segment.end)] as [Point, Point],
            })),
          )
        : [],
    events:
      record && 'events' in record
        ? record.events.flatMap((e) => (e.point ? [{ id: e.id, position: point(e.point) }] : []))
        : [],
  };
}
export type SceneModel = ReturnType<typeof buildSceneModel>;
