import { expect, it } from 'vite-plus/test';
import {
  ReplayState,
  StreamRecordSchema,
  replayContext,
  DEFAULT_BUDGET,
  type Definition,
} from '@fantasy/domain/spatial';
import { battleEvents } from '../../test-support/fixtures.ts';
import { prepareBattle } from './prepare.ts';
import { runPreparedBattle } from './run.ts';
import {
  cleanseSensoryCues,
  cognitiveCueEligibility,
  cueIdentity,
  settleSensoryCues,
} from './sim/sensory-cues.ts';
import { subjectiveCueMemory } from './ai/self-view.ts';
import { Journal } from './rules/journal.ts';
import type { ActorState, SensoryCue } from './state.ts';
import { sampleManifest } from '@fantasy/samples';
import { sensoryCueManifest } from '../../test-support/sensory-cues.ts';

it('overlays only a delivered observer cue without mutating canonical observation or RNG state', () => {
  const enemy = {
    id: 'creator',
    position: { x: 1, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    facing: { x: -1, y: 0, z: 0 },
    step: 0,
  };
  const memory = {
    sampledAt: 0,
    pending: [],
    observation: { sampledAt: 0, availableAt: 0, enemy, projectiles: [] },
    lastSeen: enemy,
    pendingExperience: [],
    knowledge: [],
    learned: [],
    expired: [],
    terrain: [],
  };
  const cue = {
    id: 'cue.1.2.3',
    creatorId: 'creator',
    observerId: 'observer',
    modality: 'visual' as const,
    perceivedOrigin: { x: 8, y: 0, z: 3 },
    emittedAt: 1,
    deliveredAt: 3,
    discoveredAt: 8,
    expiresAt: 10,
    confidenceBps: 8000,
  };
  expect(subjectiveCueMemory(memory, [cue], 2)).toBe(memory);
  expect(subjectiveCueMemory(memory, [cue], 3).observation?.enemy?.position).toEqual(
    cue.perceivedOrigin,
  );
  expect(memory.observation.enemy.position).toEqual({ x: 1, y: 0, z: 0 });
  expect(subjectiveCueMemory(memory, [cue], 8)).toBe(memory);
});

it('derives cue identity independently and scopes control cleanse to one observer', () => {
  const cue = (observerId: string): SensoryCue => ({
    id: cueIdentity(7, 'creator', observerId, 12),
    creatorId: 'creator',
    observerId,
    modality: 'visual',
    perceivedOrigin: { x: 8, y: 0, z: 3 },
    emittedAt: 1,
    deliveredAt: 3,
    discoveredAt: 8,
    expiresAt: 10,
    confidenceBps: 8000,
  });
  expect(cueIdentity(7, 'creator', 'left', 12)).toBe(cueIdentity(7, 'creator', 'left', 12));
  expect(cueIdentity(8, 'creator', 'left', 12)).not.toBe(cueIdentity(7, 'creator', 'left', 12));
  expect(cueIdentity(7, 'creator', 'right', 12)).not.toBe(cueIdentity(7, 'creator', 'left', 12));
  const left = { mind: { sensoryCues: [cue('left')] } } as unknown as ActorState;
  const right = { mind: { sensoryCues: [cue('right')] } } as unknown as ActorState;
  const journal = new Journal(20, 0, DEFAULT_BUDGET);
  expect(cleanseSensoryCues(left, 5, 'resolution', journal, ['e.19'])).toBe(1);
  expect(left.mind.sensoryCues).toEqual([]);
  expect(right.mind.sensoryCues).toHaveLength(1);
  expect(journal.events).toMatchObject([
    {
      kind: 'sensory-cue',
      targetId: 'left',
      causes: ['e.19'],
      sensoryCue: { transition: 'cleansed', observerId: 'left' },
    },
  ]);
  const tied = cue('left');
  tied.discoveredAt = tied.expiresAt;
  tied.deliveryRecorded = true;
  left.mind.sensoryCues = [tied];
  const tieJournal = new Journal(30, 0, DEFAULT_BUDGET);
  settleSensoryCues(left, tied.expiresAt, tieJournal);
  expect(tieJournal.events.map((event) => event.sensoryCue?.transition)).toEqual(['discovered']);
});

it('keeps visual cues observer-bounded through delivery, AI choice, cleanse, discovery, replay and display', async () => {
  const manifest = await sensoryCueManifest();
  const battle = await prepareBattle(manifest);
  expect(battle.manifest.schemaVersion).toBe(6);
  const run = await runPreparedBattle(battle);
  for (const record of run.records) {
    const parsed = StreamRecordSchema.safeParse(record);
    expect(parsed.success, parsed.error?.message).toBe(true);
  }
  const initial = run.records[0];
  expect(initial?.kind).toBe('initial');
  if (initial?.kind !== 'initial') throw new Error('Missing initial');
  expect(initial.requiredFeatures).toContain('sensory-cues-v1');
  const transitions = battleEvents(run.records)
    .filter((event) => event.sensoryCue)
    .map((event) => event.sensoryCue!.transition);
  expect(transitions).toEqual(expect.arrayContaining(['emitted', 'delivered', 'discovered']));
  const emitted = battleEvents(run.records).find(
    (event) => event.sensoryCue?.transition === 'emitted',
  )!;
  expect(emitted.before).toEqual(emitted.after);
  const delivered = battleEvents(run.records).find(
    (event) =>
      event.sensoryCue?.id === emitted.sensoryCue?.id &&
      event.sensoryCue?.transition === 'delivered',
  )!;
  const affectedDecision = battleEvents(run.records).find(
    (event) =>
      event.kind === 'decision' &&
      event.actorId === emitted.targetId &&
      event.step >= delivered.step &&
      event.step < emitted.sensoryCue!.discoveredAt &&
      event.cognition?.kind === 'decision' &&
      event.cognition.targetPositionMm,
  );
  expect(
    affectedDecision?.cognition?.kind === 'decision'
      ? affectedDecision.cognition.targetPositionMm
      : null,
  ).toEqual({
    x: Math.round(emitted.sensoryCue!.perceivedOrigin.x * 1000),
    y: Math.round(emitted.sensoryCue!.perceivedOrigin.y * 1000),
    z: Math.round(emitted.sensoryCue!.perceivedOrigin.z * 1000),
  });
  const participantIds = new Set(
    battle.manifest.participants.map((participant) => participant.actorId),
  );
  expect(
    battleEvents(run.records).every(
      (event) =>
        (event.actorId === null || participantIds.has(event.actorId)) &&
        (event.targetId === null || participantIds.has(event.targetId)),
    ),
  ).toBe(true);
  expect(battleEvents(run.records).some((event) => event.kind === 'damage')).toBe(false);
  expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });

  const context = await replayContext(battle.manifest, run.result.simulationHash);
  const replay = new ReplayState(context);
  for (const record of run.records) replay.apply(record);
  expect(replay.checkpoint().state?.actors.every((actor) => !actor.sensoryCues?.length)).toBe(true);

  const activeIndex = run.records.findIndex(
    (record) =>
      'changes' in record && record.changes.some((actor) => (actor.sensoryCues?.length ?? 0) > 0),
  );
  expect(activeIndex).toBeGreaterThan(0);
  for (const mutation of ['identity', 'observer', 'step'] as const) {
    const records = structuredClone(run.records);
    const active = records[activeIndex]!;
    if (!('changes' in active)) throw new Error('Missing active delta');
    const cue = active.changes.find((actor) => actor.sensoryCues?.length)?.sensoryCues?.[0]!;
    if (mutation === 'identity') cue.id = 'cue.0.0.0';
    if (mutation === 'observer') cue.observerId = cue.creatorId;
    if (mutation === 'step') cue.emittedAt += 1;
    const invalid = new ReplayState(context);
    expect(() => records.forEach((record) => invalid.apply(record)), mutation).toThrow(
      /sensory cue/,
    );
  }
  const missingFeature = structuredClone(run.records);
  const missingInitial = missingFeature[0]!;
  if (missingInitial.kind !== 'initial') throw new Error('Missing initial');
  missingInitial.requiredFeatures = ['subject-clocks-v1', 'deferred-contacts-v1'];
  expect(() => new ReplayState(context).apply(missingInitial)).toThrow(
    'sensory cue replay feature',
  );
});

