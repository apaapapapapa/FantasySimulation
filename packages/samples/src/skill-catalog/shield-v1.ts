import type { BranchPlan, PathEvidence } from './martial-authoring.ts';
import { buildPathShard, evidenceForPath } from './martial-authoring.ts';

const branches = [
  {
    zodiac: 'rat',
    branch: 'snap guard initiative',
    roleTags: ['guard-protection-displacement', 'initiative'],
    missingMechanisms: ['quick-guard', 'guard-initiative-window'],
    dans: [
      {
        name: 'First cover',
        use: 'A compact shield raise covers one declared line before a longer stance forms.',
        deepening: 'Establishes a fast guard with narrow coverage.',
      },
      {
        name: 'Beat the blow',
        use: 'The cover gains priority only against a delivered attack cue.',
        deepening: 'Adds an observation-bound timing condition.',
      },
      {
        name: 'Cover and step',
        use: 'A snap guard is followed by one legal repositioning step.',
        deepening: 'Combines protection and movement as separate commitments.',
      },
      {
        name: 'Meet or yield',
        use: 'The bearer chooses an early collision or a guarded withdrawal.',
        deepening: 'Creates a timing-versus-space tactic.',
      },
      {
        name: 'Dawn rampart',
        use: 'A prepared opening guard protects a wider sector but reveals the chosen facing.',
        deepening: 'Specializes the opener for coverage rather than mobility.',
        conditionOrTradeoff:
          'Requires a declared facing and loses value if the opponent changes approach.',
      },
      {
        name: 'Shield before thunder',
        use: 'One fully prepared interception absorbs an opening exchange before a long reset.',
        deepening: 'Caps initiative with a counterable commitment rather than universal priority.',
        conditionOrTradeoff:
          'Must be prepared before the attack; wrong facing or a feint causes full recovery exposure.',
      },
    ],
  },
  {
    zodiac: 'ox',
    branch: 'braced endurance',
    roleTags: ['guard-protection-displacement', 'accumulation'],
    missingMechanisms: ['braced-guard', 'guard-fatigue'],
    dans: [
      {
        name: 'Set shield',
        use: 'A steady guard covers the bearer while facing the incoming line.',
        deepening: 'Establishes ordinary directional protection as the low-commitment option.',
      },
      {
        name: 'Rooted brace',
        use: 'Remaining stationary strengthens the next valid shield contact.',
        deepening: 'Adds a posture and no-movement condition.',
      },
      {
        name: 'Brace and breathe',
        use: 'A held guard is paired with a deliberate stamina recovery interval.',
        deepening: 'Combines protection with resource timing without making either free.',
      },
      {
        name: 'Stand or give ground',
        use: 'The bearer chooses a stronger brace or a controlled guarded retreat.',
        deepening: 'Creates a posture-versus-space tactic.',
      },
      {
        name: 'Ox-wall stance',
        use: 'Repeated frontal contacts are resisted while flank coverage and mobility narrow.',
        deepening: 'Specializes sustained frontal defense with explicit side weakness.',
        conditionOrTradeoff:
          'Requires stable footing, consumes stamina on contact and covers only the declared sector.',
      },
      {
        name: 'Mountain-bearing guard',
        use: 'A complete brace commits the shield to one severe incoming exchange.',
        deepening:
          'Spends accumulated stance on bounded protection while retaining quick set shield.',
        conditionOrTradeoff:
          'Long preparation, no redirection after impact begins and major posture loss if bypassed.',
      },
    ],
  },
  {
    zodiac: 'tiger',
    branch: 'shield pressure',
    roleTags: ['guard-protection-displacement', 'pressure'],
    missingMechanisms: ['shield-bash', 'shield-posture-pressure'],
    dans: [
      {
        name: 'Pressing rim',
        use: 'A short shield contact contests an adjacent opponent without guaranteeing movement.',
        deepening: 'Establishes pressure through contact geometry.',
      },
      {
        name: 'Off-balance press',
        use: 'Pressure increases only after contact meets an unstable posture.',
        deepening: 'Adds a posture-state condition.',
      },
      {
        name: 'Guard and shoulder',
        use: 'A valid block links to a separately resolved shield press.',
        deepening: 'Combines defense and pressure without an automatic bash.',
      },
      {
        name: 'Pin or drive',
        use: 'The bearer chooses to hold a contact line or spend effort on displacement.',
        deepening: 'Creates a restraint-versus-movement tactic.',
      },
      {
        name: 'Tiger-gate impact',
        use: 'A committed bash challenges posture in one narrow forward lane.',
        deepening: 'Specializes forward pressure while exposing the sides.',
        conditionOrTradeoff:
          'Requires adjacent contact, sufficient posture and a clear destination cell.',
      },
      {
        name: 'Rampart-breaking charge',
        use: 'A fully committed shield drive attempts one decisive displacement chain.',
        deepening:
          'Caps pressure with collision and recovery liabilities rather than forced movement.',
        conditionOrTradeoff:
          'Consumes major stamina, follows a fixed route and fails against invalid or occupied destinations.',
      },
    ],
  },
  {
    zodiac: 'rabbit',
    branch: 'covered withdrawal',
    roleTags: ['guard-protection-displacement', 'evasion'],
    missingMechanisms: ['guarded-retreat', 'rearward-guard-penalty'],
    dans: [
      {
        name: 'Backing cover',
        use: 'A narrow guard protects one line during a short retreat.',
        deepening: 'Establishes defensive movement with reduced coverage.',
      },
      {
        name: 'Clear-step cover',
        use: 'The guard persists only when the retreat destination is legal and visible.',
        deepening: 'Adds route and movement-completion conditions.',
      },
      {
        name: 'Cover, step, reset',
        use: 'A protected withdrawal links to a later stationary guard reset.',
        deepening: 'Combines escape and rebuilding defense.',
      },
      {
        name: 'Slip left or right',
        use: 'The bearer chooses one lateral retreat while keeping the shield toward danger.',
        deepening: 'Turns evasion into a facing tactic.',
      },
      {
        name: 'Hare-gap retreat',
        use: 'Successive guarded steps preserve distance but accumulate posture loss.',
        deepening: 'Specializes survival while conceding stability.',
        conditionOrTradeoff: 'Requires open terrain and weakens until a stationary reset.',
      },
      {
        name: 'Moon-rabbit passage',
        use: 'One committed escape route retains frontal cover until its endpoint.',
        deepening: 'Combines relocation and defense without immunity from flanks or obstacles.',
        conditionOrTradeoff:
          'High stamina cost, declared route and immediate cancellation on collision or rear contact.',
      },
    ],
  },
  {
    zodiac: 'dragon',
    branch: 'protective perimeter',
    roleTags: ['guard-protection-displacement', 'area-control'],
    missingMechanisms: ['shield-protection-zone', 'allied-cover-sector'],
    dans: [
      {
        name: 'Claimed frontage',
        use: 'The shield contests one adjacent approach cell in its facing.',
        deepening: 'Establishes local control through body and shield geometry.',
      },
      {
        name: 'Overlapping cover',
        use: 'Protection extends only where bearer, ally and threat line align.',
        deepening: 'Adds an explicit spatial relationship condition.',
      },
      {
        name: 'Three-point screen',
        use: 'A central guard links two later facing changes with visible gaps.',
        deepening: 'Combines sectors without creating omnidirectional cover.',
      },
      {
        name: 'Narrow or broad wall',
        use: 'The bearer chooses dense personal cover or thinner allied frontage.',
        deepening: 'Creates a tactical coverage mode.',
      },
      {
        name: 'Dragon-court rampart',
        use: 'A prepared formation contests a bounded front while restricting movement.',
        deepening: 'Specializes in area protection rather than pursuit.',
        conditionOrTradeoff: 'Requires adjacent allies, declared facings and maintained formation.',
      },
      {
        name: 'Heaven-encircling wall',
        use: 'A final coordinated screen protects a bounded group from observed lanes.',
        deepening:
          'Maximizes planned coverage while preserving gaps, timing and formation counters.',
        conditionOrTradeoff:
          'Long setup, high shared stamina cost and collapse when spacing or facing breaks.',
      },
    ],
  },
  {
    zodiac: 'snake',
    branch: 'shield-line restraint',
    roleTags: ['guard-protection-displacement', 'restraint'],
    missingMechanisms: ['shield-pin', 'contact-escape-route'],
    dans: [
      {
        name: 'Checking edge',
        use: 'The shield edge contests one adjacent escape line.',
        deepening: 'Establishes restraint by contact threat, not immobilization.',
      },
      {
        name: 'Wall-side check',
        use: 'A check strengthens only when legal terrain bounds the opposite side.',
        deepening: 'Adds a terrain relationship condition.',
      },
      {
        name: 'Check and turn',
        use: 'A valid contact links to one facing change that redirects the open route.',
        deepening: 'Combines restraint and orientation while preserving an exit.',
      },
      {
        name: 'Hold or herd',
        use: 'The bearer chooses to maintain contact or yield one escape direction.',
        deepening: 'Creates a tactical restraint mode.',
      },
      {
        name: 'Coiling bulwark',
        use: 'Sustained shield contact narrows movement while draining both posture and attention.',
        deepening: 'Specializes temporary restraint with ongoing costs.',
        conditionOrTradeoff:
          'Requires adjacent contact and valid footing; separation immediately ends it.',
      },
      {
        name: 'Serpent-gate pin',
        use: 'A final brace attempts a brief pin against a valid supporting surface.',
        deepening: 'Adds a bounded pin with explicit geometry and escape conditions.',
        conditionOrTradeoff:
          'Requires a legal surface, cannot cross bodies or terrain and ends on break, turn or expiry.',
      },
    ],
  },
  {
    zodiac: 'horse',
    branch: 'advancing screen',
    roleTags: ['guard-protection-displacement', 'mobility'],
    missingMechanisms: ['moving-guard', 'formation-advance'],
    dans: [
      {
        name: 'Walking guard',
        use: 'A shield remains raised during steady forward movement with reduced coverage.',
        deepening: 'Establishes mobile protection with a measurable guard cost.',
      },
      {
        name: 'Stride cover',
        use: 'Coverage strengthens only at one stable point in the movement cycle.',
        deepening: 'Adds a cadence condition.',
      },
      {
        name: 'Advance, cover, advance',
        use: 'Two movement segments bracket one settled guard interval.',
        deepening: 'Combines relocation and defense without simultaneous free protection.',
      },
      {
        name: 'Escort or pursue',
        use: 'The bearer chooses an ally-paced screen or a faster personal advance.',
        deepening: 'Turns mobility into a route and beneficiary choice.',
      },
      {
        name: 'Horse-wall cadence',
        use: 'Continued motion protects a narrow column but compounds posture strain.',
        deepening: 'Specializes advancing cover at the cost of stability.',
        conditionOrTradeoff: 'Requires clear routes and accumulates strain until stopping.',
      },
      {
        name: 'Galloping rampart',
        use: 'A fixed advance schedules several guarded contact windows along one route.',
        deepening: 'Combines route and cadence without adapting to hidden future movement.',
        conditionOrTradeoff:
          'Route is fixed at start, consumes major stamina and ends on collision or forced facing change.',
      },
    ],
  },
  {
    zodiac: 'goat',
    branch: 'guard economy',
    roleTags: ['guard-protection-displacement', 'harmony'],
    missingMechanisms: ['guard-stamina-rhythm', 'contact-recovery'],
    dans: [
      {
        name: 'Measured cover',
        use: 'A conservative guard preserves stamina by covering only one likely line.',
        deepening: 'Establishes efficiency through limited commitment.',
      },
      {
        name: 'Quiet interval',
        use: 'Completing a no-contact interval prepares the next guarded exchange.',
        deepening: 'Adds a recovery condition.',
      },
      {
        name: 'Cover and settle',
        use: 'A light guard is paired with a deliberate recovery beat.',
        deepening: 'Combines defense and resource timing without free recovery.',
      },
      {
        name: 'Firm or frugal guard',
        use: 'The bearer chooses stronger contact resistance or stamina preservation.',
        deepening: 'Creates an explicit resource mode.',
      },
      {
        name: 'Unbroken shelter',
        use: 'A maintained rhythm reduces wasted guard effort until impact or movement disrupts it.',
        deepening: 'Specializes stable protection while remaining interruptible.',
        conditionOrTradeoff: 'Ends on forced movement, heavy impact or cadence break.',
      },
      {
        name: 'Goat-cloud shelter',
        use: 'A complete breath cycle supports one extended guard-and-step sequence.',
        deepening: 'Combines economy with continuity while retaining quick measured cover.',
        conditionOrTradeoff:
          'Requires uninterrupted preparation and imposes a recovery interval after the sequence.',
      },
    ],
  },
  {
    zodiac: 'monkey',
    branch: 'guard feint and adaptation',
    roleTags: ['guard-protection-displacement', 'adaptation'],
    missingMechanisms: ['guard-feint', 'observed-attack-branch'],
    dans: [
      {
        name: 'False gap',
        use: 'A visible opening invites one attack line while another remains covered.',
        deepening: 'Establishes a defensive feint that exposes real space.',
      },
      {
        name: 'Taken opening',
        use: 'The guard shift becomes available only after an observed committed response.',
        deepening: 'Adds an observation-bound condition.',
      },
      {
        name: 'Gap and catch',
        use: 'A false opening links to one separately timed shield catch.',
        deepening: 'Combines deception and defense without predicting action.',
      },
      {
        name: 'Changing frontage',
        use: 'The bearer alternates between an inviting narrow face and a broad guard.',
        deepening: 'Turns adaptation into a visible tactical mode.',
      },
      {
        name: 'Borrowed attack line',
        use: 'Repeated observation permits one response tuned to a demonstrated approach.',
        deepening: 'Specializes against delivered evidence rather than hidden policy.',
        conditionOrTradeoff:
          'Expires when the attack line changes and covers no unobserved option.',
      },
      {
        name: 'Hundred-face rampart',
        use: 'A committed defense selects among recorded responses at legal contact boundaries.',
        deepening: 'Combines learned guards without foreknowledge or universal coverage.',
        conditionOrTradeoff:
          'High attention and stamina cost; novel attacks, feints and interruption defeat it.',
      },
    ],
  },
  {
    zodiac: 'rooster',
    branch: 'threat reading',
    roleTags: ['guard-protection-displacement', 'observation'],
    missingMechanisms: ['guard-telegraph-observation', 'guard-intercept-window'],
    dans: [
      {
        name: 'Watching rim',
        use: 'The shield stays ready while the bearer waits for visible commitment.',
        deepening: 'Establishes delayed observation rather than foreknowledge.',
      },
      {
        name: 'Read the line',
        use: 'A delivered attack cue opens a narrow facing-adjustment window.',
        deepening: 'Adds an observed-telegraph condition.',
      },
      {
        name: 'Read and cover',
        use: 'A successful read links one turn to one separately resolved guard.',
        deepening: 'Combines observation and defense only after evidence arrives.',
      },
      {
        name: 'Near or far watch',
        use: 'The bearer chooses to watch weapon motion or approach movement.',
        deepening: 'Creates a tactical observation scope.',
      },
      {
        name: 'Clear-mirror shield',
        use: 'Sustained focus improves one class of read while slowing proactive movement.',
        deepening: 'Specializes evidence quality at the cost of initiative.',
        conditionOrTradeoff:
          'Requires maintained visibility and forbids immediate proactive pressure.',
      },
      {
        name: 'Dawn-facing bastion',
        use: 'One fully observed commitment can be met by a decisive timed guard.',
        deepening: 'Caps reading with an interruptible evidence-bound response.',
        conditionOrTradeoff:
          'No effect against unseen or withheld actions; a false read exposes the uncovered sector.',
      },
    ],
  },
  {
    zodiac: 'dog',
    branch: 'protective interception',
    roleTags: ['guard-protection-displacement', 'protection'],
    missingMechanisms: ['ally-intercept', 'protected-target-binding'],
    dans: [
      {
        name: 'Faithful parry',
        use: 'A timed shield motion redirects one valid incoming melee line.',
        deepening: 'Establishes directional interception with timing limits.',
      },
      {
        name: 'Arrow ward',
        use: 'A visible incoming projectile can be deflected only inside the legal reaction window.',
        deepening: 'Adds projectile observation, facing and reaction timing.',
      },
      {
        name: 'Parry and shelter',
        use: 'A successful interception links to one later cover for a nearby ally.',
        deepening: 'Combines self-defense and protection as separate reactions.',
      },
      {
        name: 'Self or companion',
        use: 'The bearer chooses personal coverage or a declared adjacent beneficiary.',
        deepening: 'Creates a tactical protection target.',
      },
      {
        name: 'Hound at the gate',
        use: 'Repeated observed threats to one frontage can be intercepted while other sectors open.',
        deepening: 'Specializes faithful protection with explicit facing weakness.',
        conditionOrTradeoff:
          'Binds one frontage and beneficiary, consumes reactions and cannot cover simultaneous lanes.',
      },
      {
        name: 'Last faithful shelter',
        use: 'A final interception commits remaining reserve to one observed threat against the beneficiary.',
        deepening: 'Caps protection without negating range, timing, cover or attack direction.',
        conditionOrTradeoff:
          'Requires a delivered threat and valid route; spends remaining reserve and leaves the bearer exposed afterward.',
      },
    ],
  },
  {
    zodiac: 'boar',
    branch: 'shield breakthrough',
    roleTags: ['guard-protection-displacement', 'breakthrough'],
    missingMechanisms: ['shield-charge', 'collision-recovery'],
    dans: [
      {
        name: 'Driving shield',
        use: 'A direct guarded entry trades turning ability for closing pressure.',
        deepening: 'Establishes breakthrough through risk rather than guaranteed displacement.',
      },
      {
        name: 'Open-lane drive',
        use: 'The entry proceeds only while the observed route remains clear.',
        deepening: 'Adds a route and visibility condition.',
      },
      {
        name: 'Drive and plant',
        use: 'A successful entry links to a separately resolved stationary guard.',
        deepening: 'Combines commitment with an endpoint defense.',
      },
      {
        name: 'Body or barrier',
        use: 'The bearer chooses opponent pressure or rapid terrain occupation.',
        deepening: 'Creates a tactical target-shape fork.',
      },
      {
        name: 'Boar through the gate',
        use: 'Stamina and recovery are spent to challenge one defended opening.',
        deepening: 'Specializes in one lane while remaining vulnerable to sidestep.',
        conditionOrTradeoff:
          'Requires a clear straight route and leaves long recovery on block or miss.',
      },
      {
        name: 'Life-bearing passage',
        use: 'One maximum-commitment drive seeks a decisive collision then ends the sequence.',
        deepening:
          'Caps breakthrough with explicit collision and failure costs, not an absolute push.',
        conditionOrTradeoff:
          'Consumes major stamina, cannot redirect after launch and stops at invalid terrain or occupied destinations.',
      },
    ],
  },
] as const satisfies readonly BranchPlan[];

