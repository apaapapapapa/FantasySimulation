import { expect, it } from 'vite-plus/test';
import {
  ReplayState,
  StreamRecordSchema,
  DEFAULT_BUDGET,
  dependentSeed,
  replayContext,
} from '@fantasy/domain/spatial';
import { battleEvents } from '../../test-support/fixtures.ts';
import { summoningManifest } from '../../test-support/summoning.ts';
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

  const spawnIndex = run.records.findIndex(
    (record) => 'dependents' in record && record.dependents?.spawn.length,
  );
  const tampered = structuredClone(run.records);
  const spawn = tampered[spawnIndex];
  if (!spawn || !('dependents' in spawn) || !spawn.dependents) throw new Error('Missing spawn');
  spawn.dependents.spawn[0]!.ownerId = spawn.dependents.spawn[0]!.hostileOwnerId;
  expect(() => {
    const invalid = new ReplayState(context);
    tampered.forEach((record) => invalid.apply(record));
  }).toThrow(/dependent/);
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
