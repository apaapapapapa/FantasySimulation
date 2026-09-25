import type { Definition, Revision } from '@fantasy/domain/spatial';
import { sealRevision } from '@fantasy/engine/spatial';

type Scenario = Definition<'scenario'>;
type Point = { x: number; y: number; z: number };
const solid = { movement: true, vision: true, attack: true };
function box(id: string, center: Point, halfExtents: Point): Scenario['obstacles'][number] {
  return {
    kind: 'box',
    id,
    center,
    halfExtents,
    yawMilliDegrees: 0,
    slopeMilliDegrees: 0,
    blocks: solid,
  };
}
function route(points: Point[], prefix: string, headroomMm = 12000): Scenario['navigation'] {
  return {
    version: 'support-graph-v1',
    nodes: points.map((position, i) => ({ id: `${prefix}-${i}`, position, mode: 'ground' })),
    edges: points.slice(1).map((_, i) => ({
      from: `${prefix}-${i}`,
      to: `${prefix}-${i + 1}`,
      mode: 'walk',
      widthMm: 1800,
      headroomMm,
      bidirectional: true,
    })),
  };
}

/** Symmetric starts are part of the league input, not a change to historical scenarios. */
export function leagueStarts(scenario: string) {
  const y = scenario === 'aerial-surveyed-v1' ? 8902 : 902;
  // Keep the symmetric pillar starts in mutual sight, avoiding a blind opening stalemate.
  const z = scenario === 'pillars-surveyed-v1' ? 2200 : 0;
  return [
    { position: { x: -6000, y, z }, facing: { x: 1, y: 0, z: 0 } },
    { position: { x: 6000, y, z }, facing: { x: -1, y: 0, z: 0 } },
  ] as const;
}

export async function addLeagueTerrain(revisions: Revision[], flat: Scenario) {
  const elevation: Scenario = structuredClone(flat);
  elevation.name = '対称の高台・階段と斜面';
  elevation.navigation = { version: 'support-graph-v1', nodes: [], edges: [] };
  for (const side of [-1, 1]) {
    const z = side * 5500;
    elevation.obstacles.push(
      box(`terrace-${side}`, { x: 0, y: 750, z }, { x: 2000, y: 750, z: 2000 }),
    );
    // 250 mm risers are below the standard 300 mm step capability.
    const points: Point[] = [{ x: side * -8350, y: 902, z }];
    for (let i = 0; i < 6; i++) {
      const x = -8000 + i * 1000,
        top = (i + 1) * 250;
      elevation.obstacles.push(
        box(
          `stair-${side}-${i}`,
          { x: side * (x + 500), y: top / 2, z },
          { x: 500, y: top / 2, z: 1500 },
        ),
      );
      points.push(
        { x: side * (x + 340), y: top + 902, z },
        { x: side * (x + 660), y: top + 902, z },
      );
    }
    points.push({ x: 0, y: 2402, z });
    const stairs = route(points, `stairs-${side}`);
    elevation.navigation.nodes.push(...stairs.nodes);
    elevation.navigation.edges.push(...stairs.edges);
    const ramp = box(`ramp-${side}`, { x: side * 4900, y: 650, z }, { x: 3000, y: 100, z: 1500 });
    if (ramp.kind === 'box') ramp.slopeMilliDegrees = side * -14000;
    elevation.obstacles.push(ramp);
  }

  const indoor: Scenario = structuredClone(flat);
  indoor.name = '天井のある回廊と四つの部屋';
  indoor.bounds = { min: { x: -12000, y: -1000, z: -8000 }, max: { x: 12000, y: 6000, z: 8000 } };
  indoor.obstacles.push(box('ceiling', { x: 0, y: 4700, z: 0 }, { x: 12000, y: 200, z: 8000 }));
  for (const sign of [-1, 1]) {
    indoor.obstacles.push(
      box(`end-wall-${sign}`, { x: sign * 11800, y: 2250, z: 0 }, { x: 200, y: 2250, z: 8000 }),
      box(`side-wall-${sign}`, { x: 0, y: 2250, z: sign * 7800 }, { x: 12000, y: 2250, z: 200 }),
    );
    for (const room of [-1, 1])
      indoor.obstacles.push(
        box(
          `room-${sign}-${room}`,
          { x: sign * 7000, y: 2250, z: room * 2500 },
          { x: 4500, y: 2250, z: 200 },
        ),
      );
  }
  indoor.navigation = route(
    [
      { x: -6000, y: 902, z: 0 },
      { x: 0, y: 902, z: 0 },
      { x: 6000, y: 902, z: 0 },
    ],
    'hall',
    4500,
  );
  for (const side of [-1, 1]) {
    const rooms = route(
      [
        { x: -6000, y: 902, z: side * 5000 },
        { x: 0, y: 902, z: side * 5000 },
        { x: 0, y: 902, z: side * 1000 },
        { x: 6000, y: 902, z: side * 5000 },
      ],
      `rooms-${side}`,
      4500,
    );
    rooms.edges[2]!.from = rooms.nodes[1]!.id;
    indoor.navigation.nodes.push(...rooms.nodes);
    indoor.navigation.edges.push(...rooms.edges);
  }

  const aerial: Scenario = structuredClone(flat);
  aerial.name = '高所の足場と細い橋・開けた空';
  aerial.obstacles.push(box('bridge', { x: 0, y: 7800, z: 0 }, { x: 3000, y: 200, z: 900 }));
  for (const sign of [-1, 1])
    aerial.obstacles.push(
      box(`platform-${sign}`, { x: sign * 6000, y: 7800, z: 0 }, { x: 3000, y: 200, z: 3000 }),
    );
  aerial.navigation = route(
    [
      { x: -6000, y: 8902, z: 0 },
      { x: 0, y: 8902, z: 0 },
      { x: 6000, y: 8902, z: 0 },
    ],
    'bridge',
  );
  for (const [id, definition] of [
    ['elevation-surveyed-v1', elevation],
    ['indoor-surveyed-v1', indoor],
    ['aerial-surveyed-v1', aerial],
  ] as const)
    revisions.push(await sealRevision('scenario', id, 1, definition));
}
