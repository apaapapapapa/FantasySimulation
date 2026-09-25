import { actionActiveUntil, attackActiveSteps } from '@fantasy/domain/spatial/execution';
import type { ResolvedActor, ActorState } from '../state.ts';
export type { AbilityRevision, ActionState, ActorState, MeleeState } from '../state.ts';
import { type ActorDisplay } from '@fantasy/domain/spatial/execution';
import { initialMotion } from '../world/movement.ts';
import { emptyMemory } from '../ai/perception.ts';
import { initialDecisionRandom } from '../ai/decision-random.ts';
import type { SpatialWorld } from '../world/physics.ts';
import { initialResources } from '../rules/resources.ts';
import { stageDisplay } from '../rules/stages.ts';

export function initialActor(world: SpatialWorld, actor: ResolvedActor): ActorState {
  return {
    body: {
      motion: initialMotion(world, actor),
      ...(actor.character.stamina
        ? { locomotion: { mode: 'idle' as const, jumping: false, dodging: false } }
        : {}),
      intent: {
        direction: { x: 0, y: 0, z: 0 },
        facing: actor.participant.facing,
        jump: false,
        flight: false,
        canMove: true,
        speedBps: 10000,
      },
    },
    vitals: {
      resources: initialResources(actor.character),
      ...(actor.character.stamina ? { staminaClock: { remainder: 0, exhausted: false } } : {}),
    },
    statuses: [],
    mind: {
      memory: emptyMemory(),
      decision: { abilityId: null, goal: null, facing: actor.participant.facing },
      random: actor.participant.rngSeed,
      decisionRandom: initialDecisionRandom(actor.participant.rngSeed),
    },
    actions: { action: null, readyAt: 0, used: {}, cooldowns: {} },
  };
}
export const cloneActor = (state: ActorState): ActorState => ({
  ...state,
  body: {
    ...state.body,
    motion: {
      ...state.body.motion,
      position: { ...state.body.motion.position },
      velocity: { ...state.body.motion.velocity },
      facing: { ...state.body.motion.facing },
    },
    ...(state.body.motionClock ? { motionClock: { ...state.body.motionClock } } : {}),
    ...(state.body.locomotion ? { locomotion: { ...state.body.locomotion } } : {}),
    ...(state.body.forces ? { forces: structuredClone(state.body.forces) } : {}),
    ...(state.body.forceGravity ? { forceGravity: { ...state.body.forceGravity } } : {}),
    ...(state.body.forceDisplay !== undefined
      ? { forceDisplay: structuredClone(state.body.forceDisplay) }
      : {}),
    intent: { ...state.body.intent },
  },
  vitals: {
    ...state.vitals,
    resources: { ...state.vitals.resources },
    ...(state.vitals.staminaClock ? { staminaClock: { ...state.vitals.staminaClock } } : {}),
  },
  actions: {
    ...state.actions,
    ...(state.actions.reactions ? { reactions: structuredClone(state.actions.reactions) } : {}),
    used: { ...state.actions.used },
    cooldowns: { ...state.actions.cooldowns },
    action: state.actions.action
      ? {
          ...state.actions.action,
          ...(state.actions.action.stages ? { stages: { ...state.actions.action.stages } } : {}),
        }
      : null,
  },
  mind: { ...state.mind },
  statuses: state.statuses.map((status) => ({ ...status, causes: [...status.causes] })),
});
export function displayActor(state: ActorState, step: number): ActorDisplay {
  const { motion } = state.body;
  const { action } = state.actions;
  const stage = action ? stageDisplay(action, step) : undefined;
  const last = action?.ability.definition.stages?.at(-1);
  const active = action ? attackActiveSteps(action.ability.definition.attack) : 1;
  return {
    id: motion.actor.participant.actorId,
    position: { ...motion.position },
    velocity: { ...motion.velocity },
    facing: { ...motion.facing },
    grounded: motion.grounded,
    ...(motion.posture
      ? {
          posture: {
            current: motion.posture.current,
            body: structuredClone(motion.actor.character.body),
            ...(motion.posture.transition ? { transition: { ...motion.posture.transition } } : {}),
          },
        }
      : {}),
    ...(state.actions.reactions ? { reactions: structuredClone(state.actions.reactions) } : {}),
    ...(state.body.forceDisplay !== undefined
      ? { force: structuredClone(state.body.forceDisplay) }
      : {}),
    resources: { ...state.vitals.resources },
    ...(state.body.locomotion ? { locomotion: { ...state.body.locomotion } } : {}),
    statuses: state.statuses.map((s) => ({
      revision: {
        id: s.revision.id,
        revision: s.revision.revision,
        contentHash: s.revision.contentHash,
      },
      startStep: s.startStep,
      endStep: s.endStep,
      stacks: s.stacks,
      ...(s.flightStaminaPerSecond !== undefined && {
        flightStaminaPerSecond: s.flightStaminaPerSecond,
      }),
    })),
    action:
      action && step < action.recoveryUntil
        ? {
            id: action.id,
            abilityId: action.ability.id,
            startedAt: action.startedAt,
            launchAt: action.launchAt,
            recoveryUntil: action.recoveryUntil,
            ...(stage && last
              ? {
                  stage,
                  activeUntil: actionActiveUntil(action.launchAt, action.ability.definition),
                }
              : {}),
            phase:
              step < action.launchAt
                ? 'cast'
                : (
                      stage
                        ? stage.state === 'active'
                        : action.released && step < action.launchAt + active
                    )
                  ? 'active'
                  : 'recovery',
          }
        : null,
  };
}
/** Compact decision state, distinct from display checkpoints and a supported resume snapshot. */
export function decisionState(state: ActorState) {
  // Preserve the existing compact wire shape and TS-state digest after splitting runtime ownership.
  const { motion, statuses, action, ...rest } = {
    ...state.body,
    ...state.vitals,
    ...state.actions,
    ...state.mind,
    statuses: state.statuses,
  };
  return {
    ...rest,
    motion: { ...motion, actor: motion.actor.participant.actorId },
    statuses: statuses.map((s) => ({
      ...s,
      revision: {
        id: s.revision.id,
        revision: s.revision.revision,
        contentHash: s.revision.contentHash,
      },
    })),
    action: action
      ? {
          ...action,
          ability: {
            id: action.ability.id,
            revision: action.ability.revision,
            contentHash: action.ability.contentHash,
          },
        }
      : null,
  };
}
