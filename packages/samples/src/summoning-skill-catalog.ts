import type { SkillDan, SkillNode } from '@fantasy/domain';

const deepeningKinds = [
  'foundation',
  'conditional-effect',
  'combination',
  'tactical-mode',
  'specialization',
  'ultimate-tradeoff',
] as const satisfies readonly SkillNode['deepening']['kind'][];

export const SUMMONING_RUNTIME_MECHANISMS = [
  'ownership',
  'hostility',
  'subject-clock',
  'observed-command',
  'rng-identity',
  'guard-drain-settlement',
  'defeat-revival',
  'owner-despawn',
  'possession-release',
  'capacity-upkeep-expiry',
  'victory-bounds',
  'persistence',
  'replay',
  'viewer-2d-3d',
  'reverse-seek',
] as const;
export type SummoningRuntimeMechanism = (typeof SUMMONING_RUNTIME_MECHANISMS)[number];

type Stage = readonly [name: string, behavior: string, lowerUse: string, tradeoff?: string];
type Branch = {
  zodiac: SkillNode['coordinate']['zodiac'];
  creature: string;
  role: string;
  stages: readonly [Stage, Stage, Stage, Stage, Stage, Stage];
};

const branches = [
  {
    zodiac: 'rat',
    creature: 'scout rat',
    role: 'initiative-scouting',
    stages: [
      [
        'Scout Rat',
        'Creates one fragile scout that harasses the nearest legally observed hostile.',
        'Cheap autonomous scouting still exposes no hidden state.',
      ],
      [
        'Whistle Order',
        'Pays a command to redirect the scout toward a legally observed hostile.',
        'Autonomous scouting remains useful when a command is unaffordable.',
      ],
      [
        'Pincer Signal',
        'Coordinates owner and scout attacks without merging their action clocks.',
        'The scout can still harass without owner coordination.',
      ],
      [
        'Borrowed Burrow',
        'Possesses the owner for a short evasive burrow, then releases at a valid offset.',
        'Keeping the scout embodied preserves independent scouting.',
      ],
      [
        'Twin Scouts',
        'Maintains two low-HP scouts with separate ordinals and upkeep.',
        'A single scout remains cheaper and easier to sustain.',
        'The second body consumes the concurrent cap and doubles upkeep.',
      ],
      [
        'Plague Spirit',
        'Creates a costly spirit whose drain pressure settles in the ordinary damage transaction.',
        'Scout and command options remain lower-cost tools.',
        'High upkeep and short lifetime create a recovery opening after despawn.',
      ],
    ],
  },
  {
    zodiac: 'ox',
    creature: 'stone ox',
    role: 'accumulation-anchor',
    stages: [
      [
        'Stone Calf',
        'Creates a slow body that accumulates guard while holding a route.',
        'The inexpensive calf remains the sustainable anchor.',
      ],
      [
        'Brace Order',
        'Commands the calf to spend accumulated guard on an observed incoming threat.',
        'Uncommanded route holding still costs less attention and resource.',
      ],
      [
        'Yoke Advance',
        'Alternates owner movement with the ox body without granting either an extra turn.',
        'Static anchoring remains safer when advance is unnecessary.',
      ],
      [
        'Living Bulwark',
        'Possesses the owner with the ox guard profile while preserving dependent HP and upkeep.',
        'The separate body still blocks space that possession cannot.',
        'Possession removes the collision body until a valid release succeeds.',
      ],
      [
        'Paired Yoke',
        'Creates a second ox to form a bounded corridor between two collision bodies.',
        'One anchor remains cheaper and leaves a summon slot open.',
        'Two bodies reach the concurrent cap and pay upkeep independently.',
      ],
      [
        'Mountain Ox',
        'Commits stored guard to one heavy break resolved with simultaneous guard and drain.',
        'Earlier anchors retain longer-lived defensive value.',
        'The break empties stored guard and leaves a long owner recovery window.',
      ],
    ],
  },
  {
    zodiac: 'tiger',
    creature: 'hunting tiger',
    role: 'pressure-pursuit',
    stages: [
      [
        'Tiger Cub',
        'Creates a short-lived pursuer that pressures the nearest visible hostile.',
        'The cub is the low-upkeep pursuit option.',
      ],
      [
        'Mark Quarry',
        'Commands pursuit of one observed hostile and forgets the mark when observation expires.',
        'Default visible-target pressure remains available.',
      ],
      [
        'Crossing Pounce',
        'Coordinates a pounce after the owner creates a legal opening.',
        'Independent pursuit remains useful without an opening.',
      ],
      [
        'Predator Mantle',
        'Possesses the owner with pursuit capability but no dependent action turn.',
        'The embodied tiger retains separate route pressure.',
        'Release can fail safely when every bounded offset is occupied.',
      ],
      [
        'Pack Hunt',
        'Uses two ordinal-stable tigers to approach from distinct valid routes.',
        'One tiger remains less expensive and deterministic under congestion.',
        'The pair fills both dependent slots and increases command cost.',
      ],
      [
        'White Tiger',
        'Creates a high-pressure spirit with finite lifetime and defeat-sensitive upkeep.',
        'Cub and quarry tools retain efficient pursuit roles.',
        'Expiry is brief and owner defeat despawns it before verdict calculation.',
      ],
    ],
  },
  {
    zodiac: 'rabbit',
    creature: 'moon rabbit',
    role: 'evasion-decoy',
    stages: [
      [
        'Moon Rabbit',
        'Creates an evasive body that draws only attacks that legally target dependents.',
        'The cheap body remains a simple escape aid.',
      ],
      [
        'Scatter Order',
        'Commands a visible retreat route using only the owner-delivered observation.',
        'Autonomous evasion works without paid redirection.',
      ],
      [
        'Relay Step',
        'Coordinates an owner dodge and rabbit reposition on their separate clocks.',
        'Either actor may still evade independently.',
      ],
      [
        'Moonstep Vessel',
        'Possesses the owner for one evasive capability and later releases collision-validly.',
        'The embodied rabbit remains a targetable decoy.',
        'Possession sacrifices the separate decoy body.',
      ],
      [
        'Twin Burrows',
        'Keeps two rabbits on distinct ordinal RNG streams for route denial.',
        'One rabbit remains cheaper and leaves capacity for another branch.',
        'Two lifetimes and upkeep charges continue during subject freeze.',
      ],
      [
        'Jade Hare',
        'Creates a costly evasive spirit that can intercept one observed attack transaction.',
        'Basic evasion remains reusable and cheaper.',
        'One interception consumes the spirit and cannot alter terminal revival.',
      ],
    ],
  },
  {
    zodiac: 'dragon',
    creature: 'cloud wyrm',
    role: 'area-control',
    stages: [
      [
        'Cloud Wyrmling',
        'Creates a flying body that controls a small visible area.',
        'The wyrmling is the inexpensive localized area tool.',
      ],
      [
        'Storm Order',
        'Commands an area shift only to an observed target or valid owner-support point.',
        'Uncommanded local control remains useful.',
      ],
      [
        'Coiled Front',
        'Coordinates owner pressure and wyrm area timing without duplicate actions.',
        'The original small area remains preferable near the owner.',
      ],
      [
        'Dragon Vessel',
        'Possesses the owner with finite flight while lifetime and upkeep continue globally.',
        'The separate wyrm still controls an independent area.',
        'Possession removes its collision body and spends continuous upkeep.',
      ],
      [
        'Twin Tempests',
        'Uses two bodies with distinct ordinals to cover disjoint bounded areas.',
        'A single wyrm costs less and avoids cap saturation.',
        'The pair cannot create nested summons and pays two upkeep streams.',
      ],
      [
        'Azure Dragon',
        'Creates a large but short-lived area spirit whose hits settle simultaneously.',
        'Localized wyrm control remains economical.',
        'High cost, finite lifetime and post-cast recovery prevent permanent coverage.',
      ],
    ],
  },
  {
    zodiac: 'snake',
    creature: 'binding serpent',
    role: 'restraint-control',
    stages: [
      [
        'Binding Snake',
        'Creates a body that attempts a finite collision-based restraint.',
        'The small snake remains a cheap route restraint.',
      ],
      [
        'Coil Order',
        'Commands restraint of a legally observed hostile body.',
        'Autonomous route restraint remains available.',
      ],
      [
        'Owner Coil',
        'Coordinates owner displacement with a dependent hold in one ordinary settlement.',
        'The snake can restrain without owner commitment.',
      ],
      [
        'Serpent Vessel',
        'Possesses the owner with a finite restraint capability and bounded release.',
        'An embodied snake still occupies and restrains space.',
        'Possession gives up the independent collision body.',
      ],
      [
        'Twin Coils',
        'Uses two ordinal-stable snakes to restrain separate routes.',
        'A single coil remains lower-upkeep control.',
        'Two bodies fill the cap and cannot target an unobserved foe.',
      ],
      [
        'World Serpent',
        'Creates a costly spirit restraint that expires before it can loop indefinitely.',
        'Earlier coils remain flexible and sustainable.',
        'The ultimate pays high upkeep and a long recovery after expiry or dismissal.',
      ],
    ],
  },
  {
    zodiac: 'horse',
    creature: 'wind horse',
    role: 'mobility-relay',
    stages: [
      [
        'Wind Foal',
        'Creates a fast courier body that follows a collision-valid route.',
        'The foal remains the cheapest relocation aid.',
      ],
      [
        'Rally Order',
        'Commands the foal toward an observed support point or hostile.',
        'Following policy works without command cost.',
      ],
      [
        'Relay Charge',
        'Coordinates owner and foal movement while preserving separate due times.',
        'Solo courier movement stays useful in narrow space.',
      ],
      [
        'Mounted Spirit',
        'Possesses the owner with mobility while dependent upkeep and HP persist.',
        'The embodied foal can occupy another route.',
        'No extra turn is granted and failed release stays possessed.',
      ],
      [
        'Twin Relay',
        'Maintains two couriers on distinct ordinal RNG streams.',
        'One courier remains cheaper and leaves summon capacity.',
        'The pair reaches the body cap and doubles global upkeep.',
      ],
      [
        'Celestial Steed',
        'Creates a brief high-speed spirit with bounded movement and collision.',
        'The foal and rally remain precise low-cost options.',
        'High upkeep and finite lifetime end the burst before verdict.',
      ],
    ],
  },
  {
    zodiac: 'goat',
    creature: 'hearth goat',
    role: 'harmony-support',
    stages: [
      [
        'Hearth Kid',
        'Creates a support body that may explicitly aid only its owner.',
        'The kid remains a low-cost owner support tool.',
      ],
      [
        'Gather Order',
        'Commands the kid to an observed safe support position.',
        'Default owner-follow support remains useful.',
      ],
      [
        'Shared Rhythm',
        'Coordinates finite owner support without collapsing participant identity.',
        'The kid can still support independently.',
      ],
      [
        'Hearth Vessel',
        'Possesses the owner with a finite support capability while upkeep continues.',
        'The embodied kid remains a separate target and support position.',
        'Possession removes area presence and cannot create an extra support turn.',
      ],
      [
        'Paired Chorus',
        'Uses two bodies to alternate finite support on separate clocks.',
        'One support body remains cheaper and less vulnerable.',
        'The pair fills capacity and duplicate support follows ordinary stacking rules.',
      ],
      [
        'Qilin Guest',
        'Creates a costly spirit whose support and incoming damage settle atomically.',
        'Earlier support remains sustainable.',
        'Short lifetime, high upkeep and ordinary dispel/counter rules bound the benefit.',
      ],
    ],
  },
  {
    zodiac: 'monkey',
    creature: 'mimic monkey',
    role: 'adaptation-counterplay',
    stages: [
      [
        'Mimic Monkey',
        'Creates a body with one declared basic action, never copied hidden state.',
        'Its basic action remains reliable without observation.',
      ],
      [
        'Echo Order',
        'Commands a declared adaptation from legal recorded observation only.',
        'The basic action works when no legal echo exists.',
      ],
      [
        'Relay Trick',
        'Coordinates owner and mimic actions without duplicating either transaction.',
        'Independent mimic action remains flexible.',
      ],
      [
        'Mimic Vessel',
        'Possesses the owner with the declared adaptation and no extra turn.',
        'The body remains useful for separate positioning.',
        'Possession removes its collision body and preserves finite status.',
      ],
      [
        'Twin Mimics',
        'Runs two ordinal-stable policies whose RNG identities do not depend on enumeration.',
        'One mimic remains cheaper and simpler to command.',
        'Two bodies consume the cap and each command must be observed legally.',
      ],
      [
        'Sage Monkey',
        'Creates a costly spirit that adapts once to an observed action class.',
        'Basic and echo options retain repeatable utility.',
        'One adaptation, finite lifetime and long recovery prevent universal copying.',
      ],
    ],
  },
  {
    zodiac: 'rooster',
    creature: 'watch rooster',
    role: 'observation-warning',
    stages: [
      [
        'Watch Chick',
        'Creates a sentinel whose observation remains actor-scoped.',
        'The chick remains a cheap local warning body.',
      ],
      [
        'Alarm Order',
        'Commands focus on one legally observed hostile without leaking truth state.',
        'Local autonomous warning remains available.',
      ],
      [
        'Dawn Relay',
        'Coordinates a recorded warning with the owner decision on separate clocks.',
        'The owner and chick can still observe independently.',
      ],
      [
        'Dawn Vessel',
        'Possesses the owner with finite observation capability and bounded release.',
        'The embodied sentinel covers a separate viewpoint.',
        'Possession sacrifices that viewpoint and continues upkeep.',
      ],
      [
        'Twin Watches',
        'Places two ordinal-stable sentinels with independent delivered observations.',
        'One watch remains cheaper and easier to protect.',
        'Two bodies reach capacity and may not share hidden observations.',
      ],
      [
        'Vermilion Bird',
        'Creates a brief costly observer spirit with explicit recorded cues.',
        'Earlier watches retain efficient warning roles.',
        'Short lifetime, high upkeep and ordinary targeting prevent omniscience.',
      ],
    ],
  },
  {
    zodiac: 'dog',
    creature: 'ward hound',
    role: 'protection-interception',
    stages: [
      [
        'Ward Pup',
        'Creates a body that guards its owner through ordinary collision and guard.',
        'The pup remains a cheap positional guard.',
      ],
      [
        'Intercept Order',
        'Commands interception of an observed hostile action.',
        'Default close guard remains useful without a command.',
      ],
      [
        'Guard Relay',
        'Coordinates owner guard and hound interception in one simultaneous transaction.',
        'Either guard can still be used alone.',
      ],
      [
        'Hound Vessel',
        'Possesses the owner with finite protection while dependent HP persists.',
        'The embodied hound remains an independent interceptor.',
        'Possession removes the separate blocker and grants no extra reaction.',
      ],
      [
        'Twin Ward',
        'Uses two hounds with separate ordinals to protect distinct approaches.',
        'One hound remains cheaper and preserves capacity.',
        'The pair fills both slots and guard waves still resolve without precedence.',
      ],
      [
        'Lion Dog',
        'Creates a costly guardian whose sacrifice settles before revival and verdict.',
        'Pup and intercept remain reusable protection.',
        'The guardian despawns on owner defeat and cannot revive a terminal result.',
      ],
    ],
  },
  {
    zodiac: 'boar',
    creature: 'iron boar',
    role: 'breakthrough-displacement',
    stages: [
      [
        'Iron Piglet',
        'Creates a compact body that pushes through one collision-valid route.',
        'The piglet remains a cheap displacement tool.',
      ],
      [
        'Charge Order',
        'Commands a charge at a legally observed hostile.',
        'Autonomous route pressure remains useful.',
      ],
      [
        'Hammer Relay',
        'Coordinates owner impact and boar displacement in ordinary settlement.',
        'The boar can still displace without owner commitment.',
      ],
      [
        'Boar Vessel',
        'Possesses the owner with finite breakthrough capability and bounded release.',
        'The separate body retains independent route pressure.',
        'Possession removes that collision body and cannot add a turn.',
      ],
      [
        'Twin Tusks',
        'Uses two ordinal-stable boars for separate bounded breakthroughs.',
        'One boar remains cheaper and leaves capacity.',
        'Two bodies fill the cap and pay independent upkeep.',
      ],
      [
        'Demon Boar',
        'Creates a costly spirit whose heavy hit, drain and guard resolve simultaneously.',
        'Earlier displacement remains safer and repeatable.',
        'High upkeep, finite lifetime and long recovery expose the owner after impact.',
      ],
    ],
  },
] as const satisfies readonly Branch[];

