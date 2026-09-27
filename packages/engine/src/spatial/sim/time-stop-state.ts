import {
  canonicalJson,
  type RevisionRef,
  type Effect,
  type DeferredEffect,
} from '@fantasy/domain/spatial/execution';
import type { ActorState, AbilityRevision, MotionState } from '../state.ts';
import type { PendingEffect } from '../state.ts';

export type StopRequest = {
  id: string;
  ownerId: string;
  targetId: string;
  ability: AbilityRevision;
  cause: string;
  at: number;
  duration: number;
};
type Geometry = Pick<MotionState, 'position' | 'facing' | 'velocity' | 'grounded' | 'vision'>;
export type CapturedEffect = Omit<PendingEffect, 'observation' | 'sourceAbility'> & {
  source?: RevisionRef;
  geometry?: { self: Geometry; target: Geometry };
};
export type StopState = {
  requests: StopRequest[];
  active?: StopRequest & { from: number; until: number };
  uses: number;
  reserved: number;
  executed: number;
  contacts: number;
  operations: number;
  bytes: number;
  pending: number[];
  templates: (Omit<CapturedEffect, 'effect' | 'deferral'> & {
    capture: Pick<DeferredEffect, 'controlId' | 'capturedAt' | 'deflection'>;
  })[];
  payloads: Effect[];
  descriptors: [number, number][];
};
export const emptyStopState = (): StopState => ({
  requests: [],
  uses: 0,
  reserved: 0,
  executed: 0,
  contacts: 0,
  operations: 0,
  bytes: 0,
  pending: [],
  templates: [],
  payloads: [],
  descriptors: [],
});
export const cloneStopState = (state: StopState): StopState => ({
  ...state,
  requests: [...state.requests],
  ...(state.active ? { active: { ...state.active } } : {}),
  pending: [...state.pending],
  templates: [...state.templates],
  payloads: [...state.payloads],
  descriptors: [...state.descriptors],
});

export function captureDescriptor(effect: PendingEffect): CapturedEffect {
  const { observation, sourceAbility, ...rest } = effect;
  const geometry = (motion: MotionState): Geometry => ({
    position: { ...motion.position },
    velocity: { ...motion.velocity },
    facing: { ...motion.facing },
    grounded: motion.grounded,
    ...(motion.vision ? { vision: { ...motion.vision } } : {}),
  });
  return {
    ...structuredClone(rest),
    ...(sourceAbility
      ? {
          source: {
            id: sourceAbility.id,
            revision: sourceAbility.revision,
            contentHash: sourceAbility.contentHash,
          },
        }
      : {}),
    ...(observation
      ? { geometry: { self: geometry(observation.self), target: geometry(observation.target) } }
      : {}),
  };
}
export function restoreDescriptor(
  descriptor: CapturedEffect,
  actors: readonly ActorState[],
): PendingEffect {
  const { source, geometry, ...rest } = descriptor;
  const owner = actors.find((a) => a.body.motion.actor.participant.actorId === rest.actorId)!;
  const target = actors.find((a) => a.body.motion.actor.participant.actorId === rest.targetId)!;
  const ability =
    source &&
    actors
      .flatMap((a) => a.body.motion.actor.abilities)
      .find(
        (a) =>
          a.id === source.id &&
          a.revision === source.revision &&
          a.contentHash === source.contentHash,
      );
  return {
    ...rest,
    ...(ability ? { sourceAbility: ability } : {}),
    ...(geometry
      ? {
          observation: {
            self: { ...owner.body.motion, ...geometry.self },
            target: { ...target.body.motion, ...geometry.target },
          },
        }
      : {}),
  };
}

/** Store each contact snapshot and immutable payload once; operations are bounded ordinal pairs. */
export function appendStopDescriptors(stop: StopState, captured: CapturedEffect[]) {
  const templates = [...stop.templates],
    payloads = [...stop.payloads],
    descriptors = [...stop.descriptors];
  const templateKeys = templates.map(canonicalJson),
    payloadKeys = payloads.map(canonicalJson);
  const pending = [...stop.pending];
  for (const { effect: _effect, deferral, ...common } of captured) {
    if (!deferral) throw new Error('Missing capture receipt');
    const template = {
      ...common,
      capture: {
        controlId: deferral.controlId,
        capturedAt: deferral.capturedAt,
        ...(deferral.deflection ? { deflection: deferral.deflection } : {}),
      },
    };
    const templateKey = canonicalJson(template),
      payloadKey = canonicalJson(deferral.effect);
    let contact = templateKeys.indexOf(templateKey),
      payload = payloadKeys.indexOf(payloadKey);
    if (contact < 0) {
      contact = templates.length;
      templates.push(template);
      templateKeys.push(templateKey);
    }
    if (payload < 0) {
      payload = payloads.length;
      payloads.push(deferral.effect);
      payloadKeys.push(payloadKey);
    }
    pending.push(descriptors.length);
    descriptors.push([contact, payload]);
  }
  return {
    templates,
    payloads,
    descriptors,
    pending,
    bytes: new TextEncoder().encode(canonicalJson({ templates, payloads, descriptors })).byteLength,
  };
}
export function stopDescriptor(stop: StopState, ordinal: number): CapturedEffect {
  const [contact, payload] = stop.descriptors[ordinal]!,
    { capture, ...common } = stop.templates[contact!]!;
  const effect = stop.payloads[payload!]!;
  return {
    ...common,
    effect,
    deferral: {
      ...capture,
      id: `deferred.${ordinal}`,
      actorId: common.actorId!,
      targetId: common.targetId,
      abilityId: common.abilityId!,
      effect,
      ...(common.sourceActorId
        ? { sourceActorId: common.sourceActorId, sourceProjectileId: common.sourceProjectileId! }
        : {}),
    },
  };
}
