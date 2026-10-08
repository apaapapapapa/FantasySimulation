import type { SkillNode } from '@fantasy/domain';
import { SUMMONING_SKILL_NODES } from '../summoning-skill-catalog.ts';

export const SUMMONING_RAT_DAN1_ABILITY_ID = 'scout-rat-v1';
export const SUMMONING_RAT_DAN1_ABILITY_HASH =
  'sha256:c137e74851756fbdd5d8aefcdaecd325347758ad1627c1bc7f7a21b673687927';
export const SUMMONING_RAT_DAN1_FIXTURE_ID = 'fixture.skill.summoning.rat.1.runtime.v1';

const draft = SUMMONING_SKILL_NODES.find(({ id }) => id === 'skill.summoning.rat.1');
if (!draft) throw new Error('Missing summoning rat foundation draft');

/** One low-dan scout: short-lived, low-damage and unable to drain or decide victory. */
export const SUMMONING_RAT_DAN1_SKILL_NODE = {
  ...draft,
  lifecycle: 'available',
  description:
    'Creates one fragile, short-lived scout that spends upkeep and autonomously harasses a recorded legally observed hostile for low damage.',
  deepening: {
    ...draft.deepening,
    explanation:
      'Establishes bounded autonomous scouting with a single use, finite lifetime and upkeep; recorded policy decisions are not external redirect instructions, and it has no drain or victory eligibility.',
  },
  resolution: [
    {
      kind: 'active-ability',
      ability: {
        id: SUMMONING_RAT_DAN1_ABILITY_ID,
        revision: 1,
        contentHash: SUMMONING_RAT_DAN1_ABILITY_HASH,
      },
    },
  ],
  fixtureIds: [SUMMONING_RAT_DAN1_FIXTURE_ID],
} as const satisfies SkillNode;
