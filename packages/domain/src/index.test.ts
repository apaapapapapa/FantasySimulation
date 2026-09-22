import { describe, expect, it } from 'vite-plus/test';
import knight from '../../../data/characters/aegis-knight.json';
import mage from '../../../data/characters/ember-mage.json';
import { CharacterSchema } from './index.ts';

describe('character JSON contract', () => {
  it('accepts both sample definitions', () => {
    expect(CharacterSchema.safeParse(knight).success).toBe(true);
    expect(CharacterSchema.safeParse(mage).success).toBe(true);
  });
  it('rejects unsupported abilities instead of silently ignoring them', () => {
    expect(
      CharacterSchema.safeParse({ ...knight, abilities: [{ kind: 'absolute-win' }] }).success,
    ).toBe(false);
  });
  it('rejects missing actions, unknown fields and invalid stats', () => {
    expect(CharacterSchema.safeParse({ ...knight, actions: [] }).success).toBe(false);
    expect(CharacterSchema.safeParse({ ...knight, typo: true }).success).toBe(false);
    expect(
      CharacterSchema.safeParse({ ...knight, stats: { ...knight.stats, maxHp: 0 } }).success,
    ).toBe(false);
  });
});
