import type { Phasing, SpatialMaterial, DeepReadonly } from '@fantasy/domain/spatial/execution';
import type { Vec3 } from './math.ts';

export type Segment = { start: Vec3; end: Vec3; from: number; to: number };
export type Trace = Segment[];
export type Capsule = { radius: number; halfHeight: number };
export type PhaseQuery = DeepReadonly<Phasing> & {
  layer: 'movement' | 'attack';
  minGroundY: number;
};
export type SpatialQuery = {
  ownerId?: string;
  ignoreObjectId?: string;
  departingObjectIds?: readonly string[];
  phase?: PhaseQuery;
};
export type BlockSelector = 'none' | 'owner' | 'enemy' | 'both';
export type Obstacle = {
  id: string;
  kind?: 'pillar' | 'sphere';
  order?: number;
  position: Vec3;
  halfExtents: Vec3;
  rotation?: { x: number; y: number; z: number; w: number };
  blocks: { movement: boolean; vision: boolean; attack: boolean };
  material?: SpatialMaterial;
  ownerId?: string;
  selectors?: Record<Layer, BlockSelector>;
};
export type Layer = keyof Obstacle['blocks'];

/** The querying actor/attack owner is independent of the source power snapshot. */
export function blocksQuery(
  obstacle: Obstacle,
  layer: Layer,
  query: SpatialQuery,
  normal?: Vec3,
  overlap = false,
): boolean {
  if (obstacle.id === query.ignoreObjectId || !obstacle.blocks[layer]) return false;
  const phase = query.phase;
  if (
    phase?.layer === layer &&
    !obstacle.id.startsWith('boundary.') &&
    phase.materials.includes(obstacle.material ?? 'generic') &&
    (overlap || phase.floor || (normal && normal.y < phase.minGroundY))
  )
    return false;
  const selector = obstacle.selectors?.[layer];
  return (
    selector === undefined ||
    selector === 'both' ||
    (selector === 'owner' && query.ownerId === obstacle.ownerId) ||
    (selector === 'enemy' && query.ownerId !== undefined && query.ownerId !== obstacle.ownerId)
  );
}
