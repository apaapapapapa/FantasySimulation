import { expect, it } from 'vite-plus/test';
import { ReplayState, ResultSchema, type Interference } from '@fantasy/domain/spatial';
import {
  STATUS_CONFLICT_RULES,
  statusConflictManifest,
  startupConflictCauses,
  reactionConflictManifest,
  diagnosticsRules,
} from '../../test-support/interference-diagnostics.ts';
import { recordedCheckpoints } from '../../test-support/replay.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { boundedInterferences } from './sim/interference.ts';
import { runBattle } from './run.ts';

it('captures actual before-hit and before-defeat wave attempts without committing their effects', async () => {
  for (const point of ['before-hit', 'before-defeat'] as const) {
    const input = await diagnosticsRules(await reactionConflictManifest(point));
    const output = await runBattle(input);
    expect(output.result.outcome).toMatchObject({
      kind: 'unresolved',
      interferences: [
        {
          point: 'status-commit',
          step: 5,
          wave: null,
          causes: expect.arrayContaining([
            expect.objectContaining({ kind: 'attempt', point, wave: 0, step: 5 }),
          ]),
        },
      ],
    });
    expect(battleEvents(output.records).some((e) => e.kind === 'damage')).toBe(false);
    await recordedCheckpoints(input, output);
  }
});

it('records 32 real simultaneous causes and truncates at 33 without retaining partial costs or events', async () => {
  for (const count of [32, 33]) {
    const input = await startupConflictCauses(count);
    const output = await runBattle(input);
    const outcome = output.result.outcome;
    if (count === 32) {
      expect(outcome.kind).toBe('unresolved');
      if (outcome.kind !== 'unresolved') throw new Error('Fixture');
      expect(outcome.interferences![0]!.causes).toHaveLength(32);
    } else {
      expect(outcome).toMatchObject({
        kind: 'truncated',
        resource: 'interference-causes',
        details: {
          observed: 33,
          limit: 32,
        },
      });
      expect(outcome).not.toHaveProperty('interferences');
    }
    expect(battleEvents(output.records).every((e) => e.kind === 'terminal')).toBe(true);
    await recordedCheckpoints(input, output);
  }
});

it.each(STATUS_CONFLICT_RULES)(
  'records the complete bounded causal set and preserves rollback for %s',
  async (rule) => {
    const input = await statusConflictManifest(rule);
    const full = await runBattle(input);
    const legacy = await runBattle(await statusConflictManifest(rule, false));
    const outcome = full.result.outcome;
    expect(outcome.kind).toBe('unresolved');
    if (outcome.kind !== 'unresolved') throw new Error('Expected conflict');
    const { interferences, ...old } = outcome;
    expect(old).toEqual(legacy.result.outcome);
    const startup = rule === 'status.simultaneous-conflict';
    expect(interferences).toHaveLength(1);
    expect(interferences![0]).toMatchObject({
      ruleId: rule,
      step: startup ? 0 : 5,
      point: startup ? 'startup' : 'status-commit',
      wave: null,
    });
    expect(interferences![0]!.causes).toHaveLength(rule === 'status.reaction-conflict' ? 3 : 2);
    expect(interferences![0]!.causes.some((c) => c.kind === 'event')).toBe(!startup);
    if (rule === 'status.reaction-conflict')
      expect(interferences![0]!.causes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'attempt', point: 'contact', wave: 0, actorId: 'left' }),
          expect.objectContaining({
            kind: 'attempt',
            point: 'after-damage',
            wave: 0,
            actorId: 'right',
          }),
        ]),
      );
    for (const hash of ['eventHash', 'tsStateHash', 'physicsStateHash'] as const)
      expect(full.result[hash], hash).toBe(legacy.result[hash]);
    // The stream hash includes the optional terminal outcome; committed display records do not change.
    expect(full.result.trajectoryHash).not.toBe(legacy.result.trajectoryHash);
    expect(full.records.slice(0, -1)).toEqual(legacy.records.slice(0, -1));
    expect(
      battleEvents(full.records).filter(
        (e) => e.kind === 'damage' || e.ruleId === 'reaction.activated',
      ),
    ).toEqual([]);
    expect(ResultSchema.parse(JSON.parse(JSON.stringify(full.result)))).toEqual(full.result);
    const { context, replay } = await recordedCheckpoints(input, full);
    expect(new ReplayState(context, replay.checkpoint()).checkpoint()).toEqual(replay.checkpoint());
  },
);

