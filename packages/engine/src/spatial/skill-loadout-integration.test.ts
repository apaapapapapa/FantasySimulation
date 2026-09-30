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
    resolutionDigest = await contentHash(
      JSON.parse(
        canonicalJson({
          resolverVersion: 'skill-resolver-v1',
          catalog,
          resolvedNodeIds,
          nodeResolutions,
        }),
      ),
    ),
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
      resolutionDigest = await contentHash(
        JSON.parse(
          canonicalJson({
            resolverVersion: 'skill-resolver-v1',
            catalog,
            resolvedNodeIds,
            nodeResolutions,
          }),
        ),
      ),
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
