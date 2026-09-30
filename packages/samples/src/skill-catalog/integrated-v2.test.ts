import { describe, expect, it } from 'vite-plus/test';
import { compareIds, skillCoordinateKey } from '@fantasy/domain';
import { integratedSkillShards } from './integrated-v2.ts';

describe('integrated startup skill shards', () => {
  it('covers fourteen unique authored paths without duplicate nodes or coordinates', () => {
    const nodes = integratedSkillShards.flatMap(({ nodes }) => nodes),
      paths = integratedSkillShards.map(({ path }) => path);

    expect(paths).toHaveLength(14);
    expect(new Set(paths).size).toBe(14);
    expect(nodes).toHaveLength(1_008);
    expect(new Set(nodes.map(({ id }) => id)).size).toBe(1_008);
    expect(new Set(nodes.map(({ coordinate }) => skillCoordinateKey(coordinate))).size).toBe(1_008);
    expect(nodes.filter(({ lifecycle }) => lifecycle === 'available')).toHaveLength(28);
    expect(nodes.filter(({ lifecycle }) => lifecycle === 'implemented')).toHaveLength(3);
    expect(nodes.filter(({ lifecycle }) => lifecycle === 'draft')).toHaveLength(977);
  });

  it('exposes only the runtime-evidenced available nodes from the source shards', () => {
    const available = integratedSkillShards
      .flatMap(({ nodes }) => nodes)
      .filter(({ lifecycle }) => lifecycle === 'available')
      .map(({ id }) => id)
      .sort(compareIds);

    expect(available).toEqual(
      [
        ...[1, 2, 3, 4, 5, 6].map((dan) => `skill.sword.rat.${dan}`),
        'skill.aikido.dog.1',
        'skill.spear.rat.1',
        'skill.shield.ox.1',
        'skill.shinto.rat.1',
        'skill.shinto.dragon.1',
        'skill.shinto.snake.1',
        'skill.shinto.dog.1',
        'skill.renki.rabbit.1',
        'skill.renki.horse.1',
        'skill.renki.rooster.1',
        'skill.renki.boar.1',
        'skill.magic.rat.1',
        'skill.magic.ox.1',
        'skill.magic.tiger.1',
        'skill.magic.rabbit.1',
        'skill.magic.dragon.1',
        'skill.magic.snake.1',
        'skill.magic.horse.1',
        'skill.magic.monkey.1',
        'skill.magic.rooster.1',
        'skill.magic.dog.1',
        'skill.magic.boar.1',
      ].sort(compareIds),
    );
    expect(
      available.every((id) => !id.includes('illusion-curse') && !id.includes('summoning')),
    ).toBe(true);
  });
});
