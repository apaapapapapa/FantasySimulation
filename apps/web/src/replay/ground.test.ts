import { expect, it } from 'vite-plus/test';
import { groundBelow } from './ground.ts';
import type { Point, SceneModel } from './scene-model.ts';

type Obstacle = SceneModel['obstacles'][number];
const box = (position: Point, size: Point, yawDegrees = 0, slopeDegrees = 0): Obstacle => ({
  id: 'box',
  kind: 'box',
  position,
  size,
  rotation: [0, (yawDegrees * Math.PI) / 180, (slopeDegrees * Math.PI) / 180],
  topWidth: size[0],
  colour: '#526174',
  material: 'generic',
  solid: true,
});
const pillar = (position: Point, radius: number, height: number): Obstacle => ({
  id: 'pillar',
  kind: 'cylinder',
  position,
  radius,
  height,
  colour: '#526174',
  material: 'stone',
  solid: true,
});
const floor = box([0, -0.5, 0], [100, 1, 100]);

it('finds the highest recorded surface below a point and ignores terrain above it', () => {
  expect(groundBelow([], [0, 5, 0], -1)).toBe(-1);
  expect(groundBelow([floor], [3, 5, -2], -1)).toBeCloseTo(0, 9);
  const ceiling = box([0, 4.6, 0], [10, 0.4, 10]);
  expect(groundBelow([floor, ceiling], [0, 0.002, 0], -1)).toBeCloseTo(0, 9);
  const post = pillar([0, 1.5, 0], 1.2, 3);
  expect(groundBelow([floor, post], [0.5, 3.002, 0], -1)).toBeCloseTo(3, 9);
  expect(groundBelow([floor, post], [2, 3.002, 0], -1)).toBeCloseTo(0, 9);
});

it('counts a body standing on an edge by its radius', () => {
  const post = pillar([0, 1.5, 0], 1.2, 3);
  expect(groundBelow([floor, post], [1.4, 3.002, 0], -1)).toBeCloseTo(0, 9);
  expect(groundBelow([floor, post], [1.4, 3.002, 0], -1, 0.3)).toBeCloseTo(3, 9);
  const step = box([0, 0.5, 0], [2, 1, 2]);
  expect(groundBelow([floor, step], [1.2, 1.002, 0], -1)).toBeCloseTo(0, 9);
  expect(groundBelow([floor, step], [1.2, 1.002, 0], -1, 0.3)).toBeCloseTo(1, 9);
});

it('follows yawed and sloped boxes like the renderers rotate them', () => {
  // A 2 m square turned 45° reaches √2 m along the x axis.
  const turned = box([0, 0.5, 0], [2, 1, 2], 45);
  expect(groundBelow([floor, turned], [1.35, 1.5, 0], -1)).toBeCloseTo(1, 9);
  expect(groundBelow([floor, turned], [0.9, 1.5, 0.9], -1)).toBeCloseTo(0, 9);
  // A ramp tilted about z rises along x by tan(slope) per metre from its centre.
  const ramp = box([0, 0, 0], [6, 0.2, 2], 0, 10);
  const expected = 0.1 / Math.cos((10 * Math.PI) / 180) + Math.tan((10 * Math.PI) / 180);
  expect(groundBelow([floor, ramp], [1, 3, 0], -1)).toBeCloseTo(expected, 6);
});
