import { reference, sealRevision } from '@fantasy/engine/spatial';
import { sampleManifest } from '@fantasy/samples';
import { completeSkillTestCatalog } from '../../../packages/domain/src/skill-system.test-fixtures.ts';
import { SkillStore } from '../src/db/skill-store.ts';
import type { Store } from '../src/db/store.ts';

export async function skillPersistenceFixture(store: Store, id: string) {
  const manifest = await sampleManifest(20),
    source = manifest.revisions.find((revision) => revision.kind === 'ability')!,
    ability = await sealRevision('ability', `skill.${id}.strike`, 1, {
      ...source.definition,
      name: `Stored ${id} skill strike`,
    }),
    alternateAbility = await sealRevision('ability', `skill.${id}.guard`, 1, {
      ...source.definition,
      name: `Stored ${id} skill guard`,
    }),
    character = manifest.revisions.find((revision) => revision.kind === 'character')!,
    target = 'skill.sword.rat.1',
    alternate = 'skill.judo.rat.1',
    catalog = completeSkillTestCatalog();
  catalog.nodes = catalog.nodes.map((node) =>
    node.id === target
      ? {
          ...node,
          prerequisites: [],
          resolution: [{ kind: 'active-ability' as const, ability: reference(ability) }],
        }
      : node.id === alternate
        ? {
            ...node,
            prerequisites: [],
            resolution: [{ kind: 'active-ability' as const, ability: reference(alternateAbility) }],
          }
        : {
            ...node,
            lifecycle: 'draft' as const,
            prerequisites: [],
            resolution: [],
            fixtureIds: [],
          },
  );
  await store.seedRevisions([...manifest.revisions, ability, alternateAbility]);
  const skills = new SkillStore(store),
    catalogRecord = await skills.seedCatalog(catalog),
    configuration = {
      schemaVersion: 1 as const,
      id: `loadout.${id}`,
      version: 1,
      catalog: catalogRecord.reference,
      eligibilityNodeIds: [target],
      learnedNodeIds: [target],
      enabledNodeIds: [target],
    };
  return {
    skills,
    manifest,
    character,
    catalog,
    catalogRecord,
    configuration,
    target,
    alternate,
  };
}
