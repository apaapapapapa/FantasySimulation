import { describe, expect, it } from 'vite-plus/test';
import {
  deriveSkillEligibility,
  resolveSkillAcquisition,
  skillAcquisitionRevisionHash,
  skillBranchDans,
} from './skill-acquisition.ts';
import { skillCatalogDigest, type SkillNode } from './skill-system.ts';
import { SKILL_TEST_HASH as hash, completeSkillTestCatalog } from './skill-system.test-fixtures.ts';

const character = { id: 'character.acquisition', revision: 1, contentHash: hash };

describe('skill acquisition', () => {
  it('derives eligibility from lifecycle, exact equipment tags and augment base ownership', async () => {
    const catalog = completeSkillTestCatalog(),
      tagged = 'skill.sword.rat.1',
      augmented = 'skill.sword.ox.1',
      base = { id: 'ability.base', revision: 1, contentHash: hash };
    catalog.nodes = catalog.nodes.map((node): SkillNode =>
      node.id === tagged
        ? { ...node, weaponTags: ['weapon.sword'] }
        : node.id === augmented
          ? {
              ...node,
              resolution: [
                {
                  kind: 'augment',
                  baseAbility: base,
                  resolvedAbility: { ...base, revision: 2 },
                },
              ],
            }
          : node,
    );
    const unavailable = await deriveSkillEligibility(catalog, {
      equipmentTags: [],
      abilityRefs: [],
    });
    expect(unavailable.eligibilityNodeIds).not.toContain(tagged);
    expect(unavailable.eligibilityNodeIds).not.toContain(augmented);
    const available = await deriveSkillEligibility(catalog, {
      equipmentTags: ['weapon.sword'],
      abilityRefs: [base],
    });
    expect(available.eligibilityNodeIds).toEqual(expect.arrayContaining([tagged, augmented]));
  });

  it('seals an order-independent explicit learning choice and derives branch dan', async () => {
    const catalog = completeSkillTestCatalog(),
      learned = ['skill.sword.rat.1', 'skill.sword.rat.2'],
      catalogRef = {
        id: catalog.id,
        revision: catalog.revision,
        contentHash: await skillCatalogDigest(catalog),
      },
      selection = {
        schemaVersion: 1 as const,
        id: 'acquisition.test',
        version: 1,
        character,
        catalog: catalogRef,
        learnedNodeIds: learned,
      },
      direct = await resolveSkillAcquisition(catalog, selection, {
        equipmentTags: [],
        abilityRefs: [],
      }),
      permuted = await resolveSkillAcquisition(
        catalog,
        { ...selection, learnedNodeIds: [...learned].reverse() },
        { equipmentTags: [], abilityRefs: [] },
      );
    expect(await skillAcquisitionRevisionHash(direct)).toBe(
      await skillAcquisitionRevisionHash(permuted),
    );
    expect(skillBranchDans(catalog, direct.learnedNodeIds)).toContainEqual({
      path: 'sword',
      zodiac: 'rat',
      dan: 2,
    });
    await expect(
      resolveSkillAcquisition(
        catalog,
        { ...selection, learnedNodeIds: [learned[1]!] },
        { equipmentTags: [], abilityRefs: [] },
      ),
    ).rejects.toMatchObject({ code: 'unmet-learning-prerequisite' });
  });
});
