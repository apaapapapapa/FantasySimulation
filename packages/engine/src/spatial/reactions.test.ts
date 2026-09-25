import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_BUDGET,
  AbilitySchema,
  ReplayState,
  type Definition,
} from '@fantasy/domain/spatial';
import { initializePhysics } from './world/physics.ts';
import { runBattle } from './run.ts';
import { reactionManifest } from '../../test-support/reactions.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { ReactionBudget } from './sim/reactions.ts';

beforeAll(initializePhysics);
const counter: Partial<Definition<'ability'>> = {
  trigger: 'after-damage',
  target: 'enemy',
  rangeMm: 20000,
  attack: { kind: 'hitscan', radiusMm: 0 },
  reaction: { response: { kind: 'counter' } },
  effects: [{ kind: 'damage', amount: 10, attackScaleBps: 0, element: 'physical' }],
};
describe('transactional reaction activations', () => {
  it('records a wide counter sweep center separately from its contact surface', async () => {
    const input = await reactionManifest({
      attack: { attack: { kind: 'hitscan', radiusMm: 20 } },
      reactions: [
        {
          ...counter,
          rangeMm: 999,
          attack: { kind: 'hitscan', radiusMm: 1000 },
          costs: { hp: 0, mp: 0, uses: 1 },
        },
      ],
    });
    input.participants[0].position = { x: -400, y: 8000, z: 0 };
    input.participants[1].position = { x: 400, y: 8000, z: 0 };
    const full = await runBattle(input);
    expect(
      battleEvents(full.records).filter(
        (e) => e.ruleId === 'reaction.first-contact' && e.kind === 'hit',
      ),
    ).toHaveLength(2);
    await recordedCheckpoints(input, full);
  });
  it('consumes a staged contact ledger even when the first hit is fully parried', async () => {
    const attack: Definition<'ability'>['attack'] = {
      kind: 'melee',
      reachMm: 2000,
      radiusMm: 200,
      activeSteps: 3,
      maxHitsPerTarget: 16,
    };
    const effects: Definition<'ability'>['effects'] = [
      { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'physical' },
    ];
    const input = await reactionManifest({
      reactions: [{ costs: { hp: 0, mp: 1, uses: 1 } }],
      attack: {
        attack,
        effects,
        stages: [{ id: 'parried-cut', offsetSteps: 0, durationSteps: 3, attack, effects }],
      },
    });
    input.participants[0].position.x = -750;
    input.participants[1].position.x = 750;
    const full = await runBattle(input),
      events = battleEvents(full.records);
    expect(events.filter((e) => e.ruleId === 'reaction.activated')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'damage')).toHaveLength(0);
    await recordedCheckpoints(input, full);
  });
  it('keeps reaction events and state hashes invariant under input enumeration', async () => {
    const input = await reactionManifest({
      reactions: [{ ...counter, costs: { hp: 0, mp: 0, uses: 1 } }],
    });
    const first = await runBattle(input);
    input.participants.reverse();
    input.revisions.reverse();
    const second = await runBattle(input);
    const { simulationHash: firstInput, ...firstResult } = first.result;
    const { simulationHash: secondInput, ...secondResult } = second.result;
    expect(secondInput).not.toBe(firstInput);
    expect(secondResult).toEqual(firstResult);
    expect(second.records).toEqual(first.records);
  });
  it('parries a whole contact once, cancels all payloads and records actual costs', async () => {
    const input = await reactionManifest({
      reactions: [{ costs: { hp: 0, mp: 3, uses: 1 } }],
      attack: {
        effects: [
          { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'fire' },
          {
            kind: 'force',
            profile: 'linear-v1',
            direction: 'away',
            speedMmPerSecond: 500,
            durationSteps: 2,
          },
        ],
      },
    });
    const full = await runBattle(input);
    const events = battleEvents(full.records);
    expect(events.filter((e) => e.ruleId === 'reaction.activated')).toHaveLength(2);
    expect(events.filter((e) => e.kind === 'damage' || e.kind === 'force')).toHaveLength(0);
    expect(
      events
        .filter((e) => e.ruleId === 'reaction.cost-group')
        .map((e) => e.before!.mp - e.after!.mp),
    ).toEqual([3, 3]);
    expect(full.result.stats.reactionAttempts).toBe(2);
    await recordedCheckpoints(input, full);
  });
  it('damage-only parry keeps the nondamage contact and zero exact damage attribution', async () => {
    const input = await reactionManifest({
      reactions: [{ reaction: { response: { kind: 'parry', scope: 'damage' } } }],
      attack: {
        effects: [
          { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'water' },
          {
            kind: 'force',
            profile: 'linear-v1',
            direction: 'away',
            speedMmPerSecond: 500,
            durationSteps: 2,
          },
        ],
      },
    });
    const full = await runBattle(input),
      events = battleEvents(full.records);
    expect(events.filter((e) => e.kind === 'force')).toHaveLength(2);
    expect(
      events.filter((e) => e.kind === 'damage').map((e) => [e.amount, e.damage!.toHp]),
    ).toEqual([
      [0, { numerator: '0', denominator: '1' }],
      [0, { numerator: '0', denominator: '1' }],
    ]);
    await recordedCheckpoints(input, full);
  });
  it('reserves all eligible owner reactions together without partial payment', async () => {
    const input = await reactionManifest({
      reactions: [
        { costs: { hp: 0, mp: 600000, uses: 0 } },
        { costs: { hp: 0, mp: 600000, uses: 0 } },
      ],
    });
    const full = await runBattle(input),
      events = battleEvents(full.records);
    expect(events.some((e) => e.ruleId === 'reaction.activated')).toBe(false);
    expect(
      events.filter((e) => e.ruleId === 'reaction.cost-group').every((e) => e.kind === 'fizzle'),
    ).toBe(true);
    expect(full.result.stats.reactionAttempts).toBe(0);
    expect(events.filter((e) => e.kind === 'damage').every((e) => e.amount! > 0)).toBe(true);
  });
  it('releases a paid counter at the next commit boundary, alongside the main slot', async () => {
    const input = await reactionManifest({
      reactions: [{ ...counter, costs: { hp: 0, mp: 3, uses: 1 } }],
    });
    const full = await runBattle(input),
      events = battleEvents(full.records);
    const active = events.filter((e) => e.ruleId === 'reaction.activated');
    const released = events.filter((e) => e.ruleId === 'reaction.release');
    expect(active).toHaveLength(2);
    expect(released).toHaveLength(2);
    expect(released.map((e) => [e.step, e.parentEventId])).toEqual(
      active.map((e) => [e.step, e.id]),
    );
    expect(events.filter((e) => e.ruleId === 'reaction.cost-group')).toHaveLength(2);
    const { context, checkpoints } = await recordedCheckpoints(input, full);
    expect(
      checkpoints.some((c) =>
        c.state!.actors.some((a) => a.reactions?.some((r) => r.state === 'queued')),
      ),
    ).toBe(true);
    expect(
      checkpoints.some((c) =>
        c.state!.actors.some((a) =>
          a.reactions?.some((r) => r.state === 'released' && r.geometry?.kind === 'ray'),
        ),
      ),
    ).toBe(true);
    for (const checkpoint of [...checkpoints].reverse()) {
      const replay = new ReplayState(context, checkpoint);
      for (const record of full.records.slice(checkpoint.nextRecord)) replay.apply(record);
      expect(replay.checkpoint()).toEqual(checkpoints.at(-1));
    }
  });
  it('counts ancestry across intervals and rolls back the entire overflowing interval', async () => {
    const input = await reactionManifest({ reactions: [counter], rightAttack: false });
    const full = await runBattle(input, { ...DEFAULT_BUDGET, maxReactionDepth: 2 });
    expect(full.result.outcome.kind).toBe('truncated');
    if (full.result.outcome.kind === 'truncated') {
      expect(full.result.outcome.resource).toBe('reaction-depth');
      expect(full.result.outcome.reason).toContain('observed=3, limit=2');
    }
    expect(
      battleEvents(full.records)
        .filter((e) => e.ruleId === 'reaction.activated')
        .map((e) => e.reaction!.depth),
    ).toEqual([1, 2]);
    expect(full.result.stats.reactionAttempts).toBe(3);
    await recordedCheckpoints(input, full);
  });
  it('checks eligible transaction and match ceilings, while exhausted uses simply stop', async () => {
    for (const limit of [{ maxReactionsPerTransaction: 1 }, { maxReactionsPerMatch: 1 }]) {
      const input = await reactionManifest({ reactions: [{}] });
      const full = await runBattle(input, { ...DEFAULT_BUDGET, ...limit });
      expect(full.result.outcome.kind).toBe('truncated');
      expect(battleEvents(full.records).some((e) => e.ruleId === 'reaction.activated')).toBe(false);
      expect(full.result.stats.reactionAttempts).toBe(2);
    }
    const work = { attempts: 0 },
      budget = new ReactionBudget(DEFAULT_BUDGET, 0, work);
    for (let i = 0; i < 64; i++) budget.admit(1, 'fixture');
    expect(() => budget.admit(1, 'fixture')).toThrow(/observed=65, limit=64/);
    expect(work.attempts).toBe(65);
  });
  it('rejects unimplemented response geometry and restoration instead of guessing', async () => {
    const input = await reactionManifest({ reactions: [{}] });
    const definition = input.revisions.find(
      (r) => r.kind === 'ability' && r.id === 'reaction-0',
    )!.definition;
    expect(AbilitySchema.safeParse({ ...definition, trigger: 'action' }).success).toBe(false);
    expect(
      AbilitySchema.safeParse({
        ...definition,
        trigger: 'before-defeat',
        reaction: { response: { kind: 'effects' } },
        effects: [{ kind: 'heal', amount: 7 }],
      }).success,
    ).toBe(false);
    expect(
      AbilitySchema.safeParse({
        ...definition,
        ...counter,
        attack: { kind: 'melee', reachMm: 2000, radiusMm: 100, activeSteps: 1 },
      }).success,
    ).toBe(false);
  });
});
