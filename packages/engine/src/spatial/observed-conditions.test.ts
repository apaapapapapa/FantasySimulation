import { beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  AI_RULES,
  AiRulesSchema,
  ConditionSchema,
  StreamRecordSchema,
  type Condition,
} from '@fantasy/domain/spatial';
import { aiFixture, initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { initializePhysics } from './physics.ts';
import { conditionMatches, emptyMemory, perceive } from './perception.ts';
import { choosePolicy } from './policy.ts';
import { efficacy } from './assessment.ts';
import { appearancePrior } from './appearance.ts';
import { runBattle } from './run.ts';

beforeAll(initializePhysics);
describe('G-05 observation contracts', () => {
  it('extends vocabulary and elemental priors through validated rules data, independently of cue order', async () => {
    const f = await aiFixture({
      abilities: [
        {
          effects: [
            { kind: 'damage', element: 'earth', amount: 25, attackScaleBps: 0, defense: 'none' },
          ],
        },
      ],
    });
    try {
      const rules = AiRulesSchema.parse({
        ...AI_RULES,
        appearancePriors: {
          defaultEfficacyBps: 8000,
          cues: [
            {
              match: { surface: 'brown' },
              confidenceBps: 500,
              efficacy: [{ element: 'earth', bps: 4000 }],
            },
            {
              match: { silhouette: 'construct', equipment: ['axe'] },
              confidenceBps: 700,
              efficacy: [{ element: 'earth', bps: 6000 }],
            },
          ],
        },
      });
      const appearance = {
        silhouette: 'construct' as const,
        surface: 'brown' as const,
        equipment: ['axe' as const],
      };
      const view = {
        ...f.view,
        rules,
        memory: {
          ...f.view.memory,
          observation: {
            ...f.view.memory.observation!,
            enemy: { ...f.view.memory.observation!.enemy!, appearance },
          },
        },
      };
      expect(efficacy(view, 'earth', 25)).toEqual({ bps: 5000, confidence: 700, evidence: [] });
      expect(
        appearancePrior(appearance, 'earth', {
          ...rules.appearancePriors!,
          cues: [...rules.appearancePriors!.cues].reverse(),
        }),
      ).toEqual({ bps: 5000, confidence: 700 });
      expect(appearancePrior({ ...appearance, surface: 'red' }, 'fire')).toEqual({
        bps: 6500,
        confidence: 1000,
      });
      expect(appearancePrior({ ...appearance, surface: 'blue' }, 'earth')).toEqual({
        bps: 7500,
        confidence: 1000,
      });
      for (const match of [{}, { equipment: [] }])
        expect(
          AiRulesSchema.safeParse({
            ...rules,
            appearancePriors: {
              ...rules.appearancePriors,
              cues: [{ match, confidenceBps: 1, efficacy: [] }],
            },
          }).success,
        ).toBe(false);
      const run = await runBattle(f.manifest);
      expect(
        battleEvents(run.records).some((e) => e.damage?.calculation?.element === 'earth'),
      ).toBe(true);
      expect((await runBattle(f.manifest)).result).toEqual(run.result);
    } finally {
      f.world.free();
    }
  });

  it('conditions see delayed wounds, phase and relative geometry, never live opponent state', async () => {
    const f = await aiFixture();
    try {
      const conditions: Condition[] = [
        { kind: 'observed-wounds', stage: 'critical' },
        { kind: 'observed-phase', phase: 'cast' },
        { kind: 'observed-status', id: 'hidden', present: false },
        { kind: 'relative-position', relation: 'front' },
      ];
      let memory = perceive(f.world, f.self, f.enemy, [], 0, emptyMemory(), {
        resources: { hp: 1, mp: 91, shield: 0, stamina: 29 },
        action: 'cast',
      });
      expect(conditions.map((c) => conditionMatches(c, { ...f.view, memory }))).toEqual([
        false,
        false,
        false,
        false,
      ]);
      memory = perceive(f.world, f.self, f.enemy, [], 5, memory, {
        resources: { hp: 100, mp: 0, shield: 0, stamina: 0 },
        action: 'idle',
      });
      const view = { ...f.view, memory };
      expect(conditions.map((c) => conditionMatches(c, view))).toEqual([true, true, true, true]);
      const decision = choosePolicy(view, new Set(f.abilities.map((a) => a.id)), false);
      f.enemy.position.x = 100;
      f.enemy.facing.x = -f.enemy.facing.x;
      expect(choosePolicy(view, new Set(f.abilities.map((a) => a.id)), false)).toEqual(decision);
      memory = perceive(f.world, f.self, f.enemy, [], 10, memory);
      memory = perceive(f.world, f.self, f.enemy, [], 15, memory);
      expect(memory.observation?.enemy).toBeNull();
      expect(memory.lastSeen).not.toBeNull();
      for (const condition of conditions) {
        expect(conditionMatches(condition, { ...view, memory })).toBe(false);
        expect(conditionMatches({ kind: 'not', child: condition }, { ...view, memory })).toBe(
          false,
        );
      }
      expect(
        conditionMatches(
          { kind: 'not', child: { kind: 'all', children: conditions } },
          { ...view, memory },
        ),
      ).toBe(false);
      expect(
        conditionMatches(
          { kind: 'any', children: [{ kind: 'always' }, ...conditions] },
          { ...view, memory },
        ),
      ).toBe(true);
    } finally {
      f.world.free();
    }
  });

  it.each(['visible', 'hidden'] as const)(
    'executes only the condition supported by a %s status and persists its evidence',
    async (visibility) => {
      const condition: Condition = {
        kind: 'all',
        children: [
          { kind: 'observed-status', id: 'initial-status-1', present: true },
          { kind: 'relative-position', relation: 'front' },
        ],
      };
      const f = await aiFixture({ steps: 25, abilities: [{ condition }] });
      f.world.free();
      await withInitialStatus(f.manifest, 1, initialStatus({ visibility }));
      const run = await runBattle(f.manifest),
        events = battleEvents(run.records);
      const decisions = events
        .filter((e) => e.actorId === 'left')
        .flatMap((e) => (e.cognition?.kind === 'decision' ? [e.cognition] : []));
      expect(decisions.some((d) => d.selection === 'ability:choice-0')).toBe(
        visibility === 'visible',
      );
      expect(decisions.some((d) => d.conditionObservation?.phase === 'idle')).toBe(true);
      expect(events.some((e) => e.kind === 'cast-start' && e.actorId === 'left')).toBe(
        visibility === 'visible',
      );
      for (const record of run.records)
        expect(StreamRecordSchema.safeParse(record).success).toBe(true);
    },
  );

  it.each([
    { kind: 'observed-phase', phase: 'future' },
    { kind: 'observed-wounds', stage: 'exact-hp' },
    { kind: 'relative-position', relation: 'teleport' },
    { kind: 'observed-status', id: 'burning', present: true, stacks: 3 },
    { kind: 'stage', index: 2 },
  ])('rejects unsupported observation inputs: $kind', (input) => {
    expect(ConditionSchema.safeParse(input).success).toBe(false);
  });
});
