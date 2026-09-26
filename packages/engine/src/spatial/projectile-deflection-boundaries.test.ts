import { expect, it } from 'vite-plus/test';
import { DEFAULT_BUDGET, ReplayState, type Definition } from '@fantasy/domain/spatial';
import {
  deflectionManifest,
  deflectionResponse,
  deflectionShape,
} from '../../test-support/deflection.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { withInitialStatus, initialStatus } from '../../test-support/ai.ts';
import { sealRevision } from './manifest-builder.ts';
import { reference } from './prepare.ts';
import { runBattle } from './run.ts';

it('suppresses an explosive payload until the returned projectile contacts again', async () => {
  const input = await deflectionManifest({
    attack: { attack: { ...deflectionShape, explosionRadiusMm: 2000 } },
  });
  const output = await runBattle(input);
  const events = battleEvents(output.records);
  const turn = events.find((e) => e.kind === 'projectile-deflect')!;
  expect(turn).toBeDefined();
  const hits = events.filter((e) => e.ruleId === 'explosion.coverage');
  expect(hits.length).toBeGreaterThan(0);
  expect(
    hits.every((e) => e.step >= turn.step && e.actorId === input.participants[1].actorId),
  ).toBe(true);
  expect(events.some((e) => e.kind === 'damage' && e.step < turn.step)).toBe(false);
  await recordedCheckpoints(input, output);
});

it.each([false, true])(
  'preserves launch stats, force and status payloads with hidden attacker=%s',
  async (hidden) => {
    const mark = await sealRevision(
      'status',
      'returned-mark',
      1,
      initialStatus({ durationSteps: 30 }),
    );
    const input = await deflectionManifest({
      revisions: [mark],
      reactions: [{ reaction: { response: { kind: 'deflect', powerBps: 5000 } } }],
      attack: {
        effects: [
          {
            kind: 'damage',
            amount: 0,
            attackScaleBps: 10000,
            element: 'physical',
            defense: 'none',
          },
          { kind: 'apply-status', status: reference(mark) },
          {
            kind: 'force',
            profile: 'linear-v1',
            direction: 'away',
            speedMmPerSecond: 1000,
            durationSteps: 2,
          },
        ],
      },
    });
    const old = input.revisions.find(
      (r) => r.kind === 'character' && r.id === input.participants[1].character.id,
    )!;
    if (old.kind !== 'character') throw new Error('Fixture character');
    const replacement = await sealRevision('character', old.id, 1, {
      ...old.definition,
      stats: { ...old.definition.stats, attack: 9000 },
    });
    input.revisions = input.revisions.map((r) => (r === old ? replacement : r));
    input.participants[1].character = reference(replacement);
    if (hidden)
      await withInitialStatus(
        input,
        0,
        initialStatus({
          visibility: 'hidden',
          adjustments: [{ target: 'visibility', operation: 'multiply', amount: 0 }],
        }),
      );
    const output = await runBattle(input);
    const events = battleEvents(output.records);
    const turn = events.find((e) => e.kind === 'projectile-deflect')!.projectileDeflection!;
    expect(turn.basis).toBe(hidden ? 'reverse-incoming' : 'observed-position');
    if (hidden)
      for (const axis of ['x', 'y', 'z'] as const)
        expect(turn.velocity[axis]).toBeCloseTo(-turn.incomingVelocity[axis], 10);
    if (!hidden)
      expect(events.filter((e) => e.kind === 'damage')[0]).toMatchObject({
        targetId: 'left',
        amount: 10,
      });
    if (!hidden)
      expect(
        events.some(
          (e) =>
            e.kind === 'status-apply' &&
            e.targetId === 'left' &&
            e.reason.startsWith('returned-mark:'),
        ),
      ).toBe(true);
    if (!hidden) expect(events.some((e) => e.kind === 'force' && e.targetId === 'left')).toBe(true);
    await recordedCheckpoints(input, output);
  },
);

it('carries ancestry across intervals into counters and rolls back only the failing interval', async () => {
  const counter: Partial<Definition<'ability'>> = {
    trigger: 'after-damage',
    target: 'enemy',
    attack: { kind: 'hitscan', radiusMm: 0 },
    effects: [{ kind: 'damage', amount: 1, attackScaleBps: 0, element: 'physical' }],
    reaction: { response: { kind: 'counter' } },
  };
  const input = await deflectionManifest({
    leftReactions: true,
    reactions: [deflectionResponse, counter],
  });
  const complete = await runBattle(input);
  const events = battleEvents(complete.records);
  expect(events.find((e) => e.kind === 'reaction' && e.reason === 'counter')?.reaction?.depth).toBe(
    2,
  );
  const limited = await runBattle(input, { ...DEFAULT_BUDGET, maxReactionDepth: 1 });
  expect(limited.result.outcome).toMatchObject({ kind: 'truncated', resource: 'reaction-depth' });
  const committed = battleEvents(limited.records);
  expect(committed.filter((e) => e.kind === 'projectile-deflect')).toHaveLength(1);
  expect(committed.filter((e) => e.kind === 'damage')).toHaveLength(0);
  await recordedCheckpoints(input, limited);
});

