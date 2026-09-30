import { expect, it } from 'vite-plus/test';
import { SkillNodeSchema, type SkillConfiguration, type SkillNode } from '@fantasy/domain';
import {
  learnNode,
  loadoutCounts,
  toggleEnabledNode,
  workbenchNodeState,
} from './skill-workbench-state.ts';

const hash = `sha256:${'a'.repeat(64)}`;
function node(
  id: string,
  path: 'sword' | 'judo' | 'magic',
  prerequisites: string[] = [],
): SkillNode {
  return SkillNodeSchema.parse({
    id,
    coordinate: { path, zodiac: 'rat', dan: 1 },
    name: id,
    description: `${id} の検証用定義`,
    lifecycle: 'available',
    prerequisites,
    deepening: { kind: 'foundation', explanation: '基礎を検証する', retainsLowerUse: true },
    pathRoleTags: ['test-role'],
    resolution: [
      { kind: 'active-ability', ability: { id: `ability-${id}`, revision: 1, contentHash: hash } },
    ],
    fixtureIds: [`fixture-${id}`],
  });
}
function configuration(nodes: SkillNode[]): SkillConfiguration {
  return {
    schemaVersion: 1,
    id: 'test-loadout',
    version: 1,
    catalog: { id: 'catalog', revision: 1, contentHash: hash },
    eligibilityNodeIds: nodes.map((item) => item.id),
    learnedNodeIds: [],
    enabledNodeIds: [],
  };
}

it('moves an eligible node through learned and enabled without inventing catalog effects', () => {
  const nodes = [node('sword-rat-1', 'sword')];
  const learned = learnNode(nodes, configuration(nodes), nodes[0]!.id);
  expect(workbenchNodeState(nodes[0]!, learned).status).toBe('learned');
  const enabled = toggleEnabledNode(nodes, learned, nodes[0]!.id);
  expect(enabled.error).toBeUndefined();
  expect(workbenchNodeState(nodes[0]!, enabled.configuration).status).toBe('enabled');
  expect(loadoutCounts(nodes, enabled.configuration)).toEqual({ paths: 1, active: 1, passive: 0 });
});

it('keeps prerequisite locks and rejects a third path after resolving the closure', () => {
  const nodes = [
    node('sword-rat-1', 'sword'),
    node('judo-rat-1', 'judo'),
    node('magic-rat-1', 'magic', ['sword-rat-1']),
  ];
  const base = configuration(nodes);
  expect(workbenchNodeState(nodes[2]!, base)).toEqual({
    status: 'locked',
    reasons: ['missing:sword-rat-1'],
  });
  const learned = {
    ...base,
    learnedNodeIds: nodes.map((item) => item.id),
    enabledNodeIds: ['judo-rat-1'],
  };
  const rejected = toggleEnabledNode(nodes, learned, 'magic-rat-1');
  expect(rejected.error).toMatch(/最大2つ/);
  expect(rejected.configuration).toBe(learned);
});
