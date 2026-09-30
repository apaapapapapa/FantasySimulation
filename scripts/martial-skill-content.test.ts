import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { SkillCatalogShardSchema, canonicalJson } from '@fantasy/domain';
import { catalogManifest } from '@fantasy/samples';
import { initializePhysics, runBattle } from '@fantasy/engine/spatial';
import {
  compileMartialSkillContent,
  martialSkillDirectory,
  readMartialSkillContent,
} from './martial-skill-content.ts';

beforeAll(initializePhysics);

const expectedPaths = [
  'judo',
  'aikido',
  'karate',
  'staff',
  'dagger',
  'draw-sword',
  'spear',
  'axe',
] as const;
const expectedContrasts = [
  'contrast.aikido.judo',
  'contrast.axe.karate',
  'contrast.dagger.draw-sword',
  'contrast.draw-sword.sword',
  'contrast.spear.staff',
];

describe('SK-04 martial path content', () => {
  it('keeps eight exact 72-node shards and only runtime-proven foundations available', () => {
    const content = readMartialSkillContent(),
      nodes = content.shards.flatMap((shard) => shard.nodes),
      available = nodes.filter((node) => node.lifecycle === 'available');
    expect(content.shards.map(({ path }) => path)).toEqual(expectedPaths);
    expect(content.shards.every((shard) => shard.nodes.length === 72)).toBe(true);
    expect(nodes).toHaveLength(576);
    expect(new Set(nodes.map(({ id }) => id)).size).toBe(576);
    expect(available).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'skill.spear.rat.1',
          coordinate: { path: 'spear', zodiac: 'rat', dan: 1 },
          resolution: [
            {
              kind: 'active-ability',
              ability: {
                id: 'spear',
                revision: 1,
                contentHash:
                  'sha256:a35e671ad8eb99351f23624ffe35582e0d1cd083efab80307fca813f578d88f3',
              },
            },
          ],
          fixtureIds: ['fixture.skill.spear.rat.1.action'],
        }),
        expect.objectContaining({
          id: 'skill.aikido.dog.1',
          coordinate: { path: 'aikido', zodiac: 'dog', dan: 1 },
          resolution: [
            {
              kind: 'passive-ability',
              ability: {
                id: 'parry-v1',
                revision: 1,
                contentHash:
                  'sha256:e224015688c44cd495f7e239f990ba0439b52a9f8e00da5bffddf27e9da05980',
              },
            },
          ],
          fixtureIds: ['fixture.skill.aikido.dog.1.parry'],
        }),
      ]),
    );
    expect(available).toHaveLength(2);
    expect(nodes.filter((node) => node.lifecycle === 'draft')).toHaveLength(574);
    expect(
      nodes
        .filter((node) => node.lifecycle === 'draft')
        .every((node) => !node.resolution.length && !node.fixtureIds.length),
    ).toBe(true);
  });

  it('records six-stage depth, retained lower use and upper tradeoffs for all 96 branches', () => {
    const { fixtures, shards } = readMartialSkillContent();
    expect(fixtures.branches).toHaveLength(96);
    for (const fixture of fixtures.branches) {
      const nodes = shards
        .find(({ path }) => path === fixture.path)!
        .nodes.filter(({ coordinate }) => coordinate.zodiac === fixture.zodiac);
      expect(nodes.map(({ coordinate }) => coordinate.dan)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(nodes.map(({ deepening }) => deepening.kind)).toEqual([
        'foundation',
        'conditional-effect',
        'combination',
        'tactical-mode',
        'specialization',
        'ultimate-tradeoff',
      ]);
      expect(nodes.every(({ deepening }) => deepening.retainsLowerUse)).toBe(true);
      expect(nodes.slice(4).every(({ deepening }) => !!deepening.conditionOrTradeoff)).toBe(true);
      expect(fixture.lowLevelUse).not.toContain('TODO');
      expect(fixture.upperDanTradeoffs.every((tradeoff) => tradeoff.length > 40)).toBe(true);
      expect(fixture.status).toBe(
        (fixture.path === 'spear' && fixture.zodiac === 'rat') ||
          (fixture.path === 'aikido' && fixture.zodiac === 'dog')
          ? 'partial'
          : 'blocked',
      );
    }
  });

  it('pins the overlap boundaries to different required mechanisms', () => {
    const { fixtures, source } = readMartialSkillContent(),
      paths = new Map(source.paths.map((path) => [path.id, path]));
    expect(fixtures.contrasts.map(({ id }) => id)).toEqual(expectedContrasts);
    for (const [left, right] of [
      ['judo', 'aikido'],
      ['staff', 'spear'],
      ['karate', 'axe'],
      ['dagger', 'draw-sword'],
    ] as const) {
      const a = paths.get(left)!,
        b = paths.get(right)!;
      expect(a.core).not.toBe(b.core);
      expect(a.requiredMechanics.some((mechanic) => !b.requiredMechanics.includes(mechanic))).toBe(
        true,
      );
      expect(b.requiredMechanics.some((mechanic) => !a.requiredMechanics.includes(mechanic))).toBe(
        true,
      );
      expect(a.contrast).toContain(left === 'judo' ? 'initiates' : a.label);
    }
  });

  it('keeps generated shards and fixture plans equal to reviewed authoring', () => {
    const content = readMartialSkillContent();
    for (const expected of content.shards) {
      const saved = SkillCatalogShardSchema.parse(
        JSON.parse(readFileSync(join(martialSkillDirectory, `${expected.path}.json`), 'utf8')),
      );
      expect(canonicalJson(saved)).toBe(canonicalJson(expected));
    }
    const savedFixtures: unknown = JSON.parse(
      readFileSync(join(martialSkillDirectory, 'fixtures.json'), 'utf8'),
    );
    expect(canonicalJson(savedFixtures)).toBe(canonicalJson(content.fixtures));
  });

  it('rejects missing paths and unpinned release definitions', () => {
    const content = readMartialSkillContent(),
      spatial: unknown = JSON.parse(
        readFileSync(join(martialSkillDirectory, '../../spatial/catalog.json'), 'utf8'),
      );
    expect(() =>
      compileMartialSkillContent(
        { ...content.source, paths: content.source.paths.slice(1) },
        spatial,
      ),
    ).toThrow(/Too small|SK-04 path/);
    const changed = structuredClone(content.source),
      release = changed.releases[0];
    if (!release) throw new Error('Missing authored release fixture');
    release.ability.contentHash = `sha256:${'0'.repeat(64)}`;
    expect(() => compileMartialSkillContent(changed, spatial)).toThrow(
      'Missing exact martial release definition',
    );
  });

  it('executes the only released node as a real long-reach thrust', async () => {
    const manifest = await catalogManifest('lancer', 'swordsman', 'flat', 400),
      run = await runBattle(manifest),
      events = run.records.flatMap((record) => ('events' in record ? record.events : []));
    expect(events.some((event) => event.actorId === 'left' && event.abilityId === 'spear')).toBe(
      true,
    );
    const spear = manifest.revisions.find(
      (revision) => revision.kind === 'ability' && revision.id === 'spear',
    );
    if (spear?.kind !== 'ability') throw new Error('Missing spear fixture ability');
    expect(spear.definition.attack).toMatchObject({ kind: 'melee', reachMm: 3_200 });
  });
});
