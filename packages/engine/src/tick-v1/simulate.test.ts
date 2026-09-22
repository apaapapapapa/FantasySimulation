import { describe, expect, it } from 'vite-plus/test';
import {
  canonicalJson,
  createRevision,
  sha256Text,
  TickReportSchema,
  type Slot,
  type TickEvent,
  type TickOutcome,
} from '@fantasy/domain/tick-v1';
import { damage, matchup, participant } from '../../fixtures/tick-v1/cases.ts';
import golden from '../../fixtures/tick-v1/golden.json';
import {
  createTickManifest,
  DEFAULT_TICK_BUDGET,
  prepareTickBattle,
  simulateTickBattle,
} from './index.ts';
import { characterRandomState, nextRandomState, sampleBps } from './random.ts';

const wait = { kind: 'wait' } as const;
const eventsOf = <K extends TickEvent['kind']>(events: TickEvent[], kind: K) =>
  events.filter((event): event is Extract<TickEvent, { kind: K }> => event.kind === kind);

describe('tick-v1 golden replays', () => {
  for (const fixture of golden) {
    it(`replays ${fixture.name} with committed result and event hashes`, async () => {
      const snapshot = structuredClone(fixture.manifest);
      const result = await simulateTickBattle(fixture.manifest);
      expect(result).toMatchObject(fixture.expected);
      expect(TickReportSchema.parse(result)).toEqual(result);
      expect(await simulateTickBattle(fixture.manifest)).toEqual(result);
      expect(fixture.manifest).toEqual(snapshot);
      expect(Object.isFrozen(fixture.manifest)).toBe(false);
      expect(result.eventsHash).toBe(
        await sha256Text(`[${result.events.map((event) => canonicalJson(event)).join(',')}]`),
      );
    });
  }
});

