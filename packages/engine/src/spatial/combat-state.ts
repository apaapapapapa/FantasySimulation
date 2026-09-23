import {
  type ActorDisplay,
  type DeepReadonly,
  type ResourceState,
  type Revision,
} from '@fantasy/domain/spatial';
import type { MotionIntent, MotionState } from './movement.ts';
import type { PerceptionMemory } from './perception.ts';
import type { Decision } from './policy.ts';
import type { StatusCohort } from './status.ts';
import type { Vec3 } from './math.ts';
import type { DecisionRandom } from './decision-random.ts';
import type { DamageSnapshot } from './status-damage.ts';
export type AbilityRevision = DeepReadonly<Extract<Revision, { kind: 'ability' }>>;
export type ActionState = {
  id: string;
  ability: AbilityRevision;
  cause: string;
  startedAt: number;
  launchAt: number;
  recoveryUntil: number;
  released: boolean;
};
export type ActorState = {
  motion: MotionState;
  resources: ResourceState;
  staminaClock?: { remainder: number; exhausted: boolean };
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
};
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
  statuses: state.statuses.map((s) => ({ ...s, causes: [...s.causes] })),
  used: { ...state.used },
  cooldowns: { ...state.cooldowns },
  action: state.action ? { ...state.action } : null,
  intent: { ...state.intent },
});
export function displayActor(state: ActorState, step: number): ActorDisplay {
  const { motion, action } = state;
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
    resources: { ...state.resources },
    statuses: state.statuses.map((s) => ({
      revision: {
        id: s.revision.id,
        revision: s.revision.revision,
        contentHash: s.revision.contentHash,
      },
      startStep: s.startStep,
      endStep: s.endStep,
      stacks: s.stacks,
    })),
    action:
      action && step < action.recoveryUntil
        ? {
            id: action.id,
            abilityId: action.ability.id,
            startedAt: action.startedAt,
            launchAt: action.launchAt,
            recoveryUntil: action.recoveryUntil,
            phase:
              step < action.launchAt
                ? 'cast'
                : action.released && step < action.launchAt + active
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
