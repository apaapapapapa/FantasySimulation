import { describe, expect, it } from 'vite-plus/test';
import { shieldGuardPromotionPlan } from './shield-guard-promotion-v1.ts';
import { shieldSkillEvidence, shieldSkillShard } from './shield-v1.ts';

describe('shield guard promotion plan', () => {
  it('promotes exactly one proven node after its vertical fixtures pass', () => {
    const target = shieldSkillShard.nodes.find(({ id }) => id === shieldGuardPromotionPlan.node.id),
      evidence = shieldSkillEvidence.find(
        ({ nodeId }) => nodeId === shieldGuardPromotionPlan.node.id,
      );
    expect(shieldGuardPromotionPlan.status).toBe('stacked-available-candidate');
    expect(target?.lifecycle).toBe('available');
    expect(target?.resolution).toMatchObject([
      { kind: 'passive-ability', ability: { id: 'shield-set-guard-v1', revision: 1 } },
    ]);
    expect(evidence?.evidence.status).toBe('proven');
    expect(shieldSkillShard.nodes.filter(({ lifecycle }) => lifecycle === 'available')).toEqual([
      target,
    ]);
  });

  it('pins exact ability and vertical fixture identities behind explicit gates', () => {
    expect(shieldGuardPromotionPlan).toMatchObject({
      dependency: { pullRequest: 250 },
      node: { id: 'skill.shield.ox.1', promotedLifecycle: 'available' },
      ability: {
        id: 'shield-set-guard-v1',
        revision: 1,
        definition: {
          trigger: 'before-hit',
          reaction: { response: { kind: 'guard', retainedDamageBps: 8000 } },
        },
      },
      loadoutFixture: {
        enabledNodeIds: ['skill.shield.ox.1'],
        expectedAbilityIds: ['shield-set-guard-v1'],
      },
      battleFixture: { incomingDamage: 101, expectedDamage: 80 },
    });
    expect(shieldGuardPromotionPlan.promotionGates).toHaveLength(6);
  });
});
