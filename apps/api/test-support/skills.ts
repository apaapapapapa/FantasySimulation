import { reference, sealRevision } from '@fantasy/engine/spatial';
import { sampleManifest } from '@fantasy/samples';
import type { FastifyInstance } from 'fastify';
import type { RevisionRef } from '@fantasy/domain';
import { completeSkillTestCatalog } from '../../../packages/domain/src/skill-system.test-fixtures.ts';
import { SkillStore } from '../src/db/skill-store.ts';
import type { Store } from '../src/db/store.ts';

/** Test-only adapter for constructing persisted history that predates the authoritative V2 gate. */
export async function seedLegacySkillLoadout(store: Store, input: unknown) {
  return new SkillStore(store).createLegacy(input);
}

export async function saveSkillLoadoutV2(
  app: FastifyInstance,
  input: {
    id: string;
    acquisitionId: string;
    character: RevisionRef;
    catalog: RevisionRef;
    learnedNodeIds: string[];
    enabledNodeIds: string[];
  },
) {
  const acquired = await app.inject({
    method: 'POST',
    url: '/api/skill-acquisitions',
    payload: {
      selection: {
        schemaVersion: 1,
        id: input.acquisitionId,
        version: 1,
        character: input.character,
        catalog: input.catalog,
        learnedNodeIds: input.learnedNodeIds,
      },
    },
  });
  if (acquired.statusCode !== 201)
    throw new Error(`Acquisition ${acquired.statusCode}: ${acquired.body}`);
  return app.inject({
    method: 'POST',
    url: '/api/skill-loadouts',
    payload: {
      character: input.character,
      configuration: {
        schemaVersion: 2,
        id: input.id,
        version: 1,
        catalog: input.catalog,
        acquisition: acquired.json().latest,
        enabledNodeIds: input.enabledNodeIds,
      },
    },
  });
}

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
