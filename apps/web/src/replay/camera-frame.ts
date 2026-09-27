import type { Point } from './scene-model.ts';

export type FramedMode = 'overview' | 'side' | 'follow';
export type Framing = { target: Point; position: Point };
type Body = { position: Point; feet: number; standingHeight: number };

/** Vertical field of view shared by the camera and the framing maths. */
export const FOV_DEGREES = 32;
const VIEWS: Record<FramedMode, { yaw: number; pitch: number }> = {
  // High quarter view from the +z side, so the recorded left/right sides read left to right.
  overview: { yaw: 0, pitch: (52 * Math.PI) / 180 },
  side: { yaw: 0, pitch: (12 * Math.PI) / 180 },
  follow: { yaw: 0, pitch: (40 * Math.PI) / 180 },
};
/** Sprites stand full height on screen; this much of the body height above the feet is kept
 * in view for the sprite frame and its name plate. */
const SPRITE_TOP = 1.45;
/** Half the sprite frame's width per metre of standing height (48-px frame, 33-px figure). */
const SPRITE_HALF_WIDTH = 0.73;
const MARGIN = { width: 1.3, height: 1.2 };
const MINIMUM = { width: 6.5, height: 3.6 };
/** Follow mode stays this close unless the followed sprite needs more room. */
const FOLLOW_DISTANCE = 10;
const FOLLOW_MARGIN = { width: 0.4, height: 0.4 };
const TAN = Math.tan((FOV_DEGREES * Math.PI) / 360);
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Camera placement that keeps every recorded body, its sprite and name plate in view with a
 * margin. Only display state is read; framing never changes what is shown as recorded.
 */
export function frameCamera(mode: FramedMode, bodies: readonly Body[], aspect: number): Framing {
  const { yaw, pitch } = VIEWS[mode];
  // Direction from the target back to the camera, and the camera's screen axes.
  const back: Point = [
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    Math.cos(yaw) * Math.cos(pitch),
  ];
  const right: Point = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up: Point = [
    -Math.sin(yaw) * Math.sin(pitch),
    Math.cos(pitch),
    -Math.cos(yaw) * Math.sin(pitch),
  ];
  const place = (target: Point, distance: number): Framing => ({
    target,
    position: target.map((n, i) => n + back[i]! * distance) as Point,
  });
  if (!bodies.length) return place([0, 0, 0], MINIMUM.height / TAN);
  // Sprites stand full height on screen: each body spans feet → feet + camera-up · top.
  const spans = bodies.map((b) => {
    const feet: Point = [b.position[0], b.feet, b.position[2]];
    return {
      feet,
      x: dot(feet, right),
      y: dot(feet, up),
      top: b.standingHeight * SPRITE_TOP,
      half: b.standingHeight * SPRITE_HALF_WIDTH,
    };
  });
  const tanWidth = TAN * Math.max(0.1, aspect);
  // Perspective-exact: each sprite constrains the distance by its own depth and size.
  const fit = (target: Point, framed: typeof spans, margin: typeof MARGIN, minimum: number) =>
    framed.reduce((distance, span) => {
      const q = span.feet.map((n, i) => n - target[i]!) as Point;
      const depth = dot(q, back),
        x = dot(q, right),
        y = dot(q, up);
      return Math.max(
        distance,
        depth + (Math.abs(x) + span.half + margin.width) / tanWidth,
        depth + (Math.max(Math.abs(y), Math.abs(y + span.top)) + margin.height) / TAN,
      );
    }, minimum);
  if (mode === 'follow') {
    const followed = bodies[0]!.position;
    return place(followed, fit(followed, spans.slice(0, 1), FOLLOW_MARGIN, FOLLOW_DISTANCE));
  }
  const left = Math.min(...spans.map((s) => s.x)),
    rightmost = Math.max(...spans.map((s) => s.x));
  const bottom = Math.min(...spans.map((s) => s.y)),
    top = Math.max(...spans.map((s) => s.y + s.top));
  // Centre the screen-space box; the depth along `back` is kept from the first body.
  const anchor = spans[0]!.feet;
  const target = anchor.map(
    (n, i) =>
      n +
      right[i]! * ((left + rightmost) / 2 - spans[0]!.x) +
      up[i]! * ((bottom + top) / 2 - spans[0]!.y),
  ) as Point;
  const minimum = Math.max(MINIMUM.height / TAN, MINIMUM.width / tanWidth);
  return place(target, fit(target, spans, MARGIN, minimum));
}
