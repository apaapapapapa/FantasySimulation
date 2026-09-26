import type {
  DeepReadonly,
  Barrier,
  StageContact,
  Stage,
  AttackVariant,
  SpatialObjectDisplay,
} from '@fantasy/domain/spatial/execution';
import type { AbilityRevision, DamageSnapshot } from '../state.ts';
import type { Obstacle } from '../geometry-types.ts';
import type { Vec3 } from '../math.ts';
import { objectGeometry } from '../world/object-geometry.ts';

type CommonObject = DamageSnapshot & {
  id: string;
  ownerId: string;
  ownerSlot: number;
  ordinal: number;
  ability: AbilityRevision;
  actionId: string;
  stage?: StageContact;
  hit?: DeepReadonly<Stage['hit']>;
  cause: string;
  launchStep: number;
  activeFrom: number;
  endStep: number;
  active: boolean;
  position: Vec3;
};
export type SpatialObject = CommonObject &
  (
    | { kind: 'barrier'; spec: DeepReadonly<Barrier>; durability: number; offset: Vec3 }
    | { kind: 'area'; spec: DeepReadonly<AttackVariant<'area'>> }
    | {
        kind: 'beam';
        spec: DeepReadonly<AttackVariant<'beam'>>;
        direction: Vec3;
        offset: Vec3;
        geometry?: SpatialObjectDisplay['geometry'];
      }
  );
export function barrierObstacle(object: Extract<SpatialObject, { kind: 'barrier' }>): Obstacle {
  return {
    ...objectGeometry(object.id, object.spec.shape, object.position),
    ownerId: object.ownerId,
    material: 'energy',
    order: object.ownerSlot * 100000 + object.ordinal,
    blocks: {
      movement: object.spec.blocks.movement !== 'none',
      vision: object.spec.blocks.vision !== 'none',
      attack: object.spec.blocks.attack !== 'none',
    },
    selectors: object.spec.blocks,
  };
}
export function displaySpatialObject(object: SpatialObject): SpatialObjectDisplay {
  return {
    id: object.id,
    kind: object.kind,
    ownerId: object.ownerId,
    abilityId: object.ability.id,
    cause: object.cause,
    launchStep: object.launchStep,
    activeFrom: object.activeFrom,
    endStep: object.endStep,
    position: { ...object.position },
    attachment:
      object.kind === 'area' ? 'fixed' : object.kind === 'beam' ? 'follow' : object.spec.attachment,
    ...(object.stage ? { stage: { ...object.stage } } : {}),
    ...(object.kind === 'beam'
      ? {
          direction: { ...object.direction },
          radiusMm: object.spec.radiusMm,
          ...(object.geometry ? { geometry: object.geometry } : {}),
        }
      : { shape: structuredClone(object.spec.shape) }),
    ...(object.kind === 'barrier'
      ? {
          durability: object.durability,
          maxDurability: object.spec.durability,
          blocks: { ...object.spec.blocks },
        }
      : {}),
  };
}
