import { expect, it } from 'vite-plus/test';
import { AbilitySchema, ReplayState, type Definition } from '@fantasy/domain/spatial';
import { revivalManifest, reviveAbility } from '../../test-support/revival.ts';
import { reactionManifest } from '../../test-support/reactions.ts';
import { initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import { recordedCheckpoints, runReversedEnumeration } from '../../test-support/replay.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { runBattle } from './run.ts';

it.each([false, true])(
  'settles all healing before revival and simultaneous verdict, both=%s',
  async (both) => {
    const input = await revivalManifest({ leftReactions: both });
    const run = await runBattle(input);
    const { replay } = await recordedCheckpoints(input, run);
    expect(run.result.outcome).toEqual(
      both ? { kind: 'draw', reason: 'time-limit' } : { kind: 'win', winner: 'right' },
    );
    expect(replay.checkpoint().state!.actors.map((a) => a.resources.hp)).toEqual(
      both ? [7, 7] : [0, 7],
    );
    const events = battleEvents(run.records).filter((e) => e.revival);
    expect(events).toHaveLength(both ? 2 : 1);
    expect(
      events.every((e) => e.before?.hp === 0 && e.after?.hp === 7 && e.revival?.use === 1),
    ).toBe(true);
    expect(replay.checkpoint().state!.actors.at(-1)!.resources).toMatchObject({
      hp: 7,
      mp: 18,
      stamina: 17,
    });
  },
);
it.each([
  { costs: { hp: 0, mp: 21, uses: 1 } },
  { costs: { hp: 0, mp: 0, stamina: 21, uses: 1 } },
] satisfies Partial<Definition<'ability'>>[])(
  'does not pay unaffordable revival costs %j',
  async (edit) => {
    const input = await revivalManifest({ reactions: [reviveAbility(edit)] });
    const run = await runBattle(input);
    expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
    expect(battleEvents(run.records).filter((e) => e.revival)).toHaveLength(0);
    const { replay } = await recordedCheckpoints(input, run);
    expect(replay.checkpoint().state!.actors.map((a) => a.resources.mp)).toEqual([20, 20]);
  },
);
it('reserves revival and other before-defeat responses all-or-none per owner', async () => {
  const input = await revivalManifest({
    reactions: [
      reviveAbility(),
      {
        trigger: 'before-defeat',
        reaction: { response: { kind: 'effects' } },
        costs: { hp: 0, mp: 19, uses: 1 },
        effects: [{ kind: 'shield', amount: 1 }],
      },
    ],
  });
  const run = await runBattle(input);
  expect(battleEvents(run.records).filter((e) => e.ruleId === 'reaction.activated')).toHaveLength(
    0,
  );
  expect(run.result.outcome.kind).toBe('draw');
});
it('retains periodic states and stops at four revivals without truncating', async () => {
  const input = await revivalManifest({
    steps: 30,
    reactions: [reviveAbility({ costs: { hp: 0, mp: 0, uses: 9 } })],
    attack: { target: 'self', attack: { kind: 'direct' }, effects: [{ kind: 'heal', amount: 0 }] },
  });
  for (const i of [0, 1] as const)
    await withInitialStatus(
      input,
      i,
      initialStatus({
        periodic: [{ kind: 'damage', amount: 30, element: 'fire', everySteps: 3 }],
        durationSteps: 30,
      }),
    );
  const run = await runBattle(input);
  const { replay } = await recordedCheckpoints(input, run);
  expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
  for (const id of ['left', 'right']) {
    expect(
      battleEvents(run.records)
        .filter((e) => e.actorId === id && e.revival)
        .map((e) => e.revival!.use),
    ).toEqual([1, 2, 3, 4]);
    expect(replay.checkpoint().state!.actors.find((a) => a.id === id)).toMatchObject({
      revivals: 4,
      resources: { hp: 0 },
    });
  }
});
it('revives on the last interval and floors maximum-HP ratios once', async () => {
  const input = await revivalManifest({
    steps: 6,
    reactions: [
      reviveAbility({
        reaction: { response: { kind: 'revive', health: { kind: 'max-hp', bps: 2500 } } },
      }),
    ],
  });
  const run = await runBattle(input);
  const { replay } = await recordedCheckpoints(input, run);
  expect(replay.checkpoint().state!.actors.map((a) => a.resources.hp)).toEqual([2, 2]);
  expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
});
it('rejects ambiguous or unbounded revival definitions and multiple loadout revivals', async () => {
  const input = await revivalManifest();
  const ability = input.revisions.find(
    (r) => r.kind === 'ability' && r.definition.reaction,
  )!.definition;
  for (const edit of [
    { costs: { hp: 0, mp: 0, uses: 0 } },
    { costs: { hp: 1, mp: 0, uses: 1 } },
    { trigger: 'after-damage' },
    { effects: [{ kind: 'heal', amount: 4 }] },
  ])
    expect(AbilitySchema.safeParse({ ...ability, ...edit }).success).toBe(false);
  await expect(
    reactionManifest({ reactions: [reviveAbility(), reviveAbility()] }).then(runBattle),
  ).rejects.toThrow(/one revival/);
});
it('rejects forged revival HP, uses, activation and display counts during engine-free replay', async () => {
  const input = await revivalManifest();
  const run = await runBattle(input);
  const { context } = await recordedCheckpoints(input, run);
  for (const corrupt of [
    'hp',
    'use',
    'cause',
    'count',
    'display',
    'duplicate',
    'missing',
  ] as const) {
    const records = structuredClone(run.records);
    const record = records.find((r) => 'events' in r && r.events.some((e) => e.revival))!;
    if (!('events' in record)) throw Error('Missing revival');
    const event = record.events.find((e) => e.revival)!;
    if (corrupt === 'hp') event.after!.hp++;
    if (corrupt === 'use') event.revival!.use++;
    if (corrupt === 'cause') event.parentEventId = event.causes[0] ?? null;
    if (corrupt === 'count' && record.kind === 'interval')
      record.changes.find((a) => a.revivals)!.revivals = 3;
    if (record.kind === 'interval') {
      const actor = record.changes.find((a) => a.id === event.actorId)!;
      if (corrupt === 'display') actor.resources!.hp = 1;
      if (corrupt === 'duplicate') {
        const duplicate = structuredClone(event);
        duplicate.id = `e.${Math.max(...record.events.map((e) => Number(e.id.slice(2)))) + 1}`;
        duplicate.revival!.use = 2;
        record.events.splice(record.events.indexOf(event) + 1, 0, duplicate);
        const firstSequence = record.events[0]!.sequence;
        record.events.forEach((e, i) => (e.sequence = firstSequence + i));
        actor.revivals = 2;
      }
      if (corrupt === 'missing') {
        event.kind = 'reaction';
        delete event.revival;
        actor.revivals = 0;
      }
    }
    const replay = new ReplayState(context);
    expect
      .soft(
        () => records.slice(0, records.indexOf(record) + 1).forEach((r) => replay.apply(r)),
        corrupt,
      )
      .toThrow(/revival/);
  }
});
it('preserves deterministic result events trajectory and state under reversed enumeration', async () => {
  const input = await revivalManifest();
  const run = await runBattle(input);
  expect(await runBattle(input)).toEqual(run);
  const reversed = await runReversedEnumeration(input);
  expect(reversed.records).toEqual(run.records);
  expect({ ...reversed.result, simulationHash: run.result.simulationHash }).toEqual(run.result);
});
