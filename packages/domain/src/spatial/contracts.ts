import { z } from 'zod';
import { assertJson } from './canonical.ts';

export const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const CURRENT_ENGINE_VERSION = 'spatial-v1.11' as const;
const uint = (max: number) => z.number().int().min(0).max(max);
const positive = (max: number) => z.number().int().min(1).max(max);
export const Vec3Schema = z.strictObject({
  x: z.number().int().min(-1_000_000).max(1_000_000),
  y: z.number().int().min(-1_000_000).max(1_000_000),
  z: z.number().int().min(-1_000_000).max(1_000_000),
});
export type VectorMm = z.infer<typeof Vec3Schema>;
export const DirectionSchema = Vec3Schema.refine(
  (v) => v.x !== 0 || v.y !== 0 || v.z !== 0,
  'Direction must not be zero',
);
export const RefSchema = z.strictObject({
  id: IdSchema,
  revision: positive(1_000_000),
  contentHash: HashSchema,
});
export type RevisionRef = z.infer<typeof RefSchema>;
export const ElementSchema = z.enum(['physical', 'fire', 'ice', 'lightning', 'arcane', 'water']);
const ResistancesSchema = z.strictObject({
  physical: uint(10_000),
  fire: uint(10_000),
  ice: uint(10_000),
  lightning: uint(10_000),
  arcane: uint(10_000),
  water: uint(10_000).optional(),
});

export const BodySchema = z
  .strictObject({
    radiusMm: positive(5_000),
    heightMm: positive(20_000),
    eyeOffset: Vec3Schema,
    muzzleOffset: Vec3Schema,
    aimOffset: Vec3Schema,
  })
  .superRefine((body, ctx) => {
    if (body.heightMm < 2 * body.radiusMm)
      ctx.addIssue({ code: 'custom', message: 'Capsule height must include both hemispheres' });
    for (const offset of [body.eyeOffset, body.muzzleOffset, body.aimOffset])
      if (
        Math.abs(offset.x) > body.radiusMm * 2 ||
        Math.abs(offset.z) > body.radiusMm * 2 ||
        Math.abs(offset.y) > body.heightMm / 2
      )
        ctx.addIssue({ code: 'custom', message: 'Body offset outside supported bounds' });
  });
export const MovementSchema = z.strictObject({
  speedMmPerSecond: uint(100_000),
  accelerationMmPerSecond2: uint(100_000),
  turnMilliDegreesPerSecond: uint(720_000),
  jumpMmPerSecond: uint(30_000),
  stepHeightMm: uint(2_000),
  maxSlopeMilliDegrees: uint(60_000),
  flySpeedMmPerSecond: uint(100_000),
});
export const PerceptionSchema = z.strictObject({
  rangeMm: positive(200_000),
  fovMilliDegrees: positive(360_000),
  reactionSteps: positive(500),
  memorySteps: uint(6_000),
  revealWardBps: uint(10_000).optional(),
});
export const AppearanceSchema = z.strictObject({
  silhouette: z.enum(['humanoid', 'beast', 'construct']),
  surface: z.enum(['neutral', 'red', 'blue', 'dark', 'bright']),
  equipment: z.array(z.enum(['blade', 'bow', 'staff', 'shield'])).max(4),
});
export const AiRulesSchema = z.strictObject({
  profile: z.literal('observed-utility-v1'),
  observation: z.literal('visible-coarse-v1'),
  initialKnowledge: z.literal('empty-match-v1'),
  random: z.literal('actor-purpose-rejection-v1'),
  horizonSteps: positive(100),
  memorySamples: positive(32),
  knowledgeTtlSteps: positive(1000),
  damageQuantum: positive(100),
  healthPrior: positive(1000),
  explorationWeight: uint(1000),
  riskWeight: positive(5000),
  killWeight: positive(5000),
  actionWeight: positive(1000),
  dodgeWeight: positive(5000),
});
export const AI_RULES = Object.freeze(
  AiRulesSchema.parse({
    profile: 'observed-utility-v1',
    observation: 'visible-coarse-v1',
    initialKnowledge: 'empty-match-v1',
    random: 'actor-purpose-rejection-v1',
    horizonSteps: 50,
    memorySamples: 32,
    knowledgeTtlSteps: 500,
    damageQuantum: 10,
    healthPrior: 200,
    explorationWeight: 60,
    riskWeight: 800,
    killWeight: 2400,
    actionWeight: 100,
    dodgeWeight: 600,
  }),
);

