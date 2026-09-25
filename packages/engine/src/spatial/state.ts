/** Pure execution state types. Runtime behavior depends on these definitions, never the reverse. */
import type {
  ActorDisplay,
  AttackGeometry,
  Cognition,
  DeepReadonly,
  Definition,
  ElementSchema,
  Experience,
  ForceContribution,
  Manifest,
  ObservedReaction,
  ObservedStage,
  ObservedStatus,
  ObservedSurface,
  Posture,
  ReactionDisplay,
  ResourceState,
  Revision,
  Stage,
  StageContact,
} from '@fantasy/domain/spatial/execution';
import type { Vec3 } from './math.ts';
export type DamageSource = { attack: number; magicPower?: number };

export type ResolvedActor = DeepReadonly<{
  participant: Manifest['participants'][number];
  character: Definition<'character'>;
  abilities: Extract<Revision, { kind: 'ability' }>[];
  decisionAbilities: Extract<Revision, { kind: 'ability' }>[];
  equipment: Definition<'equipment'>[];
  policy: Definition<'policy'>;
  knownStatuses?: Extract<Revision, { kind: 'status' }>[];
}>;

export type PreparedBattle = DeepReadonly<{
  manifest: Manifest;
  simulationHash: string;
  rules: Definition<'ruleset'> & {
    ai: NonNullable<Definition<'ruleset'>['ai']>;
    forcedSpeedCapMmPerSecond: number;
  };
  scenario: Definition<'scenario'> & {
    terrainKnowledge: NonNullable<Definition<'scenario'>['terrainKnowledge']>;
  };
  actors: [ResolvedActor, ResolvedActor];
  statuses: Extract<Revision, { kind: 'status' }>[];
}>;

export type MotionState = {
  actor: ResolvedActor;
  position: Vec3;
  velocity: Vec3;
  facing: Vec3;
  grounded: boolean;
  posture?: PostureState;
  vision?: { rangeMm: number; fovMilliDegrees: number; enabled: boolean; visible: boolean };
};

export type MotionIntent = {
  direction: Vec3;
  facing: Vec3;
  jump: boolean;
  flight: boolean;
  canMove: boolean;
  speedBps: number;
  speedMmPerSecond?: number;
  canStep?: boolean;
  /** External force mode supplies separate carry and force; only gravity is retained. */
  forced?: { gravity: Vec3; force: Vec3 };
  accelerationMmPerSecond2?: number;
  authored?: {
    direction: Vec3;
    speedMmPerSecond: number;
    accelerationMmPerSecond2: number;
    jump: boolean;
  };
};

export type ObservedActor = {
  id: string;
  position: Vec3;
  velocity: Vec3;
  facing: Vec3;
  step: number;
  appearance?: Definition<'character'>['appearance'];
  wounds?: 'unknown' | 'unhurt' | 'hurt' | 'severe' | 'critical';
  action?: 'idle' | 'cast' | 'active' | 'recovery';
  size?: { radiusMm: number; heightMm: number };
  statuses?: ObservedStatus[];
  stage?: ObservedStage;
  reaction?: ObservedReaction;
  posture?: Posture;
};

export type ObservableProjectile = {
  id: string;
  ownerId: string;
  position: Vec3;
  velocity: Vec3;
  radiusMm?: number;
  element?: Experience['element'] | undefined;
  attackCueId?: string;
};

export type Observation = DeepReadonly<{
  sampledAt: number;
  availableAt: number;
  enemy: ObservedActor | null;
  projectiles: ObservableProjectile[];
  terrain?: ObservedSurface[];
}>;

export type PerceptionMemory = DeepReadonly<{
  sampledAt: number;
  pending: Observation[];
  observation: Observation | null;
  lastSeen: ObservedActor | null;
  pendingExperience: Experience[];
  knowledge: Experience[];
  learned: Experience[];
  expired: string[];
  terrain: ObservedSurface[];
  statusChangedAt?: number;
  threatHistory?: ThreatExperience[];
  search?: SearchMemory;
}>;

export type ThreatExperience = {
  eventId: string;
  sourceId: string;
  sampledAt: number;
  availableAt: number;
  expiresAt: number;
  element?: Experience['element'];
  statusId?: string;
};