it('rejects dangling diagnostic events, wrong owners, revisions and attempted boundaries atomically', async () => {
  const input = await statusConflictManifest('status.reaction-conflict');
  const output = await runBattle(input);
  const { context, checkpoints } = await recordedCheckpoints(input, output);
  const terminal = output.records.at(-1)!;
  if (terminal.kind !== 'terminal' || terminal.outcome.kind !== 'unresolved')
    throw new Error('Fixture');
  const prior = checkpoints.at(-2)!;
  for (const change of ['event', 'actor', 'owner', 'revision', 'step'] as const) {
    const damaged = structuredClone(terminal);
    if (damaged.outcome.kind !== 'unresolved') throw new Error('Fixture');
    const entry = damaged.outcome.interferences![0]!;
    if (change === 'event') entry.causes = [{ kind: 'event', eventId: `e.${prior.nextEvent}` }];
    if (change === 'actor') entry.actors = ['absent'];
    if (change === 'revision') entry.revisions[0]!.contentHash = `sha256:${'f'.repeat(64)}`;
    const attempt = entry.causes.find((c) => c.kind === 'attempt' && c.point === 'after-damage');
    if (change === 'owner' && attempt?.kind === 'attempt') {
      const grant = input.revisions.find(
        (r) => r.kind === 'ability' && r.id === 'initial-grant-1',
      )!;
      const ref = { id: grant.id, revision: grant.revision, contentHash: grant.contentHash };
      attempt.actorId = 'left';
      attempt.ability = ref;
      entry.revisions.push({ ...ref, kind: 'ability' });
    }
    if (change === 'step') entry.step++;
    const replay = new ReplayState(context, prior);
    expect(() => replay.apply(damaged), change).toThrow();
    expect(replay.checkpoint()).toEqual(prior);
  }
});

it('admits exact diagnostic count limits and truncates whole contexts rather than slicing causes', () => {
  const ref = { id: 'a', revision: 1, contentHash: `sha256:${'1'.repeat(64)}` };
  const entry: Interference = {
    step: 0,
    point: 'startup',
    wave: null,
    actors: ['a', 'b'],
    ruleId: 'status.simultaneous-conflict',
    revisions: [{ ...ref, kind: 'status' }],
    causes: [
      {
        kind: 'attempt',
        step: 0,
        point: 'startup',
        wave: null,
        actorId: 'a',
        ability: ref,
        ordinal: 0,
      },
    ],
  };
  const copies = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ ...structuredClone(entry), ruleId: `rule-${i}` }));
  expect(boundedInterferences(copies(16))).toHaveLength(16);
  expect(() => boundedInterferences(copies(17))).toThrow('interference-entries');
  for (const [resource, limit] of [
    ['actors', 2],
    ['causes', 32],
    ['revisions', 64],
  ] as const) {
    const candidate = structuredClone(entry);
    if (resource === 'actors') candidate.actors = ['a', 'b'];
    if (resource === 'causes')
      candidate.causes = Array.from({ length: limit }, (_, i) => ({
        kind: 'event',
        eventId: `e.${i}`,
      }));
    if (resource === 'revisions')
      candidate.revisions = Array.from({ length: limit }, (_, i) => ({
        ...ref,
        id: `status-${i}`,
        kind: 'status',
      }));
    expect(boundedInterferences([candidate])[0]![resource]).toHaveLength(limit);
    if (resource === 'actors') candidate.actors.push('c');
    if (resource === 'causes') candidate.causes.push({ kind: 'event', eventId: 'e.99' });
    if (resource === 'revisions')
      candidate.revisions.push({ ...ref, id: 'status-99', kind: 'status' });
    expect(() => boundedInterferences([candidate])).toThrow(`interference-${resource}`);
  }
  const oversized = copies(16).map((item) => ({
    ...item,
    revisions: Array.from({ length: 64 }, (_, i) => ({
      ...ref,
      id: `status-${i}`,
      kind: 'status' as const,
    })),
  }));
  expect(() => boundedInterferences(oversized)).toThrow('interference-bytes');
  expect(oversized[0]!.revisions).toHaveLength(64);
});

it('keeps diagnosis and combat under reversed participant revision and position-stream correspondence', async () => {
  const input = await statusConflictManifest('status.reaction-conflict');
  const base = await runBattle(input);
  const reversed = structuredClone(input);
  reversed.participants.reverse();
  reversed.revisions.reverse();
  expect((await runBattle(reversed)).result.outcome).toEqual(base.result.outcome);
  const mirrored = structuredClone(input);
  for (const participant of mirrored.participants) {
    participant.position.x *= -1;
    participant.position.z *= -1;
    participant.facing.x *= -1;
    participant.facing.z *= -1;
  }
  const output = await runBattle(mirrored);
  expect(output.result.outcome).toEqual(base.result.outcome);
  expect(output.result.tsStateHash).not.toBe(base.result.tsStateHash);
  await recordedCheckpoints(mirrored, output);
});
