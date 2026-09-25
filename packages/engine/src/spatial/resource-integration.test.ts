import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { StreamRecordSchema } from '@fantasy/domain/spatial';
import { combatManifest, battleEvents } from '../../test-support/fixtures.ts';
import { aiFixture } from '../../test-support/ai.ts';
import { runBattle } from './run.ts';
import { choosePolicy } from './ai/policy.ts';
import { emptyMemory, perceive } from './ai/perception.ts';
import { conditionMatches } from './rules/conditions.ts';
import { initializePhysics } from './world/physics.ts';

beforeAll(initializePhysics);

describe('stamina in the real battle and own-resource AI', () => {
  it('keeps enemy stamina out of observation and decisions when visible motion and appearance match', async () => {
    const f = await aiFixture();
    try {
      const observe = (stamina: number) => {
        let memory = emptyMemory();
        for (const step of [0, 5])
          memory = perceive(f.world, f.self, f.enemy, [], step, memory, {
            resources: { hp: f.enemy.actor.character.stats.hp, mp: 0, shield: 0, stamina },
            action: 'idle',
          });
        return memory;
      };
      const empty = observe(0),
        full = observe(1000000);
      expect(empty.observation?.enemy?.id).toBe('right');
      expect(empty).toEqual(full);
      const ready = new Set(f.abilities.map((a) => a.id));
      expect(choosePolicy({ ...f.view, memory: empty }, ready, false)).toEqual(
        choosePolicy({ ...f.view, memory: full }, ready, false),
      );
    } finally {
      f.world.free();
    }
  });
  it('rejects the entire real startup group when aggregate stamina exceeds the maximum', async () => {
    const f = await aiFixture({
      steps: 2,
      character: { stamina: { max: 10, recoveryPerSecond: 1 } },
      abilities: [1, 2].map((n) => ({
        name: `startup-${n}`,
        trigger: 'battle-start',
        target: 'self',
        attack: { kind: 'direct' },
        castSteps: 0,
        costs: { hp: 1, mp: 0, stamina: 6, uses: 1 },
        effects: [{ kind: 'shield', amount: 20 }],
      })),
    });
    try {
      const run = await runBattle(f.manifest),
        events = battleEvents(run.records);
      expect(
        events.filter((e) => e.kind === 'fizzle' && e.ruleId === 'startup.cost-group'),
      ).toHaveLength(4);
      expect(events.some((e) => e.kind === 'cost' || e.kind === 'shield')).toBe(false);
    } finally {
      f.world.free();
    }
  });
  it('pays startup once, recovers while waiting, logs and stores the final interval', async () => {
    const manifest = await combatManifest(50, {
      character: { stamina: { max: 10, recoveryPerSecond: 3 } },
      ability: {
        trigger: 'battle-start',
        target: 'self',
        attack: { kind: 'direct' },
        castSteps: 0,
        costs: { hp: 0, mp: 0, stamina: 8, uses: 1 },
        effects: [{ kind: 'shield', amount: 1 }],
      },
      policy: { movement: 'hold', priorities: [] },
    });
    const run = await runBattle(manifest);
    for (const record of run.records)
      expect(StreamRecordSchema.safeParse(record).success).toBe(true);
    const events = battleEvents(run.records),
      paid = events.filter((e) => e.ruleId === 'startup.cost-group');
    expect(paid).toHaveLength(2);
    expect(paid.map((e) => [e.before?.stamina, e.after?.stamina])).toEqual([
      [10, 2],
      [10, 2],
    ]);
    const recovery = events.filter(
      (e) => e.ruleId === 'resource.stamina-recovery' && e.actorId === 'left',
    );
    expect(recovery.map((e) => [e.step, e.before?.stamina, e.after?.stamina])).toEqual([
      [17, 2, 3],
      [34, 3, 4],
      [50, 4, 5],
    ]);
    expect(run.result.steps).toBe(50);
  });
  it('starts paid skills again after exhaustion recovery without double payment or leaking a new legacy field', async () => {
    const input = await combatManifest(50, {
      character: { stamina: { max: 4, recoveryPerSecond: 10, resumeAt: 3 } },
      ability: {
        target: 'self',
        attack: { kind: 'direct' },
        castSteps: 0,
        recoverySteps: 1,
        cooldownSteps: 0,
        costs: { hp: 0, mp: 0, stamina: 4, uses: 2 },
        effects: [{ kind: 'shield', amount: 1 }],
      },
      policy: { movement: 'hold' },
    });
    const run = await runBattle(input),
      events = battleEvents(run.records);
    const payments = events.filter((e) => e.ruleId === 'action.cost' && e.actorId === 'left');
    expect(payments.map((e) => [e.step, e.before?.stamina, e.after?.stamina])).toEqual([
      [0, 4, 0],
      [20, 4, 0],
    ]);
    const old = await runBattle(await combatManifest(2, { policy: { movement: 'hold' } }));
    expect(JSON.stringify(old.records)).not.toContain('stamina');
  });
  it('excludes unaffordable own actions, evaluates stamina conditions, and prices the same skill higher at low stamina', async () => {
    const f = await aiFixture({
      character: { stamina: { max: 20, recoveryPerSecond: 2 } },
      abilities: [
        {
          target: 'self',
          attack: { kind: 'direct' },
          costs: { hp: 0, mp: 0, stamina: 6, uses: 0 },
          effects: [{ kind: 'shield', amount: 10 }],
        },
      ],
    });
    try {
      const ready = new Set(f.abilities.map((a) => a.id));
      const choose = (stamina: number) =>
        choosePolicy({ ...f.view, resources: { ...f.view.resources, stamina } }, ready, false)
          .cognition!;
      expect(choose(5).excluded).toContainEqual({
        abilityId: 'choice-0',
        reason: 'insufficient-stamina',
      });
      expect(choose(6).candidates[0]!.costBps).toBeGreaterThan(choose(20).candidates[0]!.costBps);
      expect(
        conditionMatches(
          { kind: 'resource', resource: 'stamina', belowBps: 5000 },
          { ...f.view, resources: { ...f.view.resources, stamina: 9 } },
        ),
      ).toBe(true);
      expect(
        choosePolicy(
          { ...f.view, resources: { ...f.view.resources, stamina: 10 }, staminaExhausted: true },
          ready,
          false,
        ).abilityId,
      ).toBeNull();
    } finally {
      f.world.free();
    }
  });
});
