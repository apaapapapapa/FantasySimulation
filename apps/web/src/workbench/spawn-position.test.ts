import { readFileSync } from 'node:fs';
import { expect, it } from 'vite-plus/test';
import { ReplayManifestSchema } from '@fantasy/domain/spatial';
import { spawnPositions } from './spawn-position.ts';

it('fits tall bodies and translated arena bounds, rejecting bodies that cannot fit', () => {
  const manifest = ReplayManifestSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(
          '../../test-fixtures/replays/swordsman-sky-mage-240/manifest.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );
  const character = manifest.input.revisions.find((r) => r.kind === 'character')!;
  const scenario = manifest.input.revisions.find((r) => r.kind === 'scenario')!;
  if (character.kind !== 'character' || scenario.kind !== 'scenario')
    throw new Error('Fixture kinds');
  character.definition.body.heightMm = 6000;
  expect(spawnPositions([character, character], scenario)[0]).toEqual({ x: -4000, y: 3020, z: 0 });
  scenario.definition.bounds = {
    min: { x: 10000, y: 5000, z: 20000 },
    max: { x: 20000, y: 15000, z: 30000 },
  };
  expect(spawnPositions([character, character], scenario)).toEqual([
    { x: 11000, y: 8000, z: 25000 },
    { x: 19000, y: 8000, z: 25000 },
  ]);
  character.definition.body.radiusMm = 600;
  scenario.definition.bounds.max.x = 12000;
  expect(spawnPositions([character, character], scenario)).toEqual([
    { x: 11000, y: 8000, z: 21000 },
    { x: 11000, y: 8000, z: 29000 },
  ]);
  scenario.definition.bounds.max.z = 22000;
  expect(() => spawnPositions([character, character], scenario)).toThrow('2体を離して');
  scenario.definition.bounds.max.y = 10000;
  expect(() => spawnPositions([character, character], scenario)).toThrow('範囲に収まりません');
});
