import type { SkillNode } from '@fantasy/domain';

export const ENVIRONMENTAL_HOLOGRAM_ABILITY_ID = 'side-step-image-v1';
export const ENVIRONMENTAL_HOLOGRAM_ABILITY_HASH =
  'sha256:96e42f32200a1d27beffa1a185a79206b847ce2a1ff162b680150bab6a0aa1fa';
export const ENVIRONMENTAL_HOLOGRAM_FIXTURE_ID = 'fixture.skill.illusion-curse.rabbit.1.runtime';

/** The first published environmental-hologram skill: one bounded visual sensor decoy. */
export const ENVIRONMENTAL_HOLOGRAM_SKILL_NODE = {
  id: 'skill.illusion-curse.rabbit.1',
  coordinate: { path: 'illusion-curse', zodiac: 'rabbit', dan: 1 },
  name: 'Side-Step Image',
  description:
    'Projects one short-lived visual sensor image beside the caster to cover a withdrawal without creating a combat actor.',
  lifecycle: 'available',
  prerequisites: [],
  deepening: {
    kind: 'foundation',
    explanation:
      'Establishes the inexpensive single visual decoy; it never gains collision, HP, damage or victory eligibility.',
    retainsLowerUse: true,
  },
  pathRoleTags: ['illusion-curse.illusion', 'zodiac.rabbit', 'modality.visual', 'evasion'],
  resolution: [
    {
      kind: 'active-ability',
      ability: {
        id: ENVIRONMENTAL_HOLOGRAM_ABILITY_ID,
        revision: 1,
        contentHash: ENVIRONMENTAL_HOLOGRAM_ABILITY_HASH,
      },
    },
  ],
  fixtureIds: [ENVIRONMENTAL_HOLOGRAM_FIXTURE_ID],
} as const satisfies SkillNode;
