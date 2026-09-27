import { expect, it } from 'vite-plus/test';
import { AbilitySchema, StatusSchema, ReplayState } from '@fantasy/domain/spatial';
import { conceptManifest } from '../../test-support/concepts.ts';
import { initialStatus } from '../../test-support/ai.ts';
import { reviveAbility } from '../../test-support/revival.ts';
import { recordedCheckpoints, runReversedEnumeration } from '../../test-support/replay.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { runBattle } from './run.ts';
import { prepareBattle } from './prepare.ts';
import { reference } from './prepare.ts';
import { ManifestBuilder } from './manifest-builder.ts';
import { deflectionShape, deflectionResponse } from '../../test-support/deflection.ts';

it('requires the opening status and does not accept a same-wave newly granted prerequisite', async () => {
  const input = await conceptManifest({ status: { durationSteps: 100 } }),
    status = input.revisions.find((r) => r.kind === 'status')!,
    old = input.revisions.find((r) => r.kind === 'ability' && r.id === 'reaction-primary')!;
  if (old.kind !== 'ability') throw new Error('Primary ability');
  const ability = await ManifestBuilder.create('ability', old.id, 1, {
    ...old.definition,
    effects: [
      { kind: 'apply-status', status: reference(status) },
      { kind: 'defeat', requires: { kind: 'status', id: status.id, present: true } },
    ],
  });
  const manifest = await ManifestBuilder.relink(input, [{ from: old, to: ability }]);
  const run = await runBattle(manifest),
    { replay } = await recordedCheckpoints(manifest, run);
  expect(replay.checkpoint().state!.actors.map((a) => a.resources.hp)).toEqual([10, 0]);
  expect(
    Object.fromEntries(
      battleEvents(run.records)
        .filter((e) => e.defeat)
        .map((e) => [e.targetId, e.defeat!.reason]),
    ),
  ).toEqual({ left: 'condition', right: 'accepted' });
});

it('returns a defeated projectile payload once without numeric damage or drain', async () => {
  const input = await conceptManifest({
    attack: { attack: deflectionShape },
    reactions: [deflectionResponse],
    steps: 30,
  });
  const run = await runBattle(input);
  await recordedCheckpoints(input, run);
  const events = battleEvents(run.records);
  expect(events.filter((event) => event.projectileDeflection)).toHaveLength(2);
  expect(events.filter((event) => event.defeat?.applied)).toHaveLength(2);
  expect(
    events
      .filter((event) => event.defeat)
      .every(
        (event) => event.sourceActorId === event.targetId && event.sourceActorId !== event.actorId,
      ),
  ).toBe(true);
  expect(events.filter((event) => event.damage)).toEqual([]);
  expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
});

it('resolves defeat before finite protection and revival with engine-free replay', async () => {
  const input = await conceptManifest({
    attack: { effects: [{ kind: 'defeat' }] },
    status: { immortality: { protections: 1 } },
    reactions: [reviveAbility({ costs: { hp: 0, mp: 0, uses: 1 } })],
  });
  const run = await runBattle(input);
  const { replay } = await recordedCheckpoints(input, run);
  expect(replay.checkpoint().state!.actors.map((actor) => actor.resources.hp)).toEqual([7, 1]);
  expect(
    battleEvents(run.records)
      .filter((event) => event.revival)
      .map((event) => event.actorId),
  ).toEqual(['left']);
  const protection = battleEvents(run.records).filter((event) => event.immortality);
  expect(protection).toHaveLength(1);
  expect(protection[0]).toMatchObject({
    actorId: 'right',
    immortality: { use: 1 },
    after: { hp: 1, shield: 100 },
  });
  expect(
    battleEvents(run.records).filter((event) => event.damage || event.ruleId === 'damage.drain'),
  ).toHaveLength(0);
});

it.each(['all', 'damage'] as const)(
  'keeps whole-contact and damage-only parry distinct for defeat: %s',
  async (scope) => {
    const input = await conceptManifest({
      reactions: [{ reaction: { response: { kind: 'parry', scope } } }],
    });
    const run = await runBattle(input);
    const { replay } = await recordedCheckpoints(input, run);
    expect(replay.checkpoint().state!.actors.map((actor) => actor.resources.hp)).toEqual(
      scope === 'all' ? [10, 10] : [0, 0],
    );
    expect(run.result.outcome).toEqual({
      kind: 'draw',
      reason: scope === 'all' ? 'time-limit' : 'mutual-defeat',
    });
  },
);