export type DecisionView = {
  self: MotionState;
  resources: ResourceState;
  staminaExhausted: boolean;
  statusIds: readonly string[];
  memory: PerceptionMemory;
  step: number;
  gravityMmPerSecond2: number;
  used: Readonly<Record<string, number>>;
  reactionReadyAt: Readonly<Record<string, number>>;
  canAct: boolean;
  activeAbility: DeepReadonly<Definition<'ability'>> | undefined;
  canMove: boolean;
  stageOwnsMotion: boolean;
  speedBps: number;
  flightStaminaPerSecond: number;
  silenced: boolean;
  incapacitated: boolean;
  ownStatuses: readonly StatusCohort[] | undefined;
  burnDamage: number | undefined;
  waterExtinguishable: boolean;
  attack: number;
  magicPower: number;
  rules: DeepReadonly<NonNullable<Definition<'ruleset'>['ai']>>;
};

export type Decision = {
  abilityId: string | null;
  goal: Vec3 | null;
  facing: Vec3;
  cognition?: Extract<Cognition, { kind: 'decision' }>;
  random?: DecisionRandom;
  gait?: Gait;
  dodge?: boolean;
  search?: SearchMemory;
  posture?: Posture;
  postureUntil?: number;
  jump?: boolean;
};

export type PostureState = {
  current: Posture;
  standingBody: DeepReadonly<Definition<'character'>['body']>;
  transition?: { to: Posture; completeAt: number };
  holdUntil?: number;
};

export type StatusRevision = DeepReadonly<Extract<Revision, { kind: 'status' }>>;

export type StatusCohort = {
  revision: StatusRevision;
  startStep: number;
  endStep: number;
  stacks: number;
  causes: string[];
  flightStaminaPerSecond?: number;
};

export type StageRuntime = {
  index: number;
  next: number;
  active: boolean;
  cause: string;
  interruptedAt?: number;
  geometry?: AttackGeometry;
  motion?: NonNullable<NonNullable<ActorDisplay['action']>['stage']>['motion'];
};

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

export type ActorBodyState = {
  motion: MotionState;
  motionClock?: { remainder: number; flightRemainder: number; dodgeUntilStep?: number };
  locomotion?: ActorDisplay['locomotion'];
  forces?: ForceContribution[];
  forceGravity?: Vec3;
  forceDisplay?: ActorDisplay['force'];
  intent: MotionIntent;
};

export type ActorVitalsState = {
  resources: ResourceState;
  staminaClock?: { remainder: number; exhausted: boolean };
};

export type ActorActionState = {
  reactions?: ReactionDisplay[];
  action: ActionState | null;
  readyAt: number;
  used: Record<string, number>;
  cooldowns: Record<string, number>;
};

export type ActorMindState = {
  memory: PerceptionMemory;
  decision: Decision;
  random: number;
  decisionRandom: DecisionRandom;
};

export type ActorState = {
  body: ActorBodyState;
  vitals: ActorVitalsState;
  statuses: StatusCohort[];
  actions: ActorActionState;
  mind: ActorMindState;
};
export type PreviousMovement = Pick<ActorBodyState, 'intent'> & Pick<ActorMindState, 'decision'>;

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

export type DamageSnapshot = DamageSource & {
  dealtByElement?: Readonly<
    Partial<Record<(typeof ElementSchema.enum)[keyof typeof ElementSchema.enum], number>>
  >;
};

export type DecisionRandom = {
  action: number;
  dodge: number;
  movement?: number;
  search?: number;
  cover?: number;
};

export type DirectionCue = {
  id: string;
  sampledAt: number;
  availableAt: number;
  origin: Vec3;
  direction: Vec3;
};

export type SearchMemory = {
  cells: { position: Vec3; confirmedAt: number | null; attemptedAt?: number }[];
  pending: { sampledAt: number; availableAt: number; cells: number[] }[];
  cues: DirectionCue[];
  lastContactAt: number;
  investigatedAt: number;
  goal?: { key: string; position: Vec3; since: number; evidenceAt: number };
};

export type Gait = 'walk' | 'run' | 'slow';
