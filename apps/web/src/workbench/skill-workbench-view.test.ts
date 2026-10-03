import { expect, it } from 'vite-plus/test';
import { SkillNodeSchema, type SkillNode } from '@fantasy/domain';
import { revisionHash, RevisionSchema } from '@fantasy/domain/spatial';
import type { SkillAbility } from './skill-api.ts';
import {
  abilitiesForNode,
  filterSkillNodes,
  formatAbilityConstraints,
  formatAbilityCosts,
  workbenchReasonTexts,
} from './skill-workbench-view.ts';

const hash = (value: string) => `sha256:${value.repeat(64)}` as const;

function node(overrides: Record<string, unknown> = {}): SkillNode {
  return SkillNodeSchema.parse({
    id: 'skill.shield.rat.1',
    coordinate: { path: 'shield', zodiac: 'rat', dan: 1 },
    name: '先護り',
    description: '防護を先に構えて相手の攻撃を受け止める。',
    lifecycle: 'available',
    prerequisites: [],
    weaponTags: ['shield'],
    deepening: {
      kind: 'foundation',
      explanation: '低消耗の防御を基礎として残す。',
      retainsLowerUse: true,
    },
    pathRoleTags: ['guard'],
    resolution: [
      {
        kind: 'active-ability',
        ability: { id: 'shield-set-guard-v1', revision: 1, contentHash: hash('a') },
      },
    ],
    fixtureIds: ['fixture.shield.guard'],
    ...overrides,
  });
}

async function ability(overrides: Record<string, unknown> = {}): Promise<SkillAbility> {
  const parsed = RevisionSchema.parse({
    kind: 'ability',
    id: 'shield-set-guard-v1',
    revision: 1,
    schemaVersion: 1,
    contentHash: hash('0'),
    definition: {
      name: 'Set shield guard',
      originalText: '',
      trigger: 'action',
      effects: [{ kind: 'heal', amount: 1 }],
      attack: { kind: 'direct' },
      condition: { kind: 'always' },
      target: 'self',
      costs: { hp: 0, mp: 0, stamina: 7, uses: 0 },
      rangeMm: 0,
      castSteps: 2,
      cooldownSteps: 11,
      recoverySteps: 9,
      aimErrorMilliDegrees: 0,
      movementWhileCasting: 'allow',
      ...overrides,
    },
  });
  if (parsed.kind !== 'ability') throw new Error('Expected ability fixture');
  return { ...parsed, contentHash: await revisionHash(parsed) };
}

it('searches actual node text by name, path, dan, zodiac and effect without hiding coordinates', () => {
  const target = node();
  for (const query of ['先護り', '盾道', '初段', '子', '防護', 'guard']) {
    expect(
      filterSkillNodes([target], { query, path: 'shield', zodiac: 'all', dan: 'all' }),
    ).toEqual([target]);
  }
  expect(
    filterSkillNodes([target], { query: '防護', path: 'shield', zodiac: 'ox', dan: 'all' }),
  ).toEqual([]);
});

it('uses the immutable ability ref for actual target, costs and runtime constraints', async () => {
  const matching = await ability();
  const target = node({
    resolution: [
      {
        kind: 'active-ability',
        ability: {
          id: matching.id,
          revision: matching.revision,
          contentHash: matching.contentHash,
        },
      },
    ],
  });
  const different = await ability({ costs: { hp: 0, mp: 1, stamina: 4, uses: 0 } });
  expect(abilitiesForNode(target, [different])[0]?.ability).toBeUndefined();
  const resolved = abilitiesForNode(target, [matching]);
  expect(resolved[0]?.ability?.definition.target).toBe('self');
  expect(formatAbilityCosts(resolved[0]!.ability!)).toBe(
    'HP 0 / MP 0 / スタミナ 7 / 使用回数 無制限',
  );
  expect(formatAbilityConstraints(resolved[0]!.ability!)).toContain(
    '条件 always / 詠唱 2 step / 硬直 9 step / 再使用 11 step / 射程 0 mm / 詠唱中移動 可',
  );
});

it('explains unavailable lifecycle and prerequisite locks in user-facing terms', () => {
  const prerequisite = node({ id: 'skill.shield.rat.1' });
  const locked = node({
    id: 'skill.shield.rat.2',
    coordinate: { path: 'shield', zodiac: 'rat', dan: 2 },
    prerequisites: [prerequisite.id],
    deepening: {
      kind: 'conditional-effect',
      explanation: '攻撃を観測した場合に応用する。',
      retainsLowerUse: true,
    },
  });
  expect(
    workbenchReasonTexts(
      {
        status: 'locked',
        reasons: [
          { code: 'not-eligible', nodeId: locked.id },
          {
            code: 'unmet-learning-prerequisite',
            nodeId: locked.id,
            prerequisiteNodeId: prerequisite.id,
          },
        ],
      },
      [prerequisite, locked],
    ),
  ).toEqual(['このキャラクターでは未解禁です', '前提「先護り」を先に習得してください']);
  expect(
    workbenchReasonTexts(
      {
        status: 'disabled',
        reasons: [{ code: 'unavailable-node', nodeId: locked.id, lifecycle: 'implemented' }],
      },
      [prerequisite],
    ),
  ).toEqual(['実装済みですが、利用可能として公開されていません']);
});