it.each([true, false])(
  'uses opening defeat immunity and ignores shield defense resistance: immune=%s',
  async (immune) => {
    const input = await conceptManifest({ status: { defeatImmunity: immune } });
    const run = await runBattle(input);
    const { replay } = await recordedCheckpoints(input, run);
    expect(replay.checkpoint().state!.actors.map((actor) => actor.resources.hp)).toEqual([
      0,
      immune ? 10 : 0,
    ]);
    const requests = battleEvents(run.records).filter((event) => event.defeat);
    expect(requests.find((event) => event.targetId === 'left')!.defeat!.reason).toBe('accepted');
    expect(requests.find((event) => event.targetId === 'right')!.defeat!.reason).toBe(
      immune ? 'immune' : 'accepted',
    );
  },
);

it('samples defeat predicates before same-wave damage or newly applied statuses', async () => {
  const input = await conceptManifest({
    attack: {
      effects: [
        { kind: 'damage', amount: 105, attackScaleBps: 0, element: 'physical', defense: 'none' },
        { kind: 'defeat', requires: { kind: 'hp-at-most', bps: 5000 } },
      ],
    },
  });
  const run = await runBattle(input);
  const { replay } = await recordedCheckpoints(input, run);
  expect(replay.checkpoint().state!.actors.map((actor) => actor.resources.hp)).toEqual([5, 5]);
  expect(
    battleEvents(run.records)
      .filter((event) => event.defeat)
      .every((event) => event.defeat!.reason === 'condition'),
  ).toBe(true);
});

it('exhausts finite protection without truncation and does not spend it twice in one wave', async () => {
  const input = await conceptManifest({
    both: true,
    status: { immortality: { protections: 2 } },
    attack: {
      cooldownSteps: 0,
      costs: { hp: 0, mp: 0, uses: 3 },
      effects: [{ kind: 'defeat' }, { kind: 'defeat' }],
    },
    steps: 50,
  });
  const run = await runBattle(input);
  const { replay } = await recordedCheckpoints(input, run);
  expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
  expect(replay.checkpoint().state!.actors.map((actor) => actor.immortalityUsed)).toEqual([2, 2]);
  for (const id of ['left', 'right'])
    expect(
      battleEvents(run.records)
        .filter((event) => event.actorId === id && event.immortality)
        .map((event) => event.immortality!.use),
    ).toEqual([1, 2]);
});

it('rejects unpermitted dormant concepts and invalid defeat and immortality forms', async () => {
  const input = await conceptManifest();
  const rule = input.revisions.find((revision) => revision.kind === 'ruleset')!;
  if (rule.kind !== 'ruleset') throw new Error('Rules missing');
  const { experimental: _, ...definition } = rule.definition;
  const standard = await ManifestBuilder.create('ruleset', 'no-concepts', 1, definition);
  const denied = await ManifestBuilder.relink(input, [{ from: rule, to: standard }]);
  await expect(prepareBattle(denied)).rejects.toThrow(/instant-death.*does not permit/);
  const ability = input.revisions.find(
    (revision) =>
      revision.kind === 'ability' &&
      revision.definition.effects.some((effect) => effect.kind === 'defeat'),
  )!;
  for (const edit of [
    { target: 'self' },
    { trigger: 'battle-start' },
    { effects: [{ kind: 'defeat', probabilityBps: 5000 }] },
  ])
    expect(AbilitySchema.safeParse({ ...ability.definition, ...edit }).success).toBe(false);
  for (const edit of [
    { immortality: { protections: 0 } },
    { immortality: { protections: 5 } },
    { maxStacks: 2 },
    { stacking: 'sum' },
  ])
    expect(
      StatusSchema.safeParse({
        ...initialStatus({ maxStacks: 1, stacking: 'refresh', immortality: { protections: 1 } }),
        ...edit,
      }).success,
    ).toBe(false);
});

it('preserves concept determinism and rejects forged protection use and HP records', async () => {
  const input = await conceptManifest({ both: true, status: { immortality: { protections: 1 } } });
  const run = await runBattle(input);
  expect(await runBattle(input)).toEqual(run);
  const reverse = await runReversedEnumeration(input);
  expect(reverse.records).toEqual(run.records);
  expect({ ...reverse.result, simulationHash: run.result.simulationHash }).toEqual(run.result);
  const { context } = await recordedCheckpoints(input, run);
  for (const variant of ['use', 'hp', 'missing'] as const) {
    const records = structuredClone(run.records);
    const record = records.find(
      (record) => 'events' in record && record.events.some((event) => event.immortality),
    )!;
    if (!('events' in record)) throw new Error('Missing protection');
    const event = record.events.find((event) => event.immortality)!;
    if (variant === 'use') event.immortality!.use++;
    if (variant === 'hp') event.after!.hp = 2;
    if (variant === 'missing') {
      delete event.immortality;
      event.kind = 'diagnostic';
    }
    const replay = new ReplayState(context);
    expect(() => records.forEach((record) => replay.apply(record))).toThrow(
      /immortality|Immortality/,
    );
  }
});
