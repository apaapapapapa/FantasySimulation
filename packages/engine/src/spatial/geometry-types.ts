import type { Vec3 } from './math.ts';

export type Segment = { start: Vec3; end: Vec3; from: number; to: number };
export type Trace = Segment[];
export type Capsule = { radius: number; halfHeight: number };
export type Obstacle = {
  id: string;
  kind?: 'pillar';
  position: Vec3;
  halfExtents: Vec3;
  rotation?: { x: number; y: number; z: number; w: number };
  blocks: { movement: boolean; vision: boolean; attack: boolean };
};
export type Layer = keyof Obstacle['blocks'];