export type Condition =
  | { kind: 'always' }
  | { kind: 'resource'; resource: 'hp' | 'mp'; belowBps: number }
  | { kind: 'distance'; withinMm: number }
  | { kind: 'visible'; value: boolean }
  | { kind: 'status'; id: string; present: boolean }
  | { kind: 'projectile-observed' }
  | { kind: 'all' | 'any'; children: Condition[] }
  | { kind: 'not'; child: Condition };
function conditionAt(depth: number): z.ZodType<Condition> {
  const leaves = [
    z.strictObject({ kind: z.literal('always') }),
    z.strictObject({
      kind: z.literal('resource'),
      resource: z.enum(['hp', 'mp']),
      belowBps: uint(10_000),
    }),
    z.strictObject({ kind: z.literal('distance'), withinMm: uint(200_000) }),
    z.strictObject({ kind: z.literal('visible'), value: z.boolean() }),
    z.strictObject({ kind: z.literal('status'), id: IdSchema, present: z.boolean() }),
    z.strictObject({ kind: z.literal('projectile-observed') }),
  ] as const;
  if (depth === 0) return z.discriminatedUnion('kind', leaves);
  const child = conditionAt(depth - 1);
  return z.discriminatedUnion('kind', [
    ...leaves,
    z.strictObject({ kind: z.enum(['all', 'any']), children: z.array(child).min(1).max(8) }),
    z.strictObject({ kind: z.literal('not'), child }),
  ]);
}
export const ConditionSchema = conditionAt(4);
// Issue #61 G-01: extend these enums additively; omitted categories keep legacy meaning.
export const AbilityCategorySchema = z.enum(['physical', 'magic', 'technique', 'special']);
export const StatusCategorySchema = z.enum(['buff', 'debuff', 'control', 'damage-over-time']);
export type AbilityCategory = z.infer<typeof AbilityCategorySchema>;
export type StatusCategory = z.infer<typeof StatusCategorySchema>;
const categoryList = <T extends z.ZodType<string>>(item: T) =>
  z
    .array(item)
    .min(1)
    .max(8)
    .refine((values) => new Set(values).size === values.length, 'Categories must be unique');

export const DamageDefenseSchema = z.enum(['physical', 'magic', 'none']);
export type DamageDefense = z.infer<typeof DamageDefenseSchema>;
const DamageScalingSchema = z
  .array(z.strictObject({ stat: z.enum(['attack', 'magicPower']), ratioBps: uint(100_000) }))
  .min(1)
  .max(2)
  .refine(
    (terms) => new Set(terms.map((term) => term.stat)).size === terms.length,
    'Damage scaling stats must be unique',
  );

