import type { BranchPlan, PathEvidence } from './martial-authoring.ts';
import { buildPathShard, evidenceForPath } from './martial-authoring.ts';

const branches = [
  {
    zodiac: 'rat',
    branch: 'first-shot initiative',
    roleTags: ['range-sightline-aim', 'initiative'],
    missingMechanisms: ['quick-nock', 'initiative-shot'],
    dans: [
      {
        name: 'First loose',
        use: 'A simple arrow is loosed before a longer aiming exchange develops.',
        deepening: 'Establishes the ordinary projectile shot as the low-preparation option.',
      },
      {
        name: 'Ready nock',
        use: 'A prepared nock shortens the next release only if preparation was uninterrupted.',
        deepening: 'Adds explicit preparation rather than free speed.',
      },
      {
        name: 'First and following',
        use: 'An opening arrow is linked to one separately loaded follow-up.',
        deepening: 'Combines two ammunition and timing commitments.',
      },
      {
        name: 'Advance or loose',
        use: 'The archer chooses between taking position and releasing immediately.',
        deepening: 'Turns initiative into a movement-versus-shot tactic.',
      },
      {
        name: 'Dawn volley',
        use: 'Several prepared lines pressure an opening area but reveal the archer.',
        deepening: 'Specializes the opener for area denial rather than precision.',
        conditionOrTradeoff:
          'Requires pre-nocked ammunition, a clear firing lane and sustained exposure.',
      },
      {
        name: 'Arrow before thunder',
        use: 'One fully prepared release seeks a decisive first impact at the cost of recovery.',
        deepening:
          'Caps initiative with a visible, interruptible preparation instead of guaranteed priority.',
        conditionOrTradeoff:
          'Long preparation, no retarget after release and severe recovery on obstruction or miss.',
      },
    ],
  },
  {
    zodiac: 'ox',
    branch: 'draw accumulation',
    roleTags: ['range-sightline-aim', 'accumulation'],
    missingMechanisms: ['held-draw', 'draw-fatigue'],
    dans: [
      {
        name: 'Settled draw',
        use: 'The bow is drawn steadily while aim remains on one lane.',
        deepening: 'Establishes stored draw as time under tension.',
      },
      {
        name: 'Full anchor',
        use: 'Reaching the anchor improves release stability only while posture holds.',
        deepening: 'Adds a posture condition and interruption point.',
      },
      {
        name: 'Draw and breathe',
        use: 'A breath cycle is coordinated with anchor and release.',
        deepening: 'Combines resource rhythm with aim preparation.',
      },
      {
        name: 'Hold or let down',
        use: 'The archer chooses continued tension or a safe reset.',
        deepening: 'Creates a tactical commitment decision.',
      },
      {
        name: 'Patient full draw',
        use: 'A longer hold narrows error but accumulates fatigue.',
        deepening: 'Specializes precision with a growing resource liability.',
        conditionOrTradeoff:
          'Consumes stamina while held and loses preparation on forced movement.',
      },
      {
        name: 'Ox-horn release',
        use: 'Maximum stable draw is released once before mandatory recovery.',
        deepening: 'Spends accumulated tension for one shot without replacing quick loose.',
        conditionOrTradeoff:
          'Requires uninterrupted full draw, high stamina and a long let-down recovery.',
      },
    ],
  },
  {
    zodiac: 'tiger',
    branch: 'suppressive force',
    roleTags: ['range-sightline-aim', 'pressure'],
    missingMechanisms: ['projectile-suppression', 'cover-pressure'],
    dans: [
      {
        name: 'Driving arrow',
        use: 'A forceful shot pressures an exposed approach.',
        deepening: 'Establishes ranged pressure through a visible projectile.',
      },
      {
        name: 'Pinned lane',
        use: 'A recent near impact temporarily discourages the same clear lane.',
        deepening: 'Adds an impact-location condition instead of raw damage.',
      },
      {
        name: 'Crossing shots',
        use: 'Two shots cover different approach lines in sequence.',
        deepening: 'Combines lanes while leaving time between releases.',
      },
      {
        name: 'Press or pierce',
        use: 'The archer chooses broad suppression or a narrow aimed shot.',
        deepening: 'Creates a coverage-versus-precision tactic.',
      },
      {
        name: 'Tiger rain',
        use: 'Repeated arrows hold an open route at substantial ammunition cost.',
        deepening: 'Specializes in route pressure while sacrificing efficiency.',
        conditionOrTradeoff: 'Requires multiple arrows and uninterrupted line of fire.',
      },
      {
        name: 'Mountain-breaking shot',
        use: 'A long prepared shot challenges one defended line but not solid obstruction.',
        deepening: 'Caps pressure with a counterable committed release.',
        conditionOrTradeoff:
          'Long telegraph, high stamina and ammunition cost; terrain still blocks it.',
      },
    ],
  },
  {
    zodiac: 'rabbit',
    branch: 'shooting withdrawal',
    roleTags: ['range-sightline-aim', 'evasion'],
    missingMechanisms: ['retreating-shot', 'mobile-aim-penalty'],
    dans: [
      {
        name: 'Parting arrow',
        use: 'A low-precision arrow covers a retreat from close pressure.',
        deepening: 'Establishes escape shooting with reduced aim.',
      },
      {
        name: 'Clear-step loose',
        use: 'The shot is permitted only after a legal retreat step clears the attacker.',
        deepening: 'Adds route and movement-completion conditions.',
      },
      {
        name: 'Withdraw and reset',
        use: 'A covering arrow is linked to a later stationary aim.',
        deepening: 'Combines disengagement with rebuilding accuracy.',
      },
      {
        name: 'Side-step sight',
        use: 'The archer chooses a lateral exit that preserves one firing lane.',
        deepening: 'Turns evasion into a sightline tactic.',
      },
      {
        name: 'Hare-gap shooting',
        use: 'Repeated short withdrawals preserve distance but steadily degrade aim.',
        deepening: 'Specializes survival while conceding precision.',
        conditionOrTradeoff:
          'Requires open terrain and accumulates movement error until a stationary reset.',
      },
      {
        name: 'Moon-rabbit escape',
        use: 'One committed leap to long range permits a final covering release.',
        deepening: 'Combines escape and fire without granting immunity during movement.',
        conditionOrTradeoff:
          'Consumes major stamina, has a predictable route and cannot pass obstacles or bodies.',
      },
    ],
  },
  {
    zodiac: 'dragon',
    branch: 'ranged area control',
    roleTags: ['range-sightline-aim', 'area-control'],
    missingMechanisms: ['arrow-zone', 'volley-pattern'],
    dans: [
      {
        name: 'Marked ground',
        use: 'An arrow marks one approach point for later pressure.',
        deepening: 'Establishes area control through a recorded impact location.',
      },
      {
        name: 'Overlapping mark',
        use: 'A second shot matters only when its lane overlaps the first mark.',
        deepening: 'Adds a spatial relationship condition.',
      },
      {
        name: 'Three-lane fan',
        use: 'Sequential shots cover centre and both sides with visible gaps.',
        deepening: 'Combines firing lanes without creating an instant area hit.',
      },
      {
        name: 'Narrow or broad fan',
        use: 'The archer chooses dense local coverage or wider sparse coverage.',
        deepening: 'Creates a tactical pattern choice.',
      },
      {
        name: 'Dragon sky net',
        use: 'A prepared volley contests a bounded ground region for a short interval.',
        deepening: 'Specializes in area denial rather than target tracking.',
        conditionOrTradeoff:
          'Requires a stationary setup, ammunition and unobstructed ballistic arcs.',
      },
      {
        name: 'Heaven-covering volley',
        use: 'A final plotted pattern pressures all clear cells in one bounded region.',
        deepening: 'Maximizes planned coverage while preserving shelter and exit timing.',
        conditionOrTradeoff:
          'Large ammunition cost, long warning and no correction after the volley begins.',
      },
    ],
  },
  {
    zodiac: 'snake',
    branch: 'movement restraint',
    roleTags: ['range-sightline-aim', 'restraint'],
    missingMechanisms: ['pinning-projectile', 'escape-lane-denial'],
    dans: [
      {
        name: 'Checking shot',
        use: 'An arrow is placed across the most direct escape lane.',
        deepening: 'Establishes restraint by threat geometry, not immobilization.',
      },
      {
        name: 'Footing shot',
        use: 'The shot gains value only against an observed grounded movement start.',
        deepening: 'Adds a legal observation condition.',
      },
      {
        name: 'Check and crossfire',
        use: 'A checked lane is paired with a second shot toward the alternate exit.',
        deepening: 'Combines pressure while preserving an uncovered route.',
      },
      {
        name: 'Hold or herd',
        use: 'The archer chooses to keep one lane closed or redirect movement.',
        deepening: 'Creates a tactical restraint mode.',
      },
      {
        name: 'Coiling arrows',
        use: 'Repeated impacts narrow routes while consuming ammunition and attention.',
        deepening: 'Specializes sustained pressure with finite resources.',
        conditionOrTradeoff:
          'Requires visible movement and repeated shots; cover immediately breaks the effect.',
      },
      {
        name: 'Serpent-field pin',
        use: 'A final shot attempts a brief physical pin only at a valid surface contact.',
        deepening: 'Adds a bounded restraint payoff with explicit escape and invalid targets.',
        conditionOrTradeoff:
          'Requires surface geometry, ends on break or expiry and cannot pin through armor or terrain.',
      },
    ],
  },
  {
    zodiac: 'horse',
    branch: 'mobile shooting',
    roleTags: ['range-sightline-aim', 'mobility'],
    missingMechanisms: ['moving-shot', 'movement-aim-model'],
    dans: [
      {
        name: 'Walking loose',
        use: 'An arrow is released during steady lateral movement with reduced precision.',
        deepening: 'Establishes moving fire with a measurable accuracy cost.',
      },
      {
        name: 'Stride release',
        use: 'The shot times release to one stable point in the movement cycle.',
        deepening: 'Adds a cadence condition.',
      },
      {
        name: 'Move, loose, move',
        use: 'Two movement segments bracket one release.',
        deepening: 'Combines relocation and shooting without simultaneous free movement.',
      },
      {
        name: 'Circle or retreat',
        use: 'The archer selects lateral circling or direct withdrawal.',
        deepening: 'Turns mobility into route strategy.',
      },
      {
        name: 'Horseback cadence',
        use: 'Continued motion supports repeated fire but compounds aim error.',
        deepening: 'Specializes pursuit and kiting at the cost of precision.',
        conditionOrTradeoff: 'Requires open routes and accumulates error until stopping.',
      },
      {
        name: 'Galloping constellation',
        use: 'A long committed route schedules several releases at fixed points.',
        deepening: 'Combines route and cadence without adapting to hidden future movement.',
        conditionOrTradeoff:
          'Route is fixed at start, consumes stamina and is cancelled by collision or forced movement.',
      },
    ],
  },
  {
    zodiac: 'goat',
    branch: 'aim and resource harmony',
    roleTags: ['range-sightline-aim', 'resource-control'],
    missingMechanisms: ['aim-breath-cycle', 'ammunition-resource'],
    dans: [
      {
        name: 'Quiet loose',
        use: 'A conservative draw preserves stamina and ammunition tempo.',
        deepening: 'Establishes a low-cost shot with ordinary effect.',
      },
      {
        name: 'Breath mark',
        use: 'A completed breath interval steadies the next release.',
        deepening: 'Adds a no-interruption preparation condition.',
      },
      {
        name: 'Loose and recover',
        use: 'The shot is paired with a deliberate recovery beat.',
        deepening: 'Combines firing and resource recovery as separate phases.',
      },
      {
        name: 'Fast or frugal string',
        use: 'The archer chooses rapid expenditure or careful conservation.',
        deepening: 'Creates a resource cadence mode.',
      },
      {
        name: 'Unbroken draw cycle',
        use: 'Stable cadence reduces wasted motion until disrupted.',
        deepening: 'Specializes efficiency, not damage.',
        conditionOrTradeoff: 'Ends on sprinting, impact or a rushed release.',
      },
      {
        name: 'Cloud-flock cadence',
        use: 'A prepared reserve supports one extended sequence before a forced rest.',
        deepening: 'Combines efficiency tools while preserving ammunition and fatigue limits.',
        conditionOrTradeoff:
          'Requires a stocked reserve and imposes a long recovery after the sequence.',
      },
    ],
  },
  {
    zodiac: 'monkey',
    branch: 'feinting aim',
    roleTags: ['range-sightline-aim', 'adaptation'],
    missingMechanisms: ['aim-feint', 'observed-dodge-adaptation'],
    dans: [
      {
        name: 'False sightline',
        use: 'The archer visibly aims one lane before releasing elsewhere.',
        deepening: 'Establishes deception with additional aim time.',
      },
      {
        name: 'Taken line',
        use: 'A changed release becomes available only after an observed response.',
        deepening: 'Adds an observation-bound branch.',
      },
      {
        name: 'Feint and second nock',
        use: 'A false first aim sets up a separately loaded second shot.',
        deepening: 'Combines deception and ammunition timing.',
      },
      {
        name: 'High or low invitation',
        use: 'The archer chooses which dodge direction to invite.',
        deepening: 'Creates a visible tactical feint choice.',
      },
      {
        name: 'Borrowed dodge rhythm',
        use: 'Observed repeated movement informs one later lead angle.',
        deepening: 'Specializes against recorded behavior without reading hidden intent.',
        conditionOrTradeoff:
          'Requires delivered observations and expires when movement pattern changes.',
      },
      {
        name: 'Many-faced release',
        use: 'A fully prepared shot selects one legal lead from observed responses.',
        deepening: 'Combines evidence and feinting while retaining projectile travel and misses.',
        conditionOrTradeoff:
          'Long preparation; novel movement, cover or lost sight defeats the prediction.',
      },
    ],
  },
  {
    zodiac: 'rooster',
    branch: 'precision observation',
    roleTags: ['range-sightline-aim', 'observation'],
    missingMechanisms: ['progressive-aim', 'weak-point-observation'],
    dans: [
      {
        name: 'Sighted shot',
        use: 'A stationary look establishes a clear target line before release.',
        deepening: 'Establishes aim from delivered visibility.',
      },
      {
        name: 'Measured lead',
        use: 'Observed target velocity permits a bounded lead correction.',
        deepening: 'Adds a motion-observation condition.',
      },
      {
        name: 'Observe, range, loose',
        use: 'Separate observation and ranging phases precede the shot.',
        deepening: 'Combines evidence without exposing exact hidden state.',
      },
      {
        name: 'Body or route sight',
        use: 'The archer chooses direct target aim or anticipated route aim.',
        deepening: 'Creates a tactical observation scope.',
      },
      {
        name: 'Rooster-eye focus',
        use: 'Sustained sight narrows error while preventing mobile fire.',
        deepening: 'Specializes precision at the cost of movement.',
        conditionOrTradeoff: 'Requires continuous visibility and stationary posture.',
      },
      {
        name: 'Single-feather certainty',
        use: 'One fully ranged shot commits to the last delivered target state.',
        deepening: 'Caps precision without learning future movement or bypassing obstruction.',
        conditionOrTradeoff:
          'Loses all preparation on sight break and cannot update after release.',
      },
    ],
  },
  {
    zodiac: 'dog',
    branch: 'protective interception',
    roleTags: ['range-sightline-aim', 'defensive-response'],
    missingMechanisms: ['ranged-intercept', 'protected-lane'],
    dans: [
      {
        name: 'Answering arrow',
        use: 'A visible hostile approach can be met by one ordinary shot.',
        deepening: 'Establishes a response constrained by sight and travel time.',
      },
      {
        name: 'Protected lane',
        use: 'The response covers one declared line near the archer.',
        deepening: 'Adds a bounded protected geometry.',
      },
      {
        name: 'Watch and answer',
        use: 'A held watch links observation to a separately released arrow.',
        deepening: 'Combines readiness and response without automatic targeting.',
      },
      {
        name: 'Near or far watch',
        use: 'The archer chooses close approach or distant projectile cues.',
        deepening: 'Creates a tactical threat scope.',
      },
      {
        name: 'Hound-string guard',
        use: 'Repeated responses defend one lane while consuming arrows.',
        deepening: 'Specializes protection with resource and facing limits.',
        conditionOrTradeoff: 'Covers one declared lane and spends ammunition for each response.',
      },
      {
        name: 'Last gate arrow',
        use: 'A final prepared intercept is released against one fully observed threat.',
        deepening: 'Caps defense with a finite evidence-bound answer.',
        conditionOrTradeoff:
          'Cannot answer unseen, simultaneous or obstructed threats and has long recovery.',
      },
    ],
  },
  {
    zodiac: 'boar',
    branch: 'decisive piercing line',
    roleTags: ['range-sightline-aim', 'breakthrough'],
    missingMechanisms: ['armor-penetration', 'overdraw-recoil'],
    dans: [
      {
        name: 'Hard-drawn arrow',
        use: 'A stronger draw commits more time to one direct shot.',
        deepening: 'Establishes breakthrough through preparation and exposure.',
      },
      {
        name: 'Clear-line pierce',
        use: 'The shot proceeds only along an unobstructed narrow lane.',
        deepening: 'Adds an explicit geometry condition.',
      },
      {
        name: 'Break and follow',
        use: 'A hard shot is linked to a later ordinary arrow after impact evidence.',
        deepening: 'Combines commitment and follow-up without double resolution.',
      },
      {
        name: 'Armor or stance aim',
        use: 'The archer chooses equipment pressure or posture pressure.',
        deepening: 'Creates a tactical target-aspect choice.',
      },
      {
        name: 'Boar-tusk overdraw',
        use: 'Overdraw challenges one defended target while exhausting the user.',
        deepening: 'Specializes penetration with a bodily cost.',
        conditionOrTradeoff: 'Long visible draw, high stamina and impaired recovery after release.',
      },
      {
        name: 'Sky-piercing wager',
        use: 'One maximum overdraw attempts a decisive line then forces the bow down.',
        deepening: 'Caps the branch with a single risky shot, not universal armor bypass.',
        conditionOrTradeoff:
          'Requires full preparation and clear sight; miss, cover or deflection causes full recovery exposure.',
      },
    ],
  },
] as const satisfies readonly BranchPlan[];

const evidence = {
  'skill.archery.rat.1': {
    status: 'definition-only',
    ability: {
      id: 'arrow',
      revision: 1,
      contentHash: 'sha256:d3adfc1d75e87120dfbfb9f11953f116e25b852db63a33e85a64442820303a81',
    },
    fixtureIds: ['projectile-golden', 'stage-single-projectile'],
    evidenceFiles: [
      'packages/engine/src/spatial/projectiles.test.ts',
      'packages/engine/src/spatial/stages.test.ts',
    ],
    releaseBlocker:
      'Needs an archery-specific AI, saved battle and replay fixture before availability.',
  },
} as const satisfies PathEvidence;

export const archerySkillShard = buildPathShard('archery', branches, evidence);
export const archerySkillEvidence = evidenceForPath('archery', branches, evidence);
