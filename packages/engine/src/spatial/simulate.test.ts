import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_BUDGET,
  StreamRecordSchema,
  type Definition,
  type Manifest,
  type StreamRecord,
} from '@fantasy/domain/spatial';
import { prepareBattle, reference, sealRevision } from './prepare.ts';
import { sampleManifest } from './sample.ts';
import {
  battleEvents as events,
  combatManifest,
  editScenario,
  glassWall,
} from '../../test-support/fixtures.ts';
import { runBattle, runPreparedBattle } from './run.ts';

async function fixture(
  maxSteps: number,
  edit: {
    ability?: Partial<Definition<'ability'>>;
    character?: Partial<Definition<'character'>>;
    policy?: Partial<Definition<'policy'>>;
    statuses?: Definition<'status'>[];
    startup?: boolean;
    wall?: boolean;
  } = {},
) {
  const statuses = await Promise.all(
    (edit.statuses ?? []).map((definition, i) =>
      sealRevision('status', `status-${i}`, 1, definition),
    ),
  );
  const manifest = await combatManifest(maxSteps, {
    ability: {
      ...edit.ability,
      ...(statuses.length
        ? {
            target: 'self' as const,
            attack: { kind: 'direct' as const },
            castSteps: 0,
            costs: { hp: 0, mp: 0, uses: 1 },
            effects: statuses.map((s) => ({ kind: 'apply-status' as const, status: reference(s) })),
          }
        : {}),
      ...(edit.startup ? { trigger: 'battle-start' as const } : {}),
    },
    policy: edit.policy ?? {},
    character: edit.character ?? {},
  });
  manifest.revisions.push(...statuses);
  if (edit.wall) await editScenario(manifest, (scenario) => scenario.obstacles.push(glassWall(5)));
  return manifest;
}
const finalActors = (records: StreamRecord[]) => {
  const initial = records[0]!;
  if (initial.kind !== 'initial') throw new Error('Missing initial display');
  const actors = structuredClone(initial.state.actors);
  for (const record of records)
    if ('changes' in record)
      for (const change of record.changes)
        Object.assign(
          actors.find((a) => a.id === change.id)!,
          change,
        );
  return actors;
};
const aura = (): Definition<'status'> => ({
  name: 'flight pulse',
  originalText: '',
  stackKey: 'aura',
  stacking: 'refresh',
  durationSteps: 3,
  maxStacks: 1,
  modifiers: { attack: 0, defense: 0, speedBps: 10000, flight: true, rooted: false },
  periodic: [{ kind: 'damage', element: 'fire', amount: 15, everySteps: 2 }],
});
describe('fixed-step battle stream', () => {
  it('runs a symmetric melee battle, preserves the input, and emits sufficient validated display deltas', async () => {
    const input = await sampleManifest(500),
      copy = structuredClone(input);
    const run = await runBattle(input);
    expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
    expect(run.result.steps).toBeLessThan(500);
    expect(run.result).toMatchObject({
      steps: 161,
      eventHash: 'sha256:0e02f14f0aeb0d77325f905d766123cced8ad6618bafcbe4a5e9aba9f3d63369',
      trajectoryHash: 'sha256:d1e12aec07acae9c98f6b6112f90b2b9cbd02b75f71a2bdf86ef687ea2f8d03f',
      tsStateHash: 'sha256:984a42f1668429ec51ab574bda8f3720e4224428e815011db29acc1901098dcc',
      physicsStateHash: 'sha256:680dac7ee74bc7a5cbdfee30427f3b7ec229ebfa68febdf361bc4ab90d551976',
    });
    expect(finalActors(run.records).map((a) => a.resources.hp)).toEqual([0, 0]);
    for (const record of run.records) {
      expect(StreamRecordSchema.safeParse(record).success).toBe(true);
      if (record.kind === 'interval')
        for (const path of record.paths) {
          expect(path.segments[0]!.from).toBe(0);
          expect(path.segments.at(-1)!.to).toBe(1);
          for (let i = 1; i < path.segments.length; i++)
            expect(path.segments[i]!.start).toEqual(path.segments[i - 1]!.end);
        }
    }
    const log = events(run.records);
    expect(log.map((e) => e.sequence)).toEqual(log.map((_, i) => i));
    const seen = new Set<string>();
    for (const event of log) {
      if (event.parentEventId) expect(seen.has(event.parentEventId)).toBe(true);
      for (const cause of event.causes) expect(seen.has(cause)).toBe(true);
      seen.add(event.id);
    }
    expect(input).toEqual(copy);
  });
  it('repeats event/state/physics hashes and preserves combat under participant and revision enumeration changes', async () => {
    const input = await sampleManifest(300);
    const first = await runBattle(input),
      repeat = await runBattle(input);
    expect(repeat.result).toEqual(first.result);
    input.participants.reverse();
    input.revisions.reverse();
    const reversed = await runBattle(input);
    expect(reversed.result.simulationHash).not.toBe(first.result.simulationHash);
    expect(reversed.result.eventHash).toBe(first.result.eventHash);
    expect(reversed.result.trajectoryHash).toBe(first.result.trajectoryHash);
    expect(reversed.result.tsStateHash).toBe(first.result.tsStateHash);
  });
  it('allows an immediate committed heal to offset an HP cost that consumed the last HP', async () => {
    const input = await fixture(1, {
      ability: {
        target: 'self',
        attack: { kind: 'direct' },
        castSteps: 0,
        costs: { hp: 100, mp: 100, uses: 1 },
        effects: [{ kind: 'heal', amount: 20 }],
      },
      policy: { movement: 'hold' },
    });
    const run = await runBattle(input);
    expect(finalActors(run.records).map((a) => a.resources)).toEqual([
      { hp: 20, mp: 0, shield: 0 },
      { hp: 20, mp: 0, shield: 0 },
    ]);
    expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
    expect(
      events(run.records)
        .filter((e) => e.kind === 'cost')
        .every((e) => e.after?.hp === 0),
    ).toBe(true);
  });
  it('does not partially pay an unaffordable action and enforces cooldown and a finite number of uses', async () => {
    const base = {
      target: 'self' as const,
      attack: { kind: 'direct' as const },
      castSteps: 0,
      recoverySteps: 1,
      cooldownSteps: 20,
      effects: [{ kind: 'heal' as const, amount: 1 }],
    };
    const failed = await runBattle(
      await fixture(1, {
        ability: { ...base, costs: { hp: 1, mp: 101, uses: 0 } },
        policy: { movement: 'hold' },
      }),
    );
    expect(
      finalActors(failed.records).every((a) => a.resources.hp === 100 && a.resources.mp === 100),
    ).toBe(true);
    expect(events(failed.records).filter((e) => e.kind === 'cost')).toHaveLength(0);
    expect(events(failed.records).some((e) => e.reason === 'insufficient-mp')).toBe(true);
    const limited = await runBattle(
      await fixture(50, {
        ability: { ...base, costs: { hp: 0, mp: 1, uses: 2 } },
        policy: { movement: 'hold' },
      }),
    );
    expect(
      events(limited.records)
        .filter((e) => e.kind === 'launch' && e.actorId === 'left')
        .map((e) => e.step),
    ).toEqual([0, 20]);
    expect(finalActors(limited.records)[0]!.resources.mp).toBe(98);
  });
  it('activates action statuses at the next boundary, pulses at activation, and removes them before the expiry pulse', async () => {
    const run = await runBattle(
      await fixture(5, { statuses: [aura()], policy: { movement: 'hold' } }),
    );
    expect(
      events(run.records)
        .filter((e) => e.kind === 'damage' && e.targetId === 'left')
        .map((e) => e.step),
    ).toEqual([1, 3]);
    expect(finalActors(run.records).map((a) => a.resources.hp)).toEqual([80, 80]);
    expect(finalActors(run.records).every((a) => a.statuses.length === 0)).toBe(true);
    const frames = run.records.filter((r) => r.kind === 'interval');
    const velocityAt = (n: number) =>
      finalActors(run.records.slice(0, run.records.indexOf(frames[n]!) + 1))[0]!.velocity.y;
    expect(velocityAt(2)).toBeGreaterThan(0);
    expect(velocityAt(4)).toBeCloseTo(velocityAt(3) - 0.19614, 6);
  });
  it('resolves startup status/periodic effects before the first interval without dependence on actor order', async () => {
    const run = await runBattle(
      await fixture(4, { statuses: [aura()], startup: true, policy: { movement: 'hold' } }),
    );
    expect(
      events(run.records)
        .filter((e) => e.kind === 'damage' && e.targetId === 'left')
        .map((e) => e.step),
    ).toEqual([0, 2]);
    expect(finalActors(run.records).map((a) => a.resources.hp)).toEqual([80, 80]);
  });
  it('does not invent a priority for conflicting accepted status definitions or retain partial costs', async () => {
    const run = await runBattle(
      await fixture(5, {
        statuses: [
          aura(),
          { ...aura(), name: 'conflicting', modifiers: { ...aura().modifiers, defense: 5 } },
        ],
        startup: true,
      }),
    );
    expect(run.result.outcome).toMatchObject({
      kind: 'unresolved',
      ruleId: 'status.simultaneous-conflict',
      revisions: ['status-0', 'status-1'],
    });
    expect(run.result.steps).toBe(0);
    expect(events(run.records)).toHaveLength(1);
    expect(
      finalActors(run.records).every((a) => a.resources.hp === 100 && a.statuses.length === 0),
    ).toBe(true);
  });
  it('rolls back a budget-exhausted interval and retries the same simulation hash with a larger attempt budget', async () => {
    const prepared = await prepareBattle(await sampleManifest(300));
    for (const budget of [
      { ...DEFAULT_BUDGET, maxCasts: 1 },
      { ...DEFAULT_BUDGET, maxFrameBytes: 1 },
      { ...DEFAULT_BUDGET, maxEvents: 1 },
    ]) {
      const small = await runPreparedBattle(prepared, budget);
      expect(small.result.outcome.kind).toBe('truncated');
      expect(small.result.simulationHash).toBe(prepared.simulationHash);
      expect(small.records.at(-1)!.kind).toBe('terminal');
      expect(finalActors(small.records).every((a) => a.resources.hp === 100)).toBe(true);
    }
    const full = await runPreparedBattle(prepared);
    expect(full.result.outcome.kind).toBe('draw');
    expect(full.result.simulationHash).toBe(prepared.simulationHash);
  });
  it('resolves the last allowed interval, checks simultaneous defeat before timeout, and starts nothing at the end boundary', async () => {
    const options = {
      ability: {
        target: 'self' as const,
        attack: { kind: 'direct' as const },
        castSteps: 0,
        recoverySteps: 1,
        effects: [
          { kind: 'damage' as const, amount: 100, attackScaleBps: 0, element: 'physical' as const },
        ],
      },
      policy: { movement: 'hold' as const },
    };
    const before = await runBattle(await fixture(5, options));
    expect(before.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
    expect(finalActors(before.records)[0]!.resources.hp).toBe(5);
    const final = await runBattle(await fixture(6, options));
    expect(final.result.outcome).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
    expect(final.result.steps).toBe(6);
    expect(
      events(final.records)
        .filter((e) => e.kind === 'cast-start')
        .every((e) => e.step < 6),
    ).toBe(true);
  });
  it('uses attack occlusion independently from visibility in the integrated hitscan loop', async () => {
    const run = await runBattle(
      await fixture(50, {
        wall: true,
        ability: { attack: { kind: 'hitscan', radiusMm: 100 }, rangeMm: 20000, castSteps: 0 },
        policy: { movement: 'hold' },
      }),
    );
    expect(finalActors(run.records).every((a) => a.resources.hp === 100)).toBe(true);
    expect(
      events(run.records).some((e) => e.ruleId === 'hitscan.first-contact' && e.reason === 'wall'),
    ).toBe(true);
    expect(events(run.records).some((e) => e.kind === 'damage')).toBe(false);
  });
  it('completes all 6000 intervals with zero action speed and does not turn game time into a host timeout', async () => {
    const sample = await sampleManifest();
    const stats = sample.revisions.find((r) => r.kind === 'character')!.definition.stats;
    const input: Manifest = await fixture(6000, {
      character: { stats: { ...stats, actionSpeedBps: 0 } },
      policy: { movement: 'hold' },
    });
    const run = await runBattle(input);
    expect(run.result.steps).toBe(6000);
    expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
    expect(events(run.records).some((e) => e.kind === 'cast-start')).toBe(false);
  }, 30000);
});
