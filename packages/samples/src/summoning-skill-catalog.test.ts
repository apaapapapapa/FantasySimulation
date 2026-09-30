import { expect, it } from 'vite-plus/test';
import { SkillCatalogShardSchema, SKILL_ZODIAC_IDS } from '@fantasy/domain';
import {
  SUMMONING_FIXTURE_CONTRACTS,
  SUMMONING_FIXTURE_RELEASE_GATE,
  SUMMONING_RUNTIME_MECHANISMS,
  SUMMONING_SKILL_CATALOG_SHARD,
  SUMMONING_SKILL_NODES,
} from './summoning-skill-catalog.ts';

it('defines all 12 summoning branches and 72 draft nodes without placeholder effects', () => {
  const parsed = SkillCatalogShardSchema.parse(SUMMONING_SKILL_CATALOG_SHARD);
  expect(parsed.nodes).toHaveLength(72);
  expect(new Set(parsed.nodes.map(({ id }) => id)).size).toBe(72);
  expect(new Set(parsed.nodes.map(({ name }) => name)).size).toBe(72);
  expect(new Set(parsed.nodes.map(({ description }) => description)).size).toBe(72);
  for (const zodiac of SKILL_ZODIAC_IDS) {
    const branch = parsed.nodes.filter((node) => node.coordinate.zodiac === zodiac);
    expect(branch.map((node) => node.coordinate.dan)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(branch.map((node) => node.deepening.kind)).toEqual([
      'foundation',
      'conditional-effect',
      'combination',
      'tactical-mode',
      'specialization',
      'ultimate-tradeoff',
    ]);
    expect(branch.every((node) => node.lifecycle === 'draft')).toBe(true);
    expect(branch.every((node) => node.resolution.length === 0)).toBe(true);
    expect(branch.every((node) => node.deepening.retainsLowerUse)).toBe(true);
    expect(branch.slice(4).every((node) => node.deepening.conditionOrTradeoff)).toBe(true);
  }
});

it('binds every node to one pending fixture and covers the complete ADR 0021 mechanism set', () => {
  const contracts = new Map(SUMMONING_FIXTURE_CONTRACTS.map((fixture) => [fixture.id, fixture]));
  expect(contracts.size).toBe(72);
  expect(SUMMONING_SKILL_NODES.every((node) => contracts.has(node.fixtureIds[0]!))).toBe(true);
  expect(
    SUMMONING_FIXTURE_CONTRACTS.every(
      (fixture) =>
        fixture.status === 'runtime-pending' &&
        fixture.assertions.length >= 3 &&
        fixture.assertions[0]!.includes('allied with its immutable owner slot') &&
        fixture.assertions[0]!.includes('hostility derives from the opposing owner slot'),
    ),
  ).toBe(true);
  expect(SUMMONING_FIXTURE_RELEASE_GATE.lifecycle).toBe('draft-until-executable');
  expect(SUMMONING_FIXTURE_RELEASE_GATE.compatibility).toContain('legacy two-participant');
  expect(SUMMONING_FIXTURE_RELEASE_GATE.rollback).toContain('without rewriting');
  for (const zodiac of SKILL_ZODIAC_IDS) {
    const covered = new Set(
      SUMMONING_FIXTURE_CONTRACTS.filter((fixture) =>
        fixture.nodeId.startsWith(`skill.summoning.${zodiac}.`),
      ).flatMap((fixture) => fixture.missingMechanisms),
    );
    expect([...covered].sort()).toEqual([...SUMMONING_RUNTIME_MECHANISMS].sort());
  }
});
