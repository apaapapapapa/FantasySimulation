import {
  SKILL_ZODIAC_IDS,
  SkillCatalogShardSchema,
  type RevisionRef,
  type SkillDan,
  type SkillNode,
  type SkillPathId,
} from '@fantasy/domain';

export const MYSTIC_CATALOG_ID = 'skill-catalog-v1';
export const MYSTIC_CATALOG_REVISION = 2;

type MysticPath = Extract<SkillPathId, 'shinto' | 'renki' | 'magic'>;
type BranchDesign = {
  zodiac: (typeof SKILL_ZODIAC_IDS)[number];
  title: string;
  foundation: string;
  conditional: string;
  combination: string;
  tactic: string;
  specialization: string;
  ultimate: string;
};
type BranchTuple = readonly [
  BranchDesign['zodiac'],
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

const shinto = [
  [
    'rat',
    'Quick Rite',
    'a fast self-heal',
    'healing only after confirmed loss',
    'healing followed by finite regeneration',
    'choosing a short safe window to recover',
    'rapid triage that yields tempo while preserving the basic heal',
    'an emergency rite that consumes the remaining reserve and leaves a long recovery',
  ],
  [
    'ox',
    'Stored Blessing',
    'a small prepared ward',
    'a ward released only after damage',
    'a ward combined with slow recovery',
    'banking protection instead of acting immediately',
    'a durable ward that limits repeated renewal',
    'releasing every stored blessing at once, then forbidding renewal for a long interval',
  ],
  [
    'tiger',
    'Resolute Prayer',
    'stabilization while pressured',
    'recovery admitted only during hostile pressure',
    'stabilization followed by a brief protective response',
    'holding ground rather than pursuing damage',
    'pressure-resistant recovery with a visible cast opening',
    'surviving a decisive exchange at the cost of all remaining spiritual reserve',
  ],
  [
    'rabbit',
    'Evasive Purity',
    'cleansing one removable affliction',
    'cleansing only after the affliction is observed',
    'cleansing followed by a brief escape window',
    'delaying the rite until movement is safe',
    'mobile purification with reduced coverage',
    'escaping one decisive affliction while surrendering further cleansing for the battle',
  ],
  [
    'dragon',
    'Sanctuary',
    'a bounded protective space',
    'forming it only where placement is valid',
    'protection combined with gradual recovery',
    'controlling a route instead of chasing',
    'a wider sanctuary with finite durability and uses',
    'a final sanctuary that consumes all uses and fixes the caster in a vulnerable recovery',
  ],
  [
    'snake',
    'Binding Purification',
    'removing a known harmful status',
    'purifying only named removable categories',
    'purification paired with a finite seal',
    'choosing between cleanse and restraint',
    'a narrow purge that cannot remove unrelated effects',
    'a complete purge of the admitted set that also removes the caster’s beneficial effects',
  ],
  [
    'horse',
    'Pilgrim Recovery',
    'recovery that permits movement',
    'healing only while a route remains traversable',
    'regeneration combined with relocation',
    'trading healing rate for mobility',
    'a mobile ward with shorter duration',
    'a final crossing that spends the reserve and prevents another recovery cycle',
  ],
  [
    'goat',
    'Harmonizing Water',
    'extinguishing a fire interaction',
    'restoration only for an admitted elemental state',
    'extinguishing combined with modest healing',
    'balancing recovery against resource conservation',
    'multi-effect harmony with lower output per effect',
    'restoring balance once while emptying the supporting resource pool',
  ],
  [
    'monkey',
    'Adaptive Rite',
    'selecting one observed removable condition',
    'adapting only to evidence already perceived',
    'a cleanse combined with the matching small ward',
    'switching response without changing canonical truth',
    'broader adaptation with a strict category limit',
    'one comprehensive adaptation that locks the selected response for the remainder of battle',
  ],
  [
    'rooster',
    'Diagnostic Prayer',
    'revealing which recovery is currently useful',
    'acting only on delivered observations',
    'diagnosis combined with the selected low rite',
    'spending time to avoid a wasted recovery',
    'precise diagnosis that exposes the caster during observation',
    'perfect diagnosis for one boundary followed by a long period without reassessment',
  ],
  [
    'dog',
    'Guardian Ward',
    'a finite personal shield',
    'protection admitted only while the ward is intact',
    'shielding combined with a small recovery pulse',
    'interposing protection before healing',
    'a stronger fixed ward with finite durability and duration',
    'a last ward that consumes every use and cannot be refreshed',
  ],
  [
    'boar',
    'Breakthrough Restoration',
    'an emergency recovery action',
    'recovery admitted only below a health threshold',
    'healing combined with removal of one blocking status',
    'accepting a long recovery to regain initiative',
    'large emergency healing with high cost and cooldown',
    'restoration from the brink that exhausts the caster and cannot loop',
  ],
] as const satisfies readonly BranchTuple[];

const renki = [
  [
    'rat',
    'Breath Ignition',
    'a short physical readiness exercise',
    'enhancement admitted only with enough stamina',
    'breath combined with one practiced action',
    'spending readiness for early initiative',
    'a sharper opening with a shorter safe duration',
    'overclocking the opening while exhausting stamina and forbidding immediate renewal',
  ],
  [
    'ox',
    'Reserve Tempering',
    'conserving a bounded reserve',
    'drawing on it only below the declared resource threshold',
    'reserve combined with steady posture',
    'delaying output to accumulate endurance',
    'greater reserve with slower activation',
    'emptying the whole reserve for one sustained effort followed by enforced recovery',
  ],
  [
    'tiger',
    'Pressure Tempering',
    'a brief increase in committed output',
    'output admitted only during a declared attack window',
    'enhancement combined with a costly follow-up',
    'choosing pressure over defense',
    'higher output with explicit stamina drain and finite duration',
    'maximum pressure that ends the enhancement and leaves no stamina for continuation',
  ],
  [
    'rabbit',
    'Reflex Tempering',
    'one bounded contact evasion',
    'evasion admitted only for a valid contact',
    'reflex combined with repositioning',
    'holding the response instead of attacking',
    'broader evasion with a visible finite status',
    'escaping a decisive contact once, then losing the evasion state for the remainder',
  ],
  [
    'dragon',
    'Circulating Aura',
    'a local enhancement centered on self',
    'circulation maintained only while resource remains',
    'aura combined with one physical discipline',
    'choosing area support over personal peak output',
    'wider circulation with a lower per-effect cap',
    'a final full circulation that drains the reserve and expires without refresh',
  ],
  [
    'snake',
    'Sealed Breath',
    'suppressing one self-defeating impulse',
    'control admitted only for a named category',
    'mental restraint combined with physical stillness',
    'trading action variety for reliability',
    'strong restraint that also seals one beneficial option',
    'complete internal sealing that prevents both disruption and further enhancement',
  ],
  [
    'horse',
    'Sustained Flight',
    'finite flight maintained by stamina',
    'flight continuing only while upkeep can be paid',
    'flight combined with a practiced route',
    'choosing altitude at ongoing stamina cost',
    'longer travel with increased upkeep exposure',
    'a final ascent that consumes all stamina and forces landing when upkeep fails',
  ],
  [
    'goat',
    'Balanced Circulation',
    'balancing physical and mental readiness',
    'correction applied only to the weaker side',
    'two small capped enhancements combined',
    'choosing balance rather than peak specialization',
    'stable harmony with no stacking beyond its explicit key',
    'equalizing all admitted reserves once, then preventing another circulation cycle',
  ],
  [
    'monkey',
    'Adaptive Stance',
    'selecting one enhancement from observed need',
    'switching only at an explicit boundary',
    'the selected stance combined with one basic action',
    'adapting without stacking incompatible modes',
    'broader selection with a switch cost and finite duration',
    'one final adaptation locked for the battle and vulnerable to its counter',
  ],
  [
    'rooster',
    'Focused Mind',
    'a finite mental resistance',
    'focus admitted only before the hostile concept resolves',
    'focus combined with evidence-based assessment',
    'spending time to resist rather than attack',
    'stronger resistance that remains visible, finite and dispellable',
    'complete focus for one exchange followed by a long interval without resistance',
  ],
  [
    'dog',
    'Enduring Guard',
    'a bounded defensive enhancement',
    'guard strengthened only after a confirmed threat',
    'defense combined with resource-efficient posture',
    'protecting endurance instead of dealing damage',
    'longer guard with a strict refresh policy',
    'a final stand that consumes the reserve and ends when its finite duration expires',
  ],
  [
    'boar',
    'Body Overdrive',
    'a short phase of altered movement',
    'overdrive admitted only with full resource payment',
    'movement combined with a committed strike',
    'crossing obstruction instead of sustaining defense',
    'stronger phasing with explicit material limits and cooldown',
    'a final breakthrough that drains the reserve and leaves a long recovery opening',
  ],
] as const satisfies readonly BranchTuple[];

const magic = [
  [
    'rat',
    'Spark Casting',
    'a quick low-cost elemental projectile',
    'casting only after a valid observed target',
    'a spark combined with a finite elemental status',
    'using speed instead of area coverage',
    'a faster specialized bolt with reduced effect breadth',
    'an instant decisive cast that spends the remaining mana and cannot be repeated',
  ],
  [
    'ox',
    'Affinity Vessel',
    'one explicit elemental affinity',
    'conversion admitted only for the named element',
    'affinity combined with a matching low spell',
    'waiting to exploit the known interaction',
    'strong absorption with one stack and finite battle duration',
    'full conversion for one element while becoming vulnerable to its declared counter',
  ],
  [
    'tiger',
    'Flame Pressure',
    'a direct fire projectile',
    'ignition admitted only on a valid hit',
    'damage combined with bounded burning',
    'committing cast time for explosive pressure',
    'larger pressure with greater mana and recovery cost',
    'a final conflagration that spends all uses and leaves the caster exposed',
  ],
  [
    'rabbit',
    'Retreating Step',
    'a bounded retreating blink',
    'teleporting only to a valid unoccupied destination',
    'blink combined with a low ranged action',
    'ceding ground to break contact',
    'longer displacement with fewer uses and cooldown',
    'one final escape that consumes the last charge and cannot cross forbidden boundaries',
  ],
  [
    'dragon',
    'Arcane Formation',
    'a finite placed damage area',
    'arming only after valid placement',
    'periodic area damage combined with route control',
    'holding territory instead of immediate impact',
    'larger formation with finite duration, period and hit cap',
    'a final formation that consumes all uses and fixes its position for counterplay',
  ],
  [
    'snake',
    'Sealing Ray',
    'a narrow finite category seal',
    'sealing only the named ability and status categories',
    'seal combined with modest arcane damage',
    'restraining options instead of maximizing damage',
    'longer restraint that remains visible and expires normally',
    'a final seal that also blocks the caster’s matching category until expiry',
  ],
  [
    'horse',
    'Flanking Step',
    'a bounded flank blink',
    'teleporting only with current visibility and free space',
    'flank movement combined with a low spell',
    'trading a charge for positional advantage',
    'deeper flank with fewer uses and longer cooldown',
    'one final crossing that spends every charge and cannot ignore arena or body collision',
  ],
  [
    'goat',
    'Elemental Balance',
    'a self-applied water interaction',
    'extinguishing only an admitted fire state',
    'water combined with a complementary low spell',
    'choosing counter-element utility over damage',
    'broader balance with lower output and explicit category bounds',
    'one full rebalance that clears both hostile and beneficial admitted elemental states',
  ],
  [
    'monkey',
    'Adaptive Frost',
    'a precise ice hitscan',
    'slow applied only on a valid hit',
    'damage combined with finite frost',
    'switching element according to observed efficacy',
    'adaptive selection with extra mana and assessment time',
    'one perfect adaptation locked to the chosen element and exposed to changed conditions',
  ],
  [
    'rooster',
    'Affinity Reading',
    'a bounded reveal of fire resistance',
    'reading only delivered and permitted evidence',
    'reveal combined with a measured probe',
    'spending time and uses to reduce uncertainty',
    'more precise reading with narrower scope and longer cooldown',
    'a final exact reading for one element that consumes all uses and grants no hidden future state',
  ],
  [
    'dog',
    'Boundary Barrier',
    'a finite placed barrier',
    'forming only at a valid placement point',
    'barrier combined with a low covering action',
    'blocking route or attack without changing victory ownership',
    'greater durability with finite duration and uses',
    'a final barrier that consumes all uses, remains destructible and expires normally',
  ],
  [
    'boar',
    'Arcane Beam',
    'a finite-duration beam',
    'damage admitted only while the beam intersects a target',
    'beam duration combined with bounded repeated hits',
    'committing position for breakthrough pressure',
    'longer beam with an explicit interval and hit cap',
    'a final beam that spends all uses and leaves a long recovery window',
  ],
] as const satisfies readonly BranchTuple[];

const refs = {
  heal: ['heal', '2ff77c3130c363d1d15d991a0ee1a92f9595759fcabfc85c90f2ebdc922f2231'],
  cleanse: ['cleanse', '6e039c88be89bf40379ad6a6ae7a74b5b6ab2c492b3cbe417a452187d2d98121'],
  guard: ['guard', 'f05415d544efcfcc0e4fa8f2698d2033d064346bd071563ca8e6dd9de3cdb769'],
  'spatial-barrier-v1': [
    'spatial-barrier-v1',
    '84e6bf7208e50d53ed18b1a2460ea2f7c7b420eadbaaa671ac91fc86788ed753',
  ],
  'stamina-takeoff-v1': [
    'stamina-takeoff-v1',
    '74bdae414167ea17a3f92a0489148d03d5a60fd624ae3f97ca73eb0ca950485c',
  ],
  'finite-contact-evasion-v1-grant': [
    'finite-contact-evasion-v1-grant',
    'f37c6ff8c69846737228e899051387dc3af53ece8e8c947d2bf449f81b9d8d9e',
  ],
  'concept-resistance-v1-grant': [
    'concept-resistance-v1-grant',
    '0672a211da8c248b3177f73f3c6837c9a4bd257177a2a0f353ab59ee86e5ce00',
  ],
  'phase-grant-v1': [
    'phase-grant-v1',
    '456e8b0a5d7c851e3ff0cdd2d696182c04a39ea22c92c0724db17901c4bf5377',
  ],
  'ordinary-flare': [
    'ordinary-flare',
    'ebe6c0f4194d04a18d9d657a3fdd2b692a86b1ccb82b291d6b5885e17ddc5c42',
  ],
  'fire-absorption-trait-v1': [
    'fire-absorption-trait-v1',
    'f2c2fd1282229ea23860d3aa3b36d531e22c59d01f7ae3a645f075f65548ea57',
  ],
  fireball: ['fireball', 'e4dc989f853cc05c7b8238c68610c3e32a4b94784ecab7df4113c6ec99d44fc1'],
  'spatial-blink-retreat-v1': [
    'spatial-blink-retreat-v1',
    'f2b61f9ac4b6c6c87bba2f510f52f39a814c2c33e8390b53cebace67371f221b',
  ],
  'spatial-area-v1': [
    'spatial-area-v1',
    '2bc11d09b79ad01f39eb7bb2a5e781c743d727bbaf8229c22e8a48cbb6305edd',
  ],
  'sealing-bolt-v1': [
    'sealing-bolt-v1',
    '1dc5f75885c01d1e6b421a2d8f4393e55465e09fd5ba0de6229840925b073f3e',
  ],
  'spatial-blink-flank-v1': [
    'spatial-blink-flank-v1',
    '3e72e38247bf86e9d388d8015b59c877b14352ee0a9fc2f3d61a95240d51f173',
  ],
  ice: ['ice', '0102cbd86b2e227894db699bfc4340ca7f727e1767c43e5e7cb41e000b294444'],
  'reveal-fire': [
    'reveal-fire',
    '1d54c35a5d79ce021d43eb0cc31b6bccd027ad71846ea9f9ce3dbde71f6c3514',
  ],
  'spatial-beam-v1': [
    'spatial-beam-v1',
    '341fe27a18970c970300ea60d1031fc3b2df2ed8bfb4dd405545939557aad492',
  ],
} as const;

export type MysticAbilityId = keyof typeof refs;
const abilityRef = (id: MysticAbilityId): RevisionRef => ({
  id: refs[id][0],
  revision: 1,
  contentHash: `sha256:${refs[id][1]}`,
});

const available: Partial<
  Record<
    `${MysticPath}:${BranchDesign['zodiac']}`,
    readonly [MysticAbilityId, 'active-ability' | 'passive-ability']
  >
> = {
  'shinto:rat': ['heal', 'active-ability'],
  'shinto:dragon': ['spatial-barrier-v1', 'active-ability'],
  'shinto:snake': ['cleanse', 'active-ability'],
  'shinto:dog': ['guard', 'passive-ability'],
  'renki:rabbit': ['finite-contact-evasion-v1-grant', 'passive-ability'],
  'renki:horse': ['stamina-takeoff-v1', 'passive-ability'],
  'renki:rooster': ['concept-resistance-v1-grant', 'passive-ability'],
  'renki:boar': ['phase-grant-v1', 'active-ability'],
  'magic:rat': ['ordinary-flare', 'active-ability'],
  'magic:ox': ['fire-absorption-trait-v1', 'passive-ability'],
  'magic:tiger': ['fireball', 'active-ability'],
  'magic:rabbit': ['spatial-blink-retreat-v1', 'active-ability'],
  'magic:dragon': ['spatial-area-v1', 'active-ability'],
  'magic:snake': ['sealing-bolt-v1', 'active-ability'],
  'magic:horse': ['spatial-blink-flank-v1', 'active-ability'],
  'magic:monkey': ['ice', 'active-ability'],
  'magic:rooster': ['reveal-fire', 'active-ability'],
  'magic:dog': ['spatial-barrier-v1', 'active-ability'],
  'magic:boar': ['spatial-beam-v1', 'active-ability'],
};

const kinds = [
  'foundation',
  'conditional-effect',
  'combination',
  'tactical-mode',
  'specialization',
  'ultimate-tradeoff',
] as const;
const labels = ['Foundation', 'Condition', 'Combination', 'Tactic', 'Specialization', 'Ultimate'];

function branchNodes(path: MysticPath, design: BranchDesign): SkillNode[] {
  const uses = [
    design.foundation,
    design.conditional,
    design.combination,
    design.tactic,
    design.specialization,
    design.ultimate,
  ];
  return uses.map((use, index) => {
    const dan = (index + 1) as SkillDan,
      id = `skill.${path}.${design.zodiac}.${dan}`,
      prior = dan === 1 ? [] : [`skill.${path}.${design.zodiac}.${dan - 1}`],
      evidence = dan === 1 ? available[`${path}:${design.zodiac}`] : undefined;
    return {
      id,
      coordinate: { path, zodiac: design.zodiac, dan },
      name: `${design.title}: ${labels[index]}`,
      description: `${use}. The earlier techniques remain independently selectable; this dan does not silently replace them.`,
      lifecycle: evidence ? 'available' : 'draft',
      prerequisites: prior,
      deepening: {
        kind: kinds[index]!,
        explanation: `${use}; it deepens ${design.foundation} without removing that lower-cost use.`,
        retainsLowerUse: true,
        ...(dan >= 5
          ? {
              conditionOrTradeoff: dan === 5 ? design.specialization : design.ultimate,
            }
          : {}),
      },
      pathRoleTags: [`path.${path}`, `zodiac.${design.zodiac}`, `dan.${dan}`],
      resolution: evidence ? [{ kind: evidence[1], ability: abilityRef(evidence[0]) }] : [],
      fixtureIds: evidence ? [`fixture.skill.${path}.${design.zodiac}.1.runtime`] : [],
    };
  });
}

function shard(path: MysticPath, designs: readonly BranchDesign[]) {
  return SkillCatalogShardSchema.parse({
    schemaVersion: 1,
    catalogId: MYSTIC_CATALOG_ID,
    catalogRevision: MYSTIC_CATALOG_REVISION,
    path,
    nodes: designs.flatMap((design) => branchNodes(path, design)),
  });
}

const branchDesigns = (tuples: readonly BranchTuple[]): BranchDesign[] =>
  tuples.map(
    ([zodiac, title, foundation, conditional, combination, tactic, specialization, ultimate]) => ({
      zodiac,
      title,
      foundation,
      conditional,
      combination,
      tactic,
      specialization,
      ultimate,
    }),
  );

export const MYSTIC_SKILL_SHARDS = {
  shinto: shard('shinto', branchDesigns(shinto)),
  renki: shard('renki', branchDesigns(renki)),
  magic: shard('magic', branchDesigns(magic)),
};

export const MYSTIC_AVAILABLE_NODE_IDS = Object.values(MYSTIC_SKILL_SHARDS)
  .flatMap(({ nodes }) => nodes)
  .filter(({ lifecycle }) => lifecycle === 'available')
  .map(({ id }) => id);
