import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  AI_RULES,
  AiRulesSchema,
  CognitionSchema,
  replayContext,
  ReplayState,
} from '@fantasy/domain/spatial';
import { initializePhysics } from './physics.ts';
import { aiFixture, flyingBody, initialStatus, incomingArrow } from '../../test-support/ai.ts';
import { advanceLocomotion, locomotion, locomotionFixture } from '../../test-support/locomotion.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { choosePolicy } from './policy.ts';
import { initialDecisionRandom, initialMovementRandom } from './decision-random.ts';
import { admitPair, rejectPair } from './pair-admission.ts';
import { ResourceBudget } from './resources.ts';
import { prepareBattle } from './prepare.ts';
import { sealRevision } from './manifest-builder.ts';
import { runBattle } from './run.ts';
import { STANDARD_MOVEMENT } from '@fantasy/samples';
import { simultaneousManifest } from '../../test-support/simultaneous.ts';
import { AbilitySchema } from '@fantasy/domain/spatial';

beforeAll(initializePhysics);
async function simultaneousFixture(cost = 6, stop = false) {
  const f = await aiFixture({
    abilities: [
      {
        castSteps: 3,
        movementWhileCasting: stop ? 'stop' : 'allow',
        costs: { hp: 0, mp: 0, stamina: cost, uses: 0 },
      },
    ],
    character: {
      body: flyingBody,
      stamina: { max: 20, recoveryPerSecond: 0 },
      movement: {
        ...STANDARD_MOVEMENT,
        accelerationMmPerSecond2: 100000,
        locomotion: { ...locomotion(), dodgeStamina: 8 },
      },
    },
  });
  f.view.rules = { ...AI_RULES, slots: 'simultaneous-v1' };
  f.view.resources.stamina = 20;
  f.view.memory = {
    ...f.view.memory,
    observation: {
      ...f.view.memory.observation!,
      projectiles: [incomingArrow(f.self.position)],
    },
  };
  return f;
}

