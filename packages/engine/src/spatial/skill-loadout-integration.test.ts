import { describe, expect, it } from 'vite-plus/test';
import {
  JobRequestSchema,
  ReplayState,
  SkillLoadoutReceiptSchema,
  StagedJobRequestSchema,
  canonicalJson,
  contentHash,
  replayContext,
  type Manifest,
  type Revision,
} from '@fantasy/domain/spatial';
import { SkillBattleJobRequestSchema } from '@fantasy/domain';
import { sampleManifest } from '@fantasy/samples';
import { revivalManifest } from '../../test-support/revival.ts';
import { ManifestBuilder, sealRevision } from './manifest-builder.ts';
import { prepareBattle, reference } from './prepare.ts';
import { executionEligibility } from './execution-policy.ts';
import { runBattle } from './run.ts';

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const skillResolutionDigest = (
  catalog: object,
  resolvedNodeIds: string[],
  nodeResolutions: object[],
) =>
  contentHash(
    JSON.parse(
      canonicalJson({
        resolverVersion: 'skill-resolver-v1',
        catalog,
        resolvedNodeIds,
        nodeResolutions,
      }),
    ),
  );

async function skillFixture() {
  const manifest = await sampleManifest(),
    source = manifest.revisions.find((revision) => revision.kind === 'ability')!,
    ability = await sealRevision('ability', 'skill.sword.rat.1.action', 1, {
      ...source.definition,
      name: 'Rat opening cut',
      effects: source.definition.effects.map((effect) =>
        effect.kind === 'damage' ? { ...effect, amount: 50 } : effect,
      ),
    }),
    catalog = { id: 'skill-catalog-v1', revision: 1, contentHash: hash('1') },
    loadout = { id: 'skill-loadout-v1', revision: 1, contentHash: hash('2') },
    resolvedNodeIds = ['skill.sword.rat.1'],
    nodeResolutions = [
      {
        nodeId: resolvedNodeIds[0]!,
        resolution: [{ kind: 'active-ability' as const, ability: reference(ability) }],
      },
    ],
    resolutionDigest = await skillResolutionDigest(catalog, resolvedNodeIds, nodeResolutions),
    receipt = SkillLoadoutReceiptSchema.parse({
      schemaVersion: 1,
      resolverVersion: 'skill-resolver-v1',
      character: manifest.participants[0]!.character,
      catalog,
      loadout,
      explicitlyEnabledNodeIds: resolvedNodeIds,
      resolvedNodeIds,
      nodeResolutions,
      resolutionDigest,
    });
  return { manifest, ability, receipt };
}
async function builtSkillBattle() {
  const { manifest, ability, receipt } = await skillFixture(),
    participants = structuredClone(manifest.participants);
  participants[0].skillLoadout = receipt;
  const battle = await ManifestBuilder.from([...manifest.revisions, ability]).build({
    seed: manifest.seed,
    participants,
    ruleset: manifest.ruleset,
    scenario: manifest.scenario,
  });
  return { battle, ability };
}

