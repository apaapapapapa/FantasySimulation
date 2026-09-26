import { beforeAll, expect, it } from 'vite-plus/test';
import {
  ReplayState,
  replayContext,
  StreamRecordSchema,
  ExperienceSchema,
} from '@fantasy/domain/spatial';
import { recoveryManifest, recoveryDamage } from '../../test-support/recovery.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { aiFixture } from '../../test-support/ai.ts';
import { runBattle } from './run.ts';
import { prepareBattle } from './prepare.ts';
import { assessAbility, efficacy } from './ai/assessment.ts';
import { observeImpact } from './ai/perception.ts';
import { initializePhysics } from './world/physics.ts';
import { catalogManifest } from '@fantasy/samples';

beforeAll(initializePhysics);

it('records simultaneous conversion and drain, delayed coarse knowledge, and deterministic replay', async () => {
  const input = await recoveryManifest();
  const battle = await prepareBattle(input);
  const run = await runBattle(input);
  const events = battleEvents(run.records);
  const converted = events.find((e) => e.damage?.absorption)!;
  expect(converted).toMatchObject({
    actorId: 'left',
    targetId: 'right',
    damage: {
      absorption: { element: 'fire', converted: 10, healing: 10 },
      drain: { basis: { numerator: '10', denominator: '1' }, healing: 5 },
    },
  });
  expect(events.find((e) => e.kind === 'damage' && e.actorId === 'right')).toMatchObject({
    damage: { drain: { healing: 10 } },
  });
  const last = run.records.at(-1)!;
  expect(last).toMatchObject({ kind: 'terminal', outcome: { kind: 'draw', reason: 'time-limit' } });
  const replay = new ReplayState(await replayContext(battle.manifest, run.result.simulationHash));
  for (const record of run.records) replay.apply(StreamRecordSchema.parse(record));
  expect(replay.checkpoint().state!.actors.map((a) => a.resources.hp)).toEqual([75, 100]);
  const learned = events.flatMap((e) =>
    e.cognition?.kind === 'knowledge' ? e.cognition.learned : [],
  );
  const observation = learned.find((e) => e.kind === 'absorption')!;
  expect(observation).toMatchObject({ targetId: 'right', absorptionBand: 'strong', range: null });
  expect(observation.availableAt).toBe(observation.sampledAt + 5);
  expect(observation).not.toHaveProperty('absorptionBps');
  expect(observation).not.toHaveProperty('impactBand');
  expect(
    observation.observedStatuses
      ?.flatMap((s) => s.adjustments ?? [])
      .some((a) => a.target === 'absorption'),
  ).not.toBe(true);
  expect(ExperienceSchema.safeParse({ ...observation, range: { low: 50, high: 50 } }).success).toBe(
    false,
  );
  expect(await runBattle(input)).toEqual(run);
  const reordered = {
    ...input,
    participants: [...input.participants].reverse(),
    revisions: [...input.revisions].reverse(),
  };
  const reversed = await runBattle(reordered);
  expect(reversed.records).toEqual(run.records);
  expect({ ...reversed.result, simulationHash: run.result.simulationHash }).toEqual(run.result);
});

it('rejects corrupt optional conversion, allocation and causal credit in engine-free replay', async () => {
  const input = await recoveryManifest();
  const battle = await prepareBattle(input);
  const run = await runBattle(input);
  const context = await replayContext(battle.manifest, run.result.simulationHash);
  for (const corrupt of ['conversion', 'allocation', 'credit', 'missing-credit'] as const) {
    const records = structuredClone(run.records);
    const record = records.find(
      (r) => 'events' in r && r.events.some((e) => e.damage?.absorption),
    )!;
    if (!('events' in record)) throw Error('Missing conversion record');
    const damage = record.events.find((e) => e.damage?.absorption)!;
    const credit = record.events.find(
      (e) => e.ruleId === 'damage.drain' && e.parentEventId === damage.id,
    )!;
    if (corrupt === 'conversion') damage.damage!.absorption!.converted = 21;
    if (corrupt === 'allocation') damage.damage!.drain!.basis.numerator = '100000';
    if (corrupt === 'credit') credit.amount!++;
    if (corrupt === 'missing-credit') credit.ruleId = 'heal.other';
    const replay = new ReplayState(context);
    expect(() => records.forEach((r) => replay.apply(r))).toThrow();
  }
});

