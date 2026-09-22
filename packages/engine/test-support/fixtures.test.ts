import { expect, it } from 'vite-plus/test';
import { boxObstacle, combatManifest, editScenario, glassWall } from './fixtures.ts';
import { prepareBattle, reference, sealRevision } from '../src/spatial/prepare.ts';

it('creates fresh nested obstacle inputs without sharing caller vectors or block flags', () => {
  const center = { x: 1, y: 2, z: 3 };
  const extents = { x: 100, y: 100, z: 100 };
  const first = boxObstacle('one', center, extents);
  first.center.x = 90;
  first.halfExtents.x = 90;
  first.blocks.vision = false;
  expect(center.x).toBe(1);
  expect(extents.x).toBe(100);
  expect(boxObstacle('two', center, extents).blocks.vision).toBe(true);
  expect(glassWall(5)).toMatchObject({ halfExtents: { x: 5 }, blocks: { vision: false } });
});
it('wires resealed revisions and isolates independent combat fixtures', async () => {
  const first = await combatManifest(20, {
    ability: { castSteps: 7 },
    policy: { movement: 'hold' },
  });
  const second = await combatManifest(20);
  const pristine = structuredClone(second);
  await editScenario(first, (scenario) => scenario.obstacles.push(glassWall(5)));
  const battle = await prepareBattle(first);
  expect(battle.actors[0].abilities[0]?.definition.castSteps).toBe(7);
  expect(battle.actors[0].policy.movement).toBe('hold');
  expect(second).toEqual(pristine);
  expect(first.scenario.contentHash).not.toBe(second.scenario.contentHash);
});
it('replaces only the selected scenario and leaves unrelated revisions unchanged', async () => {
  const manifest = await combatManifest(10);
  const original = manifest.revisions.find((r) => r.kind === 'scenario')!;
  if (original.kind !== 'scenario') throw Error('Expected scenario');
  const selected = await sealRevision(
    'scenario',
    original.id,
    original.revision + 1,
    original.definition,
  );
  manifest.revisions.push(selected);
  manifest.scenario = reference(selected);
  await editScenario(manifest, (scenario) => scenario.obstacles.push(glassWall(1)));
  expect(manifest.revisions).toContain(original);
  expect(manifest.revisions).not.toContain(selected);
  expect(manifest.scenario.revision).toBe(selected.revision);
  await expect(prepareBattle(manifest)).resolves.toBeDefined();
});
it('keeps the manifest untouched when an edit cannot be validated', async () => {
  const manifest = await combatManifest(10);
  const before = structuredClone(manifest);
  await expect(
    editScenario(manifest, (scenario) => {
      scenario.obstacles.push(glassWall(-1));
    }),
  ).rejects.toThrow(Error);
  expect(manifest).toEqual(before);
});
