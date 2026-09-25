import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { type Definition, DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { initializePhysics } from './world/physics.ts';
import { runBattle } from './run.ts';
import { reactionManifest } from '../../test-support/reactions.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { reference } from './prepare.ts';
import { sealRevision } from './manifest-builder.ts';
import { recordBytes } from './rules/journal.ts';

beforeAll(initializePhysics);
const stats = {
  hp: 10,
  mp: 20,
  attack: 0,
  defense: 0,
  actionSpeedBps: 10000,
  shield: 0,
  resistances: { physical: 0, fire: 0, ice: 0, lightning: 0, arcane: 0 },
};
const lethalAttack: Partial<Definition<'ability'>> = {
  effects: [{ kind: 'damage', amount: 15, attackScaleBps: 0, element: 'fire', defense: 'none' }],
};
const counter = (): Partial<Definition<'ability'>> => ({
  trigger: 'after-damage',
  target: 'enemy',
  rangeMm: 20000,
  attack: { kind: 'hitscan', radiusMm: 0 },
  reaction: { response: { kind: 'counter' } },
  costs: { hp: 0, mp: 3, uses: 1 },
  effects: [{ kind: 'damage', amount: 5, attackScaleBps: 0, element: 'physical', defense: 'none' }],
});
describe('reaction interference and old-cohort settlement', () => {
  it.each([0, 1] as const)(
    'scopes before-defeat ancestry to owner %i despite the opponent reaction wave',
    async (owner) => {
      const input = await reactionManifest({
        character: { stats },
        attack: lethalAttack,
        reactions: [
          {
            trigger: 'before-defeat',
            reaction: { response: { kind: 'effects' } },
            effects: [{ kind: 'shield', amount: 7 }],
          },
          {
            trigger: 'after-damage',
            reaction: { response: { kind: 'effects' } },
            effects: [{ kind: 'shield', amount: 1 }],
          },
        ],
      });
      for (const [index, participant] of input.participants.entries()) {
        const before = input.revisions.find(
          (r) => r.kind === 'character' && r.id === participant.character.id,
        )!;
        if (before.kind !== 'character') throw new Error('Character fixture required');
        const character = await sealRevision('character', before.id, 1, {
          ...before.definition,
          abilities: before.definition.abilities.filter(
            (a) => a.id !== (index === owner ? 'reaction-1' : 'reaction-0'),
          ),
        });
        input.revisions = input.revisions.map((r) => (r === before ? character : r));
        participant.character = reference(character);
      }
      for (const maxReactionDepth of [1, 8]) {
        const full = await runBattle(input, { ...DEFAULT_BUDGET, maxReactionDepth });
        expect(full.result.outcome).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
        const events = battleEvents(full.records),
          actorId = input.participants[owner].actorId;
        const activation = events.find(
          (e) => e.ruleId === 'reaction.activated' && e.reaction?.point === 'before-defeat',
        )!;
        expect(activation.actorId).toBe(actorId);
        expect(activation.reaction!.depth).toBe(1);
        expect(activation.causes).toEqual(
          events.filter((e) => e.kind === 'damage' && e.targetId === actorId).map((e) => e.id),
        );
        expect(full.result.stats.reactionAttempts).toBe(2);
        const { replay } = await recordedCheckpoints(input, full);
        expect(
          replay.checkpoint().state!.actors.find((a) => a.id === actorId)!.resources.shield,
        ).toBe(7);
      }
    },
  );
  it.each(['action', 'battle-start'] as const)(
    'visits before-defeat after an exact HP %s cost',
    async (trigger) => {
      const input = await reactionManifest({
        character: { stats },
        attack: {
          trigger,
          target: 'self',
          attack: { kind: 'direct' },
          effects: [{ kind: 'shield', amount: 1 }],
          costs: { hp: 10, mp: 0, uses: 1 },
        },
        reactions: [
          {
            trigger: 'before-defeat',
            reaction: { response: { kind: 'effects' } },
            effects: [{ kind: 'shield', amount: 7 }],
          },
        ],
      });
      const full = await runBattle(input),
        events = battleEvents(full.records);
      expect(
        events.filter((e) => e.ruleId === 'reaction.activated').map((e) => e.reaction?.point),
      ).toEqual(['before-defeat', 'before-defeat']);
      expect(full.result.outcome).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
      const { replay } = await recordedCheckpoints(input, full);
      expect(replay.checkpoint().state!.actors.map((a) => a.resources.shield)).toEqual([8, 8]);
      if (trigger === 'battle-start') expect(full.result.steps).toBe(0);
    },
  );
  it.each(['all', 'damage'] as const)(
    'preserves the G03 element boundary under %s parry',
    async (scope) => {
      const input = await reactionManifest({
        reactions: [{ reaction: { response: { kind: 'parry', scope } } }],
        attack: { effects: [{ kind: 'damage', amount: 10, attackScaleBps: 0, element: 'water' }] },
      });
      await withInitialStatus(
        input,
        1,
        initialStatus({ reactions: [{ element: 'water', response: { kind: 'remove' } }] }),
      );
      const full = await runBattle(input),
        events = battleEvents(full.records);
      const removed = events.filter(
        (e) => e.ruleId === 'status.reaction' && e.targetId === 'right',
      );
      expect(removed).toHaveLength(scope === 'all' ? 0 : 1);
      const { replay } = await recordedCheckpoints(input, full);
      expect(
        replay.checkpoint().state!.actors.find((a) => a.id === 'right')!.statuses,
      ).toHaveLength(scope === 'all' ? 1 : 0);
    },
  );
  it('unions later reaction waves before strengthening each old revision/element once', async () => {
    const water: Definition<'ability'>['effects'] = [{ kind: 'water', extinguish: true }];
    const input = await reactionManifest({
      reactions: [
        { reaction: { response: { kind: 'effects' } }, effects: water },
        { trigger: 'after-damage', reaction: { response: { kind: 'effects' } }, effects: water },
      ],
      attack: {
        effects: [
          { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'water', defense: 'none' },
        ],
      },
    });
    await withInitialStatus(
      input,
      1,
      initialStatus({
        stacking: 'sum',
        maxStacks: 4,
        reactions: [{ element: 'water', response: { kind: 'strengthen', stacks: 1 } }],
      }),
    );
    const full = await runBattle(input);
    const { replay } = await recordedCheckpoints(input, full);
    expect(
      replay.checkpoint().state!.actors.find((a) => a.id === 'right')!.statuses[0]!.stacks,
    ).toBe(2);
    expect(
      battleEvents(full.records).filter(
        (e) => e.ruleId === 'status.reaction' && e.targetId === 'right',
      ),
    ).toHaveLength(1);
  });
  it('defers conflicting transformations across waves to unresolved and preserves the startup boundary', async () => {
    const input = await reactionManifest({
      reactions: [
        {
          trigger: 'after-damage',
          reaction: { response: { kind: 'effects' } },
          effects: [{ kind: 'water', extinguish: true }],
        },
      ],
    });
    const fire = await sealRevision(
      'status',
      'fire-form',
      1,
      initialStatus({ stackKey: 'fire-form' }),
    );
    const water = await sealRevision(
      'status',
      'water-form',
      1,
      initialStatus({ stackKey: 'water-form' }),
    );
    input.revisions.push(fire, water);
    await withInitialStatus(
      input,
      1,
      initialStatus({
        reactions: [
          { element: 'fire', response: { kind: 'transform', status: reference(fire) } },
          { element: 'water', response: { kind: 'transform', status: reference(water) } },
        ],
      }),
    );
    const full = await runBattle(input),
      events = battleEvents(full.records);
    expect(full.result.outcome.kind).toBe('unresolved');
    expect(events.some((e) => e.ruleId === 'reaction.activated' || e.kind === 'damage')).toBe(
      false,
    );
    expect(events.some((e) => e.ruleId === 'startup.launch')).toBe(true);
    expect(full.result.stats.reactionAttempts).toBe(2);
    await recordedCheckpoints(input, full);
  });
  it('includes instant shields in shared attribution and does not counter fully absorbed damage', async () => {
    const input = await reactionManifest({
      reactions: [
        { reaction: { response: { kind: 'effects' } }, effects: [{ kind: 'shield', amount: 100 }] },
        counter(),
      ],
    });
    const full = await runBattle(input),
      events = battleEvents(full.records);
    expect(events.filter((e) => e.ruleId === 'reaction.activated').map((e) => e.reason)).toEqual([
      'effects',
      'effects',
    ]);
    expect(
      events.filter((e) => e.kind === 'damage').every((e) => e.damage!.toHp.numerator === '0'),
    ).toBe(true);
  });
  it('uses positive post-shield damage before HP clipping or simultaneous healing', async () => {
    const input = await reactionManifest({
      reactions: [
        { reaction: { response: { kind: 'effects' } }, effects: [{ kind: 'heal', amount: 20 }] },
        counter(),
      ],
      character: { stats },
    });
    const full = await runBattle(input),
      events = battleEvents(full.records);
    const firstDamage = events.find((e) => e.kind === 'damage')!;
    expect(firstDamage.before!.hp).toBe(10);
    expect(firstDamage.after!.hp).toBe(10);
    expect(firstDamage.damage!.toHp.numerator).toBe('10');
    expect(
      events.filter((e) => e.ruleId === 'reaction.activated' && e.reason === 'counter'),
    ).toHaveLength(2);
  });
  it('settles same-wave healing before defeat, without treating ordinary healing as revival', async () => {
    for (const heal of [true, false]) {
      const input = await reactionManifest({
        reactions: [
          ...(heal
            ? [
                {
                  reaction: { response: { kind: 'effects' } },
                  effects: [{ kind: 'heal', amount: 6 }],
                } as Partial<Definition<'ability'>>,
              ]
            : []),
          {
            trigger: 'before-defeat',
            reaction: { response: { kind: 'effects' } },
            effects: [{ kind: 'shield', amount: 7 }],
          },
        ],
        character: { stats },
        attack: lethalAttack,
      });
      const full = await runBattle(input),
        events = battleEvents(full.records);
      expect(
        events.filter(
          (e) => e.reaction?.point === 'before-defeat' && e.ruleId === 'reaction.activated',
        ),
      ).toHaveLength(heal ? 0 : 2);
      const { replay } = await recordedCheckpoints(input, full);
      expect(replay.checkpoint().state!.actors.map((a) => a.resources.hp)).toEqual(
        heal ? [1, 1] : [0, 0],
      );
      expect(full.result.outcome).toEqual({
        kind: 'draw',
        reason: heal ? 'time-limit' : 'mutual-defeat',
      });
    }
  });
  it('cancels a defeated owner counter after paying, without refund or launch', async () => {
    const input = await reactionManifest({
      reactions: [counter()],
      character: { stats },
      attack: lethalAttack,
    });
    const full = await runBattle(input),
      events = battleEvents(full.records);
    expect(events.filter((e) => e.ruleId === 'reaction.activated')).toHaveLength(2);
    expect(events.filter((e) => e.ruleId === 'reaction.cancelled')).toHaveLength(2);
    expect(events.some((e) => e.ruleId === 'reaction.release')).toBe(false);
    const { replay } = await recordedCheckpoints(input, full);
    expect(replay.checkpoint().state!.actors.map((a) => a.resources.mp)).toEqual([17, 17]);
  });
  it('awards the survivor after simultaneous lethal damage and one owner healing', async () => {
    const input = await reactionManifest({
      leftReactions: false,
      character: { stats },
      attack: lethalAttack,
      reactions: [
        { reaction: { response: { kind: 'effects' } }, effects: [{ kind: 'heal', amount: 6 }] },
      ],
    });
    const full = await runBattle(input);
    expect(full.result.outcome).toEqual({ kind: 'win', winner: 'right' });
    const { replay } = await recordedCheckpoints(input, full);
    expect(replay.checkpoint().state!.actors.map((a) => a.resources.hp)).toEqual([0, 1]);
  });
  it('matches declared categories and element components without inferring magic from MP', async () => {
    const input = await reactionManifest({
      reactions: [
        {
          reaction: {
            response: { kind: 'parry', scope: 'damage' },
            categories: ['physical'],
            elements: ['fire'],
          },
        },
      ],
      attack: {
        categories: ['physical'],
        costs: { hp: 0, mp: 1, uses: 1 },
        effects: [
          { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'fire', defense: 'none' },
          { kind: 'damage', amount: 12, attackScaleBps: 0, element: 'water', defense: 'none' },
        ],
      },
    });
    const events = battleEvents((await runBattle(input)).records);
    expect(events.filter((e) => e.kind === 'damage').map((e) => e.amount)).toEqual([0, 12, 0, 12]);
  });
  it('does not activate reactions blocked by old capabilities and keeps exhausted uses a no-proc', async () => {
    const input = await reactionManifest({
      reactions: [{ categories: ['magic'], costs: { hp: 0, mp: 0, uses: 1 } }],
      attack: { costs: { hp: 0, mp: 0, uses: 0 } },
    });
    await withInitialStatus(
      input,
      1,
      initialStatus({
        modifiers: {
          attack: 0,
          defense: 0,
          speedBps: 10000,
          rooted: false,
          flight: false,
          silenced: true,
        },
      }),
    );
    const full = await runBattle(input);
    expect(
      battleEvents(full.records)
        .filter((e) => e.ruleId === 'reaction.activated')
        .map((e) => e.actorId),
    ).toEqual(['left']);
    expect(full.result.outcome.kind).not.toBe('truncated');
  });
  it('retains bounded diagnostics and rolls back reaction costs when record bytes overflow', async () => {
    const input = await reactionManifest({ reactions: [{}] });
    const baseline = await runBattle(input);
    const activation = baseline.records.find(
      (r) => 'events' in r && r.events.some((e) => e.ruleId === 'reaction.activated'),
    )!;
    const full = await runBattle(input, {
      ...DEFAULT_BUDGET,
      maxFrameBytes: recordBytes(activation) - 1,
    });
    expect(full.result.outcome.kind).toBe('truncated');
    expect(full.result.stats.reactionAttempts).toBe(2);
    const { replay } = await recordedCheckpoints(input, full);
    expect(replay.checkpoint().state!.actors.every((a) => !a.reactions?.length)).toBe(true);
  });
});