const mechanismsByDan = {
  1: ['ownership', 'hostility', 'rng-identity', 'victory-bounds', 'persistence'],
  2: ['subject-clock', 'observed-command', 'rng-identity', 'replay'],
  3: ['guard-drain-settlement', 'defeat-revival', 'victory-bounds', 'replay'],
  4: ['subject-clock', 'possession-release', 'persistence', 'reverse-seek'],
  5: ['rng-identity', 'capacity-upkeep-expiry', 'owner-despawn', 'viewer-2d-3d'],
  6: [
    'guard-drain-settlement',
    'defeat-revival',
    'owner-despawn',
    'capacity-upkeep-expiry',
    'replay',
    'viewer-2d-3d',
    'reverse-seek',
  ],
} as const satisfies Record<SkillDan, readonly SummoningRuntimeMechanism[]>;

export type SummoningFixtureContract = {
  id: string;
  nodeId: string;
  status: 'runtime-pending';
  missingMechanisms: readonly SummoningRuntimeMechanism[];
  assertions: readonly string[];
};

export const SUMMONING_FIXTURE_RELEASE_GATE = {
  lifecycle: 'draft-until-executable',
  compatibility:
    'Stored manifests without dependent records retain the legacy two-participant behavior.',
  rollback:
    'Disable new dependent execution and publication; retain saved records for display without rewriting them.',
  evidence:
    'Every contract must bind an executable engine test plus API, Worker, SQLite, replay, reverse-seek, 2D and 3D evidence before its node can leave draft.',
} as const;

