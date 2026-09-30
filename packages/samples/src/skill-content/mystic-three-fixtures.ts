import type { MysticAbilityId } from './mystic-three.ts';

export type MysticSkillFixture = {
  id: string;
  nodeId: string;
  abilityId: MysticAbilityId;
  actor: string;
  opponent: string;
  scenario: string;
  ruleset?: string;
  preserves?: { nodeId: string; abilityId: MysticAbilityId };
  mechanisms: string[];
  boundaries: {
    resource: string;
    duplicate: string;
    duration: string;
    release: string;
    interference: string;
  };
  evidenceTests: string[];
};

const fixture = (
  nodeId: string,
  abilityId: MysticAbilityId,
  actor: string,
  opponent: string,
  mechanisms: string[],
  boundaries: MysticSkillFixture['boundaries'],
  evidenceTests: string[],
  options: Pick<MysticSkillFixture, 'scenario' | 'ruleset' | 'preserves'> = { scenario: 'flat' },
): MysticSkillFixture => ({
  id: nodeId.replace('skill.', 'fixture.skill.') + '.runtime',
  nodeId,
  abilityId,
  actor,
  opponent,
  mechanisms,
  boundaries,
  evidenceTests,
  ...options,
});

const objectEvidence = [
  'packages/engine/src/spatial/spatial-objects.test.ts',
  'packages/engine/src/spatial/spatial-object-interference.test.ts',
  'packages/engine/src/spatial/spatial-review.test.ts',
];
const teleportEvidence = [
  'packages/engine/src/spatial/teleport.test.ts',
  'packages/engine/src/spatial/spatial-review.test.ts',
];
const catalogEvidence = ['packages/engine/src/spatial/catalog.test.ts'];

export const MYSTIC_ROOSTER_DAN2_FIXTURE = fixture(
  'skill.magic.rooster.2',
  'measured-fire',
  'fire-seer',
  'ember-duelist',
  ['assessment-probe', 'hitscan', 'fire', 'prerequisite-closure'],
  {
    resource: 'Pays 2 MP for each admitted measured probe while retaining the reveal action.',
    duplicate: 'Each probe is an independent hit and does not duplicate affinity knowledge.',
    duration: 'The hitscan probe settles immediately and creates no continuing status.',
    release: 'Damage ends at settlement; the lower reveal remains separately selectable.',
    interference: 'Visibility and obstruction settle before the measured fire hit is admitted.',
  },
  [
    ...catalogEvidence,
    'packages/engine/src/spatial/ai-integration.test.ts',
    'packages/engine/src/spatial/assessment.test.ts',
  ],
  {
    scenario: 'flat',
    preserves: { nodeId: 'skill.magic.rooster.1', abilityId: 'reveal-fire' },
  },
);