it('validates saved ownership transitions and rejects a second deflection or forged direction', async () => {
  const input = await deflectionManifest();
  const output = await runBattle(input);
  const { context, checkpoints } = await recordedCheckpoints(input, output);
  const index = output.records.findIndex(
    (r) => r.kind === 'interval' && r.projectiles.update.some((p) => p.deflection),
  );
  for (const kind of [
    'owner',
    'speed',
    'event',
    'missing-point',
    'shifted-point',
    'boundary-time',
    'contact-time',
    'coherent-point',
    'missing-contact',
  ] as const) {
    const replay = new ReplayState(context, checkpoints[index - 1]!);
    const record = structuredClone(output.records[index]!);
    if (record.kind !== 'interval') throw new Error('Expected deflection interval');
    const update = record.projectiles.update.find((p) => p.deflection)!;
    if (kind === 'owner') update.ownerId = 'left';
    if (kind === 'speed') update.deflection!.velocity.x += 1;
    if (kind === 'event') update.deflection!.eventId = 'e.999999';
    const event = record.events.find((e) => e.projectileDeflection)!;
    if (kind === 'missing-point') event.point = null;
    if (kind === 'shifted-point' || kind === 'coherent-point')
      event.point = { ...event.point!, x: event.point!.x + 1 };
    if (kind === 'boundary-time') event.subtimeMicros = 1;
    if (kind === 'missing-contact') event.parentEventId = null;
    if (kind === 'contact-time' || kind === 'coherent-point') {
      event.projectileDeflection = structuredClone(event.projectileDeflection!);
      if (kind === 'contact-time')
        event.projectileDeflection.subtimeMicros =
          (event.projectileDeflection.subtimeMicros + 1) % 1000001;
      else event.projectileDeflection.point = { ...event.point! };
      update.deflection = structuredClone(event.projectileDeflection);
    }
    expect(() => replay.apply(record)).toThrow(
      ['owner', 'speed', 'event'].includes(kind) ? undefined : 'deflection contact',
    );
  }
  const after = checkpoints[index]!;
  const next = structuredClone(output.records[index + 1]!);
  expect(() => new ReplayState(context, after).apply(next)).not.toThrow();
  const saved = structuredClone(after);
  saved.state!.projectiles[0]!.deflection!.eventId = `e.${saved.nextEvent}`;
  expect(() => new ReplayState(context, saved)).toThrow('projectile deflection provenance');
  if (next.kind !== 'interval') throw new Error('Expected next interval');
  const turn = structuredClone(
    battleEvents(output.records).find((e) => e.kind === 'projectile-deflect')!,
  );
  turn.id = `e.${after.nextEvent + next.events.length}`;
  turn.sequence = after.nextEvent + next.events.length;
  turn.step = next.toStep;
  turn.projectileDeflection!.eventId = turn.id;
  turn.projectileDeflection!.step = next.toStep;
  next.events.push(turn);
  Object.assign(next.projectiles.update[0]!, {
    ownerId: turn.projectileDeflection!.ownerId,
    deflection: turn.projectileDeflection,
    position: turn.projectileDeflection!.position,
    velocity: turn.projectileDeflection!.velocity,
  });
  expect(() => new ReplayState(context, after).apply(next)).toThrow(
    'projectile ownership transition',
  );
});

it('binds saved deflection activations to actual reaction events and their causal context', async () => {
  const input = await deflectionManifest({
    reactions: [
      { reaction: { response: { kind: 'deflect', powerBps: 5000 } } },
      { reaction: { response: { kind: 'deflect', powerBps: 20000 } } },
    ],
  });
  const output = await runBattle(input);
  const { context, checkpoints } = await recordedCheckpoints(input, output);
  const index = output.records.findIndex(
    (r) => r.kind === 'interval' && r.events.some((e) => e.kind === 'projectile-deflect'),
  );
  for (const kind of ['missing', 'depth', 'wave', 'kind', 'cause', 'omitted'] as const) {
    const record = structuredClone(output.records[index]!);
    if (record.kind !== 'interval') throw new Error('Expected deflection interval');
    const event = record.events.find((e) => e.kind === 'projectile-deflect')!;
    event.projectileDeflection = structuredClone(event.projectileDeflection!);
    const activation = event.projectileDeflection!.activations[0]!.context;
    const reaction = record.events.find((e) => e.id === activation.activationId)!;
    if (kind === 'missing') activation.activationId = 'e.0';
    if (kind === 'depth') activation.depth += 1;
    if (kind === 'wave') activation.wave += 1;
    if (kind === 'kind') reaction.kind = 'diagnostic';
    if (kind === 'cause') event.causes = [];
    if (kind === 'omitted') {
      event.projectileDeflection!.activations.pop();
      event.projectileDeflection!.powerBps = 5000;
    }
    record.projectiles.update.find((p) => p.deflection)!.deflection = structuredClone(
      event.projectileDeflection!,
    );
    expect(() => new ReplayState(context, checkpoints[index - 1]!).apply(record)).toThrow(
      'deflection activation event',
    );
  }
});

