import { describe, expect, it } from 'vite-plus/test';
import { StatusSchema, type Definition } from '@fantasy/domain/spatial';
import { initialStatus } from '../../test-support/ai.ts';
import { prepareBattle, reference } from './prepare.ts';
import { sealRevision } from './manifest-builder.ts';
import { sampleManifest } from '@fantasy/samples';
import { applyStatuses, effectiveStats, statusBoundary } from './status.ts';
import { resolveEffects, type EffectApplication } from './effects.ts';

async function legacyState(burning = true) {
  const battle = await prepareBattle(await sampleManifest());
  const revision = await sealRevision(
    'status',
    'legacy-flame',
    1,
    initialStatus({
      burning: { waterExtinguishable: burning },
      stacking: 'sum',
      maxStacks: 3,
      durationSteps: 10,
      modifiers: { attack: 3, defense: -2, speedBps: 12000, flight: false, rooted: false },
      periodic: [{ kind: 'damage', element: 'fire', amount: 8, everySteps: 2 }],
    }),
  );
  const actor = battle.actors[0];
  return {
    revision,
    target: {
      actor,
      resources: { hp: 100, mp: 100, shield: 0 },
      statuses: [
        { revision, startStep: 2, endStep: 12, stacks: 2, causes: ['original-a', 'original-b'] },
      ],
    },
  };
}

describe('G-03 legacy status compatibility before generalized fields', () => {
  it('reads the original wire format without adding default fields or changing its revision hash', async () => {
    const definition = initialStatus({ burning: { waterExtinguishable: false } });
    const parsed = StatusSchema.parse(definition);
    expect(parsed).toEqual(definition);
    const read = await sealRevision('status', 'unchanged-legacy', 1, parsed);
    // Captured from pre-G-03 main e42a991, independently of the implementation under test.
    expect(reference(read)).toEqual({
      id: 'unchanged-legacy',
      revision: 1,
      contentHash: 'sha256:a2a3e78a94fe589730cc51f3956b71ff1d17de07456f07399b37733e0c52743e',
    });
    for (const invalid of [{ futureModifier: true }, { visibility: 'omniscient' }])
      expect(StatusSchema.safeParse({ ...definition, ...invalid }).success).toBe(false);
  });

  it('keeps additive legacy stacks, half-open expiry, and per-stack periodic pulses', async () => {
    const { target } = await legacyState();
    const value = (step: number) => effectiveStats(target.actor, target.statuses, step);
    expect(value(1)).toMatchObject({ attack: 20, defense: 5, speedBps: 10000 });
    expect(value(2)).toMatchObject({ attack: 26, defense: 1, speedBps: 14000 });
    expect(value(11)).toMatchObject({ attack: 26, defense: 1, speedBps: 14000 });
    expect(value(12)).toMatchObject({ attack: 20, defense: 5, speedBps: 10000 });
    expect(
      [1, 2, 3, 4, 11, 12].map((step) => statusBoundary(target.statuses, step).pulses.length),
    ).toEqual([0, 2, 0, 2, 0, 0]);
    expect(statusBoundary(target.statuses, 12).removed).toHaveLength(1);
  });

  it.each([true, false])(
    'preserves old water semantics (extinguishable=%s) with simultaneous ignition',
    async (extinguishable) => {
      const { target, revision } = await legacyState(extinguishable);
      const app = (
        id: string,
        effect: Definition<'ability'>['effects'][number],
      ): EffectApplication => ({
        id,
        actorId: 'left',
        targetId: 'left',
        attack: 0,
        effect,
      });
      const applications = [
        app('water', { kind: 'water', extinguish: true }),
        app('ignite', { kind: 'apply-status', status: reference(revision) }),
      ];
      const resolved = resolveEffects([target], applications, [revision], 4, 5);
      expect(resolved[0]!.resources).toEqual(target.resources);
      expect(resolved[0]!.statuses.map((s) => [s.startStep, s.endStep, s.stacks])).toEqual(
        extinguishable
          ? [[5, 15, 1]]
          : [
              [2, 12, 2],
              [5, 15, 1],
            ],
      );
      expect(resolveEffects([target], [...applications].reverse(), [revision], 4, 5)).toEqual(
        resolved,
      );
      expect(target.statuses[0]!.stacks).toBe(2);
    },
  );

  it('refreshes an old status without moving its periodic origin and expires before reapplication', async () => {
    const { revision } = await legacyState();
    const refreshed = await sealRevision('status', 'legacy-refresh', 1, {
      ...revision.definition,
      stacking: 'refresh',
    });
    const existing = [
      { revision: refreshed, startStep: 2, endStep: 12, stacks: 1, causes: ['first'] },
    ];
    const apply = (at: number) =>
      applyStatuses(existing, [{ revision: refreshed, cause: 'again' }], [], at);
    const early = apply(5);
    expect(early.statuses[0]).toMatchObject({
      startStep: 2,
      endStep: 15,
      causes: ['again', 'first'],
    });
    expect(statusBoundary(early.statuses, 6).pulses).toHaveLength(1);
    expect(statusBoundary(early.statuses, 7).pulses).toHaveLength(0);
    expect(apply(12).changes.map((c) => [c.kind, c.reason])).toEqual([
      ['remove', 'expired'],
      ['apply', 'next-boundary'],
    ]);
    expect(apply(12).statuses[0]).toMatchObject({ startStep: 12, endStep: 22 });
  });
});
