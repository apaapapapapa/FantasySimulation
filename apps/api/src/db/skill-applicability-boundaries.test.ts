import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  contentHash,
  replayContext,
  skillBattleReceipt,
  revisionRefKey,
  type Manifest,
  type Revision,
} from '@fantasy/domain';
import { prepareBattle, reference, sealRevision } from '@fantasy/engine/spatial';
import { revivalManifest } from '../../../../packages/engine/test-support/revival.ts';
import { skillPersistenceFixture } from '../../test-support/skills.ts';
import { SkillAcquisitionStore } from './skill-acquisition-store.ts';
import { openStore, type Store } from './store.ts';

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

type BoundaryCase =
  | 'equipment-augment'
  | 'active'
  | 'historical-trigger'
  | 'duplicate-base'
  | 'direct-limit'
  | 'policy-limit'
  | 'duplicate-revival';
/** Characterization of baseline 829e6e5: expected outcomes below are intentionally different. */
async function boundaryFixture(kind: BoundaryCase) {
  const store = openStore(':memory:');
  stores.push(store);
  const fixture = await skillPersistenceFixture(store, `boundary-${kind}`),
    revisions: Revision[] = [...fixture.manifest.revisions],
    source = fixture.character,
    characterDefinition = structuredClone(source.definition),
    grantRef = fixture.catalog.nodes.find(({ id }) => id === fixture.target)!.resolution[0]!;
  if (grantRef.kind === 'augment') throw new Error('Expected fixture grant');
  let grant = store.requireRevision('ability', grantRef.ability);
  if (kind === 'historical-trigger') {
    grant = await sealRevision('ability', grant.id, 2, {
      ...grant.definition,
      trigger: 'battle-start',
      target: 'self',
      attack: { kind: 'direct' },
      castSteps: 0,
    });
  }
  if (kind === 'duplicate-base') {
    const equipment = await sealRevision('equipment', 'boundary-duplicate-equipment', 1, {
      name: 'Duplicate base fixture',
      originalText: '',
      attackBonus: 0,
      defenseBonus: 0,
      abilities: [characterDefinition.abilities[0]!],
    });
    revisions.push(equipment);
    characterDefinition.equipment.push(reference(equipment));
  }
  if (kind === 'equipment-augment') {
    const base = characterDefinition.abilities.shift()!,
      original = store.requireRevision('ability', base),
      equipment = await sealRevision('equipment', 'boundary-augment-equipment', 1, {
        name: 'Equipment augment fixture',
        originalText: '',
        attackBonus: 0,
        defenseBonus: 0,
        abilities: [base],
      });
    revisions.push(equipment);
    characterDefinition.equipment.push(reference(equipment));
    grant = await sealRevision('ability', original.id, original.revision + 1, {
      ...original.definition,
      name: 'Equipment replacement fixture',
    });
  }
  if (kind === 'direct-limit') {
    while (characterDefinition.abilities.length < 32) {
      const ability = await sealRevision(
        'ability',
        `boundary-direct-${characterDefinition.abilities.length}`,
        1,
        grant.definition,
      );
      revisions.push(ability);
      characterDefinition.abilities.push(reference(ability));
    }
  }
  if (kind === 'policy-limit') {
    const policy = store.requireRevision('policy', characterDefinition.policy),
      changed = await sealRevision('policy', policy.id, 2, {
        ...policy.definition,
        priorities: Array.from({ length: 32 }, () => ({
          when: { kind: 'always' as const },
          abilityId: characterDefinition.abilities[0]!.id,
        })),
      });
    revisions.push(changed);
    characterDefinition.policy = reference(changed);
  }
  if (kind === 'duplicate-revival') {
    const existing = (await revivalManifest()).revisions.find(
      (revision) =>
        revision.kind === 'ability' && revision.definition.reaction?.response.kind === 'revive',
    );
    if (existing?.kind !== 'ability') throw new Error('Missing revival fixture');
    revisions.push(existing);
    characterDefinition.abilities.push(reference(existing));
    grant = await sealRevision('ability', grant.id, 2, existing.definition);
  }
  const character = await sealRevision('character', source.id, 2, characterDefinition);
  revisions.push(character, grant);
  if (kind === 'duplicate-base') {
    const recorded = structuredClone(fixture.manifest) as Manifest;
    recorded.revisions = revisions;
    recorded.participants[0].character = reference(character);
    return {
      recorded,
      save: async (_version: 1 | 2) => {
        await store.seedExactRevisions(revisions);
        return recorded;
      },
    };
  }
  await store.seedExactRevisions(revisions);
  const catalog = structuredClone(fixture.catalog);
  catalog.revision = 2;
  catalog.nodes.find(({ id }) => id === fixture.target)!.resolution =
    kind === 'equipment-augment'
      ? [
          {
            kind: 'augment',
            baseAbility: source.definition.abilities[0]!,
            resolvedAbility: reference(grant),
          },
        ]
      : [
          {
            kind: kind === 'duplicate-revival' ? 'passive-ability' : 'active-ability',
            ability: reference(grant),
          },
        ];
  const record = await fixture.skills.seedCatalog(catalog),
    configuration = { ...fixture.configuration, catalog: record.reference };
  const save = async (version: 1 | 2) => {
    const snapshot =
      version === 1
        ? await fixture.skills.createLegacy({ character: reference(character), configuration })
        : await (async () => {
            const acquisition = await new SkillAcquisitionStore(store).create({
              selection: {
                schemaVersion: 1,
                id: `boundary-acquisition-${kind}`,
                version: 1,
                character: reference(character),
                catalog: record.reference,
                learnedNodeIds: [fixture.target],
              },
            });
            return fixture.skills.create({
              character: reference(character),
              configuration: {
                schemaVersion: 2,
                id: `boundary-loadout-${kind}`,
                version: 1,
                catalog: record.reference,
                acquisition: acquisition.latest,
                enabledNodeIds: [fixture.target],
              },
            });
          })();
    const saved = await fixture.skills.revision(snapshot.latest),
      receipt = await skillBattleReceipt(saved),
      manifest = structuredClone(fixture.manifest) as Manifest;
    manifest.schemaVersion = receipt.schemaVersion === 1 ? 4 : 5;
    manifest.revisions = revisions;
    manifest.participants[0] = {
      ...manifest.participants[0],
      character: reference(character),
      skillLoadout: receipt,
    };
    return manifest;
  };
  return { save };
}