it('keeps non-cognitive targets fail-closed', async () => {
  const character = {
    name: 'mindless',
    originalText: '',
    stats: {
      hp: 10,
      mp: 0,
      attack: 0,
      defense: 0,
      actionSpeedBps: 10000,
      shield: 0,
      resistances: { physical: 0, fire: 0, ice: 0, lightning: 0, arcane: 0 },
    },
  } satisfies Partial<Definition<'character'>>;
  const actor = {
    body: { motion: { actor: { character } } },
    statuses: [],
  } as unknown as ActorState;
  expect(cognitiveCueEligibility(actor, 0)).toEqual({
    eligible: false,
    reason: 'non-cognitive-target',
  });
  const cognitive = {
    ...actor,
    body: {
      ...actor.body,
      motion: {
        ...actor.body.motion,
        actor: {
          ...actor.body.motion.actor,
          character: { ...actor.body.motion.actor.character, mentalEligibility: 'cognitive' },
        },
      },
    },
  } as ActorState;
  expect(cognitiveCueEligibility(cognitive, 0)).toEqual({ eligible: true });
  cognitive.statuses = [
    {
      startStep: 0,
      endStep: 5,
      stacks: 1,
      causes: ['e.0'],
      revision: { definition: { mentalImmunity: true } },
    },
  ] as unknown as ActorState['statuses'];
  expect(cognitiveCueEligibility(cognitive, 0)).toEqual({
    eligible: false,
    reason: 'mental-immunity',
  });
});

it('keeps legacy recordings free of sensory fields and replay features', async () => {
  const input = await sampleManifest(1);
  const run = await runPreparedBattle(await prepareBattle(input));
  const initial = run.records[0];
  expect(initial?.kind).toBe('initial');
  if (initial?.kind !== 'initial') throw new Error('Missing initial');
  expect(initial.requiredFeatures).toBeUndefined();
  expect(initial.state.actors.every((actor) => actor.sensoryCues === undefined)).toBe(true);
});
