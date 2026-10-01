import { expect, it } from 'vite-plus/test';
import {
  ReplayState,
  StreamRecordSchema,
  DEFAULT_BUDGET,
  actorSeed,
  contentHash,
  dependentSeed,
  replayContext,
} from '@fantasy/domain/spatial';
import { battleEvents } from '../../test-support/fixtures.ts';
import { stoppedSummoningManifest, summoningManifest } from '../../test-support/summoning.ts';
import { initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import { withStopReactions } from '../../test-support/time-stop.ts';
import { reviveAbility } from '../../test-support/revival.ts';
import { prepareBattle } from './prepare.ts';
import { runPreparedBattle } from './run.ts';
import { freezeDependent, settleDefeatedDependents } from './sim/dependents.ts';
import type { DependentState } from './state.ts';
import type { StepTransaction } from './sim/step-transaction.ts';
import { Journal } from './rules/journal.ts';
import type { StreamRecord } from '@fantasy/domain/spatial';
import { ManifestBuilder, sealRevision } from './manifest-builder.ts';
import fixture from '../../fixtures/spatial/summoning-rat-dan1.json' with { type: 'json' };

async function lethalPulseSummoningManifest() {
  const manifest = await summoningManifest(10);
  for (const index of [0, 1] as const)
    await withInitialStatus(
      manifest,
      index,
      initialStatus({
        durationSteps: 3,
        periodic: [{ kind: 'damage', element: 'fire', amount: 50, everySteps: 1 }],
      }),
    );
  return manifest;
}

async function revivalWaveSummoningManifest() {
  let manifest = await summoningManifest(12);
  manifest = await withStopReactions(manifest, 0, [
    reviveAbility({ costs: { hp: 0, mp: 2, uses: 4 } }),
  ]);
  for (const index of [0, 1] as const) {
    await withInitialStatus(
      manifest,
      index,
      initialStatus({
        durationSteps: 6,
        periodic: [{ kind: 'damage', element: 'fire', amount: 60, everySteps: 5 }],
      }),
    );
  }
  return manifest;
}

async function multiHitSummoningManifest() {
  const manifest = await summoningManifest(35);
  const summon = manifest.revisions.find(
    (revision) => revision.kind === 'ability' && revision.definition.summon,
  );
  if (!summon || summon.kind !== 'ability' || !summon.definition.summon)
    throw new Error('Missing summon ability');
  const replacement = await sealRevision('ability', summon.id, summon.revision, {
    ...summon.definition,
    costs: { ...summon.definition.costs, uses: 2 },
    cooldownSteps: 1,
    summon: { ...summon.definition.summon, hp: 1, actionEverySteps: 1 },
  });
  const withFragileDependents = await ManifestBuilder.relink(manifest, [
    { from: summon, to: replacement },
  ]);
  const character = withFragileDependents.revisions.find(
    (revision) => revision.kind === 'character',
  );
  if (!character || character.kind !== 'character') throw new Error('Missing summon character');
  const delayedObservation = await sealRevision('character', character.id, character.revision, {
    ...character.definition,
    perception: { ...character.definition.perception, reactionSteps: 5 },
  });
  return ManifestBuilder.relink(withFragileDependents, [
    { from: character, to: delayedObservation },
  ]);
}

async function respawnSummoningManifest() {
  const manifest = await summoningManifest(70);
  const summon = manifest.revisions.find(
    (revision) => revision.kind === 'ability' && revision.definition.summon,
  );
  if (!summon || summon.kind !== 'ability') throw new Error('Missing summon ability');
  const replacement = await sealRevision('ability', summon.id, summon.revision, {
    ...summon.definition,
    costs: { ...summon.definition.costs, uses: 2 },
    cooldownSteps: 31,
  });
  return ManifestBuilder.relink(manifest, [{ from: summon, to: replacement }]);
}

function followedDependent(record: Exclude<StreamRecord, { kind: 'initial' | 'terminal' }>) {
  return record.events.find((event, index, events) => {
    if (
      (event.kind !== 'dependent-command' && event.ruleId !== 'dependent.upkeep') ||
      !event.actorId
    )
      return false;
    return events
      .slice(index + 1)
      .some(
        (later) =>
          !!later.before &&
          !!later.after &&
          later.targetId === event.actorId &&
          !['cost', 'resource', 'dependent-command'].includes(later.kind),
      );
  });
}

it('executes a bounded observed rat dependent through replay with ordinal RNG identity', async () => {
  const battle = await prepareBattle(await summoningManifest());
  expect(battle.manifest.schemaVersion).toBe(9);
  const run = await runPreparedBattle(battle);
  for (const record of run.records) {
    const parsed = StreamRecordSchema.safeParse(record);
    expect(parsed.success, parsed.error?.message).toBe(true);
  }
  const initial = run.records[0];
  if (initial?.kind !== 'initial') throw new Error('Missing initial');
  expect(initial.requiredFeatures).toContain('dependent-entities-v1');
  expect(initial.requiredFeatures).toContain('dependent-observation-v2');
  const events = battleEvents(run.records);
  const creates = events.filter((event) => event.kind === 'dependent-create');
  expect(creates).toHaveLength(2);
  expect(
    creates.map((event) => event.entityId).toSorted((a, b) => (a ?? '').localeCompare(b ?? '')),
  ).toEqual(['dependent.a.0.scout-rat', 'dependent.b.0.scout-rat']);
  const commands = events.filter((event) => event.kind === 'dependent-command');
  const acts = events.filter((event) => event.kind === 'dependent-act');
  const spawnedDependents = run.records.flatMap((record) =>
    'dependents' in record ? (record.dependents?.spawn ?? []) : [],
  );
  expect(commands.length).toBeGreaterThan(0);
  expect(acts.length).toBe(commands.length);
  for (const command of commands) {
    const target = spawnedDependents.find((dependent) => dependent.id === command.targetId);
    expect(command.reason).toBe(
      target ? 'owner-delivered-dependent-observation' : 'owner-delivered-enemy-observation',
    );
    expect(command.actorId).toBe(command.dependent?.ownerId);
    if (target) expect(target.ownerId).toBe(command.dependent?.hostileOwnerId);
    else expect(command.targetId).toBe(command.dependent?.hostileOwnerId);
    expect(acts.find((act) => act.parentEventId === command.id)).toMatchObject({
      targetId: command.targetId,
    });
  }
  const dependentDamage = events.filter(
    (event) => event.kind === 'damage' && event.entityId?.startsWith('dependent.'),
  );
  expect(dependentDamage).toHaveLength(acts.length);
  const eventsById = new Map(events.map((event) => [event.id, event]));
  let dependentTargetDamage = 0;
  for (const damage of dependentDamage) {
    const act = damage.parentEventId ? eventsById.get(damage.parentEventId) : undefined;
    const dependent = spawnedDependents.find((candidate) => candidate.id === damage.entityId);
    const target = spawnedDependents.find((candidate) => candidate.id === damage.targetId);
    expect(act).toMatchObject({
      kind: 'dependent-act',
      actorId: dependent?.ownerId,
      entityId: dependent?.id,
      targetId: damage.targetId,
    });
    if (target) {
      dependentTargetDamage++;
      expect(damage).toMatchObject({
        actorId: dependent?.ownerId,
        targetId: target.id,
        ruleId: 'damage.dependent-hp',
        reason: 'same-wave-dependent-hp-clamp',
      });
      expect(act?.reason).toBe('stable-ordinal-visible-hostile-dependent');
      expect(target.ownerId).toBe(dependent?.hostileOwnerId);
      expect(target.id).not.toBe(dependent?.id);
    } else {
      expect(damage).toMatchObject({
        actorId: dependent?.ownerId,
        targetId: dependent?.hostileOwnerId,
      });
    }
    if (!damage.before || !damage.after || damage.amount === null)
      throw new Error('Missing dependent damage resources');
    expect(damage.amount).toBeGreaterThan(0);
    expect(damage.before.hp - damage.after.hp).toBe(damage.amount);
  }
  expect(dependentTargetDamage).toBeGreaterThan(0);
  const measuredDependentDamage = dependentDamage.find((event) =>
    spawnedDependents.some((dependent) => dependent.id === event.targetId),
  );
  expect({
    beforeHp: measuredDependentDamage?.before?.hp,
    afterHp: measuredDependentDamage?.after?.hp,
    amount: measuredDependentDamage?.amount,
  }).toEqual(fixture.runtimeSettlementEvidence.dependentTargetDamage);
  const nonNoopDrain = events.find(
    (event) =>
      event.kind === 'heal' &&
      event.reason === 'same-wave-hp-loss-dependent-drain' &&
      !!event.before &&
      !!event.after &&
      event.after.hp > event.before.hp,
  );
  expect(nonNoopDrain).toBeDefined();
  if (!nonNoopDrain?.before || !nonNoopDrain.after || nonNoopDrain.amount === null)
    throw new Error('Missing dependent drain resources');
  const drainRecipient = spawnedDependents.find(
    (dependent) => dependent.id === nonNoopDrain.entityId,
  );
  expect(nonNoopDrain.targetId).toBe(drainRecipient?.id);
  expect({
    beforeHp: nonNoopDrain.before.hp,
    afterHp: nonNoopDrain.after.hp,
    amount: nonNoopDrain.amount,
    maxHp: drainRecipient?.maxHp,
  }).toEqual(fixture.runtimeSettlementEvidence.dependentDrain);
  expect(nonNoopDrain.after.hp).toBe(
    Math.min(drainRecipient!.maxHp, nonNoopDrain.before.hp + nonNoopDrain.amount),
  );
  const drainParent = nonNoopDrain.parentEventId
    ? eventsById.get(nonNoopDrain.parentEventId)
    : undefined;
  expect(drainParent).toMatchObject({
    kind: 'damage',
    actorId: drainRecipient?.ownerId,
    entityId: drainRecipient?.id,
  });
  expect(events.filter((event) => event.kind === 'dependent-despawn')).toEqual(
    expect.arrayContaining([expect.objectContaining({ reason: 'expired' })]),
  );

  const context = await replayContext(battle.manifest, run.result.simulationHash);
  const replay = new ReplayState(context);
  for (const record of run.records) {
    replay.apply(record);
    if (!('dependents' in record)) continue;
    for (const update of record.dependents?.update ?? [])
      expect(replay.checkpoint().state?.dependents?.find(({ id }) => id === update.id)?.hp).toBe(
        update.hp,
      );
  }
  expect(replay.checkpoint().state?.dependents ?? []).toHaveLength(0);

  const rejects = (mutate: (records: typeof run.records) => void) => {
    const tampered = structuredClone(run.records);
    mutate(tampered);
    const invalid = new ReplayState(context);
    expect(() => tampered.forEach((record) => invalid.apply(record))).toThrow(/dependent/);
  };
  const spawnRecord = (records: typeof run.records) =>
    records.find((record) => 'dependents' in record && record.dependents?.spawn.length);
  const actionRecord = (records: typeof run.records) =>
    records.find(
      (record) =>
        'dependents' in record &&
        record.dependents?.update.length &&
        record.events.some((event) => event.kind === 'dependent-command'),
    );
  rejects((records) => {
    const record = spawnRecord(records);
    if (!record || !('dependents' in record) || !record.dependents)
      throw new Error('Missing spawn');
    record.dependents.spawn[0]!.ownerId = record.dependents.spawn[0]!.hostileOwnerId;
  });
  rejects((records) => {
    const record = spawnRecord(records);
    if (!record || !('dependents' in record) || !record.dependents)
      throw new Error('Missing spawn');
    record.dependents.spawn[0]!.rngState ^= 1;
  });
  for (const field of ['hp', 'rngState', 'nextActionAt', 'nextUpkeepAt'] as const)
    rejects((records) => {
      const record = actionRecord(records);
      if (!record || !('dependents' in record) || !record.dependents)
        throw new Error('Missing action update');
      record.dependents.update[0]![field] += 1;
    });
  rejects((records) => {
    const record = actionRecord(records);
    if (!record || !('changes' in record)) throw new Error('Missing action record');
    const command = record?.events.find((event) => event.kind === 'dependent-command');
    if (command?.dependent?.nextActionAt === undefined) throw new Error('Missing command');
    command.dependent.nextActionAt += 1;
  });
  rejects((records) => {
    const record = actionRecord(records);
    if (!record || !('events' in record)) throw new Error('Missing action record');
    const command = record.events.find((event) => event.kind === 'dependent-command');
    if (!command?.dependent) throw new Error('Missing dependent command');
    delete command.dependent.observedTargetIds;
  });
  rejects((records) => {
    const initial = records[0];
    if (initial?.kind !== 'initial' || !initial.requiredFeatures)
      throw new Error('Missing initial features');
    initial.requiredFeatures = initial.requiredFeatures.filter(
      (feature) => feature !== 'dependent-observation-v2',
    );
    for (const event of battleEvents(records))
      if (event.dependent) delete event.dependent.observedTargetIds;
  });
  rejects((records) => {
    const record = actionRecord(records);
    if (!record || !('events' in record)) throw new Error('Missing action record');
    const command = record?.events.find((event) => event.kind === 'dependent-command');
    if (!command?.after) throw new Error('Missing command cost');
    command.after.mp += 1;
  });
  rejects((records) => {
    const record = actionRecord(records);
    if (!record || !('events' in record)) throw new Error('Missing action record');
    const command = record.events.find((event) => event.kind === 'dependent-command');
    if (!command?.before || !command.after) throw new Error('Missing command cost');
    command.before.mp += 1;
    command.after.mp += 1;
  });
  rejects((records) => {
    const record = records.find(
      (candidate) =>
        (candidate.kind === 'boundary' || candidate.kind === 'interval') &&
        candidate.events.some(
          (event) => event.kind === 'damage' && event.targetId?.startsWith('dependent.'),
        ),
    );
    if (!record || !('events' in record)) throw new Error('Missing dependent damage record');
    const damage = record.events.find(
      (event) => event.kind === 'damage' && event.targetId?.startsWith('dependent.'),
    );
    if (!damage) throw new Error('Missing dependent target damage');
    damage.entityId = null;
  });
  rejects((records) => {
    const record = actionRecord(records);
    if (!record || !('events' in record)) throw new Error('Missing action record');
    const act = record.events.find((event) => event.kind === 'dependent-act');
    if (!act) throw new Error('Missing dependent act');
    act.reason =
      act.reason === 'stable-ordinal-policy'
        ? 'stable-ordinal-visible-hostile-dependent'
        : 'stable-ordinal-policy';
  });
  rejects((records) => {
    const record = actionRecord(records);
    if (!record || !('changes' in record)) throw new Error('Missing action record');
    const command = record.events.find((event) => event.kind === 'dependent-command');
    const owner = record.changes.find((change) => change.id === command?.actorId);
    if (!owner?.resources) throw new Error('Missing owner resource delta');
    owner.resources.mp += 1;
  });
  for (const mutation of ['delta', 'anchor-and-delta'] as const) {
    const records = structuredClone(run.records);
    const recordIndex = records.findIndex((candidate) => {
      if (!('changes' in candidate)) return false;
      return !!followedDependent(candidate);
    });
    const record = records[recordIndex];
    if (!record || !('changes' in record)) throw new Error('Missing followed resource record');
    const dependent = followedDependent(record);
    const anchor = record.events.find(
      (event) =>
        !!dependent &&
        event.sequence > dependent.sequence &&
        !!event.before &&
        !!event.after &&
        event.targetId === dependent.actorId &&
        !['cost', 'resource', 'dependent-command'].includes(event.kind),
    );
    const owner = record.changes.find((change) => change.id === dependent?.actorId);
    if (!anchor?.before || !anchor.after || !owner?.resources)
      throw new Error('Missing followed owner resource delta');
    if (mutation === 'anchor-and-delta') {
      anchor.before.mp += 1;
      anchor.after.mp += 1;
    }
    owner.resources.mp += 1;
    const invalid = new ReplayState(context);
    for (const prior of records.slice(0, recordIndex)) invalid.apply(prior);
    expect(() => invalid.apply(record)).toThrow(/dependent/);
  }
  rejects((records) => {
    const record = records.find(
      (candidate) =>
        'events' in candidate &&
        candidate.events.some((event) => event.ruleId === 'dependent.upkeep'),
    );
    if (!record || !('events' in record)) throw new Error('Missing upkeep record');
    const upkeep = record.events.find((event) => event.ruleId === 'dependent.upkeep');
    if (!upkeep?.before || !upkeep.after) throw new Error('Missing upkeep cost');
    upkeep.before.mp += 1;
    upkeep.after.mp += 1;
  });
  rejects((records) => {
    const record = records.find(
      (candidate) => 'dependents' in candidate && candidate.dependents?.remove.length,
    );
    if (!record || !('dependents' in record) || !record.dependents || !('events' in record))
      throw new Error('Missing removal record');
    const removal = record.dependents.remove[0]!;
    const despawn = record.events.find(
      (event) => event.kind === 'dependent-despawn' && event.entityId === removal.id,
    );
    if (!despawn?.dependent) throw new Error('Missing despawn');
    removal.reason = 'owner-defeated';
    despawn.reason = 'owner-defeated';
    despawn.dependent.reason = 'owner-defeated';
  });
});

it('keeps legacy schema-7/8 participant-only summon records replayable without target observations', async () => {
  let selected:
    | {
        battle: Awaited<ReturnType<typeof prepareBattle>>;
        run: Awaited<ReturnType<typeof runPreparedBattle>>;
      }
    | undefined;
  for (let seed = 1; seed <= 32 && !selected; seed++) {
    const input = await summoningManifest(8);
    input.seed = seed;
    for (const participant of input.participants)
      participant.rngSeed = actorSeed(seed, participant.rngStream);
    const battle = await prepareBattle(input);
    const run = await runPreparedBattle(battle);
    const commands = battleEvents(run.records).filter(
      (event) => event.kind === 'dependent-command',
    );
    if (
      commands.length > 0 &&
      commands.every((event) => event.targetId === event.dependent?.hostileOwnerId)
    )
      selected = { battle, run };
  }
  if (!selected) throw new Error('Missing participant-only legacy summon fixture');
  for (const schemaVersion of [7, 8] as const) {
    const legacyManifest = {
      ...structuredClone(selected.battle.manifest),
      schemaVersion,
    };
    const legacyHash = await contentHash(legacyManifest);
    const legacyRecords = structuredClone(selected.run.records).map((record) => ({
      ...record,
      ...('simulationHash' in record ? { simulationHash: legacyHash } : {}),
    }));
    const legacyInitial = legacyRecords[0];
    if (legacyInitial?.kind !== 'initial') throw new Error('Missing legacy initial');
    legacyInitial.requiredFeatures = legacyInitial.requiredFeatures?.filter(
      (feature) => feature !== 'dependent-observation-v2',
    );
    for (const event of battleEvents(legacyRecords))
      if (event.dependent) delete event.dependent.observedTargetIds;
    const context = await replayContext(legacyManifest, legacyHash);
    const replay = new ReplayState(context);
    const checkpoints = legacyRecords.map((record) => {
      replay.apply(record);
      return replay.checkpoint();
    });
    for (const checkpoint of checkpoints.toReversed())
      expect(new ReplayState(context, checkpoint).checkpoint()).toEqual(checkpoint);

    const tampered = structuredClone(legacyRecords);
    const events = battleEvents(tampered);
    const command = events.find((event) => event.kind === 'dependent-command');
    const act = events.find((event) => event.parentEventId === command?.id);
    const target = tampered
      .flatMap((record) => ('dependents' in record ? (record.dependents?.spawn ?? []) : []))
      .find((dependent) => dependent.ownerId === command?.dependent?.hostileOwnerId);
    if (!command || !act || !target) throw new Error('Missing legacy target tamper fixture');
    command.targetId = target.id;
    act.targetId = target.id;
    const invalid = new ReplayState(context);
    expect(() => tampered.forEach((record) => invalid.apply(record))).toThrow(/dependent/);
  }
});

it('commits simultaneous dependent hits as one replay-bound HP wave', async () => {
  const battle = await prepareBattle(await multiHitSummoningManifest());
  const run = await runPreparedBattle(battle);
  const record = run.records.find(
    (candidate) =>
      'events' in candidate &&
      Object.values(
        candidate.events
          .filter((event) => event.kind === 'damage' && event.targetId?.startsWith('dependent.'))
          .reduce<Record<string, number>>((counts, event) => {
            counts[event.targetId!] = (counts[event.targetId!] ?? 0) + 1;
            return counts;
          }, {}),
      ).some((count) => count >= 2),
  );
  if (!record || !('events' in record)) throw new Error('Missing simultaneous dependent hits');
  const targetId = record.events.find(
    (event) =>
      event.kind === 'damage' &&
      event.targetId?.startsWith('dependent.') &&
      record.events.filter(
        (candidate) => candidate.kind === 'damage' && candidate.targetId === event.targetId,
      ).length >= 2,
  )!.targetId;
  const hits = record.events.filter(
    (event) => event.kind === 'damage' && event.targetId === targetId,
  );
  expect(new Set(hits.map((event) => event.before?.hp))).toHaveLength(1);
  expect(new Set(hits.map((event) => event.after?.hp))).toHaveLength(1);
  expect(hits.reduce((sum, event) => sum + (event.amount ?? 0), 0)).toBe(
    hits[0]!.before!.hp - hits[0]!.after!.hp,
  );
  expect(hits.map((event) => event.amount)).toEqual([1, 0]);
  let remainingCommittedLoss = hits[0]!.before!.hp - hits[0]!.after!.hp;
  for (const hit of hits.toSorted((left, right) => left.sequence - right.sequence)) {
    const expected = Math.min(
      hit.damage?.calculation?.afterModifiers ?? -1,
      remainingCommittedLoss,
    );
    expect(hit.amount).toBe(expected);
    remainingCommittedLoss -= expected;
  }
  expect(remainingCommittedLoss).toBe(0);
  const context = await replayContext(battle.manifest, run.result.simulationHash);
  const replay = new ReplayState(context);
  run.records.forEach((candidate) => replay.apply(candidate));
  const allEvents = battleEvents(run.records);
  const staleAct = allEvents.find((event) => {
    const actRecord = run.records.findIndex(
      (record) =>
        'events' in record && record.events.some((candidate) => candidate.id === event.id),
    );
    const despawnRecord = run.records.findIndex(
      (record) =>
        'events' in record &&
        record.events.some(
          (candidate) =>
            candidate.kind === 'dependent-despawn' && candidate.entityId === event.targetId,
        ),
    );
    return (
      event.kind === 'dependent-act' &&
      event.targetId?.startsWith('dependent.') &&
      despawnRecord >= 0 &&
      despawnRecord < actRecord &&
      allEvents.some(
        (candidate) =>
          candidate.kind === 'dependent-despawn' &&
          candidate.entityId === event.targetId &&
          candidate.sequence < event.sequence,
      ) &&
      !allEvents.some((candidate) => candidate.parentEventId === event.id)
    );
  });
  const staleCommand = allEvents.find((event) => event.id === staleAct?.parentEventId);
  const staleDespawn = allEvents.find(
    (event) =>
      event.kind === 'dependent-despawn' &&
      event.entityId === staleAct?.targetId &&
      event.sequence < (staleAct?.sequence ?? -1),
  );
  expect(staleCommand?.dependent?.observedTargetIds).toContain(staleAct?.targetId);
  expect(staleDespawn).toBeDefined();
  const staleActRecord = run.records.findIndex(
    (candidate) =>
      'events' in candidate && candidate.events.some((event) => event.id === staleAct?.id),
  );
  const staleDespawnRecord = run.records.findIndex(
    (candidate) =>
      'events' in candidate && candidate.events.some((event) => event.id === staleDespawn?.id),
  );
  expect(staleDespawnRecord).toBeGreaterThanOrEqual(0);
  expect(staleActRecord).toBeGreaterThan(staleDespawnRecord);
  const replayFromDespawn = new ReplayState(context);
  for (const candidate of run.records.slice(0, staleDespawnRecord + 1))
    replayFromDespawn.apply(candidate);
  const afterDespawn = replayFromDespawn.checkpoint();
  expect(afterDespawn.state?.dependents?.some(({ id }) => id === staleAct?.targetId)).toBe(false);
  const resumedAfterDespawn = new ReplayState(context, afterDespawn);
  for (const candidate of run.records.slice(staleDespawnRecord + 1, staleActRecord + 1))
    resumedAfterDespawn.apply(candidate);

  const removedSourceRecordIndex = run.records.findIndex(
    (candidate) =>
      'dependents' in candidate &&
      candidate.dependents?.remove.some(
        (removed) =>
          removed.reason === 'owner-defeated' &&
          candidate.events.some(
            (event) => event.kind === 'dependent-command' && event.entityId === removed.id,
          ) &&
          !candidate.dependents?.update.some((updated) => updated.id === removed.id),
      ),
  );
  expect(removedSourceRecordIndex).toBeGreaterThanOrEqual(0);
  for (const mutation of ['reason', 'next-action', 'candidate'] as const) {
    const records = structuredClone(run.records);
    const candidate = records[removedSourceRecordIndex];
    if (!candidate || !('dependents' in candidate) || !candidate.dependents)
      throw new Error('Missing remove-only source record');
    const removed = candidate.dependents.remove.find(
      (entry) =>
        entry.reason === 'owner-defeated' &&
        candidate.events.some(
          (event) => event.kind === 'dependent-command' && event.entityId === entry.id,
        ),
    );
    const command = candidate.events.find(
      (event) => event.kind === 'dependent-command' && event.entityId === removed?.id,
    );
    const act = candidate.events.find((event) => event.parentEventId === command?.id);
    if (!command?.dependent?.observedTargetIds || !act?.dependent)
      throw new Error('Missing remove-only source action');
    if (mutation === 'reason')
      command.reason =
        command.reason === 'owner-delivered-enemy-observation'
          ? 'owner-delivered-dependent-observation'
          : 'owner-delivered-enemy-observation';
    if (mutation === 'next-action') {
      if (command.dependent.nextActionAt === undefined || act.dependent.nextActionAt === undefined)
        throw new Error('Missing remove-only action deadline');
      command.dependent.nextActionAt += 1;
      act.dependent.nextActionAt += 1;
    }
    if (mutation === 'candidate') {
      const alternate = command.dependent.observedTargetIds.find(
        (targetId) => targetId !== command.targetId,
      );
      if (!alternate) throw new Error('Missing remove-only alternate candidate');
      command.targetId = alternate;
      act.targetId = alternate;
      const dependentTarget = alternate.startsWith('dependent.');
      command.reason = dependentTarget
        ? 'owner-delivered-dependent-observation'
        : 'owner-delivered-enemy-observation';
      act.reason = dependentTarget
        ? 'stable-ordinal-visible-hostile-dependent'
        : 'stable-ordinal-policy';
    }
    const invalidRemovedSource = new ReplayState(context);
    expect(() => records.forEach((record) => invalidRemovedSource.apply(record))).toThrow(
      /dependent/,
    );
  }

  const unknownStale = structuredClone(run.records);
  const unknownEvents = battleEvents(unknownStale);
  const unknownAct = unknownEvents.find((event) => event.id === staleAct?.id);
  const unknownCommand = unknownEvents.find((event) => event.id === staleCommand?.id);
  if (!unknownAct || !unknownCommand?.dependent?.observedTargetIds || !staleAct?.targetId)
    throw new Error('Missing stale dependent action');
  const unknownId = staleAct.targetId.replace(/\.[0-7]\./, '.7.');
  unknownAct.targetId = unknownId;
  unknownCommand.targetId = unknownId;
  unknownCommand.dependent.observedTargetIds = unknownCommand.dependent.observedTargetIds.map(
    (id) => (id === staleAct.targetId ? unknownId : id),
  );
  if (unknownAct.dependent)
    unknownAct.dependent.observedTargetIds = unknownCommand.dependent.observedTargetIds;
  const unknownReplay = new ReplayState(context);
  expect(() => unknownStale.forEach((candidate) => unknownReplay.apply(candidate))).toThrow(
    /dependent/,
  );

  const tampered = structuredClone(run.records);
  const altered = tampered
    .flatMap((candidate) => ('events' in candidate ? candidate.events : []))
    .find((event) => event.id === hits[0]!.id)!;
  altered.amount = (altered.amount ?? 0) + 1;
  const invalid = new ReplayState(context);
  expect(() => tampered.forEach((candidate) => invalid.apply(candidate))).toThrow(/dependent/);

  const redistributed = structuredClone(run.records);
  const redistributedHits = redistributed
    .flatMap((candidate) => ('events' in candidate ? candidate.events : []))
    .filter((event) => hits.some((hit) => hit.id === event.id));
  redistributedHits[0]!.amount = 0;
  redistributedHits[1]!.amount = 1;
  const redistributedReplay = new ReplayState(context);
  expect(() => redistributed.forEach((candidate) => redistributedReplay.apply(candidate))).toThrow(
    /dependent/,
  );

  const reordered = structuredClone(run.records);
  const reorderedHits = reordered
    .flatMap((candidate) => ('events' in candidate ? candidate.events : []))
    .filter((event) => hits.some((hit) => hit.id === event.id));
  [reorderedHits[0]!.amount, reorderedHits[1]!.amount] = [
    reorderedHits[1]!.amount,
    reorderedHits[0]!.amount,
  ];
  const reorderedReplay = new ReplayState(context);
  expect(() => reordered.forEach((candidate) => reorderedReplay.apply(candidate))).toThrow(
    /dependent/,
  );

  const coTampered = structuredClone(run.records);
  const actionRecord = coTampered.find(
    (candidate) =>
      'events' in candidate &&
      candidate.events.some((event) => {
        if (event.kind !== 'damage' || !event.targetId?.startsWith('dependent.')) return false;
        const act = candidate.events.find((parent) => parent.id === event.parentEventId);
        const command = candidate.events.find((parent) => parent.id === act?.parentEventId);
        return (
          (command?.dependent?.observedTargetIds?.filter((id) => id.startsWith('dependent.'))
            .length ?? 0) >= 2
        );
      }),
  );
  if (!actionRecord || !('events' in actionRecord))
    throw new Error('Missing dependent co-tamper action');
  const damage = actionRecord.events.find((event) => {
    if (event.kind !== 'damage' || !event.targetId?.startsWith('dependent.')) return false;
    const act = actionRecord.events.find((parent) => parent.id === event.parentEventId);
    const command = actionRecord.events.find((parent) => parent.id === act?.parentEventId);
    return (
      (command?.dependent?.observedTargetIds?.filter((id) => id.startsWith('dependent.')).length ??
        0) >= 2
    );
  });
  const act = actionRecord.events.find((event) => event.id === damage?.parentEventId);
  const command = actionRecord.events.find((event) => event.id === act?.parentEventId);
  const alternate = command?.dependent?.observedTargetIds?.find(
    (id) => id.startsWith('dependent.') && id !== damage?.targetId,
  );
  if (!damage || !act || !command || !alternate)
    throw new Error('Missing multi-dependent co-tamper fixture');
  command.targetId = alternate;
  act.targetId = alternate;
  damage.targetId = alternate;
  const coInvalid = new ReplayState(context);
  expect(() => coTampered.forEach((candidate) => coInvalid.apply(candidate))).toThrow(/dependent/);
});

it('never reuses a retired dependent identity and keeps bounded history restorable', async () => {
  const battle = await prepareBattle(await respawnSummoningManifest());
  const run = await runPreparedBattle(battle);
  const context = await replayContext(battle.manifest, run.result.simulationHash);
  const replay = new ReplayState(context);
  const checkpoints = run.records.map((record) => {
    replay.apply(record);
    const checkpoint = replay.checkpoint();
    expect(new ReplayState(context, checkpoint).checkpoint()).toEqual(checkpoint);
    return checkpoint;
  });
  const spawns = run.records.flatMap((record, recordIndex) =>
    'dependents' in record
      ? (record.dependents?.spawn ?? []).map((dependent) => ({ dependent, recordIndex }))
      : [],
  );
  const first = spawns[0];
  const later = spawns.find(
    ({ dependent, recordIndex }) =>
      !!first &&
      dependent.ownerId === first.dependent.ownerId &&
      recordIndex > first.recordIndex &&
      run.records
        .slice(first.recordIndex, recordIndex)
        .some(
          (record) =>
            'dependents' in record &&
            record.dependents?.remove.some((removed) => removed.id === first.dependent.id),
        ),
  );
  if (!first || !later) throw new Error('Missing retired dependent respawn fixture');
  const reused = structuredClone(run.records);
  const reusedRecord = reused[later.recordIndex];
  if (!reusedRecord || !('dependents' in reusedRecord) || !reusedRecord.dependents)
    throw new Error('Missing later spawn record');
  reusedRecord.dependents.spawn[0]!.id = first.dependent.id;
  reusedRecord.dependents.spawn[0]!.ordinal = first.dependent.ordinal;
  const invalid = new ReplayState(context);
  for (const record of reused.slice(0, later.recordIndex)) invalid.apply(record);
  expect(() => invalid.apply(reusedRecord)).toThrow(/dependent spawn identity\/history/);

  const overCapacity = structuredClone(checkpoints.at(-1)!);
  overCapacity.dependentHistory = Array.from({ length: 17 }, (_, ordinal) => ({
    id: `retired-dependent-${ordinal}`,
    ownerId: battle.manifest.participants[ordinal % 2]!.actorId,
    hostileOwnerId: battle.manifest.participants[(ordinal + 1) % 2]!.actorId,
  }));
  expect(() => new ReplayState(context, overCapacity)).toThrow();
});

it('settles dependent HP and drain in the owner revival wave before the verdict', async () => {
  const battle = await prepareBattle(await revivalWaveSummoningManifest());
  const run = await runPreparedBattle(battle);
  const record = run.records.find(
    (candidate) =>
      'dependents' in candidate &&
      candidate.events.some((event) => event.ruleId === 'damage.dependent-hp') &&
      candidate.events.some((event) => !!event.revival),
  );
  expect(record).toBeDefined();
  if (!record || !('dependents' in record)) throw new Error('Missing revival dependent wave');
  const dependentDamage = record.events.find((event) => event.ruleId === 'damage.dependent-hp');
  const dependentDrain = record.events.find(
    (event) =>
      event.ruleId === 'damage.drain' &&
      event.reason === 'same-wave-hp-loss-dependent-drain' &&
      event.entityId === dependentDamage?.targetId &&
      !!event.before &&
      !!event.after &&
      event.after.hp > event.before.hp,
  );
  const cappedDrain = record.events.find(
    (event) =>
      event.ruleId === 'damage.drain' &&
      event.reason === 'same-wave-hp-loss-dependent-drain' &&
      event.entityId !== dependentDamage?.targetId,
  );
  const guard = record.events.find(
    (event) => event.ruleId === 'reaction.activated' && event.reaction?.point === 'before-defeat',
  );
  const revival = record.events.find((event) => !!event.revival);
  expect(dependentDamage?.before?.hp).toBeGreaterThan(dependentDamage?.after?.hp ?? Infinity);
  expect(dependentDrain?.after?.hp).toBeGreaterThan(dependentDrain?.before?.hp ?? Infinity);
  expect(dependentDrain).toMatchObject({
    actorId: expect.any(String),
    targetId: dependentDamage?.targetId,
    entityId: dependentDamage?.targetId,
    before: { hp: 72, mp: 0, shield: 0 },
    after: { hp: 73, mp: 0, shield: 0 },
    amount: 1,
  });
  expect({
    beforeHp: dependentDrain?.before?.hp,
    afterHp: dependentDrain?.after?.hp,
    amount: dependentDrain?.amount,
  }).toEqual(fixture.runtimeSettlementEvidence.revivalWave.guardedDrain);
  expect(cappedDrain).toMatchObject({
    targetId: cappedDrain?.entityId,
    before: { hp: 80, mp: 0, shield: 0 },
    after: { hp: 80, mp: 0, shield: 0 },
    amount: 4,
  });
  expect({
    beforeHp: cappedDrain?.before?.hp,
    afterHp: cappedDrain?.after?.hp,
    amount: cappedDrain?.amount,
  }).toEqual(fixture.runtimeSettlementEvidence.revivalWave.cappedDrain);
  expect({ beforeHp: revival?.before?.hp, afterHp: revival?.after?.hp }).toEqual(
    fixture.runtimeSettlementEvidence.revivalWave.ownerRevival,
  );
  expect(dependentDamage!.sequence).toBeLessThan(dependentDrain!.sequence);
  expect(dependentDrain!.sequence).toBeLessThan(guard!.sequence);
  expect(guard!.sequence).toBeLessThan(revival!.sequence);
  expect(
    record.dependents?.update.find((dependent) => dependent.id === dependentDrain?.entityId)?.hp,
  ).toBe(dependentDrain?.after?.hp);

  const context = await replayContext(battle.manifest, run.result.simulationHash);
  const replay = new ReplayState(context);
  for (const candidate of run.records) {
    replay.apply(candidate);
    if (candidate !== record) continue;
    expect(
      replay
        .checkpoint()
        .state?.dependents?.find((dependent) => dependent.id === dependentDrain?.entityId)?.hp,
    ).toBe(73);
    expect(
      replay.checkpoint().state?.actors.find((actor) => actor.id === revival?.targetId)?.resources
        .hp,
    ).toBe(7);
  }
  expect(replay.checkpoint().state?.dependents?.every((dependent) => dependent.hp > 0)).toBe(true);
  expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
});

it('keeps dependent action clock frozen while lifetime/upkeep remain global', () => {
  const dependent = {
    nextActionAt: 300,
    nextUpkeepAt: 300,
    expiresAt: 1100,
  } as DependentState;
  freezeDependent(dependent, 'control.1', 300, 400);
  expect(dependent).toMatchObject({
    nextActionAt: 300,
    nextUpkeepAt: 300,
    expiresAt: 1100,
    clock: { controlId: 'control.1', frozenFrom: 300, frozenUntil: 400 },
  });
});

it('records boundary pulse owner defeat at the actual boundary and replays it', async () => {
  const battle = await prepareBattle(await lethalPulseSummoningManifest());
  const run = await runPreparedBattle(battle);
  const record = run.records.find(
    (candidate) =>
      candidate.kind === 'boundary' &&
      candidate.dependents?.remove.some((removal) => removal.reason === 'owner-defeated'),
  );
  if (!record || record.kind !== 'boundary' || !record.dependents)
    throw new Error('Missing boundary owner defeat');
  expect(
    record.events
      .filter((event) => event.kind === 'dependent-despawn')
      .map((event) => ({ step: event.step, phase: event.phase, reason: event.reason })),
  ).toEqual(
    record.dependents.remove.map(() => ({
      step: record.step,
      phase: 'boundary',
      reason: fixture.runtimeSettlementEvidence.terminalOwnerDefeat.despawnReason,
    })),
  );
  for (const removal of record.dependents.remove) {
    const despawn = record.events.find(
      (event) => event.kind === 'dependent-despawn' && event.entityId === removal.id,
    );
    const owner = run.records
      .flatMap((candidate) =>
        'dependents' in candidate ? (candidate.dependents?.spawn ?? []) : [],
      )
      .find((dependent) => dependent.id === removal.id)?.ownerId;
    const delta = record.changes.find((change) => change.id === owner);
    const lethal = record.events.findLast(
      (event) =>
        event.kind === 'damage' &&
        event.targetId === owner &&
        event.before?.hp !== undefined &&
        event.after?.hp === 0,
    );
    expect(delta?.resources?.hp).toBe(0);
    expect(lethal?.amount).toBeGreaterThan(0);
    expect(lethal!.sequence).toBeLessThan(despawn!.sequence);
  }
  const terminal = run.records.at(-1);
  expect(terminal).toMatchObject({
    kind: 'terminal',
    step: record.step,
    outcome: fixture.runtimeSettlementEvidence.terminalOwnerDefeat.outcome,
  });
  expect(run.result.outcome).toEqual(fixture.runtimeSettlementEvidence.terminalOwnerDefeat.outcome);
  const replay = new ReplayState(await replayContext(battle.manifest, run.result.simulationHash));
  for (const candidate of run.records) replay.apply(candidate);
  expect(replay.checkpoint().state?.dependents ?? []).toHaveLength(0);
  expect(replay.checkpoint().state?.actors.map((actor) => actor.resources.hp)).toEqual(
    fixture.runtimeSettlementEvidence.terminalOwnerDefeat.participantHp,
  );
});

it('propagates an owner time stop to its dependent subject clock and rebases only actions', async () => {
  const input = await stoppedSummoningManifest();
  const battle = await prepareBattle(input);
  const run = await runPreparedBattle(battle);
  const events = battleEvents(run.records);
  const activation = events.find(
    (event) => event.timeStop?.state === 'activated' && event.targetId === 'right',
  )!;
  const release = events.find(
    (event) =>
      event.timeStop?.state === 'release' &&
      event.timeStop.controlId === activation.timeStop!.controlId,
  )!;
  expect(release.step - activation.step).toBe(5);
  expect(
    events.filter(
      (event) =>
        event.kind === 'dependent-act' &&
        event.actorId === 'right' &&
        event.step > activation.step &&
        event.step < release.step,
    ),
  ).toEqual([]);
  const ownerActs = events.filter(
    (event) => event.kind === 'dependent-act' && event.actorId === 'right',
  );
  expect(ownerActs.some((event) => event.step >= release.step)).toBe(true);

  const frozen = run.records.find(
    (record) =>
      'dependents' in record &&
      record.dependents?.update.some(
        (dependent) =>
          dependent.ownerId === 'right' &&
          dependent.clock?.controlId === activation.timeStop!.controlId,
      ),
  );
  expect(frozen).toBeDefined();
  const thawed = run.records.find(
    (record) =>
      record.kind === 'boundary' &&
      record.step === release.step &&
      record.dependents?.update.some(
        (dependent) => dependent.ownerId === 'right' && !dependent.clock,
      ),
  );
  expect(thawed).toBeDefined();

  const context = await replayContext(battle.manifest, run.result.simulationHash);
  const replay = new ReplayState(context);
  for (const record of run.records) replay.apply(record);
  const clockTamper = structuredClone(run.records);
  const clockRecord = clockTamper.find(
    (record) =>
      'dependents' in record &&
      record.dependents?.update.some((dependent) => dependent.clock?.controlId),
  );
  if (!clockRecord || !('dependents' in clockRecord) || !clockRecord.dependents)
    throw new Error('Missing dependent clock');
  const clock = clockRecord.dependents.update.find((dependent) => dependent.clock)?.clock;
  if (!clock) throw new Error('Missing dependent clock');
  clock.frozenUntil += 1;
  expect(() => {
    const invalid = new ReplayState(context);
    clockTamper.forEach((record) => invalid.apply(record));
  }).toThrow(/dependent/);
});

it('records time-limit release owner defeat at the release boundary and replays it', async () => {
  const input = await withStopReactions(
    await stoppedSummoningManifest({ duration: 20, steps: 15, stopCastSteps: 0 }),
    1,
    [
      {
        trigger: 'after-damage',
        costs: { hp: 36, mp: 0, uses: 1 },
        reaction: { response: { kind: 'effects' } },
        effects: [{ kind: 'shield', amount: 1 }],
      },
    ],
  );
  const battle = await prepareBattle(input);
  const run = await runPreparedBattle(battle);
  const record = run.records.find(
    (candidate) =>
      candidate.kind === 'boundary' &&
      candidate.events.some(
        (event) =>
          event.timeStop?.state === 'release' &&
          event.reason === 'time-limit release-only settlement',
      ),
  );
  if (!record || record.kind !== 'boundary')
    throw new Error(
      `Missing time-limit release: ${JSON.stringify({
        outcome: run.result.outcome,
        stops: battleEvents(run.records)
          .filter((event) => event.timeStop)
          .map((event) => ({
            step: event.step,
            state: event.timeStop?.state,
            reason: event.reason,
          })),
      })}`,
    );
  const despawn = record.events.find(
    (event) => event.kind === 'dependent-despawn' && event.reason === 'owner-defeated',
  );
  if (!despawn)
    throw new Error(
      `Missing release despawn: ${JSON.stringify({
        outcome: run.result.outcome,
        changes: record.changes,
        events: record.events.map((event) => ({
          kind: event.kind,
          actorId: event.actorId,
          targetId: event.targetId,
          before: event.before,
          after: event.after,
          ruleId: event.ruleId,
          reason: event.reason,
        })),
      })}`,
    );
  expect(despawn).toMatchObject({ step: record.step, phase: 'boundary' });
  expect(
    record.dependents?.remove.some(
      (removal) => removal.id === despawn?.entityId && removal.reason === 'owner-defeated',
    ),
  ).toBe(true);
  const replay = new ReplayState(await replayContext(battle.manifest, run.result.simulationHash));
  for (const candidate of run.records) replay.apply(candidate);
  expect(replay.checkpoint().state?.dependents ?? []).toHaveLength(0);
});

it('derives dependent randomness from owner stream, ordinal, identity and purpose only', () => {
  const seed = dependentSeed(228071, 0, 0, 'dependent.a.0.scout-rat', 'policy-target');
  expect(seed).toBe(dependentSeed(228071, 0, 0, 'dependent.a.0.scout-rat', 'policy-target'));
  expect(seed).not.toBe(dependentSeed(228071, 1, 0, 'dependent.a.0.scout-rat', 'policy-target'));
  expect(seed).not.toBe(dependentSeed(228071, 0, 1, 'dependent.a.0.scout-rat', 'policy-target'));
});

it('despawns only after the owner revival result is known', async () => {
  const battle = await prepareBattle(await summoningManifest());
  const ability = battle.actors[0].abilities.find((candidate) => candidate.definition.summon)!;
  const owner = {
    body: { motion: { actor: battle.actors[0] } },
    vitals: { resources: { hp: 250 } },
  };
  const dependent = {
    id: 'dependent.a.0.scout-rat',
    ownerId: battle.actors[0].participant.actorId,
    hostileOwnerId: battle.actors[1].participant.actorId,
    ordinal: 0,
    ability,
  } as DependentState;
  const tx = {
    step: 10,
    next: { actors: [owner], dependents: [dependent] },
    dependentRemovals: new Map(),
    journal: new Journal(0, 0, DEFAULT_BUDGET),
  } as unknown as StepTransaction;
  settleDefeatedDependents(tx, 11, 'resolution');
  expect(tx.next.dependents).toHaveLength(1);
  owner.vitals.resources.hp = 0;
  settleDefeatedDependents(tx, 11, 'resolution');
  expect(tx.next.dependents).toHaveLength(0);
  expect(tx.journal.events).toMatchObject([
    {
      kind: 'dependent-despawn',
      step: 11,
      phase: 'resolution',
      reason: 'owner-defeated',
      entityId: dependent.id,
    },
  ]);
});