export const EffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('damage'),
    amount: uint(1_000_000),
    attackScaleBps: uint(100_000),
    element: ElementSchema,
    scaling: DamageScalingSchema.optional(),
    defense: DamageDefenseSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('heal'), amount: uint(1_000_000) }),
  z.strictObject({ kind: z.literal('shield'), amount: uint(1_000_000) }),
  z.strictObject({ kind: z.literal('apply-status'), status: RefSchema }),
  z.strictObject({
    kind: z.literal('dispel'),
    statusIds: z.array(IdSchema).min(1).max(16).optional(),
    categories: categoryList(StatusCategorySchema).optional(),
  }),
  z.strictObject({ kind: z.literal('water'), extinguish: z.literal(true) }),
  z.strictObject({
    kind: z.literal('reveal'),
    field: z.literal('resistance'),
    element: ElementSchema,
    precisionBps: positive(10_000),
    durationSteps: positive(1000),
    delaySteps: positive(500),
    occlusion: z.literal('vision'),
    powerBps: positive(10_000),
  }),
]);
export type Effect = z.infer<typeof EffectSchema>;
export const StatusSchema = z.strictObject({
  name: z.string().min(1).max(100),
  originalText: z.string().max(20_000),
  stackKey: IdSchema,
  stacking: z.enum(['sum', 'replace', 'refresh', 'reject']),
  maxStacks: positive(32),
  durationSteps: positive(6_000),
  categories: categoryList(StatusCategorySchema).optional(),
  burning: z.strictObject({ waterExtinguishable: z.boolean() }).optional(),
  modifiers: z.strictObject({
    attack: z.number().int().min(-100_000).max(100_000),
    defense: z.number().int().min(-100_000).max(100_000),
    speedBps: uint(30_000),
    flight: z.boolean(),
    rooted: z.boolean(),
    silenced: z.boolean().optional(),
  }),
  periodic: z
    .array(
      z.strictObject({
        everySteps: positive(6_000),
        kind: z.enum(['damage', 'heal']),
        amount: uint(1_000_000),
        element: ElementSchema,
      }),
    )
    .max(8),
});
export const AttackSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct') }),
  z.strictObject({
    kind: z.literal('melee'),
    reachMm: positive(20_000),
    radiusMm: positive(5_000),
    activeSteps: positive(100),
    maxHitsPerTarget: positive(16),
  }),
  z.strictObject({ kind: z.literal('hitscan'), radiusMm: uint(1_000) }),
  z.strictObject({
    kind: z.literal('projectile'),
    speedMmPerSecond: positive(1_000_000),
    radiusMm: positive(5_000),
    lifetimeSteps: positive(6_000),
    gravityScaleBps: uint(30_000),
    homingTurnMilliDegreesPerSecond: uint(720_000),
    observation: z.enum(['launch-only', 'owner-visible']),
    explosionRadiusMm: uint(50_000),
    maxHitsPerTarget: z.literal(1),
  }),
]);
export const AbilitySchema = z
  .strictObject({
    name: z.string().min(1).max(100),
    originalText: z.string().max(20_000),
    trigger: z.enum(['action', 'battle-start']),
    categories: categoryList(AbilityCategorySchema).optional(),
    target: z.enum(['self', 'enemy']),
    condition: ConditionSchema,
    costs: z.strictObject({ hp: uint(1_000_000), mp: uint(1_000_000), uses: uint(6_000) }),
    castSteps: uint(6_000),
    recoverySteps: positive(6_000),
    cooldownSteps: uint(6_000),
    movementWhileCasting: z.enum(['allow', 'stop']),
    rangeMm: uint(200_000),
    aimErrorMilliDegrees: uint(45_000),
    attack: AttackSchema,
    effects: z.array(EffectSchema).min(1).max(16),
  })
  .superRefine((ability, ctx) => {
    if (ability.effects.some((e) => e.kind === 'dispel' && !e.statusIds && !e.categories))
      ctx.addIssue({
        code: 'custom',
        message: 'Dispel requires status IDs or status categories',
      });
    if (
      ability.effects.some((e) => e.kind === 'reveal') &&
      (ability.target !== 'enemy' ||
        ability.attack.kind !== 'hitscan' ||
        ability.attack.radiusMm !== 0)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Reveal requires an enemy-targeted zero-radius hitscan; unsupported acquisition modes are rejected',
      });
    if (ability.target === 'self' && ability.attack.kind !== 'direct')
      ctx.addIssue({ code: 'custom', message: 'Self effects require direct targeting' });
    if (ability.attack.kind === 'direct' && ability.target !== 'self')
      ctx.addIssue({
        code: 'custom',
        message: 'Direct effects are self-only; enemy attacks require geometry',
      });
    if (
      ability.trigger === 'battle-start' &&
      (ability.castSteps !== 0 || ability.target !== 'self')
    )
      ctx.addIssue({ code: 'custom', message: 'Battle-start effects are immediate and self-only' });
  });
