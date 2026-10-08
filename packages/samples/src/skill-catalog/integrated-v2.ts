import { SkillCatalogShardSchema } from '@fantasy/domain';
import aikido from '../../../../data/skills/martial-eight-v1/aikido.json' with { type: 'json' };
import axe from '../../../../data/skills/martial-eight-v1/axe.json' with { type: 'json' };
import dagger from '../../../../data/skills/martial-eight-v1/dagger.json' with { type: 'json' };
import drawSword from '../../../../data/skills/martial-eight-v1/draw-sword.json' with { type: 'json' };
import judo from '../../../../data/skills/martial-eight-v1/judo.json' with { type: 'json' };
import karate from '../../../../data/skills/martial-eight-v1/karate.json' with { type: 'json' };
import spear from '../../../../data/skills/martial-eight-v1/spear.json' with { type: 'json' };
import staff from '../../../../data/skills/martial-eight-v1/staff.json' with { type: 'json' };
import { MYSTIC_SKILL_SHARDS } from '../skill-content/mystic-three.ts';
import { martialBasicSkillShards } from './martial-basic-v1.ts';

const martialEight = [judo, aikido, karate, staff, dagger, drawSword, spear, axe].map((input) =>
  SkillCatalogShardSchema.parse(input),
);

/**
 * Authored catalog slices that production startup overlays onto its complete draft skeleton.
 * Source catalog IDs are intentionally not rewritten: the aggregate is a new immutable catalog
 * revision assembled by the API, while every shard remains independently attributable.
 */
export const integratedSkillShards = [
  ...martialBasicSkillShards,
  ...martialEight,
  ...Object.values(MYSTIC_SKILL_SHARDS),
];
