/**
 * Promotion contract for the first executable shield guard.
 *
 * This is intentionally a blocked authoring plan rather than catalog evidence: PR #250 proves
 * the guard response itself, but the proposed ability is not sealed in the spatial catalog and
 * no saved loadout-to-replay fixture binds it to this skill node yet.
 */
export const shieldGuardPromotionPlan = {
  schemaVersion: 1,
  status: 'blocked',
  dependency: {
    pullRequest: 250,
    testedHead: 'b643680c573bd6d406de3609c092c58f4ea1777c',
    requiredCapabilities: [
      'before-hit-guard-response',
      'observed-ai-guard-assessment',
      'guard-cause-recording',
      'guard-replay-validation',
      'guard-viewer-display',
    ],
    evidenceFiles: [
      'packages/engine/src/spatial/reactions.test.ts',
      'packages/engine/src/spatial/projectile-deflection-boundaries.test.ts',
      'apps/web/src/replay/guard-display.test.ts',
    ],
  },
  node: {
    id: 'skill.shield.ox.1',
    currentLifecycle: 'implemented',
    promotedLifecycle: 'available',
    replacesDefinitionOnlyAbility: 'guard',
  },
  ability: {
    id: 'shield-set-guard-v1',
    revision: 1,
    schemaVersion: 1,
    definition: {
      name: 'Set shield guard',
      originalText: 'Brace the shield against one observed physical hit.',
      trigger: 'before-hit',
      reaction: {
        response: { kind: 'guard', retainedDamageBps: 8000 },
        categories: ['physical'],
      },
      categories: ['technique'],
      target: 'self',
      condition: { kind: 'always' },
      costs: { hp: 0, mp: 0, stamina: 4, uses: 0 },
      castSteps: 0,
      recoverySteps: 6,
      cooldownSteps: 60,
      movementWhileCasting: 'allow',
      rangeMm: 0,
      aimErrorMilliDegrees: 0,
      attack: { kind: 'direct' },
      effects: [],
    },
    approvalRequired: ['retainedDamageBps', 'stamina cost', 'recoverySteps', 'cooldownSteps'],
  },
  loadoutFixture: {
    id: 'loadout.fixture.shield.ox.guard',
    version: 1,
    catalog: { id: 'skill-catalog-v1', revision: 2 },
    characterId: 'stage-vanguard-v1',
    eligibilityNodeIds: ['skill.shield.ox.1'],
    learnedNodeIds: ['skill.shield.ox.1'],
    enabledNodeIds: ['skill.shield.ox.1'],
    expectedExplicitNodeIds: ['skill.shield.ox.1'],
    expectedResolvedNodeIds: ['skill.shield.ox.1'],
    expectedAbilityIds: ['shield-set-guard-v1'],
  },
  battleFixture: {
    id: 'fixture.skill.shield.ox.1.guard-battle',
    attackerAbilityId: 'sword',
    incomingDamage: 101,
    expectedDamage: 80,
    expectedForceEvents: 1,
    assertions: [
      'AI selects the guard from delivered before-hit observations only',
      'the guard activation id is present in the damage event causes',
      'contact force remains after damage reduction',
      'reversing revision enumeration does not change records',
    ],
  },
  replayFixture: {
    id: 'fixture.skill.shield.ox.1.guard-replay',
    assertions: [
      'saved replay context contains catalog and loadout references',
      'damage guard provenance names the activation and retainedDamageBps',
      'checkpoint replay equals the terminal checkpoint',
      '2D and 3D consume the same guard event record',
    ],
  },
  promotionGates: [
    'PR #250 is merged and its guard capability remains release eligible',
    'shield-set-guard-v1 is schema-validated, sealed and committed to the ability catalog',
    'skill-catalog-v1 revision 2 is assembled, sealed and persisted',
    'the saved loadout fixture resolves exactly shield-set-guard-v1',
    'battle and replay fixtures pass with the declared catalog and loadout references',
    'the proposed balance values receive design approval',
  ],
} as const;
