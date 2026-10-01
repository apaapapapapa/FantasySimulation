import { expect, it } from 'vite-plus/test';
import { SkillNodeSchema, type SkillNode } from '@fantasy/domain';
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

function ability(contentHash = hash('a')): SkillAbility {
  return {
    kind: 'ability',
    id: 'shield-set-guard-v1',
    revision: 1,
    schemaVersion: 1,
    contentHash,
    definition: {
      name: 'Set shield guard',
      target: 'self',
      condition: { kind: 'always' },
      costs: { hp: 0, mp: 0, stamina: 4, uses: 0 },
      castSteps: 0,
      recoverySteps: 6,
      cooldownSteps: 60,
      movementWhileCasting: 'allow',
      rangeMm: 0,
    },
  } as SkillAbility;
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

it('uses the immutable ability ref for actual target, costs and runtime constraints', () => {
  const target = node();
  expect(abilitiesForNode(target, [ability(hash('b'))])[0]?.ability).toBeUndefined();
  const resolved = abilitiesForNode(target, [ability()]);
  expect(resolved[0]?.ability?.definition.target).toBe('self');
  expect(formatAbilityCosts(resolved[0]!.ability!)).toBe(
    'HP 0 / MP 0 / スタミナ 4 / 使用回数 無制限',
  );
  expect(formatAbilityConstraints(resolved[0]!.ability!)).toContain(
    '条件 always / 詠唱 0 step / 硬直 6 step / 再使用 60 step / 射程 0 mm / 詠唱中移動 可',
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
      { status: 'locked', reasons: ['not-eligible', `missing:${prerequisite.id}`] },
      [prerequisite, locked],
    ),
  ).toEqual(['このキャラクターでは未解禁です', '前提「先護り」を先に習得してください']);
  expect(
    workbenchReasonTexts({ status: 'disabled', reasons: ['lifecycle:implemented'] }, [
      prerequisite,
    ]),
  ).toEqual(['実装済みですが、利用可能として公開されていません']);
});
