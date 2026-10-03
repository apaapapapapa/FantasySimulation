import { expect, it } from 'vite-plus/test';
import {
  inspectSkillEnabledNodes,
  skillApplicabilityReasons,
  skillLearningReasons,
  skillNodeDecision,
  skillPrerequisiteClosure,
} from './skill-selection.ts';
import { completeSkillTestCatalog, SKILL_TEST_HASH } from './skill-system.test-fixtures.ts';
import { revisionRefKey } from './skill-system.ts';

const branch = () =>
  completeSkillTestCatalog().nodes.filter(
    (node) => node.coordinate.path === 'sword' && node.coordinate.zodiac === 'rat',
  );

it('closes prerequisites canonically, without changing selection or input nodes', () => {
  const nodes = branch(),
    before = JSON.stringify(nodes);
  expect(skillPrerequisiteClosure(nodes, ['skill.sword.rat.3', 'skill.sword.rat.2'])).toEqual([
    'skill.sword.rat.1',
    'skill.sword.rat.2',
    'skill.sword.rat.3',
  ]);
  expect(
    skillPrerequisiteClosure([...nodes].reverse(), ['skill.sword.rat.2', 'skill.sword.rat.3']),
  ).toEqual(['skill.sword.rat.1', 'skill.sword.rat.2', 'skill.sword.rat.3']);
  expect(JSON.stringify(nodes)).toBe(before);
});

it.each(['unknown-node', 'missing-prerequisite', 'prerequisite-cycle', 'duplicate-node'] as const)(
  'rejects %s without returning a partial closure',
  (code) => {
    const nodes = branch();
    if (code === 'missing-prerequisite') nodes[0]!.prerequisites = ['skill.missing'];
    if (code === 'prerequisite-cycle') nodes[0]!.prerequisites = [nodes[1]!.id];
    if (code === 'duplicate-node') nodes.push(nodes[0]!);
    expect(() =>
      skillPrerequisiteClosure(nodes, [code === 'unknown-node' ? 'skill.missing' : nodes[1]!.id]),
    ).toThrow(expect.objectContaining({ reason: expect.objectContaining({ code }) }));
  },
);

it('bounds graph and selected inputs using the existing catalog cardinality contract', () => {
  const nodes = completeSkillTestCatalog().nodes;
  expect(() => skillPrerequisiteClosure([...nodes, nodes[0]!], [])).toThrow(/1152/);
  expect(() => skillPrerequisiteClosure(nodes, [nodes[0]!.id, nodes[0]!.id])).toThrow(/unique/);
});

it('shares structured prerequisite and learning states while preserving eligibility versus learned versus enabled', () => {
  const node = branch()[1]!,
    sets = { eligible: new Set<string>(), learned: new Set<string>(), enabled: new Set<string>() };
  expect(skillLearningReasons(node, sets)).toEqual([
    { code: 'not-eligible', nodeId: 'skill.sword.rat.2' },
    {
      code: 'unmet-learning-prerequisite',
      nodeId: 'skill.sword.rat.2',
      prerequisiteNodeId: 'skill.sword.rat.1',
    },
  ]);
  expect(skillNodeDecision(node, sets).status).toBe('locked');
  sets.eligible.add(node.id);
  sets.learned.add('skill.sword.rat.1');
  expect(skillNodeDecision(node, sets)).toEqual({ status: 'learnable', reasons: [] });
  sets.learned.add(node.id);
  expect(skillNodeDecision(node, sets).status).toBe('learned');
  sets.enabled.add(node.id);
  expect(skillNodeDecision(node, sets).status).toBe('enabled');
  node.lifecycle = 'retired';
  expect(skillNodeDecision(node, sets)).toEqual({
    status: 'retired',
    reasons: [{ code: 'unavailable-node', nodeId: 'skill.sword.rat.2', lifecycle: 'retired' }],
  });
});

it('requires exact augment ownership and explicit equipment tags in capability assessment', () => {
  const node = branch()[0]!,
    baseAbility = { id: 'ability.base', revision: 1, contentHash: SKILL_TEST_HASH };
  node.weaponTags = ['weapon.sword'];
  node.resolution = [
    { kind: 'augment', baseAbility, resolvedAbility: { ...baseAbility, revision: 2 } },
  ];
  expect(
    skillApplicabilityReasons(
      node,
      new Set(),
      new Set([revisionRefKey({ ...baseAbility, revision: 2 })]),
    ),
  ).toEqual([
    { code: 'weapon-requirement', nodeId: 'skill.sword.rat.1', weaponTag: 'weapon.sword' },
    { code: 'augment-base-not-owned', nodeId: 'skill.sword.rat.1', baseAbility },
  ]);
  expect(
    skillApplicabilityReasons(
      node,
      new Set(['weapon.sword']),
      new Set([revisionRefKey(baseAbility)]),
    ),
  ).toEqual([]);
});

it('counts passive and augment together and reports path limits before mixed recipes', () => {
  const nodes = completeSkillTestCatalog().nodes.filter(
      (node) =>
        ['sword', 'judo', 'magic'].includes(node.coordinate.path) &&
        node.coordinate.zodiac === 'rat' &&
        node.coordinate.dan === 1,
    ),
    ability = { id: 'ability.passive', revision: 1, contentHash: SKILL_TEST_HASH };
  nodes[0]!.resolution.push({ kind: 'passive-ability', ability });
  nodes[1]!.resolution = [{ kind: 'passive-ability', ability }];
  nodes[2]!.resolution = [
    { kind: 'augment', baseAbility: ability, resolvedAbility: { ...ability, revision: 2 } },
  ];
  expect(inspectSkillEnabledNodes(nodes)).toEqual({
    counts: { paths: 3, active: 0, passive: 2 },
    reasons: [
      { code: 'enabled-path-limit', count: 3, maximum: 2 },
      { code: 'mixed-resolution-kind', nodeId: nodes[0]!.id },
    ],
  });
});
