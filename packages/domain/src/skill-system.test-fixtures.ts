import {
  EXPECTED_SKILL_COORDINATES,
  type SkillCatalog,
  type SkillDan,
  type SkillNode,
} from './skill-system.ts';

export const SKILL_TEST_HASH = `sha256:${'1'.repeat(64)}`;

const testDeepening = (dan: SkillDan): SkillNode['deepening'] => ({
  kind:
    dan === 1
      ? 'foundation'
      : dan === 2
        ? 'conditional-effect'
        : dan === 3
          ? 'combination'
          : dan === 4
            ? 'tactical-mode'
            : dan === 5
              ? 'specialization'
              : 'ultimate-tradeoff',
  explanation: `meaningful change for dan ${dan}`,
  retainsLowerUse: true,
  ...(dan >= 5 ? { conditionOrTradeoff: 'finite resource and recovery opening' } : {}),
});

export function completeSkillTestCatalog(): SkillCatalog {
  const nodes = EXPECTED_SKILL_COORDINATES.map((coordinate) => {
    const id = `skill.${coordinate.path}.${coordinate.zodiac}.${coordinate.dan}`;
    return {
      id,
      coordinate,
      name: id,
      description: `Executable test definition for ${id}`,
      lifecycle: 'available' as const,
      prerequisites:
        coordinate.dan === 1
          ? []
          : [`skill.${coordinate.path}.${coordinate.zodiac}.${coordinate.dan - 1}`],
      deepening: testDeepening(coordinate.dan),
      pathRoleTags: [`role.${coordinate.path}`],
      resolution: [
        {
          kind: 'active-ability' as const,
          ability: {
            id: `ability.${coordinate.path}.${coordinate.zodiac}`,
            revision: 1,
            contentHash: SKILL_TEST_HASH,
          },
        },
      ],
      fixtureIds: [`fixture.${coordinate.path}.${coordinate.zodiac}`],
    };
  });
  return { schemaVersion: 1, id: 'skill-catalog-v1', revision: 1, nodes };
}