describe('skill loadout battle vertical', () => {
  it('adds only exact active closure, enables AI evaluation and survives replay validation', async () => {
    const { battle, ability } = await builtSkillBattle();
    expect(battle.manifest.schemaVersion).toBe(4);
    expect(battle.actors[0].abilities.map(({ id }) => id)).toContain(ability.id);
    expect(battle.actors[0].policy.priorities).toContainEqual({
      when: { kind: 'always' },
      abilityId: ability.id,
    });
    expect(battle.actors[1].abilities.map(({ id }) => id)).not.toContain(ability.id);
    expect(battle.manifest.revisions).toContainEqual(ability);
    const replay = await replayContext(battle.manifest, battle.simulationHash);
    expect(replay.actors[0]!.abilities.map(({ id }) => id)).toContain(ability.id);

    const run = await runBattle(battle.manifest),
      events = run.records.flatMap((record) => ('events' in record ? record.events : []));
    expect(events.some((event) => event.actorId === 'left' && event.abilityId === ability.id)).toBe(
      true,
    );
    const restored = new ReplayState(
      await replayContext(battle.manifest, run.result.simulationHash),
    );
    for (const record of run.records) restored.apply(record);
    expect(restored).toMatchObject({ ended: true, step: run.result.steps });
    const replayed = new ReplayState(restored.context);
    for (const record of run.records) replayed.apply(record);
    expect(replayed.checkpoint()).toEqual(restored.checkpoint());
  });

  it('executes one exact shared grant while retaining both v3 node provenances', async () => {
    const { manifest, ability } = await skillFixture(),
      catalog = { id: 'skill-catalog-v1', revision: 9, contentHash: hash('8') },
      resolvedNodeIds = ['skill.magic.rat.1', 'skill.magic.tiger.2'],
      resolution = [{ kind: 'active-ability' as const, ability: reference(ability) }],
      nodeResolutions = resolvedNodeIds.map((nodeId) => ({ nodeId, resolution })),
      participants = structuredClone(manifest.participants);
    participants[0].skillLoadout = SkillLoadoutReceiptSchema.parse({
      schemaVersion: 3,
      resolverVersion: 'skill-resolver-v1',
      character: participants[0].character,
      catalog,
      loadout: { id: 'skill-loadout-shared', revision: 1, contentHash: hash('9') },
      explicitlyEnabledNodeIds: resolvedNodeIds,
      resolvedNodeIds,
      nodeResolutions,
      resolutionDigest: await skillResolutionDigest(catalog, resolvedNodeIds, nodeResolutions),
    });
    const battle = await ManifestBuilder.from([...manifest.revisions, ability]).build({
      seed: manifest.seed,
      participants,
      ruleset: manifest.ruleset,
      scenario: manifest.scenario,
    });
    expect(battle.manifest.schemaVersion).toBe(5);
    expect(battle.manifest.participants[0]!.skillLoadout?.nodeResolutions).toEqual(nodeResolutions);
    expect(battle.actors[0].abilities.filter(({ id }) => id === ability.id)).toHaveLength(1);
    expect(battle.actors[0].decisionAbilities.filter(({ id }) => id === ability.id)).toHaveLength(
      1,
    );
    expect(
      battle.actors[0].policy.priorities.filter(({ abilityId }) => abilityId === ability.id),
    ).toHaveLength(1);
    expect(battle.manifest.revisions.filter(({ id }) => id === ability.id)).toHaveLength(1);
    expect(
      (await replayContext(battle.manifest, battle.simulationHash)).actors[0]!.abilities.filter(
        ({ id }) => id === ability.id,
      ),
    ).toHaveLength(1);
    expect(battle.simulationHash).not.toBe((await builtSkillBattle()).battle.simulationHash);

    const removedProvenance = structuredClone(battle.manifest) as unknown as Manifest,
      receipt = removedProvenance.participants[0].skillLoadout!;
    receipt.resolvedNodeIds = receipt.resolvedNodeIds.slice(0, 1);
    receipt.explicitlyEnabledNodeIds = receipt.explicitlyEnabledNodeIds.slice(0, 1);
    receipt.nodeResolutions = receipt.nodeResolutions.slice(0, 1);
    await expect(prepareBattle(removedProvenance)).rejects.toThrow(/resolution digest/);
  });

  it('executes a non-action passive through a version 2 receipt and manifest 5 replay', async () => {
    const manifest = await sampleManifest(),
      source = manifest.revisions.find(
        (revision): revision is Extract<Revision, { kind: 'ability' }> =>
          revision.kind === 'ability',
      )!;
    const passiveDefinition = structuredClone(source.definition);
    Object.assign(passiveDefinition, {
      name: 'Skill passive test',
      trigger: 'battle-start',
      target: 'self',
      attack: { kind: 'direct' },
      castSteps: 0,
    });
    for (const field of ['reaction', 'accuracy', 'timeStop', 'relocation', 'barrier'])
      delete (passiveDefinition as Record<string, unknown>)[field];
    const passive = await sealRevision('ability', 'skill.passive.test', 1, passiveDefinition),
      catalog = { id: 'skill-catalog-v1', revision: 1, contentHash: hash('4') },
      resolvedNodeIds = ['skill.renki.rat.1'],
      nodeResolutions = [
        {
          nodeId: resolvedNodeIds[0]!,
          resolution: [{ kind: 'passive-ability' as const, ability: reference(passive) }],
        },
      ],
      participants = structuredClone(manifest.participants);
    participants[0].skillLoadout = SkillLoadoutReceiptSchema.parse({
      schemaVersion: 2,
      resolverVersion: 'skill-resolver-v1',
      character: participants[0].character,
      catalog,
      loadout: { id: 'skill-loadout-passive', revision: 1, contentHash: hash('5') },
      explicitlyEnabledNodeIds: resolvedNodeIds,
      resolvedNodeIds,
      nodeResolutions,
      resolutionDigest: await skillResolutionDigest(catalog, resolvedNodeIds, nodeResolutions),
    });
    const battle = await ManifestBuilder.from([...manifest.revisions, passive]).build({
      seed: manifest.seed,
      participants,
      ruleset: manifest.ruleset,
      scenario: manifest.scenario,
    });
    expect(battle.manifest.schemaVersion).toBe(5);
    expect(battle.actors[0].abilities.map(({ id }) => id)).toContain(passive.id);
    expect(battle.actors[0].policy.priorities.map(({ abilityId }) => abilityId)).not.toContain(
      passive.id,
    );
    expect(
      (await replayContext(battle.manifest, battle.simulationHash)).actors[0]!.abilities,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: passive.id })]));
  });

  it('replaces one exact character ability with an identity-preserving augment', async () => {
    const manifest = await sampleManifest(),
      character = manifest.revisions.find(
        (revision) =>
          revision.kind === 'character' && revision.id === manifest.participants[0]!.character.id,
      ) as Extract<Revision, { kind: 'character' }>,
      baseRef = character.definition.abilities[0]!,
      base = manifest.revisions.find(
        (revision) =>
          revision.kind === 'ability' &&
          revision.id === baseRef.id &&
          revision.revision === baseRef.revision,
      ) as Extract<Revision, { kind: 'ability' }>,
      augmented = await sealRevision('ability', base.id, base.revision + 1, {
        ...base.definition,
        name: `${base.definition.name} augmented`,
      }),
      catalog = { id: 'skill-catalog-v1', revision: 1, contentHash: hash('6') },
      resolvedNodeIds = ['skill.magic.rat.1'],
      nodeResolutions = [
        {
          nodeId: resolvedNodeIds[0]!,
          resolution: [
            {
              kind: 'augment' as const,
              baseAbility: reference(base),
              resolvedAbility: reference(augmented),
            },
          ],
        },
      ],
      participants = structuredClone(manifest.participants);
    participants[0].skillLoadout = SkillLoadoutReceiptSchema.parse({
      schemaVersion: 2,
      resolverVersion: 'skill-resolver-v1',
      character: participants[0].character,
      catalog,
      loadout: { id: 'skill-loadout-augment', revision: 1, contentHash: hash('7') },
      explicitlyEnabledNodeIds: resolvedNodeIds,
      resolvedNodeIds,
      nodeResolutions,
      resolutionDigest: await skillResolutionDigest(catalog, resolvedNodeIds, nodeResolutions),
    });
    expect(
      SkillLoadoutReceiptSchema.safeParse({
        ...participants[0].skillLoadout,
        nodeResolutions: [
          {
            nodeId: resolvedNodeIds[0],
            resolution: [
              {
                kind: 'augment',
                baseAbility: reference(base),
                resolvedAbility: reference(base),
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    const battle = await ManifestBuilder.from([...manifest.revisions, augmented]).build({
      seed: manifest.seed,
      participants,
      ruleset: manifest.ruleset,
      scenario: manifest.scenario,
    });
    expect(battle.actors[0].abilities.find(({ id }) => id === base.id)?.revision).toBe(
      augmented.revision,
    );
    expect(
      (await replayContext(battle.manifest, battle.simulationHash)).actors[0]!.abilities.find(
        ({ id }) => id === base.id,
      )?.revision,
    ).toBe(augmented.revision);
  });

  it('rejects a tampered resolution digest before execution', async () => {
    const { battle } = await builtSkillBattle();
    const tampered = structuredClone(battle.manifest) as unknown as Manifest;
    tampered.participants[0].skillLoadout!.resolutionDigest = hash('3');
    await expect(prepareBattle(tampered)).rejects.toThrow(/resolution digest/);
  });

  it('rechecks actor loadout invariants after adding skill abilities', async () => {
    const manifest = await revivalManifest(),
      existing = manifest.revisions.find(
        (revision): revision is Extract<Revision, { kind: 'ability' }> =>
          revision.kind === 'ability' && revision.definition.reaction?.response.kind === 'revive',
      )!,
      ability = await sealRevision('ability', 'skill.second-revival', 1, {
        ...existing.definition,
        name: 'Second revival',
      }),
      catalog = { id: 'skill-catalog-v1', revision: 1, contentHash: hash('1') },
      resolvedNodeIds = ['skill.sword.rat.1'],
      nodeResolutions = [
        {
          nodeId: resolvedNodeIds[0]!,
          resolution: [{ kind: 'active-ability' as const, ability: reference(ability) }],
        },
      ],
      resolutionDigest = await skillResolutionDigest(catalog, resolvedNodeIds, nodeResolutions),
      participants = structuredClone(manifest.participants);
    participants[0].skillLoadout = SkillLoadoutReceiptSchema.parse({
      schemaVersion: 1,
      resolverVersion: 'skill-resolver-v1',
      character: participants[0].character,
      catalog,
      loadout: { id: 'skill-loadout-v1', revision: 1, contentHash: hash('2') },
      explicitlyEnabledNodeIds: resolvedNodeIds,
      resolvedNodeIds,
      nodeResolutions,
      resolutionDigest,
    });
    await expect(
      ManifestBuilder.from([...manifest.revisions, ability]).build({
        seed: manifest.seed,
        participants,
        ruleset: manifest.ruleset,
        scenario: manifest.scenario,
      }),
    ).rejects.toThrow(/one revival ability/);
  });

  it('keeps complete receipts off the generic public job endpoint', async () => {
    const { battle } = await builtSkillBattle();
    const request = {
      spec: {
        seed: battle.manifest.seed,
        participants: battle.manifest.participants,
        ruleset: battle.manifest.ruleset,
        scenario: battle.manifest.scenario,
      },
    };
    expect(JobRequestSchema.safeParse(request).success).toBe(false);
    expect(
      StagedJobRequestSchema.safeParse({ jobs: [{ ...request, key: 'skill-job' }] }).success,
    ).toBe(false);
    expect(
      SkillBattleJobRequestSchema.safeParse({
        ...request,
        loadouts: [
          { actorId: 'left', loadout: battle.manifest.participants[0].skillLoadout!.loadout },
        ],
      }).success,
    ).toBe(false);
    const [left, right] = request.spec.participants,
      { skillLoadout: _receipt, ...cleanLeft } = left,
      cleanRequest = { ...request, spec: { ...request.spec, participants: [cleanLeft, right] } };
    expect(
      SkillBattleJobRequestSchema.safeParse({
        ...cleanRequest,
        loadouts: [
          { actorId: 'left', loadout: battle.manifest.participants[0].skillLoadout!.loadout },
        ],
      }).success,
    ).toBe(true);
  });

  it('binds the receipt to its character while allowing unknown resolvers to display', async () => {
    const { battle } = await builtSkillBattle(),
      substituted = structuredClone(battle.manifest) as unknown as Manifest;
    substituted.participants[0].skillLoadout!.character = {
      ...substituted.participants[0].character,
      id: 'substituted-character',
    };
    await expect(prepareBattle(substituted)).rejects.toThrow(/character mismatch/);
    await expect(replayContext(substituted, await contentHash(substituted))).rejects.toThrow(
      /skill loadout character/,
    );

    const future = structuredClone(battle.manifest) as unknown as Manifest;
    future.participants[0].skillLoadout!.resolverVersion = 'skill-resolver-v2';
    expect(executionEligibility(future)).toMatchObject({
      executable: false,
      code: 'unsupported-skill-resolver',
    });
    await expect(prepareBattle(future)).rejects.toThrow(/Unsupported skill resolver/);
    expect(
      (await replayContext(future, await contentHash(future))).manifest.participants[0].skillLoadout
        ?.resolverVersion,
    ).toBe('skill-resolver-v2');
  });
});
