import { afterEach, describe, expect, it } from 'vite-plus/test';
import { canonicalJson, type RevisionRef, type SkillCatalog } from '@fantasy/domain';
import { reference, sealRevision } from '@fantasy/engine/spatial';
import { skillPersistenceFixture } from '../../test-support/skills.ts';
import { SkillAcquisitionStore } from './skill-acquisition-store.ts';
import {
  characterAbilityRefs,
  readSkillCatalogRecord,
  requireSkillCatalog,
} from './skill-records.ts';
import { openStore, type Store } from './store.ts';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function seeded(id: string) {
  const store = openStore(':memory:');
  stores.push(store);
  return { store, ...(await skillPersistenceFixture(store, id)) };
}

/** Store another revision's exact catalog content and digest under a forged row identity. */
function forgeCatalogRow(store: Store, catalog: SkillCatalog, contentHash: string): RevisionRef {
  const forged = { id: 'skill-catalog.forged', revision: 1, contentHash };
  store.db
    .prepare(
      'INSERT INTO skill_catalog_revisions (id, revision, content_hash, catalog_json, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(forged.id, forged.revision, contentHash, canonicalJson(catalog), 'forged');
  return forged;
}

function nodeAbility(catalog: SkillCatalog, nodeId: string) {
  const resolution = catalog.nodes.find(({ id }) => id === nodeId)?.resolution[0];
  if (resolution?.kind !== 'active-ability') throw new Error('Expected active fixture ability');
  return resolution.ability;
}

describe('skill persistence records', () => {
  it('reads an exact stored catalog revision', async () => {
    const { store, catalogRecord } = await seeded('records-read'),
      { id, revision } = catalogRecord.reference;
    await expect(readSkillCatalogRecord(store, id, revision)).resolves.toEqual(catalogRecord);
    await expect(requireSkillCatalog(store, catalogRecord.reference)).resolves.toEqual(
      catalogRecord.catalog,
    );
  });

  it('distinguishes missing, mismatched and corrupt catalog revisions', async () => {
    const { store, catalogRecord } = await seeded('records-reject'),
      { id, revision, contentHash } = catalogRecord.reference;
    await expect(readSkillCatalogRecord(store, id, revision + 1)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(
      requireSkillCatalog(store, { id, revision, contentHash: `sha256:${'0'.repeat(64)}` }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'Skill catalog reference does not match stored content',
    });
    const forged = forgeCatalogRow(store, catalogRecord.catalog, contentHash);
    await expect(requireSkillCatalog(store, forged)).rejects.toMatchObject({
      code: 'conflict',
      message: 'Stored skill catalog revision is corrupt',
    });
  });

  it('rejects a corrupt catalog row before deriving an acquisition', async () => {
    const { store, catalogRecord, character, target } = await seeded('records-acquisition'),
      forged = forgeCatalogRow(store, catalogRecord.catalog, catalogRecord.reference.contentHash);
    await expect(
      new SkillAcquisitionStore(store).create({
        selection: {
          schemaVersion: 1,
          id: 'acquisition.forged-catalog',
          version: 1,
          character: reference(character),
          catalog: forged,
          learnedNodeIds: [target],
        },
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      message: 'Stored skill catalog revision is corrupt',
    });
  });

  it('lists character abilities before equipment abilities in definition order', async () => {
    const { store, catalogRecord, character, target, alternate } = await seeded('records-owned'),
      strike = nodeAbility(catalogRecord.catalog, target),
      guard = nodeAbility(catalogRecord.catalog, alternate),
      equipment = await sealRevision('equipment', 'equipment.records-owned', 1, {
        name: 'Records gauntlet',
        originalText: '',
        attackBonus: 0,
        defenseBonus: 0,
        abilities: [guard],
      }),
      owner = await sealRevision('character', 'character.records-owned', 1, {
        ...character.definition,
        abilities: [...character.definition.abilities, strike],
        equipment: [reference(equipment)],
      });
    await store.seedRevisions([equipment, owner]);
    expect(characterAbilityRefs(store, reference(owner))).toEqual([
      ...character.definition.abilities,
      strike,
      guard,
    ]);
  });
});
