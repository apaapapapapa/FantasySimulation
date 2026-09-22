import { describe, expect, it } from 'vite-plus/test';
import fixture from '../../fixtures/replay/mutual-hit.json' with { type: 'json' };
import { hashBytes } from './canonical.ts';
import { ResultSchema } from './records.ts';
import {
  eventHashLine,
  trajectoryHashLine,
  ReplayManifestSchema,
  RECORDING_PROFILE,
} from './replay.ts';
import { replayContext, ReplayState } from './replay-state.ts';
import { StreamRecordSchema } from './stream.ts';

describe('saved replay schema v1 (no engine or physics import)', () => {
  it('reads fixed saved bytes, hashes and simultaneous defeat after the generator has stopped', async () => {
    const result = ResultSchema.parse(fixture.result),
      records = fixture.records.map((r) => StreamRecordSchema.parse(r));
    const context = await replayContext(fixture.input, result.simulationHash),
      replay = new ReplayState(context);
    const saved = [replay.checkpoint()];
    for (const record of records) {
      replay.apply(record);
      saved.push(replay.checkpoint());
    }
    expect(result.outcome).toEqual({ kind: 'draw', reason: 'mutual-defeat' });
    expect(result).toMatchObject({
      steps: 6,
      eventHash: 'sha256:d70d13d646b781e38b824a132d8c98d5a252ef2797437d8a09e0aeb9601f5a2e',
      trajectoryHash: 'sha256:116a79a1d742494e6b1670ea43208c1e8f34556743c0ba7d1cdcb6c057888b9b',
    });
    expect(replay.checkpoint().state?.actors.map((a) => a.resources.hp)).toEqual([0, 0]);
    expect(
      await hashBytes(new TextEncoder().encode(records.map(trajectoryHashLine).join(''))),
    ).toBe(result.trajectoryHash);
    expect(
      await hashBytes(
        new TextEncoder().encode(
          records
            .flatMap((r) => ('events' in r ? r.events : []))
            .map(eventHashLine)
            .join(''),
        ),
      ),
    ).toBe(result.eventHash);
    for (let target = records.length; target > 0; target--) {
      const start = Math.max(0, target - 2),
        seek = new ReplayState(context, saved[start]);
      for (const record of records.slice(start, target)) seek.apply(record);
      expect(seek.checkpoint()).toEqual(saved[target]);
    }
    const last = saved.at(-1)!;
    expect(() => new ReplayState(context, { ...last, nextEvent: 0 })).toThrow(/cursor/);
  });
  it('rejects missing causal/entity references and mismatched terminal results atomically', async () => {
    const result = ResultSchema.parse(fixture.result),
      context = await replayContext(fixture.input, result.simulationHash);
    const records = fixture.records.map((r) => StreamRecordSchema.parse(r));
    const index = records.findIndex((r) => r.kind === 'interval' && r.events.length > 0);
    const replay = new ReplayState(context);
    records.slice(0, index).forEach((r) => replay.apply(r));
    const record = records[index]!;
    if (record.kind !== 'interval') throw new Error('fixture');
    for (const edit of [
      (r: typeof record) => {
        r.events[0]!.sequence += 1;
      },
      (r: typeof record) => {
        r.events[0]!.parentEventId = 'e.999999';
      },
      (r: typeof record) => {
        r.events[0]!.entityId = 'unknown';
      },
      (r: typeof record) => {
        r.paths[0]!.segments[0]!.to = 0.5;
      },
    ]) {
      const broken = structuredClone(record),
        before = replay.checkpoint();
      edit(broken);
      expect(() => replay.apply(broken)).toThrow();
      expect(replay.checkpoint()).toEqual(before);
    }
    records.slice(index, -1).forEach((r) => replay.apply(r));
    const terminal = records.at(-1)!;
    if (terminal.kind !== 'terminal') throw new Error('fixture');
    expect(() => replay.apply({ ...terminal, outcome: { kind: 'win', winner: 'left' } })).toThrow(
      /winner/,
    );
  });
  it('distinguishes incomplete diagnostics and forbids arbitrary artifact URLs or unsupported formats', () => {
    const result = ResultSchema.parse(fixture.result);
    const diagnostic = {
      schemaVersion: 1,
      id: 'replay-1',
      resultId: null,
      attemptId: 'attempt-1',
      simulationHash: result.simulationHash,
      input: fixture.input,
      profile: RECORDING_PROFILE,
      lastVerifiedStep: null,
      records: 0,
      eventHash: result.eventHash,
      trajectoryHash: result.trajectoryHash,
      end: { kind: 'failed', reason: 'Worker stopped before initial record' },
      checkpoints: [],
      chunks: [],
    };
    expect(ReplayManifestSchema.parse(diagnostic).end.kind).toBe('failed');
    expect(() => ReplayManifestSchema.parse({ ...diagnostic, schemaVersion: 2 })).toThrow();
    expect(() => ReplayManifestSchema.parse({ ...diagnostic, resultId: 'result-1' })).toThrow();
    expect(() =>
      ReplayManifestSchema.parse({
        ...diagnostic,
        chunks: [{ file: 'https://untrusted.test/log.gz' }],
      }),
    ).toThrow();
    expect(() =>
      ReplayManifestSchema.parse({
        ...diagnostic,
        end: { kind: 'result', result },
        resultId: 'result-1',
      }),
    ).toThrow();
  });
});
