import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { ReplayState, replayContext, type Definition } from '@fantasy/domain/spatial';
import { initializePhysics } from './physics.ts';
import { runBattle } from './run.ts';
import { prepareBattle, reference, sealRevision } from './prepare.ts';
import { assessAbility } from './assessment.ts';
import { choosePolicy } from './policy.ts';
import { emptyMemory, perceive } from './perception.ts';
import { comboStages, stagedManifest, movingSweepStages } from '../../test-support/stages.ts';
import { battleEvents, editScenario, glassWall } from '../../test-support/fixtures.ts';
import { aiFixture, initialStatus, withInitialStatus } from '../../test-support/ai.ts';

beforeAll(initializePhysics);
describe('stage interference and information boundary', () => {
  it('interrupts an unaffordable later stage while preserving paid flight in the actual interval', async () => {
    const input = await stagedManifest({ stamina: 30, steps: 11 });
    await withInitialStatus(
      input,
      0,
      initialStatus({
        modifiers: { attack: 0, defense: 0, speedBps: 10000, rooted: false, flight: true },
        flightStaminaPerSecond: 100,
      }),
    );
    const run = await runBattle(input),
      events = battleEvents(run.records);
    expect(events.find((e) => e.kind === 'stage-interrupt' && e.actorId === 'left')).toMatchObject({
      step: 10,
      reason: 'insufficient-stamina',
      stage: { stageId: 'return' },
    });
    expect(events.filter((e) => e.actorId === 'left' && e.ruleId === 'stage.cost')).toHaveLength(0);
    expect(
      events.find((e) => e.actorId === 'left' && e.step === 10 && e.ruleId === 'movement.cost'),
    ).toMatchObject({
      before: { stamina: 4 },
      after: { stamina: 2 },
      reason: 'flight; jump=false; step=false; dodge=false',
    });
    const replay = new ReplayState(
      await replayContext((await prepareBattle(input)).manifest, run.result.simulationHash),
    );
    for (const record of run.records) replay.apply(record);
    expect(replay.checkpoint().state!.actors.find((a) => a.id === 'left')!.locomotion!.mode).toBe(
      'flight',
    );
  });
  it('records melee geometry only as far as the first blocking wall', async () => {
    const input = await stagedManifest();
    await editScenario(input, (scenario) => scenario.obstacles.push(glassWall(5)));
    const { records } = await runBattle(input);
    expect(battleEvents(records).filter((e) => e.kind === 'hit')).toHaveLength(0);
    const interval = records.find((r) => r.kind === 'interval' && r.fromStep === 7)!;
    if (interval.kind !== 'interval') throw Error('Expected release interval');
    const geometry = interval.changes.find((a) => a.id === 'left')!.action!.stage!.geometry!;
    if (geometry.kind === 'blade') throw Error('Expected thrust sphere');
    expect(geometry.segments.at(-1)!.to).toBeLessThan(1);
    expect(geometry.segments.at(-1)!.end.x).toBeCloseTo(-0.205, 4);
  });
  it.each(['condition', 'incapacity'] as const)(
    'cancels future stages on %s without paying their extra cost',
    async (reason) => {
      const stages = comboStages();
      const status = await sealRevision(
        'status',
        'stage-control',
        1,
        initialStatus({
          adjustments: [{ target: 'action', operation: 'multiply', amount: 0 }],
        }),
      );
      if (reason === 'condition')
        stages[1]!.startCondition = { kind: 'resource', resource: 'hp', belowBps: 1 };
      else stages[0]!.effects.push({ kind: 'apply-status', status: reference(status) });
      const input = await stagedManifest({ stages });
      if (reason === 'incapacity') input.revisions.push(status);
      const events = battleEvents((await runBattle(input)).records);
      expect(events.filter((e) => e.kind === 'cost').map((e) => e.after?.stamina)).toEqual([
        14, 14,
      ]);
      expect(events.filter((e) => e.kind === 'stage-start').map((e) => e.stage?.stageId)).toEqual([
        'cut',
        'cut',
      ]);
      expect(
        events.filter((e) => e.kind === 'stage-interrupt').map((e) => [e.step, e.reason]),
      ).toEqual(
        reason === 'condition'
          ? [
              [10, 'start-condition'],
              [10, 'start-condition'],
            ]
          : [
              [9, 'incapacitated'],
              [9, 'incapacitated'],
            ],
      );
    },
  );
  it('keeps detached shots after boundary interruption and remains enumeration independent', async () => {
    const attack: Definition<'ability'>['attack'] = {
      kind: 'projectile',
      radiusMm: 80,
      speedMmPerSecond: 5000,
      lifetimeSteps: 80,
      gravityScaleBps: 0,
      homingTurnMilliDegreesPerSecond: 0,
      observation: 'launch-only',
      explosionRadiusMm: 0,
      maxHitsPerTarget: 1,
    };
    const effects: Definition<'ability'>['effects'] = [
      { kind: 'damage', element: 'physical', amount: 10, attackScaleBps: 0 },
    ];
    const input = await stagedManifest({
      steps: 30,
      stages: [
        { id: 'shot', offsetSteps: 0, durationSteps: 20, attack, effects, interruptOnDamage: true },
        { id: 'late', offsetSteps: 21, durationSteps: 1, attack, effects },
      ],
    });
    await withInitialStatus(
      input,
      0,
      initialStatus({ periodic: [{ kind: 'damage', amount: 6, element: 'fire', everySteps: 4 }] }),
    );
    const run = await runBattle(input),
      events = battleEvents(run.records);
    expect(events.find((e) => e.kind === 'stage-interrupt' && e.actorId === 'left')).toMatchObject({
      step: 8,
      reason: 'damage',
    });
    expect(events.filter((e) => e.kind === 'hit' && e.actorId === 'left')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'hit' && e.actorId === 'left')!.step).toBeGreaterThan(8);
    expect(events.some((e) => e.kind === 'stage-start' && e.stage?.stageId === 'late')).toBe(false);
    const reverse = structuredClone(input);
    reverse.participants.reverse();
    reverse.revisions.reverse();
    const reordered = (await runBattle(reverse)).result;
    expect(reordered).toEqual({ ...run.result, simulationHash: reordered.simulationHash });
  });
  it('consumes zero-damage contacts and pays holds without creating attack geometry', async () => {
    const stages = comboStages();
    stages[0]!.effects = [{ kind: 'damage', amount: 10, element: 'physical', attackScaleBps: 0 }];
    stages[0]!.attack = {
      kind: 'melee',
      reachMm: 2500,
      radiusMm: 200,
      activeSteps: 2,
      maxHitsPerTarget: 16,
    };
    stages[1] = {
      id: 'pause',
      offsetSteps: 3,
      durationSteps: 2,
      attack: null,
      effects: [],
      cost: { mp: 3 },
      startCondition: { kind: 'resource', resource: 'stamina', belowBps: 8000 },
    };
    const input = await stagedManifest({ stages });
    for (const index of [0, 1] as const)
      await withInitialStatus(
        input,
        index,
        initialStatus({
          modifiers: { attack: 0, defense: 100, speedBps: 10000, flight: false, rooted: false },
        }),
      );
    const events = battleEvents((await runBattle(input)).records);
    expect(events.filter((e) => e.kind === 'hit')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'diagnostic' && e.reason === 'hit-limit')).toHaveLength(
      2,
    );
    expect(
      events
        .filter((e) => e.kind === 'cost' && e.stage?.stageId === 'pause')
        .map((e) => e.before!.mp - e.after!.mp),
    ).toEqual([3, 3]);
    expect(events.filter((e) => e.kind === 'launch' && e.stage)).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'damage').every((e) => e.amount === 0)).toBe(true);
  });
  it('estimates own future timing and affordability while delayed cues omit private stage plans', async () => {
    const stages = comboStages();
    const f = await aiFixture({
      abilities: [
        {
          stages,
          attack: stages[0]!.attack!,
          effects: stages[0]!.effects,
          costs: { hp: 0, mp: 0, stamina: 6, uses: 1 },
          castSteps: 2,
          recoverySteps: 4,
        },
      ],
      character: { stamina: { max: 20, recoveryPerSecond: 0 } },
    });
    try {
      const view = { ...f.view, resources: { ...f.view.resources, stamina: 20 } },
        ability = f.abilities[0]!;
      expect(assessAbility(view, ability)).toMatchObject({ durationSteps: 11 });
      expect(assessAbility(view, ability).reason).toContain('2 presently affordable');
      expect(
        assessAbility({ ...view, resources: { ...view.resources, stamina: 8 } }, ability).reason,
      ).toContain('1 presently affordable');
      const visible = {
        resources: { hp: 100, mp: 7, shield: 0 },
        action: 'active' as const,
        stage: {
          shape: 'melee' as const,
          state: 'active' as const,
          motion: 'dash' as const,
          futureCost: 999,
          abilityId: 'private-plan',
        },
      };
      const sampled = perceive(f.world, f.self, f.enemy, [], 0, emptyMemory(), visible);
      expect(sampled.observation).toBeNull();
      const memory = perceive(f.world, f.self, f.enemy, [], 5, sampled, visible);
      expect(memory.observation!.enemy!.stage).toEqual({
        shape: 'melee',
        state: 'active',
        motion: 'dash',
      });
      const delayed = { ...view, memory },
        ready = new Set([ability.id]);
      const before = choosePolicy(delayed, ready, false);
      f.enemy.position.x = 999;
      visible.stage.futureCost = 1;
      expect(choosePolicy(delayed, ready, false)).toEqual(before);
      expect(before.cognition?.observedStage).toEqual({
        shape: 'melee',
        state: 'active',
        motion: 'dash',
      });
    } finally {
      f.world.free();
    }
  });
  it('estimates own blade coverage, force duration and motion exposure without enemy definition access', async () => {
    const stages = movingSweepStages(),
      first = stages[0]!;
    const f = await aiFixture({
      abilities: [
        {
          stages,
          attack: first.attack!,
          effects: first.effects,
          costs: { hp: 0, mp: 0, stamina: 6, uses: 0 },
        },
      ],
      character: { stamina: { max: 20, recoveryPerSecond: 0 } },
    });
    try {
      const view = { ...f.view, resources: { ...f.view.resources, stamina: 20 } };
      const distant = assessAbility(view, f.abilities[0]!);
      const memory = {
        ...view.memory,
        observation: {
          ...view.memory.observation!,
          enemy: {
            ...view.memory.observation!.enemy!,
            position: { ...f.self.position, x: f.self.position.x + 1 },
          },
        },
      };
      const near = assessAbility({ ...view, memory }, f.abilities[0]!);
      expect(near.weight).toBeGreaterThan(distant.weight);
      expect(near.successBps).toBeGreaterThan(distant.successBps);
      expect(near.reason).toContain('own shape/coverage and motion');
      f.enemy.position.x = -999;
      expect(assessAbility({ ...view, memory }, f.abilities[0]!)).toEqual(near);
      const forceOnly = {
        ...f.abilities[0]!,
        definition: {
          ...f.abilities[0]!.definition,
          stages: undefined,
          effects: first.effects.filter((e) => e.kind === 'force'),
          attack: { kind: 'hitscan' as const, radiusMm: 0 },
        },
      };
      expect(assessAbility({ ...view, memory }, forceOnly).reason).toContain('away force 2 steps');
      expect(assessAbility({ ...view, memory }, forceOnly).weight).toBeGreaterThan(0);
    } finally {
      f.world.free();
    }
  });
});
