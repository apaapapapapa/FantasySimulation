import type { Vec3 } from './math.ts';

export type Segment = { start: Vec3; end: Vec3; from: number; to: number };
export type Trace = Segment[];
export type Capsule = { radius: number; halfHeight: number };
export type SpatialQuery = { ownerId?: string; ignoreObjectId?: string };
export type BlockSelector = 'none' | 'owner' | 'enemy' | 'both';
export type Obstacle = {
  id: string;
  kind?: 'pillar' | 'sphere';
  order?: number;
  position: Vec3;
  halfExtents: Vec3;
  rotation?: { x: number; y: number; z: number; w: number };
  blocks: { movement: boolean; vision: boolean; attack: boolean };
  ownerId?: string;
  selectors?: Record<Layer, BlockSelector>;
};
export type Layer = keyof Obstacle['blocks'];

/** The querying actor/attack owner is independent of the source power snapshot. */
export function blocksQuery(obstacle: Obstacle, layer: Layer, query: SpatialQuery): boolean {
  if (obstacle.id === query.ignoreObjectId || !obstacle.blocks[layer]) return false;
  const selector = obstacle.selectors?.[layer];
  return (
    selector === undefined ||
    selector === 'both' ||
    (selector === 'owner' && query.ownerId === obstacle.ownerId) ||
    (selector === 'enemy' && query.ownerId !== undefined && query.ownerId !== obstacle.ownerId)
  );
}
