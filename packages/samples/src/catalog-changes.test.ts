import { expect, it } from 'vite-plus/test';
import { revisionHash } from '@fantasy/domain/spatial';
import sources from '../../../data/content/builtin-v1.json' with { type: 'json' };
import { compileCatalog } from './authoring.ts';
import { catalogChanges } from './catalog-changes.ts';

it('finds transitive affected definitions without rebinding old pinned characters', async () => {
  const before = await compileCatalog(sources);
  const character = before.find((r) => r.kind === 'character' && r.definition.abilities.length)!;
  if (character.kind !== 'character') throw new Error('Missing character');
  const ref = character.definition.abilities[0]!;
  const ability = before.find((r) => r.kind === 'ability' && r.id === ref.id)!;
  const revised = structuredClone(ability);
  revised.definition.name += ' revised';
  revised.contentHash = await revisionHash(revised);
  const changed = catalogChanges(
    before,
    before.map((r) => (r === ability ? revised : r)),
  );
  expect(changed.changes.map((entry) => entry.key)).toEqual([
    `ability:${ability.id}:${ability.revision}`,
  ]);
  expect(changed.affected).toContain(`character:${character.id}:${character.revision}`);
  const newer = { ...revised, revision: ability.revision + 1 };
  const added = catalogChanges(before, [...before, newer]);
  expect(added.affected).toEqual([`ability:${ability.id}:${newer.revision}`]);
  expect(catalogChanges(before, before)).toEqual({ changes: [], affected: [] });
});
