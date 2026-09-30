import { describe, expect, it } from 'vite-plus/test';
import {
  EXPECTED_SKILL_COORDINATES,
  type SkillCatalog,
  skillCatalogDigest,
} from './skill-system.ts';
import {
  resolveSkillLoadout,
  skillBattleReceipt,
  skillLoadoutRevisionHash,
  skillNodeStates,
  type SkillConfiguration,
  type SkillLoadoutRevisionContent,
} from './skill-loadout.ts';
import {
  SKILL_TEST_HASH as hash,
  completeSkillTestCatalog as completeCatalog,
} from './skill-system.test-fixtures.ts';
async function configuration(
  catalog: SkillCatalog,
  learnedNodeIds: string[],
  enabledNodeIds: string[],
  eligibilityNodeIds = learnedNodeIds,
): Promise<SkillConfiguration> {
  return {
    schemaVersion: 1,
    id: 'loadout.test',
    version: 3,
    catalog: {
      id: catalog.id,
      revision: catalog.revision,
      contentHash: await skillCatalogDigest(catalog),
    },
    eligibilityNodeIds,
    learnedNodeIds,
    enabledNodeIds,
  };
}
const branchIds = (path: string, zodiac: string, throughDan = 6) =>
  Array.from({ length: throughDan }, (_, index) => `skill.${path}.${zodiac}.${index + 1}`);
async function revisionContent(catalog: SkillCatalog, id: string) {
  const config = await configuration(catalog, [id], [id]);
  return {
    config,
    content: {
      schemaVersion: 1,
      id: config.id,
      revision: 1,
      character: { id: 'character.test', revision: 1, contentHash: hash },
      configuration: config,
      resolved: await resolveSkillLoadout(catalog, config, []),
    } satisfies SkillLoadoutRevisionContent,
  };
}

