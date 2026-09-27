import { describe, expect, it } from 'vite-plus/test';
import { PerspectiveCamera, Vector3 } from 'three';
import { FOV_DEGREES, frameCamera, type FramedMode } from './camera-frame.ts';
import type { Point } from './scene-model.ts';

const body = (x: number, z: number, feet = 0, standingHeight = 1.8) => ({
  position: [x, feet + standingHeight / 2, z] as Point,
  feet,
  standingHeight,
});
/** Projects with an independent Three camera placed where the framing says. */
function view(mode: FramedMode, bodies: ReturnType<typeof body>[], aspect: number) {
  const framing = frameCamera(mode, bodies, aspect);
  const camera = new PerspectiveCamera(FOV_DEGREES, aspect, 0.05, 2000);
  camera.position.set(...framing.position);
  camera.lookAt(...framing.target);
  camera.updateMatrixWorld();
  const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const project = (p: Point, height = 0) =>
    new Vector3(...p).addScaledVector(up, height).project(camera);
  return { framing, camera, project };
}

describe('camera framing', () => {
  it.each([
    ['overview', 16 / 9],
    ['side', 16 / 9],
    ['overview', 390 / 360],
    ['side', 2.4],
  ] as const)(
    'keeps both fighters, sprites and plates inside the %s view (aspect %d)',
    (mode, aspect) => {
      for (const bodies of [
        [body(-6, 0), body(6, 0)],
        [body(-20, 8), body(15, -12, 5)],
        [body(0.4, 0.2), body(-0.3, 0)],
      ]) {
        const { project } = view(mode, bodies, aspect);
        for (const b of bodies)
          for (const height of [0, b.standingHeight * 1.4]) {
            const ndc = project([b.position[0], b.feet, b.position[2]], height);
            expect(Math.abs(ndc.x)).toBeLessThan(1);
            expect(Math.abs(ndc.y)).toBeLessThan(1);
            expect(ndc.z).toBeLessThan(1);
          }
      }
    },
  );
  it('widens with the recorded spread and keeps a minimum when fighters are close', () => {
    const distance = (bodies: ReturnType<typeof body>[]) => {
      const { framing } = view('overview', bodies, 16 / 9);
      return new Vector3(...framing.position).distanceTo(new Vector3(...framing.target));
    };
    const near = distance([body(-1, 0), body(1, 0)]);
    expect(distance([body(-0.2, 0), body(0.2, 0)])).toBeCloseTo(near, 6);
    expect(distance([body(-20, 0), body(20, 0)])).toBeGreaterThan(near * 2);
  });
  it('looks down steeply in the overview, low from the side, and follows the first body', () => {
    const bodies = [body(-6, 0), body(6, 0)];
    const pitch = (mode: FramedMode) => {
      const { framing } = view(mode, bodies, 16 / 9);
      const d = new Vector3(...framing.position).sub(new Vector3(...framing.target));
      return (Math.asin(d.y / d.length()) * 180) / Math.PI;
    };
    expect(pitch('overview')).toBeGreaterThan(45);
    expect(pitch('side')).toBeLessThan(20);
    const follow = frameCamera('follow', bodies, 16 / 9);
    expect(follow.target).toEqual(bodies[0]!.position);
    expect(new Vector3(...follow.position).distanceTo(new Vector3(...follow.target))).toBeCloseTo(
      10,
      6,
    );
  });
});
