import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  ManifestSchema,
  ReplayState,
  SkillLoadoutReceiptSchema,
  canonicalJson,
  contentHash,
  replayContext,
  revisionReference,
} from '@fantasy/domain/spatial';
import { catalogManifest, sampleCatalog } from '@fantasy/samples';
import { editScenario, glassWall } from '../../test-support/fixtures.ts';
import { initializePhysics } from './world/physics.ts';
import { ManifestBuilder, sealRevision } from './manifest-builder.ts';
import { reference } from './prepare.ts';
import { runBattle } from './run.ts';

beforeAll(initializePhysics);
const flareId = 'ordinary-flare';
const burningId = 'ordinary-burning';
const nodeId = 'skill.magic.tiger.2';
const events = (records: Awaited<ReturnType<typeof runBattle>>['records']) =>
  records.flatMap((record) => ('events' in record ? record.events : []));

async function grantedFlareBattle(opponent: string, steps = 300) {
  const source = await catalogManifest('swordsman', opponent, 'flat', steps, 228),
    catalog = await sampleCatalog(),
    flare = catalog.find((revision) => revision.kind === 'ability' && revision.id === flareId),
    burning = catalog.find((revision) => revision.kind === 'status' && revision.id === burningId);
  if (flare?.kind !== 'ability' || burning?.kind !== 'status')
    throw new Error('Missing published ordinary flare closure');
  const catalogRef = {
      id: 'skill-catalog-v1',
      revision: 10,
      contentHash: `sha256:${'1'.repeat(64)}`,
    },
    resolvedNodeIds = [nodeId],
    nodeResolutions = [
      {
        nodeId,
        resolution: [{ kind: 'active-ability' as const, ability: revisionReference(flare) }],
      },
    ],
    resolutionDigest = await contentHash(
      JSON.parse(
        canonicalJson({
          resolverVersion: 'skill-resolver-v1',
          catalog: catalogRef,
          resolvedNodeIds,
          nodeResolutions,
        }),
      ),
    ),
    participants = structuredClone(source.participants);
  participants[0]!.skillLoadout = SkillLoadoutReceiptSchema.parse({
    schemaVersion: 1,
    resolverVersion: 'skill-resolver-v1',
    character: participants[0]!.character,
    catalog: catalogRef,
    loadout: {
      id: 'loadout.magic.tiger.2.engine',
      revision: 1,
      contentHash: catalogRef.contentHash,
    },
    explicitlyEnabledNodeIds: resolvedNodeIds,
    resolvedNodeIds,
    nodeResolutions,
    resolutionDigest,
  });
  expect(revisionReference(flare)).toEqual({
    id: flareId,
    revision: 1,
    contentHash: 'sha256:ebe6c0f4194d04a18d9d657a3fdd2b692a86b1ccb82b291d6b5885e17ddc5c42',
  });
  const battle = await ManifestBuilder.from([...source.revisions, flare, burning]).build({
    seed: source.seed,
    participants,
    ruleset: source.ruleset,
    scenario: source.scenario,
  });
  return { source, battle };
}

