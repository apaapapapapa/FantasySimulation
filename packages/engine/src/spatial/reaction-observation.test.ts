import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { CognitionSchema, ReplayState, type Definition } from '@fantasy/domain/spatial';
import { initializePhysics } from './physics.ts';
import { assessReactions, visibleReactionCue } from './reaction-assessment.ts';
import { choosePolicy } from './policy.ts';
import { emptyMemory, perceive } from './perception.ts';
import { initialActor } from './combat-state.ts';
import { aiFixture, incomingArrow } from '../../test-support/ai.ts';
import { reactionManifest } from '../../test-support/reactions.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { runBattle } from './run.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { reference, sealRevision } from './prepare.ts';
import { initialStatus } from '../../test-support/ai.ts';

beforeAll(initializePhysics);
const parry: Partial<Definition<'ability'>> = {
  trigger: 'before-hit',
  castSteps: 0,
  target: 'self',
  attack: { kind: 'direct' },
  rangeMm: 0,
  effects: [],
  condition: { kind: 'always' },
  reaction: { response: { kind: 'parry', scope: 'all' } },
  costs: { hp: 0, mp: 0, stamina: 4, uses: 3 },
};
describe('reaction information and release validation', () => {
  it('does not learn permanent resistance from a parried visible impact', async () => {
    const input = await reactionManifest({
      reactions: [{ reaction: { response: { kind: 'parry', scope: 'damage' } } }],
    });
    const full = await runBattle(input);
    const learned = battleEvents(full.records).flatMap((e) =>
      e.cognition?.kind === 'knowledge' ? e.cognition.learned : [],
    );
    expect(learned).toHaveLength(2);
    expect(learned.map((e) => [e.kind, e.range, e.confidenceBps])).toEqual([
      ['uncertain', null, 0],
      ['uncertain', null, 0],
    ]);
  });
  it('assesses only own reactions and reserves advisory stamina outside the action lottery', async () => {
    const f = await aiFixture({
      abilities: [parry],
      character: { stamina: { max: 20, recoveryPerSecond: 0 } },
    });
    try {
      f.view.resources.stamina = 10;
      f.view.memory = {
        ...f.view.memory,
        observation: {
          ...f.view.memory.observation!,
          projectiles: [incomingArrow(f.self.position)],
        },
      };
      const estimate = assessReactions(f.view);
      expect(estimate.reserve.stamina).toBe(4);
      expect(estimate.estimates[0]).toMatchObject({
        eligible: true,
        remainingUses: 3,
        point: 'before-hit',
        assessment: { confidenceBps: 1000 },
      });
      const decision = choosePolicy(f.view, new Set(), false);
      expect(decision.abilityId).toBe(null);
      expect(decision.cognition!.reactions).toHaveLength(1);
      expect(decision.cognition!.candidates.every((c) => c.abilityId !== 'choice-0')).toBe(true);
      expect(CognitionSchema.safeParse(decision.cognition).success).toBe(true);
      const mutated = {
        ...f.enemy,
        actor: {
          ...f.enemy.actor,
          abilities: [],
          character: {
            ...f.enemy.actor.character,
            stats: { ...f.enemy.actor.character.stats, hp: 999999, mp: 999999, defense: 999999 },
            abilities: [],
          },
        },
      };
      const decisions = [f.enemy, mutated].map((enemy) => {
        const state = {
          resources: {
            hp: enemy.actor.character.stats.hp,
            mp: enemy.actor.character.stats.mp,
            shield: 0,
          },
          action: 'active' as const,
        };
        const sample = perceive(f.world, f.self, enemy, [], 0, emptyMemory(), state);
        const memory = perceive(f.world, f.self, enemy, [], 5, sample, state);
        return choosePolicy({ ...f.view, memory }, new Set(), false);
      });
      expect(decisions[1]).toEqual(decisions[0]);
      f.view.reactionReadyAt = { 'choice-0': 50 };
      expect(assessReactions(f.view).estimates[0]!.reason).toBe('cooldown-or-recovery');
      expect(assessReactions(f.view).reserve.stamina).toBe(0);
    } finally {
      f.world.free();
    }
  });
  it('exposes only an actual activation cue after sight and observation delay', async () => {
    const f = await aiFixture({ abilities: [{ ...parry, costs: { hp: 0, mp: 0, uses: 1 } }] });
    try {
      const actor = initialActor(f.world, f.battle.actors[1]);
      expect(visibleReactionCue(actor, 5)).toBeUndefined();
      actor.reactions = [
        {
          context: { activationId: 'e.15', point: 'before-hit', wave: 0, depth: 1 },
          abilityId: 'choice-0',
          targetId: 'right',
          activatedAt: 5,
          readyAt: 5,
          recoveryUntil: 20,
          cooldownUntil: 40,
          state: 'applied',
        },
      ];
      const cue = visibleReactionCue(actor, 5)!;
      expect(cue).toEqual({ point: 'before-hit', response: 'parry' });
      const sampled = perceive(f.world, f.self, f.enemy, [], 5, emptyMemory(), {
        resources: { hp: 10, mp: 999, shield: 0 },
        action: 'idle',
        reaction: { ...cue, ...{ activationId: 'secret', cost: 42 } },
      });
      expect(sampled.observation).toBeNull();
      const available = perceive(f.world, f.self, f.enemy, [], 10, sampled);
      expect(available.observation!.enemy!.reaction).toEqual(cue);
      expect(JSON.stringify(available.observation!.enemy!.reaction)).not.toContain('secret');
      const hidden = perceive(
        f.world,
        f.self,
        {
          ...f.enemy,
          vision: { ...f.enemy.actor.character.perception, enabled: true, visible: false },
        },
        [],
        5,
        emptyMemory(),
        { resources: { hp: 10, mp: 0, shield: 0 }, action: 'idle', reaction: cue },
      );
      expect(hidden.pending[0]!.enemy).toBeNull();
      expect(visibleReactionCue(actor, 20)).toBeUndefined();
    } finally {
      f.world.free();
    }
  });
  it.each(['range', 'incapacity'] as const)(
    'rechecks %s after a paid activation without a second payment',
    async (reason) => {
      const status = await sealRevision(
        'status',
        'counter-stun',
        1,
        initialStatus({ adjustments: [{ target: 'action', operation: 'multiply', amount: 0 }] }),
      );
      const input = await reactionManifest({
        revisions: [status],
        reactions: [
          {
            trigger: 'after-damage',
            target: 'enemy',
            rangeMm: reason === 'range' ? 1 : 20000,
            attack: { kind: 'hitscan', radiusMm: 0 },
            reaction: { response: { kind: 'counter' } },
            costs: { hp: 0, mp: 2, uses: 1 },
            effects: [{ kind: 'damage', amount: 20, attackScaleBps: 0, element: 'fire' }],
          },
        ],
        ...(reason === 'incapacity'
          ? {
              attack: {
                effects: [
                  { kind: 'damage', amount: 10, attackScaleBps: 0, element: 'fire' },
                  { kind: 'apply-status', status: reference(status) },
                ],
              },
            }
          : {}),
      });
      const full = await runBattle(input),
        events = battleEvents(full.records);
      expect(events.filter((e) => e.ruleId === 'reaction.activated')).toHaveLength(2);
      expect(events.filter((e) => e.ruleId === 'reaction.cost-group')).toHaveLength(2);
      expect(events.filter((e) => e.ruleId === 'reaction.cancelled')).toHaveLength(2);
      expect(events.some((e) => e.ruleId === 'reaction.release')).toBe(false);
      await recordedCheckpoints(input, full);
    },
  );
  it('rejects forged queue identity/clocks and geometry while replaying saved records without an engine', async () => {
    const input = await reactionManifest({
      reactions: [
        {
          trigger: 'after-damage',
          target: 'enemy',
          rangeMm: 20000,
          attack: { kind: 'hitscan', radiusMm: 0 },
          reaction: { response: { kind: 'counter' } },
          costs: { hp: 0, mp: 0, uses: 1 },
          effects: [{ kind: 'damage', amount: 10, attackScaleBps: 0, element: 'fire' }],
        },
      ],
    });
    const full = await runBattle(input),
      { context, checkpoints } = await recordedCheckpoints(input, full);
    const queued = checkpoints.find((c) =>
      c.state?.actors.some((a) => a.reactions?.some((r) => r.state === 'queued')),
    )!;
    for (const edit of [
      (r: NonNullable<typeof queued.state>['actors'][number]['reactions']) => {
        r![0]!.readyAt++;
      },
      (r: NonNullable<typeof queued.state>['actors'][number]['reactions']) => {
        r!.push(structuredClone(r![0]!));
      },
      (r: NonNullable<typeof queued.state>['actors'][number]['reactions']) => {
        r![0]!.abilityId = 'unknown';
      },
      (r: NonNullable<typeof queued.state>['actors'][number]['reactions']) => {
        r![0]!.context.activationId = 'e.999999';
      },
    ]) {
      const bad = structuredClone(queued);
      edit(bad.state!.actors.find((a) => a.reactions?.length)!.reactions);
      expect(() => new ReplayState(context, bad)).toThrow();
    }
    const released = structuredClone(
      checkpoints.find((c) => c.state?.actors.some((a) => a.reactions?.some((r) => r.geometry)))!,
    );
    const geometry = released
      .state!.actors.flatMap((a) => a.reactions ?? [])
      .find((r) => r.geometry)!.geometry!;
    if (geometry.kind === 'blade') throw Error('Expected recorded ray');
    geometry.segments[0]!.end.x += 100;
    expect(() => new ReplayState(context, released)).toThrow(/reach/);
  });
});
