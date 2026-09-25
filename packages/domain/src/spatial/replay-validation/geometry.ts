import { matchAttack, type AttackHandlers, type AttackVariant } from '../variants.ts';
import type { AttackGeometry } from '../stream.ts';
import { fail, requireReplay, same } from './common.ts';

const unavailable = (_shape: AttackVariant, geometry: AttackGeometry) =>
  fail(geometry.kind === 'blade' ? 'blade shape' : 'stage geometry shape');
function linear(
  shape: AttackVariant<'melee' | 'hitscan'>,
  geometry: AttackGeometry,
  kind: 'sphere' | 'ray',
) {
  if (geometry.kind === 'blade') return fail('blade shape');
  requireReplay(
    geometry.kind === kind && geometry.radiusMm === shape.radiusMm,
    'stage geometry shape',
  );
  for (let i = 1; i < geometry.segments.length; i++) {
    const previous = geometry.segments[i - 1]!,
      current = geometry.segments[i]!;
    requireReplay(
      Math.abs(previous.to - current.from) <= 1e-12 && same(previous.end, current.start),
      'stage geometry continuity',
    );
  }
}
function blade(shape: AttackVariant<'arc' | 'radial'>, geometry: AttackGeometry) {
  if (geometry.kind !== 'blade') return fail('stage geometry shape');
  requireReplay(
    geometry.radiusMm === shape.bladeRadiusMm && geometry.poses[0]!.fraction === 0,
    'blade radius/start',
  );
  for (const [i, pose] of geometry.poses.entries())
    requireReplay(
      pose.root.y === pose.tip.y &&
        Math.abs(
          Math.sqrt((pose.tip.x - pose.root.x) ** 2 + (pose.tip.z - pose.root.z) ** 2) -
            shape.reachMm / 1000,
        ) < 1e-6 &&
        (i === 0 || pose.fraction > geometry.poses[i - 1]!.fraction),
      'blade length/time',
    );
}
const geometryHandlers: AttackHandlers<AttackGeometry, void> = {
  direct: unavailable,
  projectile: unavailable, // Detached projectiles have their own recorded display contract.
  melee: (shape, geometry) => linear(shape, geometry, 'sphere'),
  hitscan: (shape, geometry) => linear(shape, geometry, 'ray'),
  arc: blade,
  radial: blade,
};
export function validateGeometry(shape: AttackVariant | null, geometry: AttackGeometry) {
  if (!shape) return fail(geometry.kind === 'blade' ? 'blade shape' : 'stage geometry shape');
  matchAttack(shape, geometryHandlers, geometry);
}