describe('published magic tiger ordinary flare', () => {
  it('ignites ordinary burning only after a valid body hit', async () => {
    const { battle } = await grantedFlareBattle('swordsman'),
      log = events((await runBattle(battle.manifest)).records),
      hit = log.find(
        (event) => event.kind === 'hit' && event.actorId === 'left' && event.abilityId === flareId,
      ),
      applied = log.find(
        (event) =>
          event.kind === 'status-apply' &&
          event.actorId === 'right' &&
          event.reason.startsWith(`${burningId}:`),
      );
    expect(hit).toBeDefined();
    expect(applied).toBeDefined();
    expect(applied!.step).toBe(hit!.step + 1);
  });

  it('does not ignite through attack-occluding terrain', async () => {
    const fixture = await grantedFlareBattle('swordsman', 120),
      manifest = ManifestSchema.parse(structuredClone(fixture.battle.manifest));
    await editScenario(manifest, (scenario) => scenario.obstacles.push(glassWall(1)));
    const log = events((await runBattle(manifest)).records);
    expect(
      log.some(
        (event) => event.kind === 'status-apply' && event.reason.startsWith(`${burningId}:`),
      ),
    ).toBe(false);
  });

  it('expires a genuine miss without damage or ignition', async () => {
    const manifest = await catalogManifest(
        'ember-duelist',
        'blink-flank-mage-v1',
        'flat',
        220,
        228,
      ),
      log = events((await runBattle(manifest)).records),
      expired = log.filter(
        (event) =>
          event.kind === 'projectile-remove' &&
          event.abilityId === flareId &&
          event.ruleId === 'projectile.expired',
      );
    expect(expired.length).toBeGreaterThan(0);
    expect(
      log.some(
        (event) =>
          event.kind === 'status-apply' &&
          event.actorId === 'right' &&
          event.reason.startsWith(`${burningId}:`),
      ),
    ).toBe(false);
  });

  it('stops on a live published barrier without igniting its protected actor', async () => {
    const { battle } = await grantedFlareBattle('barrier-mage-v1', 200),
      result = await runBattle(battle.manifest),
      log = events(result.records);
    const barrierContacts = log.filter((event) => event.ruleId === 'barrier.damage-request');
    expect(barrierContacts).toHaveLength(2);
    expect(
      barrierContacts.every(
        (event) =>
          event.entityId === 'object.a.0.0' &&
          event.abilityId === flareId &&
          event.amount === 20 &&
          event.reason === 'source-snapshot; no body payload',
      ),
    ).toBe(true);
    const protectedUntil = barrierContacts.at(-1)!.step;
    expect(
      log.some(
        (event) =>
          event.kind === 'status-apply' &&
          event.actorId === 'right' &&
          event.reason.startsWith(`${burningId}:`) &&
          event.step <= protectedUntil,
      ),
    ).toBe(false);
    expect(
      log.some(
        (event) =>
          event.kind === 'damage' && event.targetId === 'right' && event.step <= protectedUntil,
      ),
    ).toBe(false);
  });

  it('lets published self-water remove actual ordinary burning', async () => {
    const manifest = await catalogManifest('ember-duelist', 'ember-duelist', 'flat', 500, 228),
      log = events((await runBattle(manifest)).records);
    expect(
      log.some(
        (event) => event.kind === 'status-apply' && event.reason.startsWith(`${burningId}:`),
      ),
    ).toBe(true);
    expect(
      log.some(
        (event) =>
          event.kind === 'status-remove' && event.reason === `${burningId}:dispel-existing`,
      ),
    ).toBe(true);

    const source = await catalogManifest('ember-duelist', 'swordsman', 'flat', 80, 228),
      catalog = await sampleCatalog(),
      ordinary = catalog.find(
        (revision) => revision.kind === 'status' && revision.id === burningId,
      ),
      legacy = catalog.find((revision) => revision.kind === 'status' && revision.id === 'burning'),
      water = catalog.find(
        (revision) => revision.kind === 'ability' && revision.id === 'self-water',
      ),
      oldCharacter = source.revisions.find(
        (revision) => revision.kind === 'character' && revision.id === 'ember-duelist',
      );
    if (
      ordinary?.kind !== 'status' ||
      legacy?.kind !== 'status' ||
      water?.kind !== 'ability' ||
      oldCharacter?.kind !== 'character'
    )
      throw new Error('Missing published water cohort closure');
    const startup = await sealRevision('ability', 'published-burning-cohort-start', 1, {
        ...water.definition,
        trigger: 'battle-start',
        castSteps: 0,
        recoverySteps: 1,
        cooldownSteps: 0,
        costs: { hp: 0, mp: 0, uses: 1 },
        effects: [
          { kind: 'apply-status', status: reference(ordinary) },
          { kind: 'apply-status', status: reference(legacy) },
        ],
      }),
      character = await sealRevision('character', 'published-burning-cohort-actor', 1, {
        ...oldCharacter.definition,
        abilities: [...oldCharacter.definition.abilities, reference(startup)],
      }),
      participants = structuredClone(source.participants);
    participants[0]!.character = reference(character);
    const cohortBattle = await ManifestBuilder.from([
        ...source.revisions.filter(
          (revision) => !(revision.kind === 'character' && revision.id === oldCharacter.id),
        ),
        legacy,
        startup,
        character,
      ]).build({
        seed: source.seed,
        participants,
        ruleset: source.ruleset,
        scenario: source.scenario,
      }),
      cohortRun = await runBattle(cohortBattle.manifest),
      replay = new ReplayState(
        await replayContext(cohortBattle.manifest, cohortRun.result.simulationHash),
      );
    let afterWater;
    for (const record of cohortRun.records) {
      replay.apply(record);
      if (
        'events' in record &&
        record.events.some(
          (event) =>
            event.kind === 'status-remove' && event.reason === `${burningId}:dispel-existing`,
        )
      ) {
        afterWater = replay.checkpoint();
        break;
      }
    }
    expect(
      afterWater?.state?.actors.find(({ id }) => id === 'left')?.statuses.map((s) => s.revision.id),
    ).toEqual(['burning']);
  });
});
