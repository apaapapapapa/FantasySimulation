import type { BranchPlan, PathEvidence } from './martial-authoring.ts';
import { buildPathShard, evidenceForPath } from './martial-authoring.ts';

const branches = [
  {
    zodiac: 'rat',
    branch: 'opening initiative',
    roleTags: ['continuous-offense-defense', 'initiative'],
    missingMechanisms: ['initiative-window'],
    dans: [
      {
        name: 'Opening cut',
        use: 'A direct low-commitment cut starts the exchange.',
        deepening: 'Establishes a reliable opening without requiring prior state.',
      },
      {
        name: 'Committed opening cut',
        use: 'A stamina-paid step turns an opening into forward pressure.',
        deepening: 'Adds resource readiness and approach distance to the foundation.',
      },
      {
        name: 'Opening return cut',
        use: 'A separately timed return strike follows the first contact.',
        deepening: 'Links two paid timings while leaving the single cut safer.',
      },
      {
        name: 'Advancing opening cut',
        use: 'A committed dash attacks while changing engagement distance.',
        deepening: 'Turns initiative into a positional approach mode.',
      },
      {
        name: 'Opening circle',
        use: 'A radial sweep contests nearby approaches instead of one line.',
        deepening: 'Specializes the opener for surrounding space rather than a single target.',
        conditionOrTradeoff: 'Requires stamina, cooldown and a long active sweep.',
      },
      {
        name: 'Decisive opening circle',
        use: 'A trained radial release accepts recovery exposure for broad pressure.',
        deepening:
          'Combines the branch tools into a high-commitment opening without replacing the direct cut.',
        conditionOrTradeoff:
          'Retains the stamina cost, active commitment, recovery opening and cooldown.',
      },
    ],
  },
  {
    zodiac: 'ox',
    branch: 'held guard pressure',
    roleTags: ['continuous-offense-defense', 'accumulation'],
    missingMechanisms: ['held-guard-charge', 'guard-release'],
    dans: [
      {
        name: 'Rooted guard',
        use: 'The sword stays between combatants while footing is settled.',
        deepening: 'Creates a patient guard whose value is time held, not extra damage.',
      },
      {
        name: 'Stored edge',
        use: 'A clean guarded interval prepares a stronger next entry.',
        deepening: 'Adds a preparation condition that can be interrupted.',
      },
      {
        name: 'Guarded cadence',
        use: 'Guard, step and cut alternate without abandoning the line.',
        deepening: 'Combines stored posture with a later attack window.',
      },
      {
        name: 'Anchor stance',
        use: 'The user chooses stability against force or freedom to advance.',
        deepening: 'Makes accumulation a stance choice rather than a passive multiplier.',
      },
      {
        name: 'Patient pressure',
        use: 'Holding the line narrows the opponent route but yields tempo.',
        deepening: 'Specializes in space denial while deliberately acting later.',
        conditionOrTradeoff: 'Requires uninterrupted guard time and concedes immediate initiative.',
      },
      {
        name: 'Immovable edge',
        use: 'Stored posture is released into one guarded advance, then must be rebuilt.',
        deepening: 'Spends all accumulated guard state for a bounded decisive exchange.',
        conditionOrTradeoff:
          'Consumes the full stored state and imposes a recovery interval if it misses.',
      },
    ],
  },
  {
    zodiac: 'tiger',
    branch: 'guard-breaking pressure',
    roleTags: ['continuous-offense-defense', 'pressure'],
    missingMechanisms: ['posture-damage', 'guard-break'],
    dans: [
      {
        name: 'Driving cut',
        use: 'A committed cut pushes against a defended line.',
        deepening: 'Establishes pressure through commitment instead of reach.',
      },
      {
        name: 'Edge bind',
        use: 'Contact with an active guard creates a brief follow-up opening.',
        deepening: 'Adds a defender-state condition to the driving cut.',
      },
      {
        name: 'Press and return',
        use: 'A driving cut is paired with a return strike after a successful bind.',
        deepening: 'Combines pressure and continuation only when contact was established.',
      },
      {
        name: 'High-low pressure',
        use: 'The user chooses a posture attack or a safer body line.',
        deepening: 'Turns the branch into a readable tactical fork.',
      },
      {
        name: 'Crushing measure',
        use: 'Close-range pressure spends stamina to contest a stable guard.',
        deepening: 'Specializes against braced defense while remaining poor at pursuit.',
        conditionOrTradeoff: 'Requires close guarded contact and significant stamina.',
      },
      {
        name: 'Tiger gate break',
        use: 'A fully committed sequence attempts to open one defended lane.',
        deepening:
          'Converts accumulated pressure into a finite break attempt, not universal penetration.',
        conditionOrTradeoff:
          'Long wind-up and recovery; failure leaves the user exposed and does not bypass barriers.',
      },
    ],
  },
  {
    zodiac: 'rabbit',
    branch: 'evasive disengagement',
    roleTags: ['continuous-offense-defense', 'evasion'],
    missingMechanisms: ['evasive-slash', 'disengage-route'],
    dans: [
      {
        name: 'Parting cut',
        use: 'A short cut covers a backward step out of melee.',
        deepening: 'Establishes escape as spacing rather than invulnerability.',
      },
      {
        name: 'Slip the line',
        use: 'The exit gains value only when it leaves the incoming attack line.',
        deepening: 'Adds a geometry condition to the parting cut.',
      },
      {
        name: 'Part and answer',
        use: 'A successful disengagement can feed a later re-entry cut.',
        deepening: 'Links escape position to a separate counter opportunity.',
      },
      {
        name: 'Left-right withdrawal',
        use: 'The user chooses the safer lateral exit from observed space.',
        deepening: 'Makes disengagement a route-selection tactic.',
      },
      {
        name: 'Vanishing measure',
        use: 'A narrow timing window trades attack pressure for reliable separation.',
        deepening: 'Specializes in leaving contact while surrendering the current exchange.',
        conditionOrTradeoff: 'Requires a legal open route and forfeits immediate follow-up.',
      },
      {
        name: 'Hare across the blade',
        use: 'One dangerous cross-line exit seeks a superior re-entry angle.',
        deepening: 'Combines evasion and repositioning without erasing collision or observation.',
        conditionOrTradeoff:
          'Fails against blocked routes and carries a long recovery if intercepted.',
      },
    ],
  },
  {
    zodiac: 'dragon',
    branch: 'nearby space control',
    roleTags: ['continuous-offense-defense', 'area-control'],
    missingMechanisms: ['persistent-melee-zone', 'route-pressure'],
    dans: [
      {
        name: 'Turning sweep',
        use: 'A broad cut contests nearby lateral space.',
        deepening: 'Establishes area control through blade geometry.',
      },
      {
        name: 'Wall-side sweep',
        use: 'The sweep is strongest when terrain removes one escape side.',
        deepening: 'Adds a terrain and positioning condition.',
      },
      {
        name: 'Crossing arcs',
        use: 'Two differently timed arcs cover approach then retreat.',
        deepening: 'Combines shapes while preserving gaps between them.',
      },
      {
        name: 'Open or closed circle',
        use: 'The user chooses a full sweep or a shorter guarded arc.',
        deepening: 'Adds a tactical coverage-versus-recovery choice.',
      },
      {
        name: 'Dragon perimeter',
        use: 'Sustained arcs defend a small perimeter but consume movement freedom.',
        deepening: 'Specializes in holding local space rather than chasing.',
        conditionOrTradeoff:
          'Requires room to rotate and prevents fast pursuit during the sequence.',
      },
      {
        name: 'Heaven-turning ring',
        use: 'A committed final rotation pressures every clear nearby lane once.',
        deepening:
          'Maximizes bounded local coverage while retaining terrain and recovery counters.',
        conditionOrTradeoff:
          'Long active time, stamina cost and recovery; walls and distance remain effective.',
      },
    ],
  },
  {
    zodiac: 'snake',
    branch: 'blade-line restraint',
    roleTags: ['continuous-offense-defense', 'restraint'],
    missingMechanisms: ['weapon-bind', 'escape-pressure'],
    dans: [
      {
        name: 'Checking edge',
        use: 'The blade occupies the direct route between opponent and user.',
        deepening: 'Establishes restraint through threat position, not a hard stun.',
      },
      {
        name: 'Contact check',
        use: 'Meeting an opposing weapon briefly limits its immediate line.',
        deepening: 'Adds a contact condition and finite duration.',
      },
      {
        name: 'Check and circle',
        use: 'A checked line is combined with a step toward the open side.',
        deepening: 'Links restraint to positioning rather than extra damage.',
      },
      {
        name: 'Bind or release',
        use: 'The user chooses to hold contact or release into a safer cut.',
        deepening: 'Creates a tactical commitment choice.',
      },
      {
        name: 'Coiling measure',
        use: 'Sustained contact taxes both users while narrowing escape.',
        deepening: 'Specializes in pressure that the opponent can break by separating.',
        conditionOrTradeoff:
          'Requires maintained weapon contact and drains stamina from the holder.',
      },
      {
        name: 'Serpent lock line',
        use: 'A final bind attempts one controlled displacement before releasing.',
        deepening: 'Adds a bounded payoff without converting restraint into indefinite capture.',
        conditionOrTradeoff:
          'Breaks on lost contact, costs stamina and cannot prevent attacks from other lines.',
      },
    ],
  },
  {
    zodiac: 'horse',
    branch: 'mobile pursuit',
    roleTags: ['continuous-offense-defense', 'mobility'],
    missingMechanisms: ['moving-melee-chain', 'pursuit-memory'],
    dans: [
      {
        name: 'Passing cut',
        use: 'A cut is delivered while continuing through the engagement.',
        deepening: 'Establishes mobility without free turning or extra reach.',
      },
      {
        name: 'Stride timing',
        use: 'The passing cut gains a follow-up only after a legal advancing step.',
        deepening: 'Adds a movement-completion condition.',
      },
      {
        name: 'Running exchange',
        use: 'Two cuts alternate across separate pursuit steps.',
        deepening: 'Combines attacks with bounded movement intervals.',
      },
      {
        name: 'Chase or cross',
        use: 'The user chooses direct pursuit or a lateral crossing route.',
        deepening: 'Turns mobility into a route tactic.',
      },
      {
        name: 'Relentless measure',
        use: 'Continued pursuit preserves pressure but steadily consumes stamina.',
        deepening: 'Specializes in following a retreat without improving defense.',
        conditionOrTradeoff: 'Requires visible route continuity and recurring stamina payment.',
      },
      {
        name: 'Thundering passage',
        use: 'A long committed pass attempts one decisive crossing strike.',
        deepening: 'Combines speed and timing while leaving turning and braking as counters.',
        conditionOrTradeoff:
          'Cannot turn sharply, is obstructed by terrain and has extended stopping recovery.',
      },
    ],
  },
  {
    zodiac: 'goat',
    branch: 'breath and expenditure',
    roleTags: ['continuous-offense-defense', 'resource-control'],
    missingMechanisms: ['action-breath-cycle', 'stamina-recovery-window'],
    dans: [
      {
        name: 'Measured cut',
        use: 'A conservative cut preserves room to recover stamina.',
        deepening: 'Establishes efficiency by lowering commitment, not increasing power.',
      },
      {
        name: 'Breath interval',
        use: 'Completing a quiet recovery interval prepares the next exchange.',
        deepening: 'Adds a no-attack condition to resource recovery.',
      },
      {
        name: 'Cut and settle',
        use: 'A light attack is paired with a deliberate recovery beat.',
        deepening: 'Combines offense and resource timing without making either free.',
      },
      {
        name: 'Fast or frugal rhythm',
        use: 'The user chooses pressure cadence or stamina-preserving cadence.',
        deepening: 'Creates an explicit tactical resource mode.',
      },
      {
        name: 'Unbroken breath',
        use: 'A maintained rhythm reduces waste until movement or impact disrupts it.',
        deepening: 'Specializes in stable exchanges while remaining vulnerable to disruption.',
        conditionOrTradeoff: 'Ends on forced movement, heavy impact or cadence break.',
      },
      {
        name: 'Goat-cloud rhythm',
        use: 'A complete breath cycle supports one extended attack-and-guard sequence.',
        deepening: 'Combines resource control with continuity but never restores spent time.',
        conditionOrTradeoff:
          'Requires preparation without interruption and imposes a cooldown after the sequence.',
      },
    ],
  },
  {
    zodiac: 'monkey',
    branch: 'feint and adaptation',
    roleTags: ['continuous-offense-defense', 'adaptation'],
    missingMechanisms: ['action-feint', 'observed-response-branch'],
    dans: [
      {
        name: 'False opening',
        use: 'A readable first motion invites a response before the real cut.',
        deepening: 'Establishes a feint that costs time and reveals intent.',
      },
      {
        name: 'Taken bait',
        use: 'The follow-up becomes available only after an observed defensive response.',
        deepening: 'Adds an observation-bound condition.',
      },
      {
        name: 'Feint and return',
        use: 'A false entry links to one of two later attack lines.',
        deepening: 'Combines deception with a bounded follow-up choice.',
      },
      {
        name: 'Changing guard',
        use: 'The user switches between attack invitation and defensive invitation.',
        deepening: 'Turns adaptation into a visible tactical mode.',
      },
      {
        name: 'Borrowed cadence',
        use: 'Repeated observation allows one response-timed variation.',
        deepening: 'Specializes against a demonstrated cadence without reading hidden policy.',
        conditionOrTradeoff:
          'Requires delivered observations and expires when the cadence changes.',
      },
      {
        name: 'Hundred-face exchange',
        use: 'A committed sequence selects among recorded responses at each legal boundary.',
        deepening: 'Combines learned observations without predicting future random choices.',
        conditionOrTradeoff:
          'High decision and stamina cost; unknown responses and interruption defeat the sequence.',
      },
    ],
  },
  {
    zodiac: 'rooster',
    branch: 'read and intercept',
    roleTags: ['continuous-offense-defense', 'observation'],
    missingMechanisms: ['melee-telegraph-observation', 'intercept-window'],
    dans: [
      {
        name: 'Watching point',
        use: 'The sword remains ready while the user waits for visible commitment.',
        deepening: 'Establishes observation as delayed evidence, not foreknowledge.',
      },
      {
        name: 'Read the shoulder',
        use: 'A clear delivered attack cue opens a narrow interception window.',
        deepening: 'Adds an observed-telegraph condition.',
      },
      {
        name: 'Read and return',
        use: 'A successful interception links to a separate restrained counter.',
        deepening: 'Combines defense and offense only after the read succeeds.',
      },
      {
        name: 'Near or far watch',
        use: 'The user chooses to watch weapon motion or approach movement.',
        deepening: 'Creates a tactical observation scope.',
      },
      {
        name: 'Clear-mirror guard',
        use: 'Sustained focus improves one class of read while slowing proactive attacks.',
        deepening: 'Specializes in evidence quality at the cost of initiative.',
        conditionOrTradeoff:
          'Requires maintained visibility and forbids immediate proactive pressure.',
      },
      {
        name: 'Dawn interception',
        use: 'One fully observed commitment can be met by a decisive timed cut.',
        deepening: 'Caps the branch with an interruptible evidence-bound response.',
        conditionOrTradeoff:
          'No effect against unseen or withheld actions; a false read causes full recovery exposure.',
      },
    ],
  },
  {
    zodiac: 'dog',
    branch: 'guarded response',
    roleTags: ['continuous-offense-defense', 'defensive-response'],
    missingMechanisms: ['melee-guard-window', 'guard-counter-link'],
    dans: [
      {
        name: 'Receiving blade',
        use: 'A compact guard seeks to reduce one incoming melee exchange.',
        deepening: 'Establishes defense with direction and timing limits.',
      },
      {
        name: 'Firm receive',
        use: 'A correctly faced contact preserves posture for a later action.',
        deepening: 'Adds facing and contact conditions.',
      },
      {
        name: 'Receive and answer',
        use: 'A successful receive links to a separately timed counter cut.',
        deepening: 'Combines guard and response without automatic retaliation.',
      },
      {
        name: 'Guard high or low',
        use: 'The user chooses which visible attack line to cover.',
        deepening: 'Makes defense a tactical coverage choice.',
      },
      {
        name: 'Hound at the gate',
        use: 'Repeated guarded responses hold a lane but yield flanking space.',
        deepening: 'Specializes in frontal defense with an explicit side weakness.',
        conditionOrTradeoff: 'Covers one facing sector and consumes stamina on contact.',
      },
      {
        name: 'Faithful last answer',
        use: 'A final guarded response commits remaining stamina to one counter.',
        deepening: 'Combines receive and counter while preserving range and direction counters.',
        conditionOrTradeoff:
          'Requires a successful guard, spends remaining reserve and cannot answer attacks outside the sector.',
      },
    ],
  },
  {
    zodiac: 'boar',
    branch: 'decisive breakthrough',
    roleTags: ['continuous-offense-defense', 'breakthrough'],
    missingMechanisms: ['committed-breakthrough', 'miss-recovery'],
    dans: [
      {
        name: 'Driving entry',
        use: 'A direct committed entry trades safety for closing pressure.',
        deepening: 'Establishes breakthrough through risk rather than guaranteed penetration.',
      },
      {
        name: 'Open-lane charge',
        use: 'The entry proceeds only while the observed route remains clear.',
        deepening: 'Adds a route and visibility condition.',
      },
      {
        name: 'Break and return',
        use: 'A successful entry links to a retreating cut that restores distance.',
        deepening: 'Combines commitment with a separate exit plan.',
      },
      {
        name: 'Body or weapon line',
        use: 'The user chooses direct collision pressure or a narrower blade line.',
        deepening: 'Creates a tactical risk and target-shape fork.',
      },
      {
        name: 'Boar through the gate',
        use: 'Stamina and recovery are spent to challenge one defended opening.',
        deepening: 'Specializes in one lane while remaining vulnerable to sidestep.',
        conditionOrTradeoff: 'Requires a clear straight route and leaves long recovery on miss.',
      },
      {
        name: 'Life-on-the-edge passage',
        use: 'One maximum-commitment entry seeks a decisive exchange then ends the sequence.',
        deepening: 'Caps the branch with explicit cost and failure exposure, not an absolute hit.',
        conditionOrTradeoff:
          'Consumes substantial stamina, cannot redirect after launch and exposes the user if blocked or evaded.',
      },
    ],
  },
] as const satisfies readonly BranchPlan[];