describe('skill loadout resolution', () => {
  it('closes prerequisites and canonicalizes set-like configuration order', async () => {
    const catalog = completeCatalog(),
      learned = branchIds('sword', 'rat'),
      direct = await configuration(catalog, learned, [learned[5]!]),
      permuted = {
        ...direct,
        eligibilityNodeIds: [...direct.eligibilityNodeIds].reverse(),
        learnedNodeIds: [...direct.learnedNodeIds].reverse(),
      },
      first = await resolveSkillLoadout(catalog, direct, []),
      second = await resolveSkillLoadout(catalog, permuted, []);
    expect(first.resolvedNodeIds).toEqual([...learned].sort());
    expect(first.resolutionDigest).toBe(second.resolutionDigest);
    expect(first.learnedNodeIds).toEqual(second.learnedNodeIds);
  });

  it('rejects learning or enabling that bypasses eligibility and prerequisites', async () => {
    const catalog = completeCatalog(),
      danTwo = branchIds('sword', 'rat', 2),
      missingPrerequisite = await configuration(catalog, danTwo, [], danTwo);
    missingPrerequisite.learnedNodeIds = [danTwo[1]!];
    await expect(resolveSkillLoadout(catalog, missingPrerequisite, [])).rejects.toMatchObject({
      code: 'unmet-learning-prerequisite',
    });

    const notLearned = await configuration(catalog, [], [danTwo[0]!], [danTwo[0]!]);
    await expect(resolveSkillLoadout(catalog, notLearned, [])).rejects.toMatchObject({
      code: 'enabled-node-not-learned',
    });
  });

  it('enforces path, active and passive/augment limits over the resolved closure', async () => {
    const catalog = completeCatalog(),
      threePaths = ['skill.sword.rat.1', 'skill.judo.rat.1', 'skill.aikido.rat.1'],
      pathConfig = await configuration(catalog, threePaths, threePaths);
    await expect(resolveSkillLoadout(catalog, pathConfig, [])).rejects.toMatchObject({
      code: 'enabled-path-limit',
    });

    const nineActive = EXPECTED_SKILL_COORDINATES.filter(
        ({ path, dan }) => path === 'sword' && dan === 1,
      )
        .slice(0, 9)
        .map(({ path, zodiac, dan }) => `skill.${path}.${zodiac}.${dan}`),
      activeConfig = await configuration(catalog, nineActive, nineActive);
    await expect(resolveSkillLoadout(catalog, activeConfig, [])).rejects.toMatchObject({
      code: 'active-node-limit',
    });

    const fivePassive = nineActive.slice(0, 5);
    catalog.nodes = catalog.nodes.map((node) =>
      fivePassive.includes(node.id)
        ? {
            ...node,
            resolution: [
              {
                kind: 'passive-ability' as const,
                ability: {
                  id: node.id.replace('skill.', 'passive.'),
                  revision: 1,
                  contentHash: hash,
                },
              },
            ],
          }
        : node,
    );
    const passiveConfig = await configuration(catalog, fivePassive, fivePassive);
    await expect(resolveSkillLoadout(catalog, passiveConfig, [])).rejects.toMatchObject({
      code: 'passive-node-limit',
    });
  });

  it('requires every explicit weapon tag on the exact resolved closure', async () => {
    const catalog = completeCatalog(),
      id = 'skill.sword.rat.1';
    catalog.nodes = catalog.nodes.map((node) =>
      node.id === id ? { ...node, weaponTags: ['weapon.sword', 'grip.one-hand'] } : node,
    );
    const config = await configuration(catalog, [id], [id]);
    await expect(resolveSkillLoadout(catalog, config, ['weapon.sword'])).rejects.toMatchObject({
      code: 'weapon-requirement',
    });
    await expect(
      resolveSkillLoadout(catalog, config, ['weapon.sword', 'grip.one-hand']),
    ).resolves.toMatchObject({ resolvedNodeIds: [id] });
  });

  it('rejects a stale or substituted catalog ref', async () => {
    const catalog = completeCatalog(),
      id = 'skill.sword.rat.1',
      config = await configuration(catalog, [id], [id]);
    config.catalog = { ...config.catalog, contentHash: `sha256:${'3'.repeat(64)}` };
    await expect(resolveSkillLoadout(catalog, config, [])).rejects.toMatchObject({
      code: 'catalog-mismatch',
    });
  });

  it('seals an immutable active-only loadout and projects a bounded battle receipt', async () => {
    const catalog = completeCatalog(),
      id = 'skill.sword.rat.1',
      { config, content } = await revisionContent(catalog, id),
      snapshot = { ...content, contentHash: await skillLoadoutRevisionHash(content) },
      receipt = await skillBattleReceipt(snapshot);
    expect(receipt).toMatchObject({
      loadout: { id: config.id, revision: 1, contentHash: snapshot.contentHash },
      resolvedNodeIds: [id],
      explicitlyEnabledNodeIds: [id],
    });
    await expect(
      skillBattleReceipt({ ...snapshot, contentHash: `sha256:${'3'.repeat(64)}` }),
    ).rejects.toThrow(/hash mismatch/);
  });

  it('keeps passive and augment recipes out of the active-only SK-02 receipt', async () => {
    const catalog = completeCatalog(),
      id = 'skill.sword.rat.1';
    catalog.nodes = catalog.nodes.map((node) =>
      node.id === id
        ? {
            ...node,
            resolution: [
              {
                kind: 'passive-ability' as const,
                ability: { id: 'passive.test', revision: 1, contentHash: hash },
              },
            ],
          }
        : node,
    );
    const { content } = await revisionContent(catalog, id);
    await expect(
      skillBattleReceipt({ ...content, contentHash: await skillLoadoutRevisionHash(content) }),
    ).rejects.toThrow(/active abilities only/);
  });
});

describe('skill node UI states', () => {
  it('distinguishes locked, learnable, learned, enabled, unsupported and retired', async () => {
    const catalog = completeCatalog(),
      enabled = 'skill.sword.rat.1',
      learned = 'skill.sword.ox.1',
      learnable = 'skill.sword.tiger.1',
      locked = 'skill.sword.tiger.2',
      unsupported = 'skill.sword.rabbit.1',
      retired = 'skill.sword.dragon.1';
    catalog.nodes = catalog.nodes.map((node) =>
      node.id === unsupported
        ? { ...node, lifecycle: 'implemented' as const }
        : node.id === retired
          ? { ...node, lifecycle: 'retired' as const }
          : node,
    );
    const config = await configuration(
        catalog,
        [enabled, learned],
        [enabled],
        [enabled, learned, learnable, locked],
      ),
      states = new Map(skillNodeStates(catalog, config).map((state) => [state.nodeId, state]));
    expect(states.get(enabled)?.status).toBe('enabled');
    expect(states.get(learned)?.status).toBe('learned');
    expect(states.get(learnable)?.status).toBe('learnable');
    expect(states.get(locked)).toMatchObject({
      status: 'locked',
      reasons: ['missing-prerequisite:skill.sword.tiger.1'],
    });
    expect(states.get(unsupported)?.status).toBe('unsupported');
    expect(states.get(retired)?.status).toBe('retired');
  });
});