it('values own drain while wounded and changes elemental choice only with learned absorption', async () => {
  const fixture = await aiFixture({
    abilities: [{ effects: [recoveryDamage(25, 10000)] }, { effects: [recoveryDamage(25)] }],
  });
  const view = fixture.view;
  const wounded = { ...view, resources: { ...view.resources, hp: 20 } };
  const [drain, ordinary] = fixture.abilities;
  expect(assessAbility(wounded, drain!).weight).toBeGreaterThan(
    assessAbility(wounded, ordinary!).weight,
  );
  expect(assessAbility(view, drain!).weight).toBe(assessAbility(view, ordinary!).weight);
  const run = await runBattle(await recoveryManifest());
  const observed = battleEvents(run.records)
    .flatMap((e) => (e.cognition?.kind === 'knowledge' ? e.cognition.learned : []))
    .find((e) => e.kind === 'absorption')!;
  const learned = {
    ...wounded,
    step: observed.availableAt,
    memory: { ...wounded.memory, knowledge: [observed] },
  };
  expect(efficacy(learned, 'fire', 25).bps).toBe(0);
  expect(efficacy(wounded, 'fire', 25).bps).toBeGreaterThan(0);
  fixture.world.free();
});

it('keeps absorption private behind occlusion and before its observation delay', async () => {
  const f = await aiFixture();
  try {
    const detail = {
      ability: f.abilities[0]!,
      eventId: 'e.1',
      element: 'fire' as const,
      basePower: 20,
      impact: 20,
      absorbed: 20,
      shield: false,
      partial: false,
    };
    expect(
      observeImpact(
        f.world,
        f.self,
        { ...f.enemy, vision: { ...f.enemy.vision!, visible: false } },
        detail,
        10,
      ),
    ).toBeNull();
    const cue = observeImpact(f.world, f.self, f.enemy, detail, 10)!;
    expect(cue).toMatchObject({
      kind: 'absorption',
      availableAt: 15,
      absorptionBand: 'strong',
      range: null,
    });
    expect(
      efficacy(
        { ...f.view, step: 14, memory: { ...f.view.memory, pendingExperience: [cue] } },
        'fire',
        20,
      ).bps,
    ).toBeGreaterThan(0);
  } finally {
    f.world.free();
  }
});

it('executes the new sample characters and preserves recovery under mirrored actors positions and RNG slots', async () => {
  const input = await catalogManifest(
    'ember-drainer-v1',
    'ember-absorber-v1',
    'flat-surveyed-v1',
    300,
  );
  const first = await runBattle(input);
  expect(first.result.outcome).toEqual({ kind: 'win', winner: 'right' });
  expect(
    battleEvents(first.records).some(
      (e) => e.damage?.absorption?.converted === 30 && e.damage.drain?.healing === 0,
    ),
  ).toBe(true);
  const exchange = (id: string | null) => (id === 'left' ? 'right' : id === 'right' ? 'left' : id);
  const mirrored = structuredClone(input);
  for (const p of mirrored.participants) {
    p.actorId = exchange(p.actorId)!;
    p.position.x *= -1;
    p.position.z *= -1;
    p.facing.x *= -1;
    p.facing.z *= -1;
  }
  mirrored.participants.reverse();
  const second = await runBattle(mirrored);
  expect(second.result.outcome).toEqual({ kind: 'win', winner: 'left' });
  expect(second.result.steps).toBe(first.result.steps);
  const damage = (records: typeof first.records, remap: boolean) =>
    battleEvents(records)
      .filter((e) => e.kind === 'damage')
      .map((e) => ({
        step: e.step,
        actor: remap ? exchange(e.actorId) : e.actorId,
        target: remap ? exchange(e.targetId) : e.targetId,
        damage: e.damage,
        after: e.after,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  expect(damage(second.records, true)).toEqual(damage(first.records, false));
});
