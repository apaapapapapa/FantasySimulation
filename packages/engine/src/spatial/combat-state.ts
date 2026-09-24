import {
  type ActorDisplay,
  type DeepReadonly,
  type ResourceState,
  type Revision,
  type StageContact,
  type Stage,
  type ForceContribution,
  type ReactionDisplay,
} from '@fantasy/domain/spatial';
import { initialMotion, type MotionIntent, type MotionState } from './movement.ts';
import { emptyMemory, type PerceptionMemory } from './perception.ts';
import type { Decision } from './policy.ts';
import type { StatusCohort } from './status.ts';
import type { Vec3 } from './math.ts';
import { initialDecisionRandom, type DecisionRandom } from './decision-random.ts';
import type { DamageSnapshot } from './status-damage.ts';
import type { SpatialWorld } from './physics.ts';
import type { ResolvedActor } from './prepare.ts';
import { initialResources } from './resources.ts';
import { stageDisplay, type StageRuntime } from './stages.ts';
export type AbilityRevision = DeepReadonly<Extract<Revision, { kind: 'ability' }>>;
export type ActionState = {
  id: string;
  ability: AbilityRevision;
  cause: string;
  startedAt: number;
  launchAt: number;
  recoveryUntil: number;
  released: boolean;
  stages?: StageRuntime;
};
export type ActorState = {
  motion: MotionState;
  resources: ResourceState;
  staminaClock?: { remainder: number; exhausted: boolean };
  motionClock?: { remainder: number; flightRemainder: number; dodgeUntilStep?: number };
  locomotion?: ActorDisplay['locomotion'];
  forces?: ForceContribution[];
  forceGravity?: Vec3;
  forceDisplay?: ActorDisplay['force'];
  reactions?: ReactionDisplay[];
  statuses: StatusCohort[];
  memory: PerceptionMemory;
  decision: Decision;
  intent: MotionIntent;
  action: ActionState | null;
  readyAt: number;
  used: Record<string, number>;
  cooldowns: Record<string, number>;
  random: number;
  decisionRandom: DecisionRandom;
};
export type MeleeState = DamageSnapshot & {
  id: string;
  actorId: string;
  ability: AbilityRevision;
  cause: string;
  launchStep: number;
  direction: Vec3;
  offset: Vec3;
  hits: number;
  stage?: StageContact;
  hit?: DeepReadonly<Stage['hit']>;
};
export function initialActor(world: SpatialWorld, actor: ResolvedActor): ActorState {
  return {
    motion: initialMotion(world, actor),
    resources: initialResources(actor.character),
    ...(actor.character.stamina ? { staminaClock: { remainder: 0, exhausted: false } } : {}),
    ...(actor.character.stamina
      ? { locomotion: { mode: 'idle' as const, jumping: false, dodging: false } }
      : {}),
    statuses: [],
    memory: emptyMemory(),
    decision: { abilityId: null, goal: null, facing: actor.participant.facing },
    intent: {
      direction: { x: 0, y: 0, z: 0 },
      facing: actor.participant.facing,
      jump: false,
      flight: false,
      canMove: true,
      speedBps: 10000,
    },
    action: null,
    readyAt: 0,
    used: {},
    cooldowns: {},
    random: actor.participant.rngSeed,
    decisionRandom: initialDecisionRandom(actor.participant.rngSeed),
  };
}
export const cloneActor = (state: ActorState): ActorState => ({
  ...state,
  motion: {
    ...state.motion,
    position: { ...state.motion.position },
    velocity: { ...state.motion.velocity },
    facing: { ...state.motion.facing },
  },
  resources: { ...state.resources },
  ...(state.staminaClock ? { staminaClock: { ...state.staminaClock } } : {}),
  ...(state.motionClock ? { motionClock: { ...state.motionClock } } : {}),
  ...(state.locomotion ? { locomotion: { ...state.locomotion } } : {}),
  ...(state.forces ? { forces: structuredClone(state.forces) } : {}),
  ...(state.reactions ? { reactions: structuredClone(state.reactions) } : {}),
  ...(state.forceGravity ? { forceGravity: { ...state.forceGravity } } : {}),
  ...(state.forceDisplay !== undefined
    ? { forceDisplay: structuredClone(state.forceDisplay) }
    : {}),
  statuses: state.statuses.map((s) => ({ ...s, causes: [...s.causes] })),
  used: { ...state.used },
  cooldowns: { ...state.cooldowns },
  action: state.action
    ? { ...state.action, ...(state.action.stages ? { stages: { ...state.action.stages } } : {}) }
    : null,
  intent: { ...state.intent },
});
export function displayActor(state: ActorState, step: number): ActorDisplay {
  const { motion, action } = state;
  const stage = action ? stageDisplay(action, step) : undefined;
  const last = action?.ability.definition.stages?.at(-1);
  const active =
    action?.ability.definition.attack.kind === 'melee'
      ? action.ability.definition.attack.activeSteps
      : 1;
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
    ...(state.reactions ? { reactions: structuredClone(state.reactions) } : {}),
    ...(state.forceDisplay !== undefined ? { force: structuredClone(state.forceDisplay) } : {}),
    resources: { ...state.resources },
    ...(state.locomotion ? { locomotion: { ...state.locomotion } } : {}),
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
              ? { stage, activeUntil: action.launchAt + last.offsetSteps + last.durationSteps }
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
  const { motion, statuses, action, ...rest } = state;
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
