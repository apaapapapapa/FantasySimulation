import { expect, it } from 'vite-plus/test';
import { DEFAULT_BUDGET } from '@fantasy/domain/spatial';
import { catalogManifest } from '@fantasy/samples';
import { revivalManifest, reviveAbility } from '../../test-support/revival.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { runBattle } from './run.ts';

it('rolls back both owners revival resources uses records and HP when reaction work is exhausted', async () => {
  const input = await revivalManifest();
  const run = await runBattle(input, { ...DEFAULT_BUDGET, maxReactionsPerTransaction: 1 });
  const { replay } = await recordedCheckpoints(input, run);
  expect(run.result.outcome.kind).toBe('truncated');
  expect(battleEvents(run.records).some((e) => e.revival)).toBe(false);
  expect(
    replay.checkpoint().state!.actors.map((a) => [a.revivals, a.resources.hp, a.resources.mp]),
  ).toEqual([
    [0, 10, 20],
    [0, 10, 20],
  ]);
  expect(run.result.stats.reactionAttempts).toBe(2);
});
it('learns only delayed visible revival existence and assesses own finite restoration', async () => {
  const input = await revivalManifest({
    steps: 40,
    reactions: [reviveAbility({ recoverySteps: 12 })],
  });
  const run = await runBattle(input);
  const events = battleEvents(run.records);
  const revivedAt = events.find((e) => e.revival)!.step;
  const knowledge = events.filter(
    (e) => e.cognition?.kind === 'knowledge' && e.cognition.revivals?.length,
  );
  expect(knowledge.length).toBeGreaterThan(0);
  for (const e of knowledge) {
    expect(e.step).toBeGreaterThan(revivedAt);
    const info = e.cognition!;
    if (info.kind !== 'knowledge') throw Error('Expected knowledge');
    expect(Object.keys(info.revivals![0]!).sort()).toEqual([
      'availableAt',
      'expiresAt',
      'sampledAt',
      'targetId',
    ]);
    expect(info.revivals![0]!.availableAt - info.revivals![0]!.sampledAt).toBe(5);
  }
  const estimates = events.flatMap((e) =>
    e.cognition?.kind === 'decision' ? (e.cognition.reactions ?? []) : [],
  );
  expect(
    estimates.some(
      (e) =>
        e.response === 'revive' && e.eligible && e.assessment.weight > 0 && e.remainingUses === 4,
    ),
  ).toBe(true);
  expect(estimates.some((e) => e.response === 'revive' && e.remainingUses === 3)).toBe(true);
  await recordedCheckpoints(input, run);
});
it('runs new phoenix and seal samples without rewriting published characters', async () => {
  const phoenix = await catalogManifest(
    'phoenix-duelist-v1',
    'phoenix-duelist-v1',
    'flat-surveyed-v1',
    150,
  );
  const run = await runBattle(phoenix);
  expect(battleEvents(run.records).filter((e) => e.revival)).toHaveLength(4);
  expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
  await recordedCheckpoints(phoenix, run);
  const seal = await catalogManifest('seal-mage-v1', 'seal-mage-v1', 'flat-surveyed-v1', 50);
  const sealed = await runBattle(seal);
  expect(battleEvents(sealed.records).some((e) => e.kind === 'status-apply')).toBe(true);
  await recordedCheckpoints(seal, sealed);
});