export const PolicySchema = z.strictObject({
  name: z.string().min(1).max(100),
  originalText: z.string().max(20_000),
  priorities: z.array(z.strictObject({ when: ConditionSchema, abilityId: IdSchema })).max(32),
  movement: z.enum(['hold', 'approach', 'keep-distance', 'evade']),
  preferredDistanceMm: uint(100_000),
  flightAltitudeMm: uint(40_000),
  jumpWhenBlocked: z.boolean(),
  evaluation: z
    .strictObject({
      attackBps: positive(30_000),
      survivalBps: positive(30_000),
      explorationBps: uint(30_000),
    })
    .optional(),
});
export const EquipmentSchema = z.strictObject({
  name: z.string().min(1).max(100),
  originalText: z.string().max(20_000),
  attackBonus: uint(100_000),
  defenseBonus: uint(100_000),
  abilities: z.array(RefSchema).max(16),
});
export const CharacterSchema = z.strictObject({
  name: z.string().min(1).max(100),
  originalText: z.string().max(20_000),
  appearance: AppearanceSchema.optional(),
  stats: z.strictObject({
    hp: positive(1_000_000),
    mp: uint(1_000_000),
    attack: uint(1_000_000),
    defense: uint(1_000_000),
    magicPower: uint(1_000_000).optional(),
    magicDefense: uint(1_000_000).optional(),
    actionSpeedBps: uint(100_000),
    shield: uint(1_000_000),
    resistances: ResistancesSchema,
  }),
  body: BodySchema,
  movement: MovementSchema,
  perception: PerceptionSchema,
  abilities: z.array(RefSchema).max(32),
  equipment: z.array(RefSchema).max(8),
  policy: RefSchema,
});

