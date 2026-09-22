import { describe, expect, it } from 'vite-plus/test';
import { CharacterSchema, type Character } from '@fantasy/domain';
import knightJson from '../../../data/characters/aegis-knight.json';
import mageJson from '../../../data/characters/ember-mage.json';
import { DEFAULT_RULESET, simulateBattle } from './index.ts';

const knight = CharacterSchema.parse(knightJson);
const mage = CharacterSchema.parse(mageJson);

describe('battle engine', () => {
  it('reproduces results without modifying character definitions', () => {
    const snapshot = structuredClone([knight, mage]);
    const result = simulateBattle(knight, mage);
    expect(result).toEqual(simulateBattle(knight, mage));
    // 25 damage per attack; the mage heals 3 after each completed round.
    // The knight survives four attacks with 20 HP and wins in round 4.
    expect(result.winnerId).toBe('aegis-knight');
    expect(result.reason).toBe('knockout');
    expect(result.rounds).toBe(4);
    expect(result.remainingHp).toEqual({ 'aegis-knight': 20, 'ember-mage': 0 });
    expect([knight, mage]).toEqual(snapshot);
  });

  it('does not favor the left slot when speed is tied', () => {
    const slowerMage = { ...mage, stats: { ...mage.stats, speed: knight.stats.speed } };
    expect(simulateBattle(knight, slowerMage)).toEqual(simulateBattle(slowerMage, knight));
  });

  it('ends an immune matchup as a bounded draw', () => {
    const shield: Character['abilities'] = [
      { kind: 'resistance', name: '無効化', damageType: 'physical', percent: 100 },
    ];
    const left = { ...knight, abilities: shield };
    const right = { ...knight, id: 'other-knight', abilities: shield };
    const result = simulateBattle(left, right);
    expect(result.winnerId).toBeNull();
    expect(result.reason).toBe('round-limit');
    expect(result.rounds).toBe(DEFAULT_RULESET.maxRounds);
    expect(result.events).toHaveLength(DEFAULT_RULESET.maxRounds * 2);
    expect(result.remainingHp).toEqual({
      [left.id]: left.stats.maxHp,
      [right.id]: right.stats.maxHp,
    });
  });

  it('chooses a magic action against a physical immunity', () => {
    const target: Character = {
      ...knight,
      abilities: [{ kind: 'resistance', name: '物理無効', damageType: 'physical', percent: 100 }],
    };
    const attacker = {
      ...mage,
      actions: mage.actions.map((action) =>
        action.kind === 'weapon' ? { ...action, power: 200 } : action,
      ),
    };
    const result = simulateBattle(attacker, target);
    expect(result.events[0]).toMatchObject({
      kind: 'attack',
      actionName: '火花',
      damageType: 'magical',
      damage: 25,
    });
  });

  it('does not let a defeated character act or regenerate', () => {
    const fragile: Character = { ...mage, stats: { ...mage.stats, maxHp: 1, speed: 0 } };
    const result = simulateBattle(knight, fragile);
    expect(result.events).toHaveLength(1);
    expect(result.winnerId).toBe(knight.id);
    expect(result.remainingHp[mage.id]).toBe(0);
  });

  it('rejects a self-match and non-finite stats', () => {
    expect(() => simulateBattle(knight, knight)).toThrow('different');
    expect(() =>
      simulateBattle({ ...knight, stats: { ...knight.stats, attack: Infinity } }, mage),
    ).toThrow('Invalid input');
  });
});
