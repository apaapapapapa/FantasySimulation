import { describe, expect, it } from 'vite-plus/test';
import {
  SkillLoadoutReceiptSchema,
  canonicalJson,
  contentHash,
  replayContext,
  type Manifest,
} from '@fantasy/domain/spatial';
import { sampleManifest } from '@fantasy/samples';
import { ManifestBuilder, sealRevision } from './manifest-builder.ts';
import { prepareBattle, reference } from './prepare.ts';

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;

async function skillFixture() {
  const manifest = await sampleManifest(),
    source = manifest.revisions.find((revision) => revision.kind === 'ability')!,
    ability = await sealRevision('ability', 'skill.sword.rat.1.action', 1, {
      ...source.definition,
      name: 'Rat opening cut',
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
    expect(battle.actors[0].abilities.map(({ id }) => id)).toContain(ability.id);
    expect(battle.actors[0].policy.priorities).toContainEqual({
      when: { kind: 'always' },
      abilityId: ability.id,
    });
    expect(battle.actors[1].abilities.map(({ id }) => id)).not.toContain(ability.id);
    expect(battle.manifest.revisions).toContainEqual(ability);
    const replay = await replayContext(battle.manifest, battle.simulationHash);
    expect(replay.actors[0]!.abilities.map(({ id }) => id)).toContain(ability.id);
  });

  it('rejects a tampered resolution digest before execution', async () => {
    const { battle } = await builtSkillBattle();
    const tampered = structuredClone(battle.manifest) as unknown as Manifest;
    tampered.participants[0].skillLoadout!.resolutionDigest = hash('3');
    await expect(prepareBattle(tampered)).rejects.toThrow(/resolution digest/);
  });
});