const hash = (value: string) => value as `sha256:${string}`;
const evidence = {
  'skill.shield.ox.1': {
    status: 'proven',
    recipe: {
      kind: 'passive-ability',
      ability: {
        id: 'shield-set-guard-v1',
        revision: 1,
        contentHash: hash(
          'sha256:a1fe8279f9be78377331735a4f4c8f08e6bb50cd91301ba550b3e6d69a0af43d',
        ),
      },
    },
    fixtureIds: [
      'fixture.skill.shield.ox.1.guard-battle',
      'fixture.skill.shield.ox.1.guard-replay',
      'fixture.skill.shield.ox.1.guard-viewer',
    ],
    evidenceFiles: [
      'apps/api/src/http/skill-guard.integration.test.ts',
      'apps/web/src/replay/guard-display.test.ts',
    ],
  },
  'skill.shield.dog.1': {
    status: 'definition-only',
    recipe: {
      kind: 'active-ability',
      ability: {
        id: 'parry-v1',
        revision: 1,
        contentHash: hash(
          'sha256:e224015688c44cd495f7e239f990ba0439b52a9f8e00da5bffddf27e9da05980',
        ),
      },
    },
    fixtureIds: ['g08-23'],
    evidenceFiles: ['packages/engine/src/spatial/reactions.test.ts'],
    releaseBlocker:
      'Needs shield-path loadout binding, AI selection and replay provenance fixtures.',
  },
  'skill.shield.dog.2': {
    status: 'definition-only',
    recipe: {
      kind: 'active-ability',
      ability: {
        id: 'projectile-deflection-v1',
        revision: 1,
        contentHash: hash(
          'sha256:05e56186c80adbbd59ff592ea1fbab6ad5fa35115e2f3f770aabb0c05227151f',
        ),
      },
    },
    fixtureIds: ['p6-deflection-01', 'p6-deflection-07'],
    evidenceFiles: ['packages/engine/src/spatial/reactions.test.ts'],
    releaseBlocker:
      'Needs shield-path loadout binding, AI selection and replay provenance fixtures.',
  },
} as const satisfies PathEvidence;

export const shieldSkillShard = buildPathShard('shield', branches, evidence);
export const shieldSkillEvidence = evidenceForPath('shield', branches, evidence);
