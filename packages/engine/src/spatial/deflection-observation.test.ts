import { expect, it } from 'vite-plus/test';
import { deflectionManifest, deflectionResponse } from '../../test-support/deflection.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { runBattle } from './run.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';

it('learns only delayed visible deflection cues and discounts subsequent projectiles without private fields', async () => {
  const input = await deflectionManifest({
    steps: 100,
    reactions: [
      {
        reaction: { response: { kind: 'effects' } },
        effects: [{ kind: 'heal', amount: 1 }],
        recoverySteps: 10,
      },
      { ...deflectionResponse, recoverySteps: 10, costs: { hp: 0, mp: 5, uses: 3 } },
    ],
    attack: { cooldownSteps: 20, costs: { hp: 0, mp: 0, uses: 0 } },
  });
  const output = await runBattle(input);
  const events = battleEvents(output.records);
  const firstTurn = events.find((e) => e.kind === 'projectile-deflect')!;
  const learned = events.filter(
    (e) =>
      e.actorId === 'left' && e.cognition?.kind === 'knowledge' && e.cognition.deflections?.length,
  );
  expect(learned.length).toBeGreaterThan(0);
  expect(learned[0]!.step).toBeGreaterThan(firstTurn.step);
  const details = learned[0]!.cognition!;
  if (details.kind !== 'knowledge') throw new Error('Expected knowledge');
  expect(Object.keys(details.deflections![0]!).sort()).toEqual([
    'availableAt',
    'expiresAt',
    'sampledAt',
    'targetId',
  ]);
  const decisions = events
    .filter((e) => e.actorId === 'left')
    .flatMap((e) =>
      e.cognition?.kind === 'decision'
        ? [{ step: e.step, candidates: e.cognition.candidates }]
        : [],
    );
  const responseKnown = (reason: string) => reason.includes('observed projectile deflection');
  expect(
    decisions
      .filter((d) => d.step < learned[0]!.step)
      .every((d) => d.candidates.every((c) => !responseKnown(c.reason))),
  ).toBe(true);
  expect(
    decisions.some(
      (d) => d.step >= learned[0]!.step && d.candidates.some((c) => responseKnown(c.reason)),
    ),
  ).toBe(true);
  const own = events
    .filter((e) => e.actorId === 'right')
    .flatMap((e) => (e.cognition?.kind === 'decision' ? (e.cognition.reactions ?? []) : []));
  expect(own.some((r) => r.response === 'deflect' && r.remainingUses === 3)).toBe(true);
  expect(own.some((r) => r.response === 'deflect' && r.remainingUses! < 3)).toBe(true);
  await recordedCheckpoints(input, output);
});
