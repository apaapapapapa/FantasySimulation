import { expect, it } from 'vite-plus/test';
import { AbilitySchema, ReplayState } from '@fantasy/domain/spatial';
import { conceptManifest } from '../../test-support/concepts.ts';
import { battleEvents, editScenario, glassWall } from '../../test-support/fixtures.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { runBattle } from './run.ts';
import { stoppedTransaction } from '../../test-support/time-stop.ts';
import { readMind } from './sim/mind-reading.ts';

it('does not reveal warded concealed or occluded private state and samples only a bounded current bucket', async () => {
  const f = await stoppedTransaction();
  try {
    const self = f.tx.next.actors[0]!.body.motion,
      target = f.tx.next.actors[1]!;
    target.vitals.resources.hp = 17;
    const effect = {
        kind: 'reveal' as const,
        field: 'health' as const,
        precisionBps: 1000,
        durationSteps: 20,
        delaySteps: 3,
        occlusion: 'vision' as const,
        powerBps: 5000,
      },
      ability = self.actor.abilities[0]!,
      sample = () =>
        readMind(f.world, self, target, target.body.motion, effect, ability, 'e.read', 10);
    expect(sample()).toMatchObject({
      field: 'health',
      range: { low: 4000, high: 5000 },
      sampledAt: 10,
    });
    const actor = target.body.motion.actor;
    target.body.motion.actor = {
      ...actor,
      character: {
        ...actor.character,
        perception: { ...actor.character.perception, revealWardBps: 5000 },
      },
    };
    expect(sample()).toBeNull();
    target.body.motion.actor = actor;
    target.body.motion.vision = { ...actor.character.perception, visible: false, enabled: true };
    expect(sample()).toBeNull();
    delete target.body.motion.vision;
    self.facing = { x: -1, y: 0, z: 0 };
    expect(sample()).toBeNull();
  } finally {
    f.world.free();
  }
});

it('zeroes authored aim error but preserves wall obstruction and whole-contact evasion', async () => {
  for (const wall of [false, true]) {
    const input = await conceptManifest({
      attack: { accuracy: 'no-error', aimErrorMilliDegrees: 45000 },
      both: true,
      status: { evasion: {} },
    });
    if (wall) await editScenario(input, (scenario) => scenario.obstacles.push(glassWall(50)));
    const run = await runBattle(input);
    const { replay } = await recordedCheckpoints(input, run);
    expect(replay.checkpoint().state!.actors.map((actor) => actor.resources.hp)).toEqual([10, 10]);
    const events = battleEvents(run.records);
    expect(events.filter((event) => event.ruleId === 'concept.no-error-aim')).toHaveLength(2);
    expect(events.filter((event) => event.evasion)).toHaveLength(wall ? 0 : 2);
    expect(events.filter((event) => event.defeat)).toHaveLength(0);
  }
});

it('limits evasion to matching hostile contacts and preserves paid reaction costs', async () => {
  for (const element of ['physical', 'fire'] as const) {
    const input = await conceptManifest({
      both: true,
      status: { evasion: { elements: [element] } },
      attack: {
        effects: [
          { kind: 'damage', amount: 111, attackScaleBps: 0, element: 'physical', defense: 'none' },
          { kind: 'defeat' },
        ],
      },
      reactions: [
        {
          costs: { hp: 0, mp: 3, uses: 1 },
          reaction: { response: { kind: 'parry', scope: 'damage' } },
        },
      ],
    });
    const run = await runBattle(input);
    const { replay } = await recordedCheckpoints(input, run);
    expect(replay.checkpoint().state!.actors.map((actor) => actor.resources)).toEqual([
      { hp: element === 'physical' ? 10 : 0, mp: 27, shield: 100 },
      { hp: element === 'physical' ? 10 : 0, mp: 27, shield: 100 },
    ]);
  }
});

it('delivers bounded health and declared-action readings after delay and rejects forged timing', async () => {
  for (const field of ['health', 'declared-action'] as const) {
    const input = await conceptManifest({
      steps: 30,
      attack: {
        effects: [
          {
            kind: 'reveal',
            ...(field === 'health' ? { field, precisionBps: 1000 } : { field }),
            durationSteps: 20,
            delaySteps: 3,
            occlusion: 'vision',
            powerBps: 10000,
          },
        ],
      },
    });
    const run = await runBattle(input);
    const { context } = await recordedCheckpoints(input, run);
    const events = battleEvents(run.records);
    const samples = events.filter((event) => event.ruleId === 'concept.bounded-read');
    expect(samples).toHaveLength(2);
    const readings = events.flatMap((event) =>
      event.cognition?.kind === 'knowledge' ? (event.cognition.readings ?? []) : [],
    );
    expect(readings).toHaveLength(2);
    for (const reading of readings) {
      const sample = samples.find((event) => event.id === reading.eventId)!;
      expect(reading.sampledAt).toBe(sample.step);
      expect(reading.availableAt).toBe(sample.step + 8);
      expect(reading.expiresAt).toBe(sample.step + 20);
      if (reading.field === 'health') expect(reading.range).toEqual({ low: 10000, high: 10000 });
      else expect(reading.action).toEqual({ abilityId: 'reaction-primary', phase: 'recovery' });
    }
    const corrupt = structuredClone(run.records);
    const event = battleEvents(corrupt).find(
      (event) => event.cognition?.kind === 'knowledge' && event.cognition.readings?.length,
    )!;
    if (event.cognition?.kind !== 'knowledge') throw new Error('Missing reading');
    event.cognition.readings![0]!.availableAt--;
    const replay = new ReplayState(context);
    expect(() => corrupt.forEach((record) => replay.apply(record))).toThrow(/mind reading/);
  }
});

it('accepts different bounded readings of one field without confusing their authored timing', async () => {
  const input = await conceptManifest({
    steps: 30,
    attack: {
      effects: [3, 4].map((delaySteps) => ({
        kind: 'reveal',
        field: 'health',
        precisionBps: 1000,
        durationSteps: 20,
        delaySteps,
        occlusion: 'vision',
        powerBps: 10000,
      })),
    },
  });
  const run = await runBattle(input);
  await recordedCheckpoints(input, run);
  const readings = battleEvents(run.records).flatMap((e) =>
    e.cognition?.kind === 'knowledge' ? (e.cognition.readings ?? []) : [],
  );
  expect(readings.map((r) => r.availableAt - r.sampledAt).sort((a, b) => a - b)).toEqual([
    8, 8, 9, 9,
  ]);
});

it('keeps expired readings undelivered and rejects unrestricted mind access', async () => {
  const input = await conceptManifest({
    attack: {
      effects: [
        {
          kind: 'reveal',
          field: 'health',
          precisionBps: 1000,
          durationSteps: 1,
          delaySteps: 3,
          occlusion: 'vision',
          powerBps: 10000,
        },
      ],
    },
  });
  const run = await runBattle(input);
  expect(
    battleEvents(run.records).some(
      (event) => event.cognition?.kind === 'knowledge' && event.cognition.readings?.length,
    ),
  ).toBe(false);
  const ability = input.revisions.find((revision) => revision.kind === 'ability')!;
  expect(
    AbilitySchema.safeParse({
      ...ability.definition,
      effects: [{ kind: 'reveal', field: 'future-action' }],
    }).success,
  ).toBe(false);
});