describe('simultaneous action and evasion', () => {
  it('selects both slots from one observation with distinct action, movement and direction streams', async () => {
    const f = await simultaneousFixture();
    try {
      const results = Array.from({ length: 24 }, (_, i) =>
        choosePolicy(f.view, new Set(['choice-0']), false, {
          ...initialDecisionRandom(i + 1),
          movement: initialMovementRandom(i + 1),
        }),
      );
      const paired = results.filter((d) => d.dodge);
      expect(paired.length).toBeGreaterThan(0);
      expect(paired.length).toBeLessThan(24);
      for (const d of results) {
        expect(d.abilityId).toBe('choice-0');
        expect(CognitionSchema.safeParse(d.cognition).success).toBe(true);
        expect(d.cognition!.draws[0]!.draws).toBe(0);
        expect(d.cognition!.movementSlot!.draw.purpose).toBe('movement');
      }
      expect(
        choosePolicy(f.view, new Set(['choice-0']), false, {
          ...initialDecisionRandom(1),
          movement: initialMovementRandom(1),
        }),
      ).toEqual(results[0]);
    } finally {
      f.world.free();
    }
  });
  it.each([
    { cost: 15, stop: false },
    { cost: 6, stop: true },
  ])('excludes an infeasible pair: %j', async ({ cost, stop }) => {
    const f = await simultaneousFixture(cost, stop);
    try {
      for (let seed = 1; seed <= 8; seed++) {
        const d = choosePolicy(f.view, new Set(['choice-0']), false, initialDecisionRandom(seed));
        expect(d.dodge).toBe(false);
        expect(d.cognition!.movementSlot!.excluded).not.toHaveLength(0);
        expect(d.cognition!.movementSlot!.draw.draws).toBe(0);
      }
    } finally {
      f.world.free();
    }
  });
  it('keeps omitted rules and no-threat action distributions unchanged', async () => {
    const f = await simultaneousFixture();
    try {
      f.view.memory = {
        ...f.view.memory,
        observation: { ...f.view.memory.observation!, projectiles: [] },
      };
      const paired = choosePolicy(f.view, new Set(['choice-0']), false);
      const legacy = choosePolicy({ ...f.view, rules: AI_RULES }, new Set(['choice-0']), false);
      expect(paired.cognition).toEqual(legacy.cognition);
      expect(paired.random).toEqual(legacy.random);
      expect(AiRulesSchema.safeParse({ ...AI_RULES, slots: 'unknown' }).success).toBe(false);
    } finally {
      f.world.free();
    }
  });
  it('admits the whole shared cost or nothing, protecting flight upkeep', async () => {
    const f = await locomotionFixture();
    try {
      const base = f.actor.motion.actor.abilities[0]!;
      const ability = await sealRevision('ability', 'paired-action', 1, {
        ...AbilitySchema.parse(base.definition),
        costs: { hp: 0, mp: 0, stamina: 6, uses: 1 },
      });
      for (const [stamina, ok] of [
        [10, false],
        [11, true],
      ] as const) {
        const budget = new ResourceBudget({ ...f.actor.resources, stamina });
        expect(admitPair(f.actor, ability, budget, 0).ok).toBe(ok);
        expect(budget.finish()).toMatchObject({ resources: { stamina }, used: {} });
      }
      const status = await sealRevision(
        'status',
        'paid-flight',
        1,
        initialStatus({
          modifiers: { attack: 0, defense: 0, speedBps: 10000, rooted: false, flight: true },
          flightStaminaPerSecond: 100,
        }),
      );
      f.actor.statuses = [{ revision: status, startStep: 0, endStep: 100, stacks: 1, causes: [] }];
      f.actor.intent.flight = true;
      const budget = new ResourceBudget({ ...f.actor.resources, stamina: 11 });
      expect(admitPair(f.actor, ability, budget, 1).ok).toBe(false);
      expect(budget.available.stamina).toBe(11);
    } finally {
      f.world.free();
    }
  });
  it.each([true, false])(
    'restores prior walking and its actual cost after a rejected jump pair, explicit gait=%s',
    async (explicitGait) => {
      const f = await locomotionFixture();
      try {
        f.actor.resources.stamina = 11;
        if (explicitGait) f.actor.decision.gait = 'walk';
        const previous = { intent: { ...f.actor.intent }, decision: f.actor.decision };
        const ability = await sealRevision('ability', 'costly-jump-shot', 1, {
          ...AbilitySchema.parse(f.actor.motion.actor.abilities[0]!.definition),
          costs: { hp: 0, mp: 0, stamina: 6, uses: 1 },
        });
        f.actor.intent = { ...f.actor.intent, direction: { x: 0, y: 0, z: 1 }, jump: true };
        f.actor.decision = { ...f.actor.decision, abilityId: ability.id, gait: 'run', dodge: true };
        const budget = new ResourceBudget(f.actor.resources);
        expect(admitPair(f.actor, ability, budget, 0)).toEqual({ ok: false, reason: 'stamina' });
        rejectPair(f.actor, previous);
        expect(f.actor.decision.gait).toBe(explicitGait ? 'walk' : undefined);
        expect(f.actor.intent.jump).toBe(false);
        advanceLocomotion(f, 0, { budget });
        for (let step = 1; step < 50; step++) advanceLocomotion(f, step);
        expect(f.actor.motion.position.x + 4).toBeCloseTo(2, 2);
        expect(f.actor.motion.position.z).toBe(0);
        expect(f.actor.resources.stamina).toBe(7);
        expect(f.actor.used).toEqual({});
        expect(f.actor.readyAt).toBe(0);
      } finally {
        f.world.free();
      }
    },
  );
  it.each([true, false])(
    'executes and restores shooting while evading, with stamina=%s',
    async (withStamina) => {
      const manifest = await simultaneousManifest(70, withStamina);
      const first = await runBattle(manifest);
      expect(await runBattle(manifest)).toEqual(first);
      const events = battleEvents(first.records);
      const pairs = events.filter(
        (e) =>
          e.cognition?.kind === 'decision' &&
          e.cognition.movementSlot?.selection === 'dodge' &&
          e.cognition.selection.startsWith('ability:'),
      );
      expect(pairs.length).toBeGreaterThan(0);
      for (const pair of pairs)
        expect(
          events.some(
            (e) => e.kind === 'cast-start' && e.step === pair.step && e.actorId === pair.actorId,
          ),
        ).toBe(true);
      if (withStamina)
        expect(
          events.some((e) => e.ruleId === 'movement.cost' && e.reason?.includes('dodge=true')),
        ).toBe(true);
      expect(
        first.records.some((r) => 'changes' in r && r.changes.some((a) => a.locomotion?.dodging)),
      ).toBe(true);
      const replay = new ReplayState(
        await replayContext((await prepareBattle(manifest)).manifest, first.result.simulationHash),
      );
      for (const record of first.records) replay.apply(record);
      expect(replay.checkpoint().state!.actors.some((a) => a.position.z !== 0)).toBe(true);
    },
  );
});
