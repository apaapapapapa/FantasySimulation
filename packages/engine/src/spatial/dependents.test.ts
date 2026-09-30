import { expect, it } from 'vite-plus/test';
import {
  ReplayState,
  StreamRecordSchema,
  DEFAULT_BUDGET,
  dependentSeed,
  replayContext,
} from '@fantasy/domain/spatial';
import { battleEvents } from '../../test-support/fixtures.ts';
import { stoppedSummoningManifest, summoningManifest } from '../../test-support/summoning.ts';
import { prepareBattle } from './prepare.ts';
import { runPreparedBattle } from './run.ts';
import { freezeDependent, settleDefeatedDependents } from './sim/dependents.ts';
import type { DependentState } from './state.ts';
import type { StepTransaction } from './sim/step-transaction.ts';
import { Journal } from './rules/journal.ts';

it('executes a bounded observed rat dependent through replay with ordinal RNG identity', async () => {
  const battle = await prepareBattle(await summoningManifest());
  expect(battle.manifest.schemaVersion).toBe(7);
  const run = await runPreparedBattle(battle);
  for (const record of run.records) {
    const parsed = StreamRecordSchema.safeParse(record);
    expect(parsed.success, parsed.error?.message).toBe(true);
  }
  const initial = run.records[0];
  if (initial?.kind !== 'initial') throw new Error('Missing initial');
  expect(initial.requiredFeatures).toContain('dependent-entities-v1');
  const events = battleEvents(run.records);
  const creates = events.filter((event) => event.kind === 'dependent-create');
  expect(creates).toHaveLength(2);
  expect(
    creates.map((event) => event.entityId).toSorted((a, b) => (a ?? '').localeCompare(b ?? '')),
  ).toEqual(['dependent.a.0.scout-rat', 'dependent.b.0.scout-rat']);
  const commands = events.filter((event) => event.kind === 'dependent-command');
  const acts = events.filter((event) => event.kind === 'dependent-act');
  expect(commands.length).toBeGreaterThan(0);
  expect(acts.length).toBe(commands.length);
  for (const command of commands) {
    expect(command.reason).toBe('owner-delivered-enemy-observation');
    expect(command.actorId).toBe(command.dependent?.ownerId);
    expect(command.targetId).toBe(command.dependent?.hostileOwnerId);
  }
  const dependentDamage = events.filter(
    (event) => event.kind === 'damage' && event.entityId?.startsWith('dependent.'),
  );
  expect(dependentDamage).toHaveLength(acts.length);
  expect(events.some((event) => event.reason === 'same-wave-hp-loss-dependent-drain')).toBe(true);
  expect(events.filter((event) => event.kind === 'dependent-despawn')).toEqual(
    expect.arrayContaining([expect.objectContaining({ reason: 'expired' })]),
  );

  const context = await replayContext(battle.manifest, run.result.simulationHash);
  const replay = new ReplayState(context);
  for (const record of run.records) replay.apply(record);
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
    if (!record || !('events' in record)) throw new Error('Missing action record');
    const command = record?.events.find((event) => event.kind === 'dependent-command');
    if (command?.dependent?.nextActionAt === undefined) throw new Error('Missing command');
    command.dependent.nextActionAt += 1;
  });
  rejects((records) => {
    const record = actionRecord(records);
    if (!record || !('events' in record)) throw new Error('Missing action record');
    const command = record?.events.find((event) => event.kind === 'dependent-command');
    if (!command?.after) throw new Error('Missing command cost');
    command.after.mp += 1;
  });
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
  settleDefeatedDependents(tx);
  expect(tx.next.dependents).toHaveLength(1);
  owner.vitals.resources.hp = 0;
  settleDefeatedDependents(tx);
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
