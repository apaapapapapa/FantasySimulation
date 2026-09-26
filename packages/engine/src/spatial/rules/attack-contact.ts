import {
  type AttackHandlers,
  type AttackVariant,
  type AttackGeometry,
  type Budget,
  type DeepReadonly,
  type Definition,
} from '@fantasy/domain/spatial/execution';
import type { Trace } from '../geometry-types.ts';
import type { MotionState } from '../state.ts';
import { add, mul, type Vec3 } from '../math.ts';
import { clipTrace, straight, type SpatialWorld } from '../world/physics.ts';
import { bodyPoint } from '../world/visibility.ts';
import { hitscan, meleeTrace, traceAttack, type AttackContact } from './attacks.ts';
import { sweepBlade } from './blades.ts';

type ContactContext = {
  world: SpatialWorld;
  source: MotionState;
  target: MotionState;
  trace: Trace;
  targetTrace: Trace;
  direction: Vec3;
  offset: Vec3;
  rangeMm: number;
  elapsedSteps: number;
  stageDuration: number | undefined;
  staged: boolean;
  rules: DeepReadonly<Definition<'ruleset'>>;
  budget: Budget;
};
type ContactResult = {
  contact: AttackContact | null;
  blocking: AttackContact | null;
  geometry: AttackGeometry | null;
  activeSteps: number;
  maxHits: number;
};
function blade(shape: AttackVariant<'arc' | 'radial'>, c: ContactContext): ContactResult {
  if (c.stageDuration === undefined) throw new Error('Invalid attached stage');
  const result = sweepBlade(
    c.world,
    c.trace,
    c.offset,
    c.direction,
    shape,
    c.elapsedSteps,
    c.stageDuration,
    c.target,
    c.targetTrace,
    c.rules,
    c.budget,
  );
  return {
    contact: result.contact,
    blocking: result.wall,
    geometry: result.geometry,
    activeSteps: c.stageDuration,
    maxHits: 0,
  };
}
type ContactOperations = {
  [K in AttackVariant['kind']]: {
    attached: boolean;
    contact: AttackHandlers<ContactContext, ContactResult>[K];
  };
};
const contactHandlers: ContactOperations = {
  area: {
    attached: false,
    contact: () => {
      throw new Error('Area requires object contact scheduler');
    },
  },
  beam: {
    attached: false,
    contact: () => {
      throw new Error('Beam requires object contact scheduler');
    },
  },
  direct: {
    attached: false,
    contact: () => ({ contact: null, blocking: null, geometry: null, activeSteps: 1, maxHits: 0 }),
  },
  hitscan: {
    attached: false,
    contact: (shape, c) => {
      const contact = hitscan(
        c.world,
        c.source,
        c.target,
        c.direction,
        c.rangeMm / 1000,
        shape.radiusMm / 1000,
      );
      const origin = bodyPoint(c.source, c.source.actor.character.body.muzzleOffset);
      return {
        contact,
        blocking: null,
        activeSteps: 1,
        maxHits: 1,
        geometry: {
          kind: 'ray',
          radiusMm: shape.radiusMm,
          segments: straight(
            origin,
            contact?.point ?? add(origin, mul(c.direction, c.rangeMm / 1000)),
          ),
        },
      };
    },
  },
  projectile: {
    attached: false,
    contact: (shape, c) => ({
      contact: traceAttack(c.world, c.trace, shape.radiusMm / 1000, c.target, c.targetTrace),
      blocking: null,
      geometry: null,
      activeSteps: shape.lifetimeSteps,
      maxHits: shape.maxHitsPerTarget,
    }),
  },
  melee: {
    attached: true,
    contact: (shape, c) => {
      const trace = meleeTrace(
        c.trace,
        c.offset,
        c.direction,
        Math.min(shape.reachMm, c.rangeMm) / 1000,
        c.elapsedSteps,
        shape.activeSteps,
      );
      const blocking: { wall: AttackContact | null } = { wall: null };
      const contact = traceAttack(
        c.world,
        trace,
        shape.radiusMm / 1000,
        c.target,
        c.targetTrace,
        c.staged ? blocking : undefined,
      );
      return {
        contact,
        blocking: blocking.wall,
        activeSteps: shape.activeSteps,
        maxHits: shape.maxHitsPerTarget,
        geometry: {
          kind: 'sphere',
          radiusMm: shape.radiusMm,
          segments: blocking.wall ? clipTrace(trace, blocking.wall.time) : trace,
        },
      };
    },
  },
  arc: { attached: true, contact: blade },
  radial: { attached: true, contact: blade },
};
export const isAttachedAttack = (shape: AttackVariant) => contactHandlers[shape.kind].attached;
export function contactAttack<K extends AttackVariant['kind']>(
  shape: AttackVariant<K>,
  context: ContactContext,
) {
  return contactHandlers[shape.kind].contact(shape, context);
}