export const MYSTIC_SKILL_FIXTURES: MysticSkillFixture[] = [
  fixture(
    'skill.shinto.rat.1',
    'heal',
    'healer',
    'swordsman',
    ['heal', 'periodic-heal', 'status-refresh'],
    {
      resource: 'Pays 15 MP and observes a 100-step cooldown.',
      duplicate: 'Regeneration refreshes one stack; it never multiplies periodic healing.',
      duration: 'Regeneration lasts 250 steps and pulses every 25 steps.',
      release: 'The status expires once at its exclusive duration boundary.',
      interference: 'Healing and same-wave damage use the shared bounded settlement rules.',
    },
    [...catalogEvidence, 'packages/engine/src/spatial/stages.test.ts'],
  ),
  fixture(
    'skill.shinto.dragon.1',
    'spatial-barrier-v1',
    'barrier-mage-v1',
    'swordsman',
    ['barrier', 'placement', 'durability'],
    {
      resource: 'Pays 6 MP, consumes one of two uses and has a 150-step cooldown.',
      duplicate: 'Each admitted cast has a distinct object identity; two uses are the hard cap.',
      duration: 'The fixed barrier lasts 150 steps and has 45 durability.',
      release: 'Expiry or zero durability removes the object exactly once.',
      interference: 'Placement, terrain, movement and enemy attacks share barrier collision rules.',
    },
    objectEvidence,
  ),
  fixture(
    'skill.shinto.snake.1',
    'cleanse',
    'healer',
    'fire-mage',
    ['dispel', 'purification'],
    {
      resource: 'Pays 5 MP for each admitted cleanse.',
      duplicate: 'A repeat after removal is a bounded no-op rather than another removal.',
      duration: 'The removal is immediate; it creates no hidden continuing status.',
      release: 'Only burning and frost are named for removal.',
      interference: 'Concurrent status application and dispel settle at the shared boundary order.',
    },
    [...catalogEvidence, 'packages/engine/src/spatial/status-generalization.test.ts'],
  ),
  fixture(
    'skill.shinto.dog.1',
    'guard',
    'guardian',
    'swordsman',
    ['shield', 'battle-start'],
    {
      resource: 'The published foundation has no resource cost and triggers only at battle start.',
      duplicate: 'The single battle-start trigger grants one 60-point shield.',
      duration: 'Shield lifetime is bounded by depletion or battle termination.',
      release: 'Incoming admitted damage consumes shield before HP under shared settlement.',
      interference: 'Simultaneous hits share the single shield and HP clamp.',
    },
    [...catalogEvidence, 'packages/engine/src/spatial/simulate.test.ts'],
  ),
  fixture(
    'skill.renki.rabbit.1',
    'finite-contact-evasion-v1-grant',
    'evasive-mage-v1',
    'unerring-mage-v1',
    ['contact-evasion', 'status-refresh', 'experimental-policy'],
    {
      resource: 'Consumes its single battle-start use.',
      duplicate: 'The visible buff refreshes one stack and cannot accumulate evasion layers.',
      duration: 'The status expires after 300 steps.',
      release: 'Expiry or permitted dispel removes the evasion capability exactly once.',
      interference: 'No-error aim still obeys the separately reviewed contact-evasion rule.',
    },
    ['packages/engine/src/spatial/concept-samples.test.ts'],
    { scenario: 'flat-surveyed-v1', ruleset: 'experimental-concepts-v1' },
  ),
  fixture(
    'skill.renki.horse.1',
    'stamina-takeoff-v1',
    'stamina-glider-v1',
    'swordsman',
    ['flight', 'stamina-upkeep', 'status-refresh'],
    {
      resource: 'Pays 5 stamina initially and 5 stamina per second while flying.',
      duplicate: 'The wings status refreshes one stack rather than multiplying upkeep.',
      duration: 'The status is bounded to 1000 steps and ends sooner when upkeep fails.',
      release: 'Failed upkeep releases flight and returns the actor to ordinary support rules.',
      interference: 'Flight, terrain support and resource drain settle on explicit boundaries.',
    },
    [...catalogEvidence, 'packages/engine/src/spatial/status-generalization.test.ts'],
  ),
  fixture(
    'skill.renki.rooster.1',
    'concept-resistance-v1-grant',
    'concept-warden-v1',
    'death-mage-v1',
    ['mental-resistance', 'status-seal', 'experimental-policy'],
    {
      resource: 'Consumes its single battle-start use.',
      duplicate: 'The resistance refreshes one visible stack.',
      duration: 'The resistance lasts 300 steps.',
      release: 'Expiry, dispel or sealing removes or suspends the admitted protection.',
      interference: 'Defeat and time-stop attempts pass through explicit resistance rules.',
    },
    ['packages/engine/src/spatial/concept-samples.test.ts'],
    { scenario: 'flat-surveyed-v1', ruleset: 'experimental-concepts-v1' },
  ),
  fixture(
    'skill.renki.boar.1',
    'phase-grant-v1',
    'phase-traveller-v1',
    'phase-archer-v1',
    ['phasing', 'material-filter', 'status-refresh'],
    {
      resource: 'Pays 8 MP and observes a 120-step cooldown.',
      duplicate: 'The phase status refreshes one stack.',
      duration: 'Phasing lasts 100 steps.',
      release: 'Expiry restores ordinary collision without relocating through invalid space.',
      interference:
        'Stone and energy may be crossed; floors, bodies and arena bounds remain solid.',
    },
    ['packages/engine/src/spatial/spatial-review.test.ts'],
    { scenario: 'phase-stone-corridor-v1' },
  ),
  fixture(
    'skill.magic.rat.1',
    'ordinary-flare',
    'ember-duelist',
    'swordsman',
    ['projectile', 'fire', 'burning'],
    {
      resource: 'Pays 3 MP per cast.',
      duplicate: 'Burning refreshes one stack rather than multiplying periodic damage.',
      duration: 'Burning lasts 250 steps and pulses every 25 steps.',
      release: 'Expiry, cleanse or water removes burning once.',
      interference: 'Projectile obstruction precedes hit, fire damage and status application.',
    },
    [...catalogEvidence, 'packages/engine/src/spatial/status-generalization.test.ts'],
  ),
  fixture(
    'skill.magic.ox.1',
    'fire-absorption-trait-v1',
    'ember-absorber-v1',
    'ember-drainer-v1',
    ['affinity', 'absorption', 'status-refresh'],
    {
      resource: 'Consumes its single battle-start use.',
      duplicate: 'Fire absorption refreshes one hidden stack.',
      duration: 'The published trait is bounded to 6000 steps and battle termination.',
      release:
        'Permitted sealing suspends the permanent-category status while its duration advances.',
      interference: 'Only fire is converted; drain and non-fire settlement remain independent.',
    },
    ['packages/engine/src/spatial/recovery-integration.test.ts'],
  ),
  fixture(
    'skill.magic.tiger.1',
    'fireball',
    'fire-mage',
    'swordsman',
    ['projectile', 'explosion', 'fire', 'burning'],
    {
      resource: 'Pays 8 MP and commits to 20 cast plus 35 recovery steps.',
      duplicate: 'Burning refreshes one stack; explosion hits each target at most once.',
      duration: 'Projectile lifetime is 150 steps and burning lasts 250 steps.',
      release: 'Projectile collision or lifetime removes it; burning expires or is cleansed.',
      interference: 'Terrain and barriers can stop the projectile before its explosion resolves.',
    },
    catalogEvidence,
  ),
  fixture(
    'skill.magic.rabbit.1',
    'spatial-blink-retreat-v1',
    'blink-retreat-mage-v1',
    'blink-flank-mage-v1',
    ['teleport', 'retreat', 'collision-validation'],
    {
      resource: 'Pays 4 MP, consumes one of three uses and observes a 50-step cooldown.',
      duplicate: 'Each cast has one relocation request and one settled result.',
      duration: 'Relocation settles at the next atomic boundary.',
      release: 'Rejected destinations produce no partial movement or residue.',
      interference: 'Bodies, terrain and arena bounds are checked before relocation commits.',
    },
    teleportEvidence,
    { scenario: 'flat-surveyed-v1' },
  ),
  fixture(
    'skill.magic.dragon.1',
    'spatial-area-v1',
    'area-mage-v1',
    'swordsman',
    ['area', 'placement', 'periodic-contact'],
    {
      resource: 'Pays 6 MP, consumes one of two uses and observes a 150-step cooldown.',
      duplicate: 'One object owns a shared hit ledger capped at four hits.',
      duration: 'The area arms after 5 steps, pulses every 25 and lasts 150 steps.',
      release: 'Exclusive-end expiry removes the area exactly once.',
      interference: 'Placement and contacts obey terrain, obstruction and shared object ordering.',
    },
    objectEvidence,
  ),
  fixture(
    'skill.magic.snake.1',
    'sealing-bolt-v1',
    'seal-mage-v1',
    'concept-warden-v1',
    ['hitscan', 'status-seal', 'arcane-damage'],
    {
      resource: 'Pays 1 MP per cast.',
      duplicate: 'The special seal refreshes one visible stack.',
      duration: 'The seal lasts 100 steps while the sealed status duration still advances.',
      release: 'Expiry restores admitted categories without replaying missed triggers.',
      interference: 'The seal targets special abilities and buff/permanent statuses only.',
    },
    ['packages/engine/src/spatial/revival-integration.test.ts'],
    { scenario: 'flat-surveyed-v1', ruleset: 'experimental-concepts-v1' },
  ),
  fixture(
    'skill.magic.horse.1',
    'spatial-blink-flank-v1',
    'blink-flank-mage-v1',
    'blink-retreat-mage-v1',
    ['teleport', 'flank', 'observation'],
    {
      resource: 'Pays 4 MP, consumes one of three uses and observes a 50-step cooldown.',
      duplicate: 'Each cast produces at most one relocation.',
      duration: 'The observed-relative destination is fixed for next-boundary settlement.',
      release: 'Invalid or occluded destinations fail without partial relocation.',
      interference: 'Visibility, bodies, terrain and arena bounds remain authoritative.',
    },
    teleportEvidence,
    { scenario: 'flat-surveyed-v1' },
  ),
  fixture(
    'skill.magic.monkey.1',
    'ice',
    'ice-mage',
    'swordsman',
    ['hitscan', 'ice', 'frost'],
    {
      resource: 'Pays 5 MP and commits to 15 cast plus 30 recovery steps.',
      duplicate: 'Frost refreshes one stack.',
      duration: 'Frost lasts 250 steps.',
      release: 'Expiry or cleanse removes the speed reduction once.',
      interference: 'Hitscan obstruction settles before ice damage and frost application.',
    },
    catalogEvidence,
  ),
  fixture(
    'skill.magic.rooster.1',
    'reveal-fire',
    'fire-seer',
    'fire-mage',
    ['assessment', 'fire-affinity', 'bounded-observation'],
    {
      resource: 'Pays 8 MP, consumes one of three uses and observes a 100-step cooldown.',
      duplicate: 'Repeated reads update bounded knowledge instead of stacking combat effects.',
      duration: 'Delivered assessment is subject to the existing observation memory boundary.',
      release: 'No hidden future choice or unrelated affinity is revealed.',
      interference: 'Occlusion and permitted observation gate the assessment.',
    },
    [...catalogEvidence, 'packages/engine/src/spatial/assessment.test.ts'],
  ),
  fixture(
    'skill.magic.dog.1',
    'spatial-barrier-v1',
    'barrier-mage-v1',
    'swordsman',
    ['barrier', 'placement', 'durability'],
    {
      resource: 'Pays 6 MP, consumes one of two uses and observes a 150-step cooldown.',
      duplicate: 'Object identity and the two-use cap bound duplicate barriers.',
      duration: 'The barrier lasts 150 steps and has 45 durability.',
      release: 'Expiry or destruction removes it once.',
      interference: 'Terrain, movement and enemy attacks use the common barrier query.',
    },
    objectEvidence,
  ),
  fixture(
    'skill.magic.boar.1',
    'spatial-beam-v1',
    'beam-mage-v1',
    'swordsman',
    ['beam', 'obstruction', 'shared-hit-ledger'],
    {
      resource: 'Pays 6 MP, consumes one of two uses and observes a 150-step cooldown.',
      duplicate: 'One beam uses a shared ledger capped at four hits.',
      duration: 'The beam stage lasts 25 steps with a 6-step minimum hit interval.',
      release: 'Stage completion removes the beam without a lingering damage source.',
      interference: 'Terrain and barriers clip the ray before target contact.',
    },
    objectEvidence,
  ),
  MYSTIC_ROOSTER_DAN2_FIXTURE,
];
