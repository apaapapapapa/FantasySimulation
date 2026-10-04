import { afterEach, describe, expect, it } from 'vite-plus/test';
import { SkillPreviewResponseSchema, skillBattleReceipt } from '@fantasy/domain';
import { reference, sealRevision } from '@fantasy/engine/spatial';
import { saveSkillLoadoutV2, skillPersistenceFixture } from '../../test-support/skills.ts';
import {
  skillAcquisitionHeads,
  skillAcquisitionRevisions,
  skillLoadoutHeads,
  skillLoadoutRevisions,
} from '../db/schema.ts';
import { openStore, type Store } from '../db/store.ts';
import { createApp } from './app.ts';

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
async function setup() {
  const store = openStore(':memory:'),
    fixture = await skillPersistenceFixture(store, 'preview'),
    app = createApp(store);
  apps.push(app);
  const proposal = {
    character: reference(fixture.character),
    catalog: fixture.catalogRecord.reference,
    learnedNodeIds: [fixture.target],
    enabledNodeIds: [fixture.target],
  };
  return { ...fixture, store, app, proposal };
}
function history(store: Store) {
  return {
    acquisitions: store.orm.select().from(skillAcquisitionRevisions).all(),
    acquisitionHeads: store.orm.select().from(skillAcquisitionHeads).all(),
    loadouts: store.orm.select().from(skillLoadoutRevisions).all(),
    loadoutHeads: store.orm.select().from(skillLoadoutHeads).all(),
  };
}
describe('read-only server skill preview', () => {
  it.each([
    ['empty', false],
    ['grant-augment-conflict', false],
    ['invalid-disabled', true],
    ['invalid-enabled', false],
    ['shared-grant', true],
  ] as const)('agrees with actual V2 saving for %s', async (scenario, canSave) => {
    const f = await setup(),
      catalog = structuredClone(f.catalog),
      target = catalog.nodes.find((node) => node.id === f.target)!,
      alternate = catalog.nodes.find((node) => node.id === f.alternate)!,
      grant = target.resolution[0]!;
    if (grant.kind !== 'active-ability') throw new Error('Expected fixture active ability');
    catalog.revision = 2;
    let character = f.proposal.character;
    const learnedNodeIds = [f.target, f.alternate];
    let enabledNodeIds = [...learnedNodeIds];
    if (scenario === 'empty') enabledNodeIds = [];
    if (scenario.startsWith('invalid-')) {
      grant.ability = { ...grant.ability, contentHash: `sha256:${'f'.repeat(64)}` };
      enabledNodeIds = scenario === 'invalid-disabled' ? [f.alternate] : [f.target];
    }
    if (scenario === 'shared-grant') alternate.resolution = structuredClone(target.resolution);
    if (scenario === 'grant-augment-conflict') {
      const base = f.store.requireRevision('ability', grant.ability),
        replacement = await sealRevision('ability', base.id, 2, {
          ...base.definition,
          name: 'Preview conflict replacement',
        }),
        owner = await sealRevision('character', f.character.id, 2, {
          ...f.character.definition,
          abilities: [...f.character.definition.abilities, reference(base)],
        });
      await f.store.seedExactRevisions([replacement, owner]);
      character = reference(owner);
      alternate.resolution = [
        {
          kind: 'augment',
          baseAbility: reference(base),
          resolvedAbility: reference(replacement),
        },
      ];
    }
    const record = await f.skills.seedCatalog(catalog),
      proposal = { character, catalog: record.reference, learnedNodeIds, enabledNodeIds },
      before = history(f.store),
      response = await f.app.inject({
        method: 'POST',
        url: '/api/skill-preview',
        payload: proposal,
      });
    expect(response.statusCode).toBe(200);
    const result = SkillPreviewResponseSchema.parse(response.json());
    expect(result.canSave).toBe(canSave);
    expect(history(f.store)).toEqual(before);
    if (scenario.startsWith('invalid-')) {
      expect(result.eligibilityNodeIds).toContain(f.target);
      expect(result.nodeReasons).toContainEqual({
        code: 'ability-application',
        reason: 'definition-reference',
        nodeId: f.target,
      });
    }
    if (scenario === 'empty' || scenario === 'grant-augment-conflict')
      expect(result.reasons).toContainEqual({ code: 'receipt-selection' });
    const saved = await saveSkillLoadoutV2(f.app, {
      ...proposal,
      id: `loadout.${scenario}`,
      acquisitionId: `acquisition.${scenario}`,
    });
    expect(saved.statusCode).toBe(canSave ? 201 : 400);
    if (scenario === 'shared-grant') {
      const receipt = await skillBattleReceipt(await f.skills.revision(saved.json().latest));
      expect(receipt.schemaVersion).toBe(3);
      expect(receipt.nodeResolutions.map(({ nodeId }) => nodeId)).toEqual(
        [...learnedNodeIds].sort(),
      );
    }
  });

  it('returns exact policy/proposal identity without migrating V1 or creating history; saving still revalidates', async () => {
    const f = await setup();
    await f.skills.createLegacy({
      character: f.proposal.character,
      configuration: f.configuration,
    });
    const before = history(f.store);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/skill-preview',
        payload: f.proposal,
      });
      expect(response.statusCode).toBe(200);
      const result = SkillPreviewResponseSchema.parse(response.json());
      expect(result).toMatchObject({
        policyVersion: 'skill-acquisition-v1',
        proposal: f.proposal,
        canSave: true,
        resolvedNodeIds: [f.target],
        counts: { paths: 1, active: 1, passive: 0 },
        reasons: [],
      });
      expect(result.eligibilityNodeIds).toEqual(expect.arrayContaining([f.target, f.alternate]));
    }
    expect(history(f.store)).toEqual(before);
    const invalidSave = await f.app.inject({
      method: 'POST',
      url: '/api/skill-acquisitions',
      payload: {
        selection: {
          schemaVersion: 1,
          id: 'acquisition.preview',
          version: 1,
          character: f.proposal.character,
          catalog: f.proposal.catalog,
          learnedNodeIds: ['skill.unknown'],
        },
      },
    });
    expect(invalidSave.statusCode).toBe(400);
    expect(history(f.store)).toEqual(before);
  });

  it('rejects caller-supplied capabilities and invalid exact references with no writes', async () => {
    const f = await setup(),
      before = history(f.store);
    for (const extra of [
      { eligibilityNodeIds: [f.target] },
      { equipmentTags: ['weapon.sword'] },
      { abilityRefs: [] },
      { version: 1 },
    ]) {
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/skill-preview',
            payload: { ...f.proposal, ...extra },
          })
        ).statusCode,
      ).toBe(400);
    }
    for (const key of ['character', 'catalog'] as const) {
      const response = await f.app.inject({
        method: 'POST',
        url: '/api/skill-preview',
        payload: {
          ...f.proposal,
          [key]: { ...f.proposal[key], contentHash: `sha256:${'f'.repeat(64)}` },
        },
      });
      expect(response.statusCode).toBe(key === 'character' ? 400 : 409);
    }
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/skill-preview',
          payload: {
            ...f.proposal,
            enabledNodeIds: Array.from({ length: 13 }, (_, i) => `skill.node.${i}`),
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(history(f.store)).toEqual(before);
  });

  it.each(['weapon', 'augment', 'revision', 'prerequisite', 'unlearned', 'limit'] as const)(
    'reports the %s constraint from authoritative definitions, without a write',
    async (scenario) => {
      const f = await setup(),
        catalog = structuredClone(f.catalog),
        target = catalog.nodes.find((node) => node.id === f.target)!;
      catalog.revision = 2;
      if (scenario === 'weapon') target.weaponTags = ['weapon.sword'];
      if (scenario === 'augment') {
        const ability = target.resolution[0]!;
        if (ability.kind !== 'active-ability') throw new Error('Expected fixture active ability');
        target.resolution = [
          {
            kind: 'augment',
            baseAbility: ability.ability,
            resolvedAbility: { ...ability.ability, revision: 2 },
          },
        ];
      }
      if (scenario === 'revision') {
        const ability = target.resolution[0]!;
        if (ability.kind !== 'active-ability') throw new Error('Expected fixture active ability');
        ability.ability = { ...ability.ability, contentHash: `sha256:${'f'.repeat(64)}` };
      }
      if (scenario === 'prerequisite') target.prerequisites = [f.alternate];
      let learnedNodeIds = scenario === 'unlearned' ? [] : [f.target],
        enabledNodeIds = [f.target];
      if (scenario === 'limit') {
        const selected = catalog.nodes
          .filter((node) => node.coordinate.path === 'sword')
          .slice(0, 9);
        for (const node of selected)
          Object.assign(node, {
            lifecycle: 'available',
            prerequisites: [],
            resolution: structuredClone(target.resolution),
            fixtureIds: ['fixture.preview'],
          });
        learnedNodeIds = selected.map((node) => node.id);
        enabledNodeIds = [...learnedNodeIds];
      }
      const record = await f.skills.seedCatalog(catalog),
        before = history(f.store),
        response = await f.app.inject({
          method: 'POST',
          url: '/api/skill-preview',
          payload: {
            ...f.proposal,
            catalog: record.reference,
            learnedNodeIds,
            enabledNodeIds,
          },
        });
      expect(response.statusCode).toBe(200);
      const result = SkillPreviewResponseSchema.parse(response.json()),
        expected = {
          weapon: { code: 'weapon-requirement', nodeId: f.target },
          augment: { code: 'augment-base-not-owned', nodeId: f.target },
          revision: { code: 'ability-application', reason: 'definition-reference' },
          prerequisite: {
            code: 'unmet-learning-prerequisite',
            nodeId: f.target,
            prerequisiteNodeId: f.alternate,
          },
          unlearned: { code: 'enabled-node-not-learned', nodeId: f.target },
          limit: { code: 'active-node-limit', count: 9, maximum: 8 },
        }[scenario];
      expect(result.canSave).toBe(false);
      expect(result.reasons).toEqual(expect.arrayContaining([expect.objectContaining(expected)]));
      if (scenario === 'weapon' || scenario === 'augment')
        expect(result.eligibilityNodeIds).not.toContain(f.target);
      expect(history(f.store)).toEqual(before);
    },
  );
});
