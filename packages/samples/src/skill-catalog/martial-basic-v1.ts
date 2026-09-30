import { archerySkillEvidence, archerySkillShard } from './archery-v1.ts';
import { shieldSkillEvidence, shieldSkillShard } from './shield-v1.ts';
import { swordSkillEvidence, swordSkillShard } from './sword-v1.ts';

export const martialBasicSkillShards = [
  swordSkillShard,
  archerySkillShard,
  shieldSkillShard,
] as const;

export const martialBasicSkillEvidence = [
  ...swordSkillEvidence,
  ...archerySkillEvidence,
  ...shieldSkillEvidence,
] as const;
