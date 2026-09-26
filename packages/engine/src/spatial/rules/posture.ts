import type { MotionState } from '../state.ts';
export type { PostureState } from '../state.ts';
import type { DeepReadonly, Definition, Posture } from '@fantasy/domain/spatial/execution';
import { capsuleShape, firstContact, straight, type SpatialWorld } from '../world/physics.ts';
import { bodyCapsule } from '../world/terrain.ts';
import { abilityCategories } from './categories.ts';

export function postureBody(self: MotionState, posture: Posture) {
  return posture === 'standing'
    ? (self.posture?.standingBody ?? self.actor.character.body)
    : self.actor.character.postures?.[posture]?.body;
}
export const postureDuration = (self: MotionState, posture: Posture) =>
  Math.max(
    posture === 'standing' ? 0 : (self.actor.character.postures?.[posture]?.transitionSteps ?? 0),
    self.posture?.current && self.posture.current !== 'standing'
      ? (self.actor.character.postures?.[self.posture.current]?.transitionSteps ?? 0)
      : 0,
  );
export const postureRequiresWalk = (self: MotionState) =>
  (self.posture?.current ?? 'standing') !== 'standing' ||
  (self.posture?.transition?.to ?? 'standing') !== 'standing';
export const postureSpeed = (self: MotionState) =>
  Math.min(
    !self.posture || self.posture.current === 'standing'
      ? 10000
      : (self.actor.character.postures?.[self.posture.current]?.speedBps ?? 10000),
    !self.posture?.transition || self.posture.transition.to === 'standing'
      ? 10000
      : (self.actor.character.postures?.[self.posture.transition.to]?.speedBps ?? 10000),
  );
export function postureAllows(self: MotionState, ability: DeepReadonly<Definition<'ability'>>) {
  if (self.posture?.current !== 'prone' && self.posture?.transition?.to !== 'prone') return true;
  const attacks = [
    ability.attack,
    ...(ability.stages?.flatMap((s) => (s.attack ? [s.attack] : [])) ?? []),
  ];
  if (
    attacks.some((a) => ['melee', 'arc'].includes(a.kind)) ||
    ability.stages?.some((s) => s.selfMotion)
  )
    return false;
  return (
    abilityCategories(ability).includes('magic') ||
    attacks.every((a) => a.kind === 'projectile' || a.kind === 'hitscan')
  );
}
export function posturePosition(
  self: MotionState,
  body: DeepReadonly<Definition<'character'>['body']>,
) {
  return {
    ...self.position,
    y: self.position.y + (body.heightMm - self.actor.character.body.heightMm) / 2000,
  };
}
/** Atomic at a physical boundary; increasing height checks headroom and the other body. */
export function advancePosture(
  self: MotionState,
  requested: Posture | undefined,
  step: number,
  world: SpatialWorld,
  others: readonly MotionState[],
  holdUntil?: number,
): MotionState {
  if (!self.posture || !self.grounded) return self;
  const state = { ...self.posture };
  if (holdUntil !== undefined) state.holdUntil = Math.max(state.holdUntil ?? 0, holdUntil);
  if (state.transition && step >= state.transition.completeAt) {
    const body = postureBody(self, state.transition.to)!;
    const position = posturePosition(self, body),
      shape = capsuleShape(bodyCapsule(body));
    const blocked =
      world.forQuery({ ownerId: self.actor.participant.actorId }).overlaps(position, shape) ||
      others.some(
        (other) =>
          other.actor.participant.actorId !== self.actor.participant.actorId &&
          firstContact(
            straight(position, position),
            shape,
            straight(other.position, other.position),
            capsuleShape(bodyCapsule(other.actor.character.body)),
            0,
            true,
          ) !== undefined,
      );
    if (!blocked) {
      state.current = state.transition.to;
      self = {
        ...self,
        position,
        actor: { ...self.actor, character: { ...self.actor.character, body } },
      };
    }
    delete state.transition;
  }
  if (
    requested &&
    !(requested === 'standing' && step < (state.holdUntil ?? 0)) &&
    !state.transition &&
    requested !== state.current &&
    postureBody(self, requested)
  )
    state.transition = {
      to: requested,
      completeAt: step + postureDuration({ ...self, posture: state }, requested),
    };
  return { ...self, posture: state };
}
