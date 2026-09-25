import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  AbilitySchema,
  DEFAULT_BUDGET,
  ReplayState,
  replayContext,
  type StageContact,
  type Definition,
} from '@fantasy/domain/spatial';
import { initializePhysics } from './world/physics.ts';
import { runBattle } from './run.ts';
import { prepareBattle } from './prepare.ts';
import { actionClock } from './rules/attacks.ts';
import { simulate } from './simulate.ts';
import { HitLedger } from './rules/hit-ledger.ts';
import { comboStages, stagedManifest } from '../../test-support/stages.ts';
import { battleEvents, combatManifest } from '../../test-support/fixtures.ts';

beforeAll(initializePhysics);
describe('staged action transactions', () => {
  it('validates stage zero, windows, duration, references and unsupported fields', async () => {
    const manifest = await stagedManifest();
    const definition = manifest.revisions.find((r) => r.kind === 'ability')!.definition;
    expect(AbilitySchema.safeParse(definition).success).toBe(true);
    const mutations = [
      (d: typeof definition) => {
        d.stages = [];
      },
      (d: typeof definition) => {
        d.stages![0]!.offsetSteps = 1;
      },
      (d: typeof definition) => {
        d.stages![1]!.id = 'cut';
      },
      (d: typeof definition) => {
        d.stages![1]!.offsetSteps = 1;
      },
      (d: typeof definition) => {
        d.stages![1]!.durationSteps = 1;
      },
      (d: typeof definition) => {
        d.stages![1]!.offsetSteps = 5999;
      },
      (d: typeof definition) => {
        d.stages![0]!.effects = [{ kind: 'heal', amount: 1 }];
      },
      (d: typeof definition) => {
        d.stages![1]!.attack = null;
      },
      (d: typeof definition) => {
        d.stages![1]!.effects = [{ kind: 'dispel' }];
      },
    ];
    for (const mutate of mutations) {
      const d = structuredClone(definition);
      mutate(d);
      expect(AbilitySchema.safeParse(d).success).toBe(false);
    }
    expect(
      AbilitySchema.safeParse({
        ...definition,
        stages: definition.stages!.map((s) => ({ ...s, teleport: true })),
      }).success,
    ).toBe(false);
  });
  it('keeps physical stage offsets and full recovery after speed-scaled preparation', async () => {
    const definition = (await stagedManifest()).revisions.find(
      (r) => r.kind === 'ability',
    )!.definition;
    expect(actionClock(definition, 20000, 10)).toEqual({
      launchAt: 11,
      recoveryUntil: 18,
      cooldownUntil: 26,
    });
  });
  it('executes two independent hits, pays future cost at its boundary and replays actual stage geometry', async () => {
    const manifest = await stagedManifest();
    const { result, records } = await runBattle(manifest);
    expect(result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
    const events = battleEvents(records),
      id = manifest.participants[0].actorId;
    expect(
      events
        .filter((e) => e.actorId === id && e.kind === 'stage-start')
        .map((e) => [e.stage?.stageId, e.step]),
    ).toEqual([
      ['cut', 7],
      ['return', 10],
    ]);
    expect(
      events.filter((e) => e.actorId === id && e.kind === 'hit').map((e) => e.stage?.stageId),
    ).toEqual(['cut', 'return']);
    expect(
      events
        .filter((e) => e.actorId === id && e.kind === 'cost')
        .map((e) => [e.step, e.after?.stamina]),
    ).toEqual([
      [5, 14],
      [10, 10],
    ]);
    expect(
      events.filter((e) => e.actorId === id && e.kind === 'stage-end').map((e) => e.step),
    ).toEqual([9, 12]);
    const context = await replayContext(
        (await prepareBattle(manifest)).manifest,
        result.simulationHash,
      ),
      replay = new ReplayState(context);
    const checkpoints = [];
    for (const record of records) {
      replay.apply(record);
      checkpoints.push(replay.checkpoint());
    }
    expect(replay.checkpoint().state?.actors.map((a) => a.resources.hp)).toEqual([75, 75]);
    const active = checkpoints.find((c) =>
      c.state?.actors.some((a) => a.action?.stage?.state === 'active'),
    )!;
    const geometry = active.state!.actors[0]!.action!.stage!.geometry!;
    if (geometry.kind === 'blade') throw Error('Expected thrust sphere');
    expect(geometry.segments.length).toBeGreaterThan(0);
    for (const checkpoint of [checkpoints.at(-1)!, active, checkpoints[0]!]) {
      const restored = new ReplayState(context, checkpoint);
      for (const record of records.slice(restored.nextRecord)) restored.apply(record);
      expect(restored.checkpoint()).toEqual(replay.checkpoint());
    }
  });
  it('retains declaration cost and deadlines when a later stage is unaffordable', async () => {
    const { records } = await runBattle(await stagedManifest({ stamina: 8 }));
    const events = battleEvents(records);
    expect(events.filter((e) => e.kind === 'stage-start')).toHaveLength(2);
    expect(
      events
        .filter((e) => e.kind === 'stage-interrupt')
        .map((e) => [e.step, e.stage?.stageId, e.reason]),
    ).toEqual([
      [10, 'return', 'insufficient-stamina'],
      [10, 'return', 'insufficient-stamina'],
    ]);
    expect(events.filter((e) => e.kind === 'cost').map((e) => e.after?.stamina)).toEqual([2, 2]);
    const stopped = records.find((r) => r.kind === 'interval' && r.fromStep === 10)!;
    expect(
      stopped.kind === 'interval' && stopped.changes.every((a) => a.action?.recoveryUntil === 16),
    ).toBe(true);
  });
  it('interrupts after collected damage while keeping that interval simultaneous', async () => {
    const stages = comboStages();
    stages[0]!.interruptOnDamage = true;
    const { records } = await runBattle(await stagedManifest({ stages }));
    const events = battleEvents(records);
    expect(events.filter((e) => e.kind === 'hit')).toHaveLength(2);
    expect(
      events
        .filter((e) => e.kind === 'stage-interrupt')
        .every((e) => e.reason === 'damage' && e.causes.length === 1),
    ).toBe(true);
    expect(events.filter((e) => e.kind === 'stage-start').map((e) => e.stage?.stageId)).toEqual([
      'cut',
      'cut',
    ]);
  });
  it('rolls back stage payments, hits and IDs when the interval exceeds its record budget', async () => {
    const stages = comboStages();
    for (const stage of stages) if (stage.attack?.kind === 'melee') stage.attack.reachMm = 2500;
    const input = await stagedManifest({ stages }),
      full = await runBattle(input);
    const hit = battleEvents(full.records).filter(
      (e) => e.kind === 'hit' && e.stage?.stageId === 'return',
    )[1]!;
    const budget = { ...DEFAULT_BUDGET, maxEvents: Number(hit.id.slice(2)) };
    const failed = await runBattle(input, budget);
    expect(failed.result.outcome.kind).toBe('truncated');
    expect(failed.result.steps).toBe(10);
    expect(failed.records.filter((r) => r.kind !== 'terminal')).toEqual(
      full.records.filter((r) => r.kind !== 'terminal').slice(0, failed.records.length - 1),
    );
    const stream = simulate(await prepareBattle(input), budget);
    let next = stream.next();
    while (!next.done) next = stream.next();
    expect(next.value.decisionState).toMatchObject({
      step: 10,
      actors: [
        { resources: { hp: 90, stamina: 14 }, used: { 'combo-fixture': 1 } },
        { resources: { hp: 90, stamina: 14 }, used: { 'combo-fixture': 1 } },
      ],
      hitLedger: [
        { hits: 1, contact: { stageId: 'cut' } },
        { hits: 1, contact: { stageId: 'cut' } },
      ],
    });
    const retry = await runBattle(input);
    expect(retry.result).toEqual(full.result);
  });
  it.each(['melee', 'hitscan', 'projectile', 'direct'] as const)(
    'preserves the one-stage %s mechanics and timing',
    async (kind) => {
      const attack: Definition<'ability'>['attack'] =
        kind === 'melee'
          ? { kind, reachMm: 1800, radiusMm: 200, activeSteps: 2, maxHitsPerTarget: 1 }
          : kind === 'hitscan'
            ? { kind, radiusMm: 0 }
            : kind === 'direct'
              ? { kind }
              : {
                  kind,
                  radiusMm: 80,
                  speedMmPerSecond: 50000,
                  lifetimeSteps: 100,
                  gravityScaleBps: 0,
                  homingTurnMilliDegreesPerSecond: 0,
                  observation: 'launch-only',
                  explosionRadiusMm: 0,
                  maxHitsPerTarget: 1,
                };
      const effects: Definition<'ability'>['effects'] =
        kind === 'direct'
          ? [{ kind: 'shield', amount: 10 }]
          : [{ kind: 'damage', amount: 10, attackScaleBps: 0, element: 'physical' }];
      const ability: Partial<Definition<'ability'>> = {
        attack,
        effects,
        target: kind === 'direct' ? 'self' : 'enemy',
        castSteps: 2,
        recoverySteps: 4,
        rangeMm: 20000,
        costs: { hp: 0, mp: 0, uses: 1 },
      };
      const runs = [];
      for (const explicit of [false, true]) {
        const input = await combatManifest(30, {
          ability: {
            ...ability,
            ...(explicit
              ? {
                  stages: [
                    {
                      id: 'only',
                      offsetSteps: 0,
                      durationSteps: kind === 'melee' ? 2 : 1,
                      attack,
                      effects,
                    },
                  ],
                }
              : {}),
          },
          policy: { movement: 'hold', jumpWhenBlocked: false },
        });
        input.participants[0].position.x = -750;
        input.participants[1].position.x = 750;
        const run = await runBattle(input);
        const events = battleEvents(run.records).filter((e) =>
          ['cast-start', 'launch', 'hit', 'damage', 'heal', 'shield', 'cost'].includes(e.kind),
        );
        expect(events.some((e) => e.kind === 'launch')).toBe(true);
        runs.push(
          events.map(({ kind, step, actorId, targetId, amount, before, after, point, damage }) => ({
            kind,
            step,
            actorId,
            targetId,
            amount,
            before,
            after,
            point,
            damage,
          })),
        );
      }
      expect(runs[1]).toEqual(runs[0]);
    },
  );
  it('prepays stage zero once and allows exact-HP cost with same-interval healing', async () => {
    const stages = comboStages();
    stages[0]!.cost = { stamina: 2 };
    const events = battleEvents((await runBattle(await stagedManifest({ stages }))).records);
    expect(
      events
        .filter((e) => e.kind === 'cost' && e.actorId === 'left')
        .map((e) => [e.step, e.after?.stamina]),
    ).toEqual([
      [5, 12],
      [10, 8],
    ]);
    const attack = { kind: 'direct' as const },
      effects = [{ kind: 'heal' as const, amount: 100 }];
    const run = await runBattle(
      await stagedManifest({
        stages: [{ id: 'restore', offsetSteps: 0, durationSteps: 1, attack, effects }],
        ability: { target: 'self', castSteps: 0, costs: { hp: 100, mp: 0, uses: 1 } },
      }),
    );
    expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
    expect(
      battleEvents(run.records)
        .filter((e) => e.kind === 'heal')
        .map((e) => e.after?.hp),
    ).toEqual([100, 100]);
  });
});
describe('shared stage hit ledger', () => {
  it('shares emitters, consumes zero-damage contacts and requires a full separation interval', () => {
    const ledger = new HitLedger();
    const key: StageContact = {
      actionId: 'a.1',
      stageId: 'cut',
      stageIndex: 0,
      emitterId: 0,
      hitGroupId: 'shared',
    };
    const rule = { group: 'shared', maxHits: 3, minIntervalSteps: 2, requireSeparation: true };
    expect(ledger.contact(key, rule, 'right', 0).accepted).toBe(true);
    expect(ledger.contact({ ...key, emitterId: 1 }, rule, 'right', 0).reason).toBe('hit-interval');
    expect(ledger.contact(key, rule, 'right', 1).accepted).toBe(false);
    expect(ledger.contact(key, rule, 'right', 2).reason).toBe('hit-separation');
    const provisional = ledger.clone();
    expect(provisional.contact(key, rule, 'right', 4).accepted).toBe(true);
    expect(ledger.snapshot()[0]!.hits).toBe(1);
    expect(
      ledger.contact({ ...key, stageId: 'return', stageIndex: 1 }, undefined, 'right', 2).accepted,
    ).toBe(true);
  });
});
