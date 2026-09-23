import { describe, expect, it } from 'vite-plus/test';
import fixture from '../../fixtures/replay/mutual-hit.json' with { type: 'json' };
import { ResultSchema } from './records.ts';
import {
  RECORDING_PROFILE,
  ReplayManifestSchema,
  replayChunkRecords,
  type ReplayCheckpoint,
} from './replay.ts';
import {
  replayContext,
  ReplayState,
  seekReplayState,
  type ReplaySeekSource,
} from './replay-state.ts';

// Three independent chunks start at these record cursors; the last holds the terminal record.
const starts = [0, 3, 6];
async function chunkedFixture() {
  const result = ResultSchema.parse(fixture.result),
    context = await replayContext(fixture.input, result.simulationHash);
  const sequential = new ReplayState(context),
    saved: ReplayCheckpoint[] = [sequential.checkpoint()];
  for (const record of fixture.records) {
    sequential.apply(record);
    saved.push(sequential.checkpoint());
  }
  const ends = [...starts.slice(1), fixture.records.length];
  const ref = (index: number, file: string) => ({
    file,
    bytes: 1,
    rawBytes: 1,
    checksum: result.eventHash,
    index,
  });
  const manifest = ReplayManifestSchema.parse({
    schemaVersion: 1,
    id: 'seek-fixture',
    resultId: 'result-1',
    attemptId: 'attempt-1',
    simulationHash: result.simulationHash,
    input: fixture.input,
    profile: RECORDING_PROFILE,
    lastVerifiedStep: result.steps,
    records: fixture.records.length,
    eventHash: result.eventHash,
    trajectoryHash: result.trajectoryHash,
    end: { kind: 'result', result },
    checkpoints: starts.map((start, i) => ({
      ...ref(i, `checkpoint-0000${i}.json.gz`),
      step: saved[start]!.step,
      nextRecord: start,
    })),
    chunks: starts.map((start, i) => ({
      ...ref(i, `chunk-0000${i}.ndjson.gz`),
      firstRecord: start,
      records: ends[i]! - start,
      fromStep: saved[start]!.step,
      toStep: saved[ends[i]!]!.step,
      checkpoint: i,
    })),
  });
  const loads: string[] = [];
  const source: ReplaySeekSource = {
    checkpoint(index) {
      loads.push(`checkpoint ${index}`);
      return Promise.resolve(saved[starts[index]!]);
    },
    records(index) {
      loads.push(`chunk ${index}`);
      return Promise.resolve(fixture.records.slice(starts[index]!, ends[index]));
    },
  };
  return { context, manifest, saved, loads, source };
}

describe('I/O-free replay seek shared by the API and browser readers', () => {
  it('restores every record cursor from its own checkpoint and loads a chunk only when needed', async () => {
    const { context, manifest, saved, loads, source } = await chunkedFixture();
    const loadsByCursor = [
      ['checkpoint 0'],
      ['checkpoint 0', 'chunk 0'],
      ['checkpoint 0', 'chunk 0'],
      ['checkpoint 1'],
      ['checkpoint 1', 'chunk 1'],
      ['checkpoint 1', 'chunk 1'],
      ['checkpoint 2'],
      ['checkpoint 2', 'chunk 2'],
      ['checkpoint 2', 'chunk 2'],
    ];
    expect(saved).toHaveLength(loadsByCursor.length);
    for (const [cursor, expected] of saved.entries()) {
      loads.length = 0;
      const replay = await seekReplayState(context, manifest, cursor, source);
      expect(replay.checkpoint()).toEqual(expected);
      expect(replay.nextRecord).toBe(cursor);
      expect(loads).toEqual(loadsByCursor[cursor]);
    }
  });
  it('rejects cursors outside the manifest and a manifest for another battle', async () => {
    const { context, manifest, source } = await chunkedFixture();
    for (const cursor of [-1, fixture.records.length + 1, 1.5, Number.NaN])
      await expect(seekReplayState(context, manifest, cursor, source)).rejects.toThrow(
        /seek cursor/,
      );
    const other = { ...manifest, simulationHash: `sha256:${'0'.repeat(64)}` };
    await expect(seekReplayState(context, other, 0, source)).rejects.toThrow(
      /seek manifest binding/,
    );
  });
  it('rejects a checkpoint or chunk that disagrees with the chunk index', async () => {
    const { context, manifest, saved, source } = await chunkedFixture();
    const shifted = { ...source, checkpoint: () => Promise.resolve(saved[3]) };
    await expect(seekReplayState(context, manifest, 1, shifted)).rejects.toThrow(
      /seek checkpoint index/,
    );
    const short = {
      ...source,
      records: (index: number) => source.records(index).then((records) => records.slice(1)),
    };
    await expect(seekReplayState(context, manifest, 4, short)).rejects.toThrow(
      /seek chunk record count/,
    );
  });
  it('returns the empty state for a diagnostic that recorded nothing', async () => {
    const { context, manifest, loads, source } = await chunkedFixture();
    const empty = ReplayManifestSchema.parse({
      ...manifest,
      resultId: null,
      lastVerifiedStep: null,
      records: 0,
      end: { kind: 'failed', reason: 'Worker stopped before the initial record' },
      checkpoints: [],
      chunks: [],
    });
    expect((await seekReplayState(context, empty, 0, source)).checkpoint().state).toBeNull();
    expect(loads).toEqual([]);
    await expect(seekReplayState(context, empty, 1, source)).rejects.toThrow(/seek cursor/);
  });
  it('splits a complete NDJSON chunk and rejects truncation or a wrong record count', () => {
    const records = fixture.records.slice(0, 2),
      text = records.map((record) => `${JSON.stringify(record)}\n`).join('');
    expect(replayChunkRecords(text, { records: 2 })).toEqual(records);
    expect(() => replayChunkRecords(text.slice(0, -1), { records: 2 })).toThrow(/incomplete/);
    expect(() => replayChunkRecords(text, { records: 3 })).toThrow(/record count/);
  });
});