it('retains gravity and expiry while disabling homing after the contact hold', async () => {
  const input = await deflectionManifest({
    attack: {
      attack: {
        ...deflectionShape,
        gravityScaleBps: 10000,
        homingTurnMilliDegreesPerSecond: 360000,
      },
    },
  });
  const output = await runBattle(input);
  const records = output.records.filter((r) => r.kind === 'interval');
  const contact = records.findIndex((r) => r.projectiles.update.some((p) => p.deflection));
  const update = records[contact]!.projectiles.update.find((p) => p.deflection)!;
  const d = update.deflection!;
  expect(Math.hypot(d.velocity.x, d.velocity.y, d.velocity.z)).toBeCloseTo(
    Math.hypot(d.incomingVelocity.x, d.incomingVelocity.y, d.incomingVelocity.z),
    10,
  );
  const next = records[contact + 1]!.projectiles.update.find((p) => p.id === update.id)!;
  expect(next.velocity.x).toBeCloseTo(d.velocity.x, 10);
  expect(next.velocity.z).toBeCloseTo(d.velocity.z, 10);
  expect(next.velocity.y).toBeCloseTo(d.velocity.y - 9.807 * 0.02, 10);
  expect(next.position.y).toBeCloseTo(
    d.position.y + d.velocity.y * 0.02 - (9.807 * 0.02 ** 2) / 2,
    10,
  );
  const hold = records[contact]!.paths.find((p) => p.entityId === update.id)!.segments.at(-1)!;
  expect(hold.start).toEqual(hold.end);
  expect(hold.to).toBe(1);
  const launch = records
    .flatMap((r) => r.projectiles.spawn)
    .find((p) => p.id === update.id)!.launchStep;
  const expires = await deflectionManifest({
    attack: {
      attack: {
        ...deflectionShape,
        gravityScaleBps: 10000,
        homingTurnMilliDegreesPerSecond: 360000,
        lifetimeSteps: d.step - launch,
      },
    },
  });
  const last = await runBattle(expires);
  const finalContact = last.records.find(
    (r) => r.kind === 'interval' && r.events.some((e) => e.kind === 'projectile-deflect'),
  )!;
  if (finalContact.kind !== 'interval') throw new Error('Expected expiry interval');
  expect(finalContact.toStep).toBe(d.step);
  expect(finalContact.projectiles.update).toHaveLength(0);
  expect(finalContact.projectiles.remove).toEqual([
    { id: update.id, reason: 'expired', subtimeMicros: 1000000 },
  ]);
  expect(battleEvents(last.records).filter((e) => e.kind === 'damage')).toHaveLength(0);
  await recordedCheckpoints(input, output);
  await recordedCheckpoints(expires, last);
});

it('keeps the staged projectile hit ledger and participant enumeration deterministic', async () => {
  const input = await deflectionManifest({
    attack: {
      stages: [
        {
          id: 'bolt',
          offsetSteps: 0,
          durationSteps: 1,
          attack: deflectionShape,
          effects: [{ kind: 'damage', amount: 10, attackScaleBps: 0, element: 'fire' }],
        },
      ],
    },
  });
  const output = await runBattle(input);
  expect(battleEvents(output.records).filter((e) => e.kind === 'projectile-deflect')).toHaveLength(
    1,
  );
  const permuted = structuredClone(input);
  permuted.participants.reverse();
  permuted.revisions.reverse();
  const { result: alternate, records } = await runBattle(permuted);
  const { simulationHash: _a, ...actual } = alternate;
  const { simulationHash: _b, ...expected } = output.result;
  expect(actual).toEqual(expected);
  expect(records).toEqual(output.records);
  const exchanged = structuredClone(input);
  for (const actor of exchanged.participants) {
    actor.actorId = actor.actorId === 'left' ? 'right' : 'left';
    for (const vector of [actor.position, actor.facing]) {
      vector.x *= -1;
      vector.z *= -1;
    }
  }
  exchanged.participants.reverse(); // Owned RNG streams move with the actors.
  const symmetric = await runBattle(exchanged);
  const before = battleEvents(output.records).find(
    (e) => e.projectileDeflection,
  )!.projectileDeflection!;
  const after = battleEvents(symmetric.records).find(
    (e) => e.projectileDeflection,
  )!.projectileDeflection!;
  expect(after.ownerId).toBe('left');
  expect(after.originalOwnerId).toBe('right');
  expect(after.step).toBe(before.step);
  expect(after.velocity.x).toBeCloseTo(-before.velocity.x, 8);
  expect(after.velocity.y).toBeCloseTo(before.velocity.y, 8);
  expect(after.velocity.z).toBeCloseTo(-before.velocity.z, 8);
  expect(battleEvents(symmetric.records).filter((e) => e.kind === 'damage')).toEqual([
    expect.objectContaining({ targetId: 'right', amount: 5 }),
  ]);
  await recordedCheckpoints(input, output);
  await recordedCheckpoints(exchanged, symmetric);
});