const hash = (value: string) => value as `sha256:${string}`;
const fixtureFiles = [
  'apps/api/src/db/startup-skill-catalog.ts',
  'apps/api/src/db/startup-data.test.ts',
] as const;
const evidence = {
  'skill.sword.rat.1': {
    status: 'proven',
    recipe: {
      kind: 'active-ability',
      ability: {
        id: 'sword',
        revision: 1,
        contentHash: hash(
          'sha256:57dba4284d2a6b5edfeaf6e254ac3e9ed62496b646a6d6e2b658134399892fef',
        ),
      },
    },
    fixtureIds: ['fixture.skill.sword.rat.1.action'],
    evidenceFiles: fixtureFiles,
  },
  'skill.sword.rat.2': {
    status: 'proven',
    recipe: {
      kind: 'active-ability',
      ability: {
        id: 'stamina-strike-v1',
        revision: 1,
        contentHash: hash(
          'sha256:d516c37829bbc6708998e73ba9ed58538d42a67495ff4b2ffd8b1e4b686671fc',
        ),
      },
    },
    fixtureIds: ['fixture.skill.sword.rat.2.action'],
    evidenceFiles: fixtureFiles,
  },
  'skill.sword.rat.3': {
    status: 'proven',
    recipe: {
      kind: 'active-ability',
      ability: {
        id: 'return-cut-v1',
        revision: 1,
        contentHash: hash(
          'sha256:396d51406e90fb6d783f0b9037d39f6bcd7f8c034624096c90db34edf3934b7f',
        ),
      },
    },
    fixtureIds: ['fixture.skill.sword.rat.3.action'],
    evidenceFiles: fixtureFiles,
  },
  'skill.sword.rat.4': {
    status: 'proven',
    recipe: {
      kind: 'active-ability',
      ability: {
        id: 'dash-cut-v1',
        revision: 1,
        contentHash: hash(
          'sha256:83b5bde59f56974f3d5296cab92ad3ecab7ada9524e5acea37208c083cc8c20c',
        ),
      },
    },
    fixtureIds: ['fixture.skill.sword.rat.4.action'],
    evidenceFiles: fixtureFiles,
  },
  'skill.sword.rat.5': {
    status: 'proven',
    recipe: {
      kind: 'active-ability',
      ability: {
        id: 'wide-sweep-v1',
        revision: 1,
        contentHash: hash(
          'sha256:aed1d678df594a94b60acf1a0d6ba191ac41a9e8c1da84703dd4dfaae8622a18',
        ),
      },
    },
    fixtureIds: ['fixture.skill.sword.rat.5.action'],
    evidenceFiles: fixtureFiles,
  },
  'skill.sword.rat.6': {
    status: 'proven',
    recipe: {
      kind: 'active-ability',
      ability: {
        id: 'wide-sweep-trained-v1',
        revision: 1,
        contentHash: hash(
          'sha256:bab5ea0a1fcd1fc011581c516ec78303c61ba5c7ac7f85dda18e515aa789e76a',
        ),
      },
    },
    fixtureIds: ['fixture.skill.sword.rat.6.action'],
    evidenceFiles: fixtureFiles,
  },
} as const satisfies PathEvidence;

export const swordSkillShard = buildPathShard('sword', branches, evidence);
export const swordSkillEvidence = evidenceForPath('sword', branches, evidence);