const BlocksSchema = z.strictObject({
  movement: z.boolean(),
  vision: z.boolean(),
  attack: z.boolean(),
});
export const TerrainSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: IdSchema,
    kind: z.literal('box'),
    center: Vec3Schema,
    halfExtents: z.strictObject({
      x: positive(100_000),
      y: positive(100_000),
      z: positive(100_000),
    }),
    yawMilliDegrees: uint(359_999),
    slopeMilliDegrees: z.number().int().min(-60_000).max(60_000),
    blocks: BlocksSchema,
  }),
  z.strictObject({
    id: IdSchema,
    kind: z.literal('pillar'),
    center: Vec3Schema,
    radiusMm: positive(20_000),
    halfHeightMm: positive(50_000),
    blocks: BlocksSchema,
  }),
]);
const NodeSchema = z.strictObject({
  id: IdSchema,
  position: Vec3Schema,
  mode: z.enum(['ground', 'air']),
});
const EdgeSchema = z.strictObject({
  from: IdSchema,
  to: IdSchema,
  mode: z.enum(['walk', 'jump', 'fly']),
  widthMm: positive(20_000),
  headroomMm: positive(50_000),
  bidirectional: z.boolean(),
});
export const ScenarioSchema = z
  .strictObject({
    name: z.string().min(1).max(100),
    bounds: z.strictObject({ min: Vec3Schema, max: Vec3Schema }),
    obstacles: z.array(TerrainSchema).max(256),
    navigation: z.strictObject({
      version: z.literal('support-graph-v1'),
      nodes: z.array(NodeSchema).max(4_096),
      edges: z.array(EdgeSchema).max(16_384),
    }),
    terrainKnowledge: z.enum(['surveyed', 'observed']).optional(),
  })
  .superRefine((scenario, ctx) => {
    for (const axis of ['x', 'y', 'z'] as const)
      if (
        scenario.bounds.min[axis] >= scenario.bounds.max[axis] ||
        scenario.bounds.max[axis] - scenario.bounds.min[axis] > 200_000
      )
        ctx.addIssue({ code: 'custom', message: 'Arena extent must be positive and at most 200m' });
    const ids = new Set<string>();
    for (const obstacle of scenario.obstacles) {
      if (ids.has(obstacle.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate terrain ID' });
      ids.add(obstacle.id);
    }
    const nodes = new Set<string>();
    const positions = new Set<string>();
    for (const node of scenario.navigation.nodes) {
      if (nodes.has(node.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate navigation ID' });
      nodes.add(node.id);
      const positionKey = `${node.mode}:${node.position.x}:${node.position.y}:${node.position.z}`;
      if (positions.has(positionKey))
        ctx.addIssue({ code: 'custom', message: 'Duplicate navigation position' });
      positions.add(positionKey);
      if (
        (['x', 'y', 'z'] as const).some(
          (axis) =>
            node.position[axis] < scenario.bounds.min[axis] ||
            node.position[axis] > scenario.bounds.max[axis],
        )
      )
        ctx.addIssue({ code: 'custom', message: 'Navigation position outside arena' });
    }
    const nodeModes = new Map(scenario.navigation.nodes.map((node) => [node.id, node.mode]));
    for (const edge of scenario.navigation.edges) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to)
        ctx.addIssue({ code: 'custom', message: 'Invalid navigation edge reference' });
      else {
        const requiredMode = edge.mode === 'fly' ? 'air' : 'ground';
        if (nodeModes.get(edge.from) !== requiredMode || nodeModes.get(edge.to) !== requiredMode)
          ctx.addIssue({
            code: 'custom',
            message: 'Navigation edge mode must match both endpoint layers',
          });
      }
    }
  });
export const RulesetSchema = z.strictObject({
  name: z.string().min(1).max(100),
  // Stored historical revisions remain readable; prepareBattle admits only the current rules.
  rulesVersion: IdSchema,
  ai: AiRulesSchema.optional(),
  stepMs: z.literal(20),
  maxSteps: positive(6_000),
  gravityMmPerSecond2: z.number().int().min(-30_000).max(0),
  fallSafeSpeedMmPerSecond: uint(30_000),
  fallDamagePerMeterPerSecond: uint(100_000),
  curveErrorMm: positive(10),
  bodyContact: z.literal('symmetric-stop'),
  aoeOcclusion: z.literal('five-samples-equal-linear-v1'),
  simultaneousConflict: z.literal('unresolved'),
});

const revision = <K extends string, S extends z.ZodType>(kind: K, definition: S) =>
  z.strictObject({
    kind: z.literal(kind),
    id: IdSchema,
    revision: positive(1_000_000),
    schemaVersion: z.literal(1),
    contentHash: HashSchema,
    definition,
  });
export const RevisionSchema = z.discriminatedUnion('kind', [
  revision('character', CharacterSchema),
  revision('ability', AbilitySchema),
  revision('status', StatusSchema),
  revision('equipment', EquipmentSchema),
  revision('policy', PolicySchema),
  revision('scenario', ScenarioSchema),
  revision('ruleset', RulesetSchema),
]);
export type Revision = z.infer<typeof RevisionSchema>;
export type DefinitionKind = Revision['kind'];
export type Definition<K extends DefinitionKind> = Extract<Revision, { kind: K }>['definition'];
export const ParticipantSchema = z.strictObject({
  actorId: IdSchema.refine(
    (id) => !id.startsWith('projectile.'),
    'Reserved projectile entity namespace',
  ),
  character: RefSchema,
  position: Vec3Schema,
  facing: DirectionSchema,
  rngSeed: uint(0xffff_ffff),
  rngStream: z.union([z.literal(0), z.literal(1)]),
});
export const PhysicsProfileSchema = z.strictObject({
  id: z.literal('spatial-v1'),
  rapier: z.literal('0.20.0'),
  axis: z.literal('right-handed-Y-up'),
  inputUnits: z.literal('integer-mm-ms'),
  stepMs: z.literal(20),
  aiMs: z.literal(100),
  maxSteps: z.literal(6000),
  gravityMmPerSecond2: z.literal(-9807),
  skinMm: z.literal(2),
  contactTimeEpsilon: z.literal(0.000001),
  maxMoveSegments: z.literal(8),
  floatEncoding: z.literal('IEEE754-binary64-big-endian-hex-negative-zero-normalized'),
  physicsConversion: z.literal('TS-binary64-metres-to-Rapier-binary32-at-each-WASM-call'),
  trigonometry: z.literal('quarter-sine-1-degree-linear-1e9-v1'),
  creationOrder: z.literal('ascending-ASCII-id'),
  simultaneousObstacleContact: z.literal('wall-first-within-epsilon'),
  actorCollision: z.literal('binary64-analytic-upright-capsule-sweep-v1'),
});
export const ManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(3),
    eventSchemaVersion: z.literal(1),
    replaySchemaVersion: z.literal(1),
    engineVersion: z.literal(CURRENT_ENGINE_VERSION),
    aiProfile: z.literal('observed-utility-v1'),
    implementationDigest: HashSchema,
    physicsProfileHash: HashSchema,
    physicsProfile: PhysicsProfileSchema,
    wasmHash: HashSchema,
    angleTableHash: HashSchema,
    prng: z.literal('xorshift32-v1'),
    seed: uint(0xffff_ffff),
    seedDerivation: z.literal('actor-stream-v1'),
    participants: z.tuple([ParticipantSchema, ParticipantSchema]),
    ruleset: RefSchema,
    scenario: RefSchema,
    revisions: z.array(RevisionSchema).min(4).max(256),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.participants[0].rngStream === manifest.participants[1].rngStream)
      ctx.addIssue({ code: 'custom', message: 'Actor streams must differ' });
    if (manifest.participants[0].actorId === manifest.participants[1].actorId)
      ctx.addIssue({ code: 'custom', message: 'Actor IDs must differ' });
    const ids = new Set<string>();
    for (const revision of manifest.revisions) {
      const key = `${revision.kind}:${revision.id}:${revision.revision}`;
      if (ids.has(key)) ctx.addIssue({ code: 'custom', message: 'Duplicate resolved revision' });
      ids.add(key);
    }
  });
export type Manifest = z.infer<typeof ManifestSchema>;
export const BudgetSchema = z.strictObject({
  maxEvents: positive(1_000_000),
  maxBytes: positive(256_000_000),
  maxFrameBytes: positive(4_000_000),
  maxCasts: positive(10_000_000),
  maxCandidates: positive(10_000_000),
  maxPathNodes: positive(100_000),
  maxProjectiles: positive(256),
  maxMoveSegments: positive(64),
  maxCurveSegments: positive(256),
  maxStatusTypes: positive(256),
  maxStatusCauses: positive(65_536),
});
export type Budget = z.infer<typeof BudgetSchema>;
export const DEFAULT_BUDGET: Readonly<Budget> = Object.freeze({
  maxEvents: 50_000,
  maxBytes: 16_000_000,
  maxFrameBytes: 512_000,
  maxCasts: 1_000_000,
  maxCandidates: 1_000_000,
  maxPathNodes: 4_096,
  maxProjectiles: 64,
  maxMoveSegments: 8,
  maxCurveSegments: 64,
  maxStatusTypes: 64,
  maxStatusCauses: 2_048,
});
export function parseJson<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  assertJson(input);
  return schema.parse(input);
}