const nodeId = (zodiac: Branch['zodiac'], dan: SkillDan) => `skill.summoning.${zodiac}.${dan}`;
const fixtureId = (zodiac: Branch['zodiac'], dan: SkillDan) =>
  `fixture.skill.summoning.${zodiac}.${dan}.contract`;

export const SUMMONING_SKILL_NODES: readonly SkillNode[] = branches.flatMap((branch) =>
  branch.stages.map((stage, index) => {
    const dan = (index + 1) as SkillDan;
    const [name, behavior, lowerUse, tradeoff] = stage;
    return {
      id: nodeId(branch.zodiac, dan),
      coordinate: { path: 'summoning', zodiac: branch.zodiac, dan },
      name,
      description: `${behavior} ${lowerUse}`,
      lifecycle: 'draft',
      prerequisites: dan === 1 ? [] : [nodeId(branch.zodiac, (dan - 1) as SkillDan)],
      deepening: {
        kind: deepeningKinds[index]!,
        explanation: `${behavior} Lower-dan use retained: ${lowerUse}`,
        retainsLowerUse: true,
        ...(tradeoff ? { conditionOrTradeoff: tradeoff } : {}),
      },
      pathRoleTags: ['summon-command-possession', branch.role],
      resolution: [],
      fixtureIds: [fixtureId(branch.zodiac, dan)],
    } satisfies SkillNode;
  }),
);

export const SUMMONING_FIXTURE_CONTRACTS: readonly SummoningFixtureContract[] = branches.flatMap(
  (branch) =>
    branch.stages.map((stage, index) => {
      const dan = (index + 1) as SkillDan;
      const behavior = stage[1];
      return {
        id: fixtureId(branch.zodiac, dan),
        nodeId: nodeId(branch.zodiac, dan),
        status: 'runtime-pending',
        missingMechanisms: mechanismsByDan[dan],
        assertions: [
          `Create ${branch.creature} allied with its immutable owner slot; hostility derives from the opposing owner slot; retain the committed ordinal.`,
          `${behavior} Preserve exactly two participants; dependents never decide victory.`,
          'Persist lifecycle records and reconstruct forward, seek, reverse, 2D and 3D views without rerunning AI.',
        ],
      };
    }),
);

/** Authoring shard only. Draft nodes cannot resolve into a battle until their contracts execute. */
export const SUMMONING_SKILL_CATALOG_SHARD = {
  schemaVersion: 1,
  catalogId: 'skill-catalog-v1',
  catalogRevision: 1,
  path: 'summoning',
  nodes: [...SUMMONING_SKILL_NODES],
};
