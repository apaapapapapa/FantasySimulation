import { describe, expect, it } from 'vite-plus/test';
import fixturePlan from '../../../docs/adr/0020-skill-illusion-fixtures.json' with { type: 'json' };
import {
  ILLUSION_CURSE_DAN_ORDER,
  ILLUSION_CURSE_DRAFT_NODES,
  ILLUSION_CURSE_MISSING_MECHANISMS,
  ILLUSION_CURSE_ZODIAC_ORDER,
} from './illusion-curse-catalog.ts';
import { SkillNodeSchema, skillCoordinateKey } from './skill-system.ts';

describe('illusion-curse draft catalog', () => {
  it('covers the exact twelve-zodiac by six-dan path without releasing runtime stubs', () => {
    expect(ILLUSION_CURSE_DRAFT_NODES).toHaveLength(72);
    expect(
      new Set(ILLUSION_CURSE_DRAFT_NODES.map(({ node }) => skillCoordinateKey(node.coordinate))),
    ).toEqual(
      new Set(
        ILLUSION_CURSE_ZODIAC_ORDER.flatMap((zodiac) =>
          ILLUSION_CURSE_DAN_ORDER.map((dan) => `illusion-curse:${zodiac}:${dan}`),
        ),
      ),
    );
    for (const { node } of ILLUSION_CURSE_DRAFT_NODES) {
      expect(SkillNodeSchema.parse(node)).toEqual(node);
      expect(node.lifecycle).toBe('draft');
      expect(node.resolution).toEqual([]);
      expect(node.fixtureIds).toEqual([]);
    }
  });

  it('gives every branch six distinct deepenings with retained lower use and upper tradeoffs', () => {
    const branchRoles = new Set<string>();
    for (const zodiac of ILLUSION_CURSE_ZODIAC_ORDER) {
      const branch = ILLUSION_CURSE_DRAFT_NODES.filter(
        ({ node }) => node.coordinate.zodiac === zodiac,
      );
      expect(new Set(branch.map(({ design }) => design.branchRole)).size).toBe(1);
      branchRoles.add(branch[0]!.design.branchRole);
      expect(branch.map(({ node }) => node.coordinate.dan)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(branch.map(({ node }) => node.name)).size).toBe(6);
      expect(new Set(branch.map(({ node }) => node.deepening.explanation)).size).toBe(6);
      for (const { node, design } of branch) {
        expect(node.deepening.retainsLowerUse).toBe(true);
        expect(node.description).toContain(design.lowerUse);
        expect(
          node.coordinate.dan < 5 || (node.deepening.conditionOrTradeoff?.length ?? 0) > 20,
        ).toBe(true);
      }
    }
    expect(branchRoles.size).toBe(12);
    expect(new Set(ILLUSION_CURSE_DRAFT_NODES.map(({ node }) => node.name)).size).toBe(72);
  });

  it('declares modality, target, defense, counters and finite lifecycle for every node', () => {
    const modalities = new Set<string>(),
      defenses = new Set<string>(),
      techniques = new Set<string>();
    for (const { design } of ILLUSION_CURSE_DRAFT_NODES) {
      modalities.add(design.modality);
      defenses.add(design.defense);
      techniques.add(design.technique);
      expect(design.duration).toBe('finite-boundary-expiry');
      expect(design.counters).toContain('expiry');
      expect(design.interference.length).toBeGreaterThanOrEqual(4);
      expect(design.observation).not.toHaveLength(0);
      expect(design.persistence).not.toHaveLength(0);
      expect(design.replay).not.toHaveLength(0);
      expect(design.missingMechanismIds).not.toHaveLength(0);
      for (const id of design.missingMechanismIds)
        expect(ILLUSION_CURSE_MISSING_MECHANISMS).toHaveProperty(id);
    }
    expect(modalities).toEqual(new Set(['none', 'visual', 'audio', 'presence', 'multi']));
    expect(defenses).toEqual(
      new Set(['curse-resistance', 'mental-resistance', 'illusion-detection', 'none']),
    );
    expect(techniques).toEqual(new Set(['curse', 'mind', 'illusion', 'counter']));
  });

  it('binds every planned node fixture to the reviewed fixture plan without claiming runtime proof', () => {
    expect(fixturePlan).toMatchObject({
      status: 'catalog-design-implemented-runtime-blocked',
      baseline: '78eddc5181a6abdf975f56428f000b16644ae580',
      path: 'illusion-curse',
      nodeDesignEvidence: { coordinates: 72 },
    });
    expect(fixturePlan.runtimeSuites).toHaveLength(7);
    expect(fixturePlan.runtimeSuites.every(({ status }) => status === 'blocked')).toBe(true);
    const required = new Set(fixturePlan.runtimeSuites.flatMap(({ requires }) => requires));
    for (const id of required) expect(ILLUSION_CURSE_MISSING_MECHANISMS).toHaveProperty(id);
    for (const { node, design } of ILLUSION_CURSE_DRAFT_NODES)
      expect(design.plannedFixtureId).toBe(`fixture.${node.id}`);
  });
});