describe('saved / execution / recorded skill applicability boundaries', () => {
  it('accepts the same active grant at all three entrances', async () => {
    const fixture = await boundaryFixture('active'),
      manifest = await fixture.save(2),
      executed = await prepareBattle(manifest),
      displayed = await replayContext(manifest, await contentHash(manifest));
    expect(executed.actors[0].abilities.map(revisionRefKey)).toEqual(
      displayed.actors[0]!.abilities.map(revisionRefKey),
    );
  });
  it('saves an equipment-origin augment and uses the same exact replacement in execution and display', async () => {
    const manifest = await (await boundaryFixture('equipment-augment')).save(2),
      executed = await prepareBattle(manifest),
      displayed = await replayContext(manifest, await contentHash(manifest)),
      resolution = manifest.participants[0].skillLoadout!.nodeResolutions[0]!.resolution[0]!;
    if (resolution.kind !== 'augment') throw new Error('Expected augment');
    expect(
      executed.actors[0].abilities.find(({ id }) => id === resolution.baseAbility.id)?.revision,
    ).toBe(2);
    expect(executed.actors[0].abilities.map(revisionRefKey)).toEqual(
      displayed.actors[0]!.abilities.map(revisionRefKey),
    );
  });
  it('retains the historical V1 trigger boundary while new V2 writes reject it', async () => {
    const fixture = await boundaryFixture('historical-trigger'),
      manifest = await fixture.save(1);
    await expect(fixture.save(2)).rejects.toThrow(
      /Active skill ability must use the action trigger/,
    );
    await expect(prepareBattle(manifest)).resolves.toBeDefined();
    await expect(replayContext(manifest, await contentHash(manifest))).resolves.toBeDefined();
  });
  it('rejects duplicate base IDs in canonical definition storage, execution and display', async () => {
    const fixture = await boundaryFixture('duplicate-base'),
      manifest = fixture.recorded!;
    await expect(fixture.save(2)).rejects.toThrow(/Duplicate actor ability/);
    await expect(prepareBattle(manifest)).rejects.toThrow(/Duplicate actor ability/);
    await expect(replayContext(manifest, await contentHash(manifest))).rejects.toThrow(
      /Duplicate actor ability/,
    );
  });
  it('records the existing write gap for a second revival while both consumers reject it', async () => {
    const manifest = await (await boundaryFixture('duplicate-revival')).save(2);
    await expect(prepareBattle(manifest)).rejects.toThrow(/one revival ability/);
    await expect(replayContext(manifest, await contentHash(manifest))).rejects.toThrow(
      /one revival ability/,
    );
  });
  it.each(['direct-limit', 'policy-limit'] as const)(
    'keeps %s enforcement at execution and preserves recorded display',
    async (kind) => {
      const manifest = await (await boundaryFixture(kind)).save(2);
      await expect(prepareBattle(manifest)).rejects.toThrow(
        kind === 'direct-limit' ? /direct ability limit/ : /policy priority limit/,
      );
      await expect(replayContext(manifest, await contentHash(manifest))).resolves.toBeDefined();
    },
  );
});
