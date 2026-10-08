import { describe, expect, it } from 'vite-plus/test';
import {
  EXPECTED_SKILL_COORDINATES,
  type SkillCatalog,
  skillCatalogDigest,
} from './skill-system.ts';
import { SkillLoadoutHeadSchema } from './skill-api.ts';
import {
  SKILL_RESOLVER_VERSION,
  SkillLoadoutRevisionContentSchema,
  resolveSkillLoadout,
  skillBattleReceipt,
  skillLoadoutRevisionHash,
  skillNodeStates,
  type SkillConfiguration,
  type SkillLoadoutRevisionContent,
} from './skill-loadout.ts';
import { canonicalJson } from './spatial/canonical.ts';
import {
  SkillLoadoutReceiptSchema,
  skillReceiptExecutionResolutions,
} from './spatial/contracts.ts';
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
  it('keeps V1 revision bytes and hash stable', async () => {
    const reference = { id: 'fixture.ref', revision: 1, contentHash: hash },
      content = {
        schemaVersion: 1 as const,
        id: 'loadout.golden',
        revision: 1,
        character: reference,
        configuration: {
          schemaVersion: 1 as const,
          id: 'loadout.golden',
          version: 1,
          catalog: reference,
          eligibilityNodeIds: ['skill.a'],
          learnedNodeIds: ['skill.a'],
          enabledNodeIds: [],
        },
        resolved: {
          schemaVersion: 1 as const,
          resolverVersion: SKILL_RESOLVER_VERSION,
          configurationId: 'loadout.golden',
          configurationVersion: 1,
          catalog: reference,
          learnedNodeIds: ['skill.a'],
          explicitlyEnabledNodeIds: [],
          resolvedNodeIds: [],
          nodeResolutions: [],
          resolutionDigest: hash,
        },
      } satisfies SkillLoadoutRevisionContent,
      parsed = SkillLoadoutRevisionContentSchema.parse(content);
    expect({ bytes: canonicalJson(parsed), hash: await skillLoadoutRevisionHash(content) }).toEqual(
      {
        bytes:
          '{"character":{"contentHash":"sha256:1111111111111111111111111111111111111111111111111111111111111111","id":"fixture.ref","revision":1},"configuration":{"catalog":{"contentHash":"sha256:1111111111111111111111111111111111111111111111111111111111111111","id":"fixture.ref","revision":1},"eligibilityNodeIds":["skill.a"],"enabledNodeIds":[],"id":"loadout.golden","learnedNodeIds":["skill.a"],"schemaVersion":1,"version":1},"id":"loadout.golden","resolved":{"catalog":{"contentHash":"sha256:1111111111111111111111111111111111111111111111111111111111111111","id":"fixture.ref","revision":1},"configurationId":"loadout.golden","configurationVersion":1,"explicitlyEnabledNodeIds":[],"learnedNodeIds":["skill.a"],"nodeResolutions":[],"resolutionDigest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","resolvedNodeIds":[],"resolverVersion":"skill-resolver-v1","schemaVersion":1},"revision":1,"schemaVersion":1}',
        hash: 'sha256:98d01c76bf2e511eb32891d4c40fa638d7ee8218bc79e04cb4913b976db4f4a0',
      },
    );
  });

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

  it.each([
    {
      learned: ['skill.sword.rat.2'],
      eligible: [],
      enabled: ['skill.unknown'],
      code: 'unknown-node',
      message: 'enabledNodeIds contains unknown skill node: skill.unknown',
    },
    {
      learned: ['skill.sword.rat.2'],
      eligible: [],
      enabled: ['skill.sword.rat.1'],
      code: 'not-eligible',
      message: 'Learned node is not eligible: skill.sword.rat.2',
    },
    {
      learned: ['skill.sword.rat.2'],
      eligible: ['skill.sword.rat.2'],
      enabled: ['skill.sword.rat.1'],
      code: 'unmet-learning-prerequisite',
      message: 'Learned node skill.sword.rat.2 requires skill.sword.rat.1',
    },
  ])(
    'retains the baseline save error priority for $code',
    async ({ learned, eligible, enabled, code, message }) => {
      const catalog = completeCatalog(),
        config = await configuration(catalog, learned, enabled, eligible);
      await expect(resolveSkillLoadout(catalog, config, [])).rejects.toMatchObject({
        code,
        message,
      });
    },
  );

  it('retains path-limit priority over mixed recipes at the saving boundary', async () => {
    const catalog = completeCatalog(),
      ids = ['skill.sword.rat.1', 'skill.judo.rat.1', 'skill.magic.rat.1'];
    catalog.nodes
      .find((node) => node.id === ids[0])!
      .resolution.push({
        kind: 'passive-ability',
        ability: { id: 'passive.priority', revision: 1, contentHash: hash },
      });
    const config = await configuration(catalog, ids, ids);
    await expect(resolveSkillLoadout(catalog, config, [])).rejects.toMatchObject({
      code: 'enabled-path-limit',
      message: 'Resolved loadout uses 3 paths; maximum is 2',
    });
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
      character: content.character,
      loadout: { id: config.id, revision: 1, contentHash: snapshot.contentHash },
      resolvedNodeIds: [id],
      explicitlyEnabledNodeIds: [id],
    });
    await expect(
      skillBattleReceipt({ ...snapshot, contentHash: `sha256:${'3'.repeat(64)}` }),
    ).rejects.toThrow(/hash mismatch/);
  });

  it('binds a sealed snapshot to its configuration and a head to that exact snapshot', async () => {
    const catalog = completeCatalog(),
      { config, content } = await revisionContent(catalog, 'skill.sword.rat.1'),
      snapshot = { ...content, contentHash: await skillLoadoutRevisionHash(content) },
      head = {
        schemaVersion: 1,
        id: config.id,
        version: config.version,
        latest: { id: config.id, revision: 1, contentHash: snapshot.contentHash },
        snapshot,
        createdAt: '2026-10-02T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
      };
    for (const [resolved, message] of [
      [{ configurationId: 'loadout.other' }, 'Resolved loadout configuration mismatch'],
      [{ configurationVersion: config.version + 1 }, 'Resolved loadout configuration mismatch'],
      [{ catalog: { ...config.catalog, revision: 2 } }, 'Resolved loadout catalog mismatch'],
    ] as const)
      expect(
        SkillLoadoutRevisionContentSchema.safeParse({
          ...content,
          resolved: { ...content.resolved, ...resolved },
        }).error?.message,
      ).toMatch(message);
    expect(SkillLoadoutHeadSchema.parse(head).snapshot).toEqual(snapshot);
    for (const mismatch of [
      { latest: { ...head.latest, revision: 2 } },
      { latest: { ...head.latest, contentHash: `sha256:${'f'.repeat(64)}` } },
      { id: 'loadout.other', latest: { ...head.latest, id: 'loadout.other' } },
      { version: config.version + 1 },
    ])
      expect(SkillLoadoutHeadSchema.safeParse({ ...head, ...mismatch }).error?.message).toMatch(
        'Skill loadout head mismatch',
      );
  });

  it('projects passive recipes into the versioned battle receipt', async () => {
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
    ).resolves.toMatchObject({
      schemaVersion: 2,
      nodeResolutions: [
        {
          nodeId: id,
          resolution: [{ kind: 'passive-ability', ability: { id: 'passive.test' } }],
        },
      ],
    });
  });

  it('preserves shared grant provenance in v3 and projects one canonical execution ref', async () => {
    const catalog = completeCatalog(),
      nodeIds = ['skill.judo.rat.1', 'skill.sword.rat.1'],
      ability = catalog.nodes.find(({ id }) => id === nodeIds[1])!.resolution[0]!;
    catalog.nodes = catalog.nodes.map((node) =>
      nodeIds.includes(node.id) ? { ...node, resolution: [ability] } : node,
    );
    const direct = await configuration(catalog, nodeIds, nodeIds),
      permuted = await configuration(catalog, [...nodeIds].reverse(), [...nodeIds].reverse()),
      first = await resolveSkillLoadout(catalog, direct, []),
      second = await resolveSkillLoadout(catalog, permuted, []);
    expect(first.nodeResolutions).toEqual(second.nodeResolutions);
    expect(first.resolutionDigest).toBe(second.resolutionDigest);
    const content = {
        schemaVersion: 1 as const,
        id: direct.id,
        revision: 1,
        character: { id: 'character.test', revision: 1, contentHash: hash },
        configuration: direct,
        resolved: first,
      },
      receipt = await skillBattleReceipt({
        ...content,
        contentHash: await skillLoadoutRevisionHash(content),
      });
    expect(receipt).toMatchObject({
      schemaVersion: 3,
      resolvedNodeIds: [...nodeIds].sort(),
      nodeResolutions: [
        { nodeId: 'skill.judo.rat.1', resolution: [ability] },
        { nodeId: 'skill.sword.rat.1', resolution: [ability] },
      ],
    });
    expect(skillReceiptExecutionResolutions(receipt)).toEqual([ability]);

    const conflicting = structuredClone(first),
      secondResolution = conflicting.nodeResolutions[1]!.resolution[0]!;
    if (secondResolution.kind === 'augment') throw new Error('Expected an active grant');
    secondResolution.ability.contentHash = `sha256:${'2'.repeat(64)}`;
    const invalidContent = { ...content, resolved: conflicting };
    await expect(
      skillBattleReceipt({
        ...invalidContent,
        contentHash: await skillLoadoutRevisionHash(invalidContent),
      }),
    ).rejects.toThrow(/exact shared grants/);
  });

  it('keeps invalid duplicate produced abilities invalid under receipt v3', async () => {
    const active = {
        kind: 'active-ability' as const,
        ability: { id: 'shared', revision: 1, contentHash: hash },
      },
      base = {
        schemaVersion: 3 as const,
        resolverVersion: 'skill-resolver-v1',
        character: { id: 'character.test', revision: 1, contentHash: hash },
        catalog: { id: 'catalog.test', revision: 1, contentHash: hash },
        loadout: { id: 'loadout.test', revision: 1, contentHash: hash },
        explicitlyEnabledNodeIds: ['skill.one', 'skill.two'],
        resolvedNodeIds: ['skill.one', 'skill.two'],
        nodeResolutions: [
          { nodeId: 'skill.one', resolution: [active] },
          { nodeId: 'skill.two', resolution: [active] },
        ],
        resolutionDigest: hash,
      },
      invalid = [
        {
          ...base,
          resolvedNodeIds: ['skill.one'],
          explicitlyEnabledNodeIds: ['skill.one'],
          nodeResolutions: [{ nodeId: 'skill.one', resolution: [active, active] }],
        },
        {
          ...base,
          nodeResolutions: [
            base.nodeResolutions[0],
            {
              nodeId: 'skill.two',
              resolution: [
                {
                  ...active,
                  ability: { ...active.ability, contentHash: `sha256:${'2'.repeat(64)}` },
                },
              ],
            },
          ],
        },
        {
          ...base,
          nodeResolutions: [
            base.nodeResolutions[0],
            {
              nodeId: 'skill.two',
              resolution: [{ kind: 'passive-ability' as const, ability: active.ability }],
            },
          ],
        },
        {
          ...base,
          nodeResolutions: [
            base.nodeResolutions[0],
            {
              nodeId: 'skill.two',
              resolution: [
                {
                  kind: 'augment' as const,
                  baseAbility: { ...active.ability, revision: 2 },
                  resolvedAbility: active.ability,
                },
              ],
            },
          ],
        },
        {
          ...base,
          nodeResolutions: base.nodeResolutions.map(({ nodeId }) => ({
            nodeId,
            resolution: [
              {
                kind: 'augment' as const,
                baseAbility: { ...active.ability, revision: 2 },
                resolvedAbility: active.ability,
              },
            ],
          })),
        },
      ];
    expect(invalid.map((receipt) => SkillLoadoutReceiptSchema.safeParse(receipt).success)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('caps v3 execution abilities after exact shared provenance is deduplicated', () => {
    const nodeIds = Array.from({ length: 5 }, (_, index) => `skill.node.0${index + 1}`),
      ability = (id: string) => ({
        kind: 'active-ability' as const,
        ability: { id, revision: 1, contentHash: hash },
      }),
      receipt = (nodeResolutions: { nodeId: string; resolution: ReturnType<typeof ability>[] }[]) =>
        ({
          schemaVersion: 3 as const,
          resolverVersion: 'skill-resolver-v1',
          character: { id: 'character.test', revision: 1, contentHash: hash },
          catalog: { id: 'catalog.test', revision: 1, contentHash: hash },
          loadout: { id: 'loadout.test', revision: 1, contentHash: hash },
          explicitlyEnabledNodeIds: nodeIds,
          resolvedNodeIds: nodeIds,
          nodeResolutions,
          resolutionDigest: hash,
        }) as const,
      shared = Array.from({ length: 7 }, (_, index) => ability(`shared.0${index + 1}`)),
      sharedReceipt = SkillLoadoutReceiptSchema.parse(
        receipt(nodeIds.map((nodeId) => ({ nodeId, resolution: shared }))),
      );
    expect(sharedReceipt.nodeResolutions.flatMap(({ resolution }) => resolution)).toHaveLength(35);
    expect(skillReceiptExecutionResolutions(sharedReceipt)).toHaveLength(7);

    const unique = receipt(
      nodeIds.map((nodeId, nodeIndex) => ({
        nodeId,
        resolution: Array.from({ length: 7 }, (_, abilityIndex) =>
          ability(`unique.${nodeIndex}.${abilityIndex}`),
        ),
      })),
    );
    expect(SkillLoadoutReceiptSchema.safeParse(unique).success).toBe(false);
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
