import {
  abilityEffects,
  actorSeed,
  compareIds,
  statusTransformationRefs,
  type Definition,
  type DefinitionKind,
  type Manifest,
  type Revision,
  type RevisionRef,
} from '@fantasy/domain/spatial';
import { reference, sealRevision } from '@fantasy/engine/spatial';
import { sampleManifest } from './sample.ts';
import { addTacticalSamples } from './tactical-samples.ts';
import {
  observedRules,
  statusRules,
  locomotionRules,
  generalAiRules,
  simultaneousRules,
  stagedRules,
  motionRules,
  reactionsRules,
} from './published-rules.ts';

type Ability = Extract<Revision, { kind: 'ability' }>;
/** Versioned data examples, never character-specific branches in the simulator. */
export async function sampleCatalog(): Promise<Revision[]> {
  const base = await sampleManifest();
  const sword = base.revisions.find((r) => r.kind === 'ability')!;
  const fighter = base.revisions.find((r) => r.kind === 'character')!;
  const flat = base.revisions.find((r) => r.kind === 'scenario')!;
  const rules = base.revisions.find((r) => r.kind === 'ruleset')!;
  const revisions: Revision[] = [
    sword,
    flat,
    rules,
    structuredClone(observedRules),
    structuredClone(statusRules),
    structuredClone(locomotionRules),
    structuredClone(generalAiRules),
    structuredClone(simultaneousRules),
    structuredClone(stagedRules),
    structuredClone(motionRules),
    structuredClone(reactionsRules),
  ];
  async function add<K extends DefinitionKind>(kind: K, id: string, definition: Definition<K>) {
    const revision = await sealRevision(kind, id, 1, definition);
    revisions.push(revision);
    return revision;
  }
  const status = (
    name: string,
    key: string,
    modifiers: Partial<Definition<'status'>['modifiers']>,
    periodic: Definition<'status'>['periodic'] = [],
  ): Definition<'status'> => ({
    name,
    originalText: name,
    stackKey: key,
    stacking: 'refresh',
    maxStacks: 1,
    durationSteps: 250,
    modifiers: {
      attack: 0,
      defense: 0,
      speedBps: 10000,
      flight: false,
      rooted: false,
      ...modifiers,
    },
    periodic,
  });
  const flight = await add('status', 'flight', {
    ...status('魔法飛行', 'flight', { flight: true }),
    durationSteps: 1000,
  });
  const burning = await add(
    'status',
    'burning',
    status('炎上', 'burning', {}, [{ kind: 'damage', amount: 8, element: 'fire', everySteps: 25 }]),
  );
  const frost = await add('status', 'frost', status('凍気', 'frost', { speedBps: 5000 }));
  const regen = await add(
    'status',
    'regeneration',
    status('再生', 'regeneration', {}, [
      { kind: 'heal', amount: 8, element: 'arcane', everySteps: 25 },
    ]),
  );
  const soaked = await add('status', 'soaked-v1', {
    ...status('濡れた体', 'soaked-v1', {}),
    visibility: 'visible',
    categories: ['debuff'],
    reactions: [{ element: 'lightning', response: { kind: 'none' }, damageTakenBps: 20000 }],
  });
  await add('status', 'ice-bound-v1', {
    ...status('氷結拘束', 'ice-bound-v1', {}),
    visibility: 'visible',
    categories: ['control'],
    adjustments: [
      { target: 'action', operation: 'multiply', amount: 0 },
      { target: 'perceptionRange', operation: 'multiply', amount: 5000 },
    ],
    reactions: [{ element: 'fire', response: { kind: 'transform', status: reference(soaked) } }],
  });
  for (const persistent of [false, true])
    await add('status', persistent ? 'unquenchable-flame-v1' : 'reactive-flame-v1', {
      ...status(
        persistent ? '水で消えない炎' : '反応する炎',
        persistent ? 'undying' : 'reactive-flame-v1',
        {},
        [{ kind: 'damage', element: 'fire', amount: 8, everySteps: 25 }],
      ),
      visibility: 'visible',
      categories: ['damage-over-time'],
      maxStacks: 3,
      stacking: 'sum',
      reactions: [{ element: 'water', response: { kind: persistent ? 'none' : 'remove' } }],
    });
  await add('status', 'battle-focus-v1', {
    ...status('戦闘中の集中', 'focus', {}),
    visibility: 'visible',
    categories: ['buff', 'permanent'],
    adjustments: [{ target: 'damageDealt', operation: 'multiply', amount: 12000 }],
  });
  await add('status', 'battle-replenishment-v1', {
    ...status('戦闘中の補給', 'supply', {}, [
      { kind: 'resource', resource: 'mp', amount: 3, everySteps: 50 },
      { kind: 'resource', resource: 'stamina', amount: 2, everySteps: 50 },
    ]),
    visibility: 'visible',
    categories: ['buff', 'permanent'],
    adjustments: [{ target: 'staminaRecovery', operation: 'multiply', amount: 12000 }],
  });
  const ability = (name: string, edits: Partial<Definition<'ability'>>): Definition<'ability'> => ({
    ...sword.definition,
    name,
    originalText: name,
    ...edits,
  });
  const projectile = (
    edits: Partial<Extract<Definition<'ability'>['attack'], { kind: 'projectile' }>> = {},
  ): Definition<'ability'>['attack'] => ({
    kind: 'projectile',
    speedMmPerSecond: 30000,
    radiusMm: 80,
    lifetimeSteps: 150,
    gravityScaleBps: 0,
    homingTurnMilliDegreesPerSecond: 0,
    observation: 'launch-only',
    explosionRadiusMm: 0,
    maxHitsPerTarget: 1,
    ...edits,
  });
  const self = {
    target: 'self' as const,
    attack: { kind: 'direct' as const },
    rangeMm: 0,
    castSteps: 0,
  };
  const spear = await add(
    'ability',
    'spear',
    ability('槍の突き', {
      rangeMm: 3500,
      attack: { kind: 'melee', reachMm: 3200, radiusMm: 150, activeSteps: 3, maxHitsPerTarget: 1 },
      recoverySteps: 30,
    }),
  );
  const arrow = await add(
    'ability',
    'arrow',
    ability('放物線の矢', {
      rangeMm: 30000,
      castSteps: 10,
      recoverySteps: 30,
      aimErrorMilliDegrees: 500,
      attack: projectile({ gravityScaleBps: 10000 }),
    }),
  );
  const seeker = await add(
    'ability',
    'seeker',
    ability('観測誘導弾', {
      rangeMm: 30000,
      castSteps: 10,
      recoverySteps: 35,
      costs: { hp: 0, mp: 4, uses: 0 },
      attack: projectile({
        speedMmPerSecond: 18000,
        homingTurnMilliDegreesPerSecond: 90000,
        observation: 'owner-visible',
      }),
      effects: [{ kind: 'damage', amount: 12, attackScaleBps: 10000, element: 'arcane' }],
    }),
  );
  const fireball = await add(
    'ability',
    'fireball',
    ability('爆炎弾', {
      rangeMm: 30000,
      castSteps: 20,
      recoverySteps: 35,
      costs: { hp: 0, mp: 8, uses: 0 },
      attack: projectile({ speedMmPerSecond: 16000, explosionRadiusMm: 2500 }),
      effects: [
        { kind: 'damage', amount: 35, attackScaleBps: 10000, element: 'fire' },
        { kind: 'apply-status', status: reference(burning) },
      ],
    }),
  );
  const ice = await add(
    'ability',
    'ice',
    ability('氷の射線', {
      rangeMm: 25000,
      castSteps: 15,
      recoverySteps: 30,
      costs: { hp: 0, mp: 5, uses: 0 },
      attack: { kind: 'hitscan', radiusMm: 100 },
      effects: [
        { kind: 'damage', amount: 15, attackScaleBps: 10000, element: 'ice' },
        { kind: 'apply-status', status: reference(frost) },
      ],
    }),
  );
  const lightning = await add(
    'ability',
    'lightning',
    ability('雷光', {
      rangeMm: 20000,
      castSteps: 8,
      recoverySteps: 25,
      costs: { hp: 0, mp: 6, uses: 0 },
      attack: { kind: 'hitscan', radiusMm: 0 },
      effects: [{ kind: 'damage', amount: 18, attackScaleBps: 10000, element: 'lightning' }],
    }),
  );
  const takeoff = await add(
    'ability',
    'takeoff',
    ability('開幕の飛行', {
      ...self,
      trigger: 'battle-start',
      effects: [{ kind: 'apply-status', status: reference(flight) }],
    }),
  );
  const guard = await add(
    'ability',
    'guard',
    ability('盾の構え', {
      ...self,
      trigger: 'battle-start',
      effects: [{ kind: 'shield', amount: 60 }],
    }),
  );
  const heal = await add(
    'ability',
    'heal',
    ability('癒しと再生', {
      ...self,
      castSteps: 5,
      cooldownSteps: 100,
      costs: { hp: 0, mp: 15, uses: 0 },
      effects: [
        { kind: 'heal', amount: 35 },
        { kind: 'apply-status', status: reference(regen) },
      ],
    }),
  );
  const cleanse = await add(
    'ability',
    'cleanse',
    ability('炎と凍気の解除', {
      ...self,
      costs: { hp: 0, mp: 5, uses: 0 },
      effects: [{ kind: 'dispel', statusIds: ['burning', 'frost'] }],
    }),
  );
  const lance = await add('equipment', 'long-spear', {
    name: '長槍',
    originalText: '攻撃力を補い、槍の突きを使える装備',
    attackBonus: 5,
    defenseBonus: 0,
    abilities: [reference(spear)],
  });
  const armor = await add('equipment', 'plate', {
    name: '重装鎧',
    originalText: '防御力を補う鎧',
    attackBonus: 0,
    defenseBonus: 12,
    abilities: [],
  });
  async function character(
    id: string,
    name: string,
    attacks: Ability[],
    preferred: number,
    options: {
      stats?: Partial<Definition<'character'>['stats']>;
      movement?: Partial<Definition<'character'>['movement']>;
      behavior?: Definition<'policy'>['movement'];
      extras?: Ability[];
      equipment?: RevisionRef[];
      appearance?: Definition<'character'>['appearance'];
      body?: Definition<'character'>['body'];
      stamina?: Definition<'character'>['stamina'];
    } = {},
  ) {
    const extras = options.extras ?? [];
    const priorities: Definition<'policy'>['priorities'] = extras
      .filter((a) => a.definition.trigger === 'action')
      .map((a) => ({
        abilityId: a.id,
        when:
          a.id === 'cleanse'
            ? {
                kind: 'any',
                children: [
                  { kind: 'status', id: 'burning', present: true },
                  { kind: 'status', id: 'frost', present: true },
                ],
              }
            : { kind: 'resource', resource: 'hp', belowBps: 6000 },
      }));
    priorities.push(
      ...attacks.map((a) => ({ abilityId: a.id, when: { kind: 'always' as const } })),
    );
    const policy = await add('policy', id + '-policy', {
      name: name + 'の方針',
      originalText: '条件を満たす優先行動と、観測に基づく移動',
      priorities,
      movement: options.behavior ?? (preferred > 3500 ? 'keep-distance' : 'approach'),
      preferredDistanceMm: preferred,
      flightAltitudeMm: 6000,
      jumpWhenBlocked: true,
    });
    const equipment = options.equipment ?? [];
    const equipped = equipment.flatMap((ref) =>
      revisions
        .filter((r) => r.kind === 'equipment' && r.id === ref.id)
        .flatMap((r) => (r.kind === 'equipment' ? r.definition.abilities.map((a) => a.id) : [])),
    );
    return add('character', id, {
      ...fighter.definition,
      ...(options.appearance ? { appearance: options.appearance } : {}),
      ...(options.body ? { body: options.body } : {}),
      ...(options.stamina ? { stamina: options.stamina } : {}),
      name,
      originalText: name + '。能力・装備・方針はすべて公開revisionで固定する。',
      stats: { ...fighter.definition.stats, ...options.stats },
      movement: { ...fighter.definition.movement, ...options.movement },
      abilities: [...attacks, ...extras].filter((a) => !equipped.includes(a.id)).map(reference),
      equipment,
      policy: reference(policy),
    });
  }
  await character('swordsman', '剣士', [sword], 1200);
  const comboAttack: Definition<'ability'>['attack'] = {
    kind: 'melee',
    reachMm: 1800,
    radiusMm: 200,
    activeSteps: 2,
    maxHitsPerTarget: 1,
  };
  const combo = await add(
    'ability',
    'return-cut-v1',
    ability('返しの連撃', {
      rangeMm: 2500,
      castSteps: 2,
      recoverySteps: 4,
      cooldownSteps: 30,
      costs: { hp: 0, mp: 0, stamina: 6, uses: 0 },
      attack: comboAttack,
      effects: [{ kind: 'damage', element: 'physical', amount: 10, attackScaleBps: 0 }],
      stages: [10, 15].map((amount, index) => ({
        id: index === 0 ? 'cut' : 'return',
        offsetSteps: index * 3,
        durationSteps: 2,
        attack: { ...comboAttack },
        effects: [{ kind: 'damage', element: 'physical', amount, attackScaleBps: 0 }],
        ...(index === 1 ? { cost: { stamina: 4 } } : {}),
      })),
    }),
  );
  await character('staged-duelist-v1', '連撃の剣士', [combo], 1200, {
    stamina: { max: 30, recoveryPerSecond: 5 },
  });
  const staminaStrike = await add(
    'ability',
    'stamina-strike-v1',
    ability('踏み込む斬撃', {
      costs: { hp: 0, mp: 0, stamina: 10, uses: 0 },
    }),
  );
  const wings = await add('status', 'stamina-wings-v1', {
    ...status('体力で維持する飛行', 'wings', { flight: true }),
    durationSteps: 1000,
    flightStaminaPerSecond: 8,
  });
  const staminaTakeoff = await add(
    'ability',
    'stamina-takeoff-v1',
    ability('省力飛行', {
      ...self,
      trigger: 'battle-start',
      costs: { hp: 0, mp: 0, stamina: 5, uses: 1 },
      effects: [{ kind: 'apply-status', status: reference(wings), flightStaminaPerSecond: 5 }],
    }),
  );
  const staminaMovement: NonNullable<Definition<'character'>['movement']['locomotion']> = {
    walk: { speedMmPerSecond: 2000, staminaPerMeter: 2 },
    run: { speedMmPerSecond: 6000, staminaPerMeter: 6 },
    exhaustedSpeedMmPerSecond: 500,
    jumpStamina: 12,
    dodgeStamina: 8,
    stepStaminaPerMeter: 10,
  };
  const stamina = { max: 100, recoveryPerSecond: 3, resumeAt: 20 };
  const dashAttack: Definition<'ability'>['attack'] = {
    kind: 'melee',
    reachMm: 1800,
    radiusMm: 200,
    activeSteps: 8,
    maxHitsPerTarget: 1,
  };
  const dashEffects: Definition<'ability'>['effects'] = [
    { kind: 'damage', element: 'physical', amount: 14, attackScaleBps: 0 },
    {
      kind: 'force',
      profile: 'linear-v1',
      direction: 'away',
      speedMmPerSecond: 12000,
      durationSteps: 3,
    },
  ];
  const dash = await add(
    'ability',
    'dash-cut-v1',
    ability('突進斬り', {
      rangeMm: 4000,
      castSteps: 2,
      recoverySteps: 10,
      cooldownSteps: 30,
      costs: { hp: 0, mp: 0, stamina: 6, uses: 0 },
      attack: dashAttack,
      effects: dashEffects,
      stages: [
        {
          id: 'dash-cut',
          offsetSteps: 0,
          durationSteps: 8,
          attack: dashAttack,
          effects: dashEffects,
          selfMotion: { kind: 'dash', speedMmPerSecond: 8000, accelerationMmPerSecond2: 100000 },
        },
      ],
    }),
  );
  const sweepAttack: Definition<'ability'>['attack'] = {
    kind: 'radial',
    reachMm: 2000,
    bladeRadiusMm: 100,
    startAngleMilliDegrees: -90000,
  };
  const sweepEffects: Definition<'ability'>['effects'] = [
    { kind: 'damage', element: 'physical', amount: 18, attackScaleBps: 0 },
  ];
  const sweep = await add(
    'ability',
    'wide-sweep-v1',
    ability('全周の薙ぎ払い', {
      rangeMm: 2400,
      castSteps: 3,
      recoverySteps: 8,
      cooldownSteps: 30,
      costs: { hp: 0, mp: 0, stamina: 8, uses: 0 },
      attack: sweepAttack,
      effects: sweepEffects,
      stages: [
        {
          id: 'sweep',
          offsetSteps: 0,
          durationSteps: 20,
          attack: sweepAttack,
          effects: sweepEffects,
        },
      ],
    }),
  );
  await character('stage-vanguard-v1', '突進と薙ぎ払いの前衛', [dash, sweep], 1400, {
    stamina,
    movement: { locomotion: staminaMovement },
  });
  const parry = await add(
    'ability',
    'parry-v1',
    ability('受け流し', {
      trigger: 'before-hit',
      categories: ['technique'],
      target: 'self',
      attack: { kind: 'direct' },
      castSteps: 0,
      recoverySteps: 6,
      cooldownSteps: 60,
      rangeMm: 0,
      costs: { hp: 0, mp: 0, stamina: 4, uses: 0 },
      effects: [],
      reaction: { response: { kind: 'parry', scope: 'all' }, categories: ['physical'] },
    }),
  );
  const counter = await add(
    'ability',
    'riposte-v1',
    ability('被弾後の反撃', {
      trigger: 'after-damage',
      categories: ['technique'],
      target: 'enemy',
      attack: { kind: 'hitscan', radiusMm: 80 },
      castSteps: 0,
      recoverySteps: 4,
      cooldownSteps: 30,
      rangeMm: 3000,
      costs: { hp: 0, mp: 0, stamina: 3, uses: 8 },
      effects: [{ kind: 'damage', amount: 12, attackScaleBps: 5000, element: 'physical' }],
      reaction: { response: { kind: 'counter' } },
    }),
  );
  await character('reaction-duelist-v1', '受け流しと反撃の剣士', [sword], 1200, {
    stamina,
    movement: { locomotion: staminaMovement },
    extras: [parry, counter],
  });
  await character('stamina-scout-v1', '体力を配分する斥候', [staminaStrike], 1200, {
    stamina,
    movement: { locomotion: staminaMovement },
  });
  await character('stamina-glider-v1', '滞空時間を選ぶ射手', [arrow], 7000, {
    stamina,
    movement: { locomotion: staminaMovement },
    extras: [staminaTakeoff],
  });
  await character('lancer', '槍兵', [spear], 2200, { equipment: [reference(lance)] });
  await character('guardian', '重装騎士', [sword], 1200, {
    stats: { hp: 160 },
    movement: { speedMmPerSecond: 2500 },
    extras: [guard],
    equipment: [reference(armor)],
  });
  await character('archer', '弓使い', [arrow], 8000, { behavior: 'evade', stats: { hp: 80 } });
  await character('arcane-archer', '魔法弓使い', [seeker], 9000, { stats: { hp: 85, mp: 300 } });
  await character('fire-mage', '炎術師', [fireball], 7000, { stats: { hp: 90, mp: 400 } });
  await character('ice-mage', '氷術師', [ice], 7000, {
    stats: {
      hp: 90,
      mp: 400,
      resistances: { physical: 0, fire: 0, ice: 4000, lightning: 0, arcane: 0 },
    },
  });
  await character('storm-mage', '雷術師', [lightning], 6000, { stats: { hp: 80, mp: 400 } });
  await character('sky-mage', '飛行術師', [seeker], 6000, {
    stats: { hp: 100, mp: 400 },
    extras: [takeoff],
  });
  await character('healer', '治癒剣士', [sword], 1200, {
    stats: { hp: 110, mp: 180 },
    extras: [cleanse, heal],
  });
  const ordinaryBurn = await add('status', 'ordinary-burning', {
    ...status('水で消える燃焼', 'ordinary-burning', {}, [
      { kind: 'damage', amount: 18, element: 'fire', everySteps: 25 },
    ]),
    burning: { waterExtinguishable: true },
  });
  const water = await add(
    'ability',
    'self-water',
    ability('自己への水魔法', {
      ...self,
      castSteps: 3,
      recoverySteps: 12,
      cooldownSteps: 25,
      costs: { hp: 0, mp: 4, uses: 0 },
      effects: [{ kind: 'water', extinguish: true }],
    }),
  );
  const probes: Ability[] = [];
  for (const element of ['fire', 'ice'] as const)
    probes.push(
      await add(
        'ability',
        `measured-${element}`,
        ability(`${element}の観測射撃`, {
          rangeMm: 20000,
          castSteps: 4,
          recoverySteps: 16,
          costs: { hp: 0, mp: 2, uses: 0 },
          attack: { kind: 'hitscan', radiusMm: 0 },
          effects: [{ kind: 'damage', amount: 25, attackScaleBps: 0, element }],
        }),
      ),
    );
  const reveal = await add(
    'ability',
    'reveal-fire',
    ability('炎耐性の限定鑑定', {
      rangeMm: 12000,
      castSteps: 8,
      recoverySteps: 16,
      cooldownSteps: 100,
      costs: { hp: 0, mp: 8, uses: 3 },
      attack: { kind: 'hitscan', radiusMm: 0 },
      effects: [
        {
          kind: 'reveal',
          field: 'resistance',
          element: 'fire',
          precisionBps: 1000,
          durationSteps: 250,
          delaySteps: 5,
          occlusion: 'vision',
          powerBps: 6000,
        },
      ],
    }),
  );
  const flare = await add(
    'ability',
    'ordinary-flare',
    ability('燃焼を与える炎弾', {
      rangeMm: 20000,
      castSteps: 6,
      recoverySteps: 24,
      costs: { hp: 0, mp: 3, uses: 0 },
      attack: projectile({ speedMmPerSecond: 16000 }),
      effects: [
        { kind: 'damage', amount: 20, attackScaleBps: 0, element: 'fire' },
        { kind: 'apply-status', status: reference(ordinaryBurn) },
      ],
    }),
  );
  await character('water-observer', '観測する水術師', [...probes, water], 7000, {
    body: { ...fighter.definition.body, muzzleOffset: { x: 0, y: 200, z: 0 } },
    stats: { hp: 130, mp: 300 },
    appearance: { silhouette: 'humanoid', surface: 'neutral', equipment: ['staff'] },
  });
  await character('fire-seer', '炎を鑑定する術師', [...probes, reveal, water], 7000, {
    body: { ...fighter.definition.body, muzzleOffset: { x: 0, y: 200, z: 0 } },
    stats: { hp: 120, mp: 300 },
    appearance: { silhouette: 'humanoid', surface: 'bright', equipment: ['staff'] },
  });
  await character('ember-duelist', '炎と水の術師', [flare, water], 7000, {
    body: { ...fighter.definition.body, muzzleOffset: { x: 0, y: 200, z: 0 } },
    stats: { hp: 150, mp: 300 },
    appearance: { silhouette: 'humanoid', surface: 'red', equipment: ['staff'] },
  });
  const nodes: Definition<'scenario'>['navigation']['nodes'] = [-1, 1].flatMap((x) =>
    [-1, 1].map((z) => ({
      id: `corner-${x < 0 ? 'w' : 'e'}${z < 0 ? 's' : 'n'}`,
      mode: 'ground' as const,
      position: { x: x * 2200, y: 902, z: z * 2200 },
    })),
  );
  const pillars = await add('scenario', 'pillars', {
    ...flat.definition,
    name: '柱のある広場',
    obstacles: [
      ...flat.definition.obstacles,
      {
        kind: 'pillar',
        id: 'pillar',
        center: { x: 0, y: 1500, z: 0 },
        radiusMm: 1200,
        halfHeightMm: 1500,
        blocks: { movement: true, vision: true, attack: true },
      },
    ],
    navigation: {
      version: 'support-graph-v1',
      nodes,
      edges: nodes.flatMap((a, i) =>
        nodes
          .slice(i + 1)
          .filter((b) => a.position.x === b.position.x || a.position.z === b.position.z)
          .map((b) => ({
            from: a.id,
            to: b.id,
            mode: 'walk' as const,
            widthMm: 1500,
            headroomMm: 10000,
            bidirectional: true,
          })),
      ),
    },
  });
  // Old IDs have two historical DB variants. New references use unambiguous IDs.
  await add('scenario', 'flat-surveyed-v1', flat.definition);
  await add('scenario', 'pillars-surveyed-v1', pillars.definition);
  await addTacticalSamples(revisions);
  return revisions.sort((a, b) => compareIds(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`));
}

/** Include only reachable revisions, so unrelated catalog additions cannot change a battle hash. */
export function revisionClosure(
  revisions: readonly Revision[],
  roots: readonly { kind: DefinitionKind; ref: RevisionRef }[],
): Revision[] {
  const found = new Map<string, Revision>();
  function visit(kind: DefinitionKind, ref: RevisionRef) {
    const key = `${kind}:${ref.id}:${ref.revision}`;
    const revision = revisions.find(
      (r) => r.kind === kind && r.id === ref.id && r.revision === ref.revision,
    );
    if (!revision || revision.contentHash !== ref.contentHash)
      throw new Error('Missing or mismatched revision: ' + key);
    if (found.has(key)) return;
    if (found.size >= 256) throw new Error('Revision closure exceeds limit');
    found.set(key, revision);
    if (revision.kind === 'character') {
      visit('policy', revision.definition.policy);
      for (const r of revision.definition.abilities) visit('ability', r);
      for (const r of revision.definition.equipment) visit('equipment', r);
    } else if (revision.kind === 'equipment') {
      for (const r of revision.definition.abilities) visit('ability', r);
    } else if (revision.kind === 'ability') {
      for (const effect of abilityEffects(revision.definition))
        if (effect.kind === 'apply-status') visit('status', effect.status);
    } else if (revision.kind === 'status') {
      for (const ref of statusTransformationRefs(revision.definition)) visit('status', ref);
    }
  }
  for (const root of roots) visit(root.kind, root.ref);
  return structuredClone([...found.values()]);
}
export async function catalogManifest(
  left = 'swordsman',
  right = 'sky-mage',
  scenarioId = 'pillars-surveyed-v1',
  maxSteps = 6000,
  seed = 42,
  rulesId?: string,
): Promise<Manifest> {
  const catalog = await sampleCatalog(),
    template = await sampleManifest(maxSteps);
  function get(kind: DefinitionKind, id: string) {
    const r = catalog.find((r) => r.kind === kind && r.id === id);
    if (!r) throw new Error('Unknown catalog entry: ' + id);
    return r;
  }
  const scenario = get('scenario', scenarioId);
  let rules = template.revisions.find((r) => r.kind === 'ruleset')!;
  if (rulesId) {
    const selected = get('ruleset', rulesId);
    if (selected.kind !== 'ruleset') throw new Error('Expected rules');
    rules = await sealRevision('ruleset', rulesId, selected.revision, {
      ...selected.definition,
      maxSteps,
    });
    template.ruleset = reference(rules);
  }
  const revisions = catalog.map((r) => (r.kind === 'ruleset' && r.id === rules.id ? rules : r));
  template.seed = seed;
  for (const [i, id] of [left, right].entries()) {
    const p = template.participants[i]!;
    p.character = reference(get('character', id));
    p.rngSeed = actorSeed(seed, p.rngStream);
    p.position.x = i === 0 ? -6000 : 6000;
  }
  template.scenario = reference(scenario);
  template.revisions = revisionClosure(revisions, [
    ...template.participants.map((p) => ({ kind: 'character' as const, ref: p.character })),
    { kind: 'ruleset', ref: template.ruleset },
    { kind: 'scenario', ref: template.scenario },
  ]);
  return template;
}