describe('simultaneous integer-tick rules', () => {
  it('commits both lethal actions at tick zero and does not reward enumeration order', async () => {
    const result = await simulateTickBattle(
      await matchup(await participant('a', [damage(100)]), await participant('b', [damage(100)])),
    );
    expect(result.outcome).toEqual({ kind: 'draw', reason: 'simultaneous-defeat' });
    expect(result.tick).toBe(0);
    expect(eventsOf(result.events, 'damage')).toHaveLength(2);
  });

  it('aggregates healing and incoming damage before clamping HP', async () => {
    const left = await participant('healer', [{ kind: 'heal', amount: 20 }]);
    const right = await participant('attacker', [damage(30)]);
    const result = await simulateTickBattle(await matchup(left, right, { maxTick: 0 }));
    expect(result.finalState.left.hp).toBe(90); // clamp(100 + 20 - 30), not clamp(100 + 20) - 30
    const saved = await simulateTickBattle(
      await matchup(left, right, { maxTick: 0, leftState: { hp: 15 } }),
    );
    expect(saved.finalState.left.hp).toBe(5);
    expect(saved.outcome.kind).toBe('draw');
    const capped = await simulateTickBattle(
      await matchup(left, await participant('idle', [wait]), { maxTick: 0 }),
    );
    expect(capped.finalState.left.hp).toBe(100);
  });

  it('applies defense, floored resistance, shield and HP in that order', async () => {
    const attacker = await participant('a', [damage(10)], { stats: { attack: 20 } });
    const defender = await participant('b', [wait], {
      stats: { defense: 3, resistanceBps: { physical: 2_500, magical: 10_000 } },
    });
    const result = await simulateTickBattle(
      await matchup(attacker, defender, { maxTick: 0, rightState: { shield: 12 } }),
    );
    expect(eventsOf(result.events, 'damage')[0]).toMatchObject({
      baseDamage: 27,
      afterResistance: 20,
      absorbedByShield: 12,
      damageToHp: 8,
    });
    expect(result.finalState.right).toMatchObject({ hp: 92, shield: 0 });
  });

  it('uses the effect damage type and never lets excessive defense create healing', async () => {
    const defender = await participant('b', [wait], {
      stats: { defense: 5, resistanceBps: { physical: 0, magical: 10_000 } },
    });
    const magic = {
      kind: 'damage',
      power: 20,
      damageType: 'magical',
      accuracyBps: 10_000,
      aim: 'roll',
    } as const;
    const result = await simulateTickBattle(
      await matchup(await participant('a', [damage(2), magic]), defender, { maxTick: 1 }),
    );
    expect(eventsOf(result.events, 'damage').map((event) => event.damageToHp)).toEqual([0, 0]);
    expect(result.finalState.right.hp).toBe(100);
  });

  it('pays self-cost before effects, lets committed actions fire and resolves death after the batch', async () => {
    const costly = await participant('a', [damage(100)], { cost: { hp: 100, mp: 10 } });
    const result = await simulateTickBattle(await matchup(costly, await participant('b', [wait])));
    expect(result.outcome).toEqual({ kind: 'draw', reason: 'simultaneous-defeat' });
    expect(result.finalState.left.mp).toBe(0);
    const healed = await participant('a', [{ kind: 'heal', amount: 20 }], {
      cost: { hp: 100, mp: 0 },
    });
    const revived = await simulateTickBattle(
      await matchup(healed, await participant('b', [wait]), { maxTick: 0 }),
    );
    expect(revived.finalState.left.hp).toBe(20);
    const selfDefeat = await simulateTickBattle(
      await matchup(
        await participant('a', [wait], { cost: { hp: 100, mp: 0 } }),
        await participant('b', [wait]),
      ),
    );
    expect(selfDefeat.outcome).toEqual({ kind: 'win', winner: 'right', reason: 'defeat' });
  });

  it('fizzles without partial costs or random consumption and still advances the cycle and recovery', async () => {
    const costly = await participant('a', [damage(100), wait], { cost: { hp: 3, mp: 11 } });
    const result = await simulateTickBattle(
      await matchup(costly, await participant('b', [wait]), { maxTick: 1 }),
    );
    const actions = eventsOf(result.events, 'action').filter((event) => event.actor === 'left');
    expect(
      actions.map((event) => [event.tick, event.effectKind, event.fizzleReason, event.paidCost]),
    ).toEqual([
      [0, 'damage', 'insufficient-mp', { hp: 0, mp: 0 }],
      [1, 'wait', 'insufficient-mp', { hp: 0, mp: 0 }],
    ]);
    expect(eventsOf(result.events, 'damage')).toHaveLength(0);
    expect(result.finalState.left).toMatchObject({ hp: 100, mp: 10 });
    const hp = await simulateTickBattle(
      await matchup(
        await participant('a', [damage()], { cost: { hp: 101, mp: 0 } }),
        await participant('b', [wait]),
        { maxTick: 0 },
      ),
    );
    expect(eventsOf(hp.events, 'action')[0]?.fizzleReason).toBe('insufficient-hp');
  });

  it('processes the time-limit tick inclusively, before choosing a draw', async () => {
    const a = await participant('a', [damage(50)], { stats: { speed: 50 } });
    const b = await participant('b', [wait]);
    const win = await simulateTickBattle(await matchup(a, b, { maxTick: 2 }));
    expect(win.outcome).toEqual({ kind: 'win', winner: 'left', reason: 'defeat' });
    expect(eventsOf(win.events, 'damage').map((event) => event.tick)).toEqual([0, 2]);
    const draw = await simulateTickBattle(await matchup(a, b, { maxTick: 1 }));
    expect(draw.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
  });

  it('bounds zero and extreme speed and jumps across empty ticks', async () => {
    const slow = await participant('a', [wait], { stats: { speed: 0 }, recoveryTicks: 10_000 });
    const result = await simulateTickBattle(
      await matchup(
        slow,
        await participant('b', [wait], { stats: { speed: 0 }, recoveryTicks: 10_000 }),
        { maxTick: 999_999 },
      ),
    );
    expect(result.processedTicks).toBe(1);
    expect(result.tick).toBe(999_999);
    expect(eventsOf(result.events, 'action')[0]?.nextActionTick).toBe(1_000_000);
    const fast = await simulateTickBattle(
      await matchup(
        await participant('a', [wait], { stats: { speed: 10_000 } }),
        await participant('b', [wait]),
        { maxTick: 2 },
      ),
    );
    expect(
      eventsOf(fast.events, 'action')
        .filter((event) => event.actor === 'left')
        .map((event) => event.tick),
    ).toEqual([0, 1, 2]);
  });

  it('keeps extreme legal intermediate arithmetic within exact integers', async () => {
    const result = await simulateTickBattle(
      await matchup(
        await participant('a', [damage(10_000)], { stats: { attack: 10_000 } }),
        await participant('b', [{ kind: 'heal', amount: 1_000_000 }], {
          stats: { maxHp: 1_000_000 },
        }),
        { maxTick: 0, rightState: { shield: 1_000_000 } },
      ),
    );
    expect(eventsOf(result.events, 'damage')[0]).toMatchObject({
      baseDamage: 20_000,
      afterResistance: 20_000,
      absorbedByShield: 20_000,
    });
    expect(result.finalState.right).toMatchObject({ hp: 1_000_000, shield: 980_000 });
    expect(TickReportSchema.safeParse(result).success).toBe(true);
  });
});

describe('accuracy and deterministic random streams', () => {
  it('matches the published xorshift32 shift recurrence vector', () => {
    let state = 1;
    const values = [];
    for (let index = 0; index < 5; index++) {
      state = nextRandomState(state);
      values.push(state);
    }
    expect(values).toEqual([270369, 67634689, 2647435461, 307599695, 2398689233]);
    expect(sampleBps(1)).toEqual({ state: 270369, value: 368 });
    // The first raw value is UINT32_MAX and must be rejected, not reduced modulo 10,000.
    expect(nextRandomState(1584200935)).toBe(0xffff_ffff);
    expect(sampleBps(1584200935)).toEqual({ state: 253983, value: 3982 });
    expect(() => sampleBps(0)).toThrow(/Too small/);
  });

  it('consumes samples for forced damage but not wait, healing or failed resource checks', async () => {
    const forced = {
      kind: 'damage',
      power: 0,
      damageType: 'physical',
      accuracyBps: 0,
      aim: 'certain-hit',
    } as const;
    const b = await participant('b', [wait]);
    for (const firstEffect of [wait, { kind: 'heal', amount: 1 } as const, forced]) {
      const a = await participant('a', [firstEffect, damage(0)]);
      const state = await characterRandomState(42, a.character.contentHash);
      const first = sampleBps(state);
      const result = await simulateTickBattle(await matchup(a, b, { maxTick: 1 }));
      const rolls = eventsOf(result.events, 'damage').map((event) => event.roll);
      expect(rolls).toEqual(
        firstEffect.kind === 'damage' ? [first.value, sampleBps(first.state).value] : [first.value],
      );
    }
    const a = await participant('a', [damage(0), damage(0)]);
    const costly = a.abilities[0]!;
    a.abilities[0] = await createRevision(costly.revisionId, {
      ...costly.definition,
      cost: { hp: 0, mp: 11 },
    });
    const result = await simulateTickBattle(await matchup(a, b, { maxTick: 1 }));
    const expected = sampleBps(await characterRandomState(42, a.character.contentHash));
    expect(eventsOf(result.events, 'damage').map((event) => [event.tick, event.roll])).toEqual([
      [1, expected.value],
    ]);
  });

  it('defines the accuracy endpoints and forced hit/miss cases', async () => {
    const miss = await simulateTickBattle(
      await matchup(await participant('a', [damage(100, 0)]), await participant('b', [wait]), {
        maxTick: 0,
      }),
    );
    expect(eventsOf(miss.events, 'damage')[0]?.hit).toBe(false);
    const evade = await participant('b', [wait], { stats: { avoidance: 'certain-evade' } });
    const evaded = await simulateTickBattle(
      await matchup(await participant('a', [damage(100)]), evade, { maxTick: 0 }),
    );
    expect(eventsOf(evaded.events, 'damage')[0]?.hit).toBe(false);
    const forced = await participant('a', [
      { kind: 'damage', power: 100, damageType: 'physical', accuracyBps: 0, aim: 'certain-hit' },
    ]);
    const hit = await simulateTickBattle(await matchup(forced, await participant('b', [wait])));
    expect(hit.outcome.kind).toBe('win');
  });

  it('reports an actual missing interaction without committing that tick, but ignores fizzled conflicts', async () => {
    const effect = {
      kind: 'damage',
      power: 100,
      damageType: 'physical',
      accuracyBps: 10_000,
      aim: 'certain-hit',
    } as const;
    const evade = await participant('b', [wait], { stats: { avoidance: 'certain-evade' } });
    const clash = await simulateTickBattle(
      await matchup(await participant('a', [effect], { cost: { hp: 2, mp: 1 } }), evade),
    );
    expect(clash.outcome).toMatchObject({
      kind: 'unresolved',
      diagnostics: [
        {
          ruleId: 'accuracy.certain-hit-vs-certain-evade',
          actor: 'left',
          target: 'right',
          tick: 0,
        },
      ],
    });
    expect(clash.events).toHaveLength(1);
    expect(clash.finalState.left).toMatchObject({ hp: 100, mp: 10 });
    const fizzled = await simulateTickBattle(
      await matchup(await participant('a', [effect], { cost: { hp: 0, mp: 11 } }), evade, {
        maxTick: 0,
      }),
    );
    expect(fizzled.outcome.kind).toBe('draw');
  });

  it('preserves each character stream when swapping character, slot and starting state', async () => {
    const a = await participant('a', [damage(23, 5_000)]);
    const b = await participant('b', [damage(31, 6_000)], { stats: { speed: 50 } });
    const swap = (slot: Slot): Slot => (slot === 'left' ? 'right' : 'left');
    const swappedOutcome = (outcome: TickOutcome) =>
      outcome.kind === 'win' ? { ...outcome, winner: swap(outcome.winner) } : outcome;
    for (const seed of [1, 2, 42, 0xffff_ffff]) {
      const forward = await simulateTickBattle(
        await matchup(a, b, { seed, leftState: { position: -5 }, rightState: { position: 20 } }),
      );
      const reverse = await simulateTickBattle(
        await matchup(b, a, { seed, leftState: { position: 20 }, rightState: { position: -5 } }),
      );
      expect(forward.outcome).toEqual(swappedOutcome(reverse.outcome));
      expect(forward.finalState.left).toEqual(reverse.finalState.right);
      expect(forward.finalState.right).toEqual(reverse.finalState.left);
      expect(forward.simulationHash).not.toBe(reverse.simulationHash);
      for (const actor of ['left', 'right'] as const) {
        const rolls = (events: TickEvent[], slot: Slot) =>
          eventsOf(events, 'damage')
            .filter((event) => event.actor === slot)
            .map((event) => [event.tick, event.roll, event.hit]);
        expect(rolls(forward.events, actor)).toEqual(rolls(reverse.events, swap(actor)));
      }
    }
  });
});

describe('budgets and identity', () => {
  async function manifest() {
    return matchup(await participant('a', [damage(60)]), await participant('b', [wait]), {
      maxTick: 2,
    });
  }

  it('truncates before an entire batch and retries with the same simulationHash', async () => {
    const input = await manifest();
    const limited = await simulateTickBattle(input, { ...DEFAULT_TICK_BUDGET, maxEvents: 5 });
    expect(limited.outcome).toMatchObject({
      kind: 'truncated',
      reason: 'event-budget',
      pendingTick: 0,
      required: 6,
    });
    expect(limited.events).toHaveLength(1);
    expect(limited.finalState).toEqual(input.scenario.definition.initialState);
    const complete = await simulateTickBattle(input);
    expect(complete.outcome.kind).toBe('win');
    expect(complete.simulationHash).toBe(limited.simulationHash);
    expect(complete.resultHash).not.toBe(limited.resultHash);
    const larger = await simulateTickBattle(input, { ...DEFAULT_TICK_BUDGET, maxEvents: 100 });
    expect(larger.resultHash).toBe(complete.resultHash);
    expect(larger.eventsHash).toBe(complete.eventsHash);
  });

  it('distinguishes processed tick budget from the game deadline and supports zero budgets', async () => {
    const input = await manifest();
    const limited = await simulateTickBattle(input, { ...DEFAULT_TICK_BUDGET, maxTicks: 1 });
    expect(limited.outcome).toMatchObject({
      kind: 'truncated',
      reason: 'tick-budget',
      pendingTick: 1,
    });
    expect(limited.finalState.right.hp).toBe(40);
    const zero = await simulateTickBattle(input, { ...DEFAULT_TICK_BUDGET, maxEvents: 0 });
    expect(zero.events).toEqual([]);
    expect(zero.outcome.kind).toBe('truncated');
    const noTicks = await simulateTickBattle(input, { ...DEFAULT_TICK_BUDGET, maxTicks: 0 });
    expect(noTicks.events).toHaveLength(1);
    expect(noTicks.processedTicks).toBe(0);
  });

  it('counts canonical UTF-8 bytes including array punctuation and reserves batches atomically', async () => {
    const input = await manifest();
    const full = await simulateTickBattle(input);
    const size = new TextEncoder().encode(canonicalJson(full.events)).byteLength;
    const exact = await simulateTickBattle(input, { ...DEFAULT_TICK_BUDGET, maxLogBytes: size });
    expect(exact.resultHash).toBe(full.resultHash);
    const short = await simulateTickBattle(input, {
      ...DEFAULT_TICK_BUDGET,
      maxLogBytes: size - 1,
    });
    expect(short.outcome).toMatchObject({
      kind: 'truncated',
      reason: 'log-byte-budget',
      pendingTick: 1,
      required: size,
    });
    expect(short.finalState.right.hp).toBe(40);
    const empty = await simulateTickBattle(input, { ...DEFAULT_TICK_BUDGET, maxLogBytes: 2 });
    expect(empty.events).toEqual([]);
    expect(empty.finalState).toEqual(input.scenario.definition.initialState);
  });

  it('binds seed, game deadline, position, priority and engine identity into the manifest', async () => {
    const original = await manifest();
    const base = await prepareTickBattle(original);
    const changed = structuredClone(original);
    changed.random.seed++;
    expect((await prepareTickBattle(changed)).simulationHash).not.toBe(base.simulationHash);
    for (const field of ['maxTick', 'position'] as const) {
      const definition = structuredClone(original.scenario.definition);
      if (field === 'maxTick') definition.maxTick++;
      else definition.initialState.left.position++;
      const scenario = await createRevision(original.scenario.revisionId, definition);
      expect((await prepareTickBattle({ ...original, scenario })).simulationHash).not.toBe(
        base.simulationHash,
      );
    }
    await expect(
      simulateTickBattle({
        ...original,
        engine: { ...original.engine, implementationDigest: `sha256:${'0'.repeat(64)}` },
      }),
    ).rejects.toThrow('digest mismatch');
    await expect(
      simulateTickBattle(original, { ...DEFAULT_TICK_BUDGET, maxTicks: -1 }),
    ).rejects.toThrow(/maxTicks/);
    const a = await participant('cycle', [damage(), { kind: 'heal', amount: 5 }]);
    const multi = await matchup(a, original.participants.right);
    const order = {
      ...a.strategy.definition,
      abilityRevisionIds: [...a.strategy.definition.abilityRevisionIds].reverse(),
    };
    const strategy = await createRevision(a.strategy.revisionId, order);
    const reordered = await createTickManifest({
      participants: { left: { ...a, strategy }, right: original.participants.right },
      rules: multi.rules,
      scenario: multi.scenario,
      seed: multi.random.seed,
    });
    expect((await prepareTickBattle(multi)).simulationHash).not.toBe(
      (await prepareTickBattle(reordered)).simulationHash,
    );
    const shuffled = structuredClone(multi);
    shuffled.participants.left.abilities.reverse();
    expect(await simulateTickBattle(shuffled)).toEqual(await simulateTickBattle(multi));
  });
});
